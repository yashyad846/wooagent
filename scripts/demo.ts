import { APRON_ID, SPOTLIGHT, STORE, orders } from "../fixture/seed.js";
import { startHarness } from "../fixture/agent.js";

/**
 * Walks through the support questions this connector exists to answer, against
 * the fixture store. Each step prints the question, the tool call an agent would
 * make, and what came back -- including the two cases that go wrong on purpose.
 */

const BOLD = (text: string) => `\x1b[1m${text}\x1b[0m`;
const FAINT = (text: string) => `\x1b[2m${text}\x1b[0m`;
const WARN = (text: string) => `\x1b[33m${text}\x1b[0m`;
const RUPEE = (amount: string | number) => `INR ${Number(amount).toFixed(2)}`;

// Realistic pacing, not the fast settings the test suite uses, so the numbers
// printed below are the ones a merchant would actually see.
const harness = await startHarness(
  { throttle: { calls: 30, windowMs: 10_000 } },
  { WC_RPS: "5", WC_BURST: "10" },
);

let step = 0;

async function ask(
  question: string,
  tool: string,
  args: Record<string, unknown>,
  render: (body: any) => string,
): Promise<void> {
  step++;
  console.log(`\n${BOLD(`${step}. ${question}`)}`);
  console.log(FAINT(`   ${tool}(${JSON.stringify(args)})`));

  const { failed, body } = await harness.invoke(tool, args);
  if (failed) {
    console.log(WARN(`   failed: ${body.failed} -- ${body.detail}`));
    console.log(FAINT(`   next step: ${body.next_step}`));
    return;
  }
  console.log(render(body));
}

const indent = (lines: string[]) => lines.map((line) => `   ${line}`).join("\n");

try {
  console.log(BOLD(`\nAgent <-> ${STORE.name} (fixture store, ${orders.length} orders)`));

  const stranded = SPOTLIGHT.strandedPayment;
  const strandedRef = stranded.meta_data!.find((field) => field.key === "_razorpay_payment_id")!
    .value as string;
  const regular = orders.find((order) => order.billing.email && order.status === "completed")!;

  await ask(
    "Is the store actually connected, and what can it see?",
    "store_link_check",
    {},
    (body) =>
      indent([
        `${body.store_url} reachable in ${body.round_trip_ms}ms, signing via ${body.signing}`,
        `${body.orders_visible} orders visible, contacts veiled: ${body.contacts_veiled}`,
        FAINT(`paced at ${body.budget.requests_per_second}/s, burst ${body.budget.burst}`),
      ]),
  );

  await ask(
    "How many payments failed in the last week?",
    "orders_list",
    { state: ["failed"], from: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10), per_page: 5 },
    (body) =>
      indent([
        `${body.matched} failed orders${body.more_pages ? ` (showing ${body.rows.length})` : ""}:`,
        ...body.rows.map(
          (row: any) => `#${row.order_id}  ${RUPEE(row.amount)}  ${row.buyer.name}  ${row.placed_at}`,
        ),
      ]),
  );

  await ask(
    `A shopper says they were charged ${strandedRef} but never got a confirmation.`,
    "order_by_gateway_ref",
    { reference: strandedRef },
    (body) =>
      body.matched
        ? indent([
            `Order #${body.orders[0].order_id} is "${body.orders[0].state}" for ${RUPEE(body.orders[0].money.charged)}.`,
            `The order has no transaction_id, so the money is not linked to it in WooCommerce.`,
            FAINT(`found after reading ${body.orders_inspected} orders`),
          ])
        : indent([`Nothing in the last ${body.window_days} days (conclusive: ${body.conclusive})`]),
  );

  await ask(
    "So why is that order still pending?",
    "order_timeline",
    { order: stranded.id },
    (body) => indent(body.entries.map((entry: any) => `[${entry.at}] ${entry.by}: ${entry.body}`)),
  );

  await ask(
    `What else has ${regular.billing.email} bought?`,
    "orders_search",
    { text: regular.billing.email!, per_page: 5 },
    (body) =>
      indent(
        body.rows.map(
          (row: any) =>
            `#${row.order_id}  ${String(row.state).padEnd(10)} ${RUPEE(row.amount).padStart(12)}  ${row.preview.join(", ")}`,
        ),
      ),
  );

  await ask(
    "What do we need to throw more of this week?",
    "stock_alerts",
    {},
    (body) =>
      indent([
        ...body.alerts.map(
          (alert: any) =>
            `${String(alert.on_hand).padStart(3)}  ${alert.severity === "sold_out" ? WARN("sold out") : "low".padEnd(8)}  ${alert.title} (${alert.sku})`,
        ),
        FAINT(body.caveat),
      ]),
  );

  await ask(
    "Do we have the studio apron in medium?",
    "product_detail",
    { product_id: APRON_ID },
    (body) =>
      indent(
        body.variants.map(
          (variant: any) => `Size ${variant.options.Size}: ${variant.on_hand} on hand (${variant.availability})`,
        ),
      ),
  );

  await ask("Pull up order #404404.", "order_detail", { order: "#404404" }, () => "");

  console.log(`\n${BOLD("And when the store throttles:")} the next two calls are forced to 429, Retry-After 1s.`);
  harness.store.tally.injected.push({ status: 429, retryAfter: "1" }, { status: 429, retryAfter: "1" });
  const startedAt = Date.now();

  await ask(
    "List the three most recent orders.",
    "orders_list",
    { per_page: 3 },
    (body) =>
      indent([
        `Recovered after ${((Date.now() - startedAt) / 1000).toFixed(1)}s and returned ${body.rows.length} orders.`,
        FAINT("The agent never saw the 429s -- they were waited out beneath the tool call."),
      ]),
  );

  console.log();
} finally {
  await harness.close();
}
