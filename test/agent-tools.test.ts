import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { APRON_ID, SPOTLIGHT, orders, products } from "../fixture/seed.js";
import { type Harness, startHarness } from "../fixture/agent.js";

/**
 * Exercises the connector the way an agent reaches it: a separate process, spoken
 * to over stdio MCP, against the fixture store.
 */
let h: Harness;

const EXPECTED_TOOLS = [
  "catalog_list",
  "catalog_search",
  "order_by_gateway_ref",
  "order_detail",
  "order_timeline",
  "orders_list",
  "orders_search",
  "product_detail",
  "stock_alerts",
  "store_link_check",
];

describe("the connector as an agent sees it", () => {
  before(async () => {
    h = await startHarness();
  });
  after(async () => h.close());

  describe("discovery", () => {
    test("every tool is declared read-only and describes itself usefully", async () => {
      const { tools } = await h.client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);

      for (const tool of tools) {
        assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
        assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must not be destructive`);
        assert.equal(tool.inputSchema.type, "object");
        assert.ok(
          (tool.description ?? "").length > 60,
          `${tool.name} needs a description the model can choose on`,
        );
      }
    });

    test("the server briefs the model on what it cannot do", async () => {
      const briefing = h.client.getInstructions() ?? "";
      assert.match(briefing, /cannot change anything/i);
      assert.match(briefing, /veiled/i);
    });

    test("store_link_check reports the live configuration", async () => {
      const { failed, body } = await h.invoke("store_link_check");
      assert.equal(failed, false);
      assert.equal(body.reachable, true);
      assert.equal(body.orders_visible, orders.length);
      assert.equal(body.contacts_veiled, true);
      // The fixture is plain HTTP, so the key must be signed rather than sent.
      assert.equal(body.signing, "query");
      assert.ok(body.round_trip_ms >= 0);
    });
  });

  describe("orders", () => {
    test("orders_list pages newest first and says how much more there is", async () => {
      const { failed, body } = await h.invoke("orders_list", { per_page: 5 });
      assert.equal(failed, false);
      assert.equal(body.rows.length, 5);
      assert.equal(body.matched, orders.length);
      assert.equal(body.more_pages, true);

      const placed = body.rows.map((row: any) => row.placed_at);
      assert.deepEqual(placed, [...placed].sort().reverse());
    });

    test("consecutive pages do not repeat an order", async () => {
      const first = await h.invoke("orders_list", { per_page: 10, page: 1 });
      const second = await h.invoke("orders_list", { per_page: 10, page: 2 });
      const seen = new Set(first.body.rows.map((row: any) => row.order_id));

      assert.equal(second.body.page, 2);
      assert.ok(second.body.rows.every((row: any) => !seen.has(row.order_id)));
    });

    test("orders_list narrows to several states at once", async () => {
      const { body } = await h.invoke("orders_list", { state: ["failed", "pending"], per_page: 50 });
      const expected = orders.filter((order) => ["failed", "pending"].includes(order.status)).length;

      assert.equal(body.matched, expected);
      assert.ok(body.rows.every((row: any) => ["failed", "pending"].includes(row.state)));
    });

    test("a bare date covers the whole day in the store's timezone", async () => {
      const day = orders[20].date_created.slice(0, 10);
      const { body } = await h.invoke("orders_list", { from: day, to: day, per_page: 50 });

      assert.ok(body.rows.length >= 1, "the day an order was placed must not come back empty");
      assert.ok(body.rows.every((row: any) => row.placed_at.startsWith(day)));
    });

    test("oldest-first is available for walking a history forwards", async () => {
      const { body } = await h.invoke("orders_list", { newest_first: false, per_page: 4 });
      const placed = body.rows.map((row: any) => row.placed_at);
      assert.deepEqual(placed, [...placed].sort());
    });

    test("buyer contact details arrive veiled", async () => {
      const { body } = await h.invoke("orders_list", { per_page: 1 });
      const { buyer } = body.rows[0];

      assert.match(buyer.email, /^.\*{3}.@example\.com$/);
      assert.match(buyer.phone, /^\*{3}\d{4}$/);
      assert.ok(buyer.name, "the name is not a secret -- support needs it");
    });

    test("orders_search finds a buyer's history by email", async () => {
      const email = orders[12].billing.email!;
      const { body } = await h.invoke("orders_search", { text: email });
      const expected = orders.filter((order) => order.billing.email === email).length;

      assert.equal(body.matched, expected);
      assert.ok(body.rows.length > 0);
    });

    test('order_detail accepts "#1234" and returns the whole order', async () => {
      const source = SPOTLIGHT.withCoupon;
      const { failed, body } = await h.invoke("order_detail", { order: `#${source.id}` });

      assert.equal(failed, false);
      assert.equal(body.order_id, source.id);
      assert.equal(body.lines.length, source.line_items.length);
      assert.deepEqual(body.coupons, ["STUDIO10"]);
      assert.equal(body.money.charged, source.total);
      assert.equal("street" in body.bill_to, false, "no street address without WC_SHOW_CONTACTS");
      assert.ok(body.bill_to.city);
    });

    test("an order that does not exist comes back as advice, not a crash", async () => {
      const { failed, body } = await h.invoke("order_detail", { order: 909909 });

      assert.equal(failed, true);
      assert.equal(body.failed, "missing_resource");
      assert.match(body.next_step, /search/i);
    });

    test("order_timeline reads oldest to newest and includes gateway messages", async () => {
      const { body } = await h.invoke("order_timeline", { order: SPOTLIGHT.failedPayment.id });
      const times = body.entries.map((entry: any) => entry.at);

      assert.deepEqual(times, [...times].sort(), "a timeline should read forwards");
      assert.ok(body.entries.some((entry: any) => /failed/i.test(entry.body)));
      assert.ok(body.entries.every((entry: any) => ["internal", "customer"].includes(entry.audience)));
    });

    test("order_by_gateway_ref finds money that arrived while the order stayed pending", async () => {
      const stranded = SPOTLIGHT.strandedPayment;
      const reference = stranded.meta_data!.find((field) => field.key === "_razorpay_payment_id")!
        .value as string;

      const { body } = await h.invoke("order_by_gateway_ref", { reference });

      assert.equal(body.matched, true);
      assert.equal(body.orders[0].order_id, stranded.id);
      assert.equal(body.orders[0].state, "pending");
      assert.equal(body.conclusive, true);
    });

    test("order_by_gateway_ref also matches a settled order's transaction id", async () => {
      const settled = SPOTLIGHT.settled;
      const { body } = await h.invoke("order_by_gateway_ref", { reference: settled.transaction_id! });

      assert.equal(body.matched, true);
      assert.equal(body.orders[0].order_id, settled.id);
    });

    test("a reference nobody used is reported as a conclusive miss", async () => {
      const { body } = await h.invoke("order_by_gateway_ref", { reference: "pay_NoSuchRef99" });

      assert.equal(body.matched, false);
      assert.equal(body.conclusive, true, "the fixture's orders fit inside one page, so the sweep finished");
      assert.ok(body.orders_inspected > 0);
    });

    test("a tighter window reads fewer orders", async () => {
      const wide = await h.invoke("order_by_gateway_ref", { reference: "pay_NoSuchRef99", window_days: 90 });
      const narrow = await h.invoke("order_by_gateway_ref", { reference: "pay_NoSuchRef99", window_days: 1 });

      assert.equal(narrow.body.window_days, 1);
      assert.ok(narrow.body.orders_inspected < wide.body.orders_inspected);
    });

    test("bad arguments are refused before the store is touched", async () => {
      const before = h.store.tally.apiCalls;

      assert.equal((await h.invoke("orders_list", { per_page: 500 })).failed, true);
      assert.equal((await h.invoke("orders_list", { from: "last tuesday" })).failed, true);
      assert.equal((await h.invoke("orders_list", { state: [] })).failed, true);
      assert.equal((await h.invoke("order_detail", { order: "not-an-order" })).failed, true);

      assert.equal(h.store.tally.apiCalls, before, "schema rejects should cost the merchant nothing");
    });
  });

  describe("catalogue and stock", () => {
    test("catalog_list shows only published products and honours the stock filter", async () => {
      const { body } = await h.invoke("catalog_list", { availability: "outofstock", per_page: 50 });

      assert.ok(body.rows.length > 0);
      assert.ok(
        body.rows.every((row: any) => row.availability === "outofstock" && row.state === "publish"),
      );

      const everything = await h.invoke("catalog_list", { per_page: 50 });
      const published = products.filter((product) => product.status === "publish").length;
      assert.equal(everything.body.matched, published);
      assert.ok(published < products.length, "the fixture keeps one product unpublished on purpose");
    });

    test("catalog_search works by text and by exact SKU, and insists on one of them", async () => {
      const byText = await h.invoke("catalog_search", { text: "mug" });
      assert.ok(byText.body.rows.some((row: any) => /mug/i.test(row.title)));

      const bySku = await h.invoke("catalog_search", { sku: "CH-APRON" });
      assert.equal(bySku.body.rows.length, 1);
      assert.equal(bySku.body.rows[0].product_id, APRON_ID);

      const neither = await h.invoke("catalog_search", {});
      assert.equal(neither.failed, true);
      assert.equal(neither.body.failed, "bad_parameters");
    });

    test("product_detail answers a question about one variant", async () => {
      const { body } = await h.invoke("product_detail", { product_id: APRON_ID });

      assert.equal(body.kind, "variable");
      assert.deepEqual(
        body.variants.map((variant: any) => variant.options.Size),
        ["S", "M", "L"],
      );

      const medium = body.variants.find((variant: any) => variant.options.Size === "M");
      assert.equal(medium.on_hand, 1);
      assert.equal(body.variants.at(-1).availability, "outofstock");
    });

    test("stock_alerts ranks the most urgent first and labels each one", async () => {
      const { body } = await h.invoke("stock_alerts", {});

      assert.equal(body.conclusive, true);
      assert.ok(body.alerts.length > 0);

      const quantities = body.alerts.map((alert: any) => alert.on_hand);
      assert.deepEqual(quantities, [...quantities].sort((a: number, b: number) => a - b));

      for (const alert of body.alerts) {
        assert.ok(["sold_out", "low"].includes(alert.severity));
        if (alert.severity === "sold_out") assert.equal(alert.on_hand, 0);
        else assert.ok(alert.on_hand > 0 && alert.on_hand <= alert.reorder_at);
      }

      assert.ok(body.alerts.some((alert: any) => alert.severity === "sold_out"));
      assert.ok(body.alerts.some((alert: any) => alert.severity === "low"));
      assert.match(body.caveat, /product_detail/);
    });

    test("an explicit reorder level overrides every per-product setting", async () => {
      const { body } = await h.invoke("stock_alerts", { reorder_at: 2, include_sold_out: false });

      assert.equal(body.reorder_level, 2);
      assert.ok(body.alerts.length > 0);
      assert.ok(body.alerts.every((alert: any) => alert.on_hand > 0 && alert.on_hand <= 2));
    });

    test("untracked products are left out rather than reported as zero", async () => {
      const { body } = await h.invoke("stock_alerts", { reorder_at: 1000 });
      const untracked = products.filter((product) => !product.manage_stock).map((product) => product.id);

      assert.ok(untracked.length > 0, "the fixture includes products that do not track stock");
      assert.ok(body.alerts.every((alert: any) => !untracked.includes(alert.product_id)));
    });
  });
});
