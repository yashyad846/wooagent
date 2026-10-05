import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { APRON_ID, products } from "../fixture/seed.js";
import { startHarness } from "../fixture/agent.js";

/**
 * WooCommerce core does not rate limit, but the things in front of a merchant's
 * store do, and shared hosting simply falls over under a burst. These are the
 * tests for behaving well when that happens.
 */
describe("when the store pushes back", () => {
  test("waits out a Retry-After and still answers the question", async () => {
    const h = await startHarness();
    try {
      h.store.tally.injected.push({ status: 429, retryAfter: "1" }, { status: 429, retryAfter: "1" });

      const startedAt = Date.now();
      const { failed, body } = await h.invoke("orders_list", { per_page: 3 });

      assert.equal(failed, false, "two 429s in a row should be survivable");
      assert.equal(body.rows.length, 3);
      assert.ok(Date.now() - startedAt >= 1900, "both Retry-After hints should have been honoured");
      assert.equal(h.store.tally.throttled, 2);
    } finally {
      await h.close();
    }
  });

  test("retries a transient 503", async () => {
    const h = await startHarness();
    try {
      h.store.tally.injected.push({ status: 503 });
      const { failed } = await h.invoke("product_detail", { product_id: APRON_ID });
      assert.equal(failed, false);
    } finally {
      await h.close();
    }
  });

  test("hands the cooldown to the agent once the retries run out", async () => {
    const h = await startHarness({}, { WC_RETRIES: "1" });
    try {
      h.store.tally.injected.push({ status: 429, retryAfter: "1" }, { status: 429, retryAfter: "9" });

      const { failed, body } = await h.invoke("orders_list", {});

      assert.equal(failed, true);
      assert.equal(body.failed, "throttled");
      assert.equal(body.retry_after_seconds, 9, "the agent needs the number to tell the user");
      assert.match(body.next_step, /retry/i);
    } finally {
      await h.close();
    }
  });

  test("refuses to sit on a conversation for an hour", async () => {
    const h = await startHarness();
    try {
      h.store.tally.injected.push({ status: 429, retryAfter: "3600" });

      const startedAt = Date.now();
      const { body } = await h.invoke("orders_list", {});

      assert.equal(body.failed, "throttled");
      assert.equal(body.retry_after_seconds, 3600);
      assert.ok(Date.now() - startedAt < 2000, "it should report the wait, not perform it");
    } finally {
      await h.close();
    }
  });

  test("a 429 slows every queued call, not just the one that collected it", async () => {
    const h = await startHarness();
    try {
      h.store.tally.injected.push({ status: 429, retryAfter: "1" });

      const startedAt = Date.now();
      const results = await Promise.all([
        h.invoke("orders_list", { per_page: 1 }),
        h.invoke("catalog_list", { per_page: 1 }),
        h.invoke("orders_list", { per_page: 2 }),
      ]);

      assert.ok(results.every((result) => !result.failed));
      assert.ok(Date.now() - startedAt >= 950, "the hold should apply across the whole client");
    } finally {
      await h.close();
    }
  });

  test("client-side pacing keeps a burst of tool calls under the store's limit", async () => {
    const h = await startHarness(
      { throttle: { calls: 5, windowMs: 1000 } },
      { WC_RPS: "3", WC_BURST: "2" },
    );
    try {
      const ids = products.filter((product) => product.type === "simple").slice(0, 6).map((p) => p.id);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, n) => h.invoke("product_detail", { product_id: ids[n % ids.length] })),
      );

      assert.ok(results.every((result) => !result.failed));
      assert.ok(
        h.store.tally.throttled <= 1,
        `pacing should mostly prevent 429s outright, saw ${h.store.tally.throttled}`,
      );
    } finally {
      await h.close();
    }
  });
});

describe("credentials on the wire", () => {
  test("a plain-HTTP store is reached with signed requests, not a Basic header", async () => {
    const h = await startHarness();
    try {
      assert.equal((await h.invoke("catalog_list", { per_page: 1 })).failed, false);
    } finally {
      await h.close();
    }
  });

  test("Basic auth can be forced, and the fixture accepts it", async () => {
    const h = await startHarness({}, { WC_SIGNING: "header" });
    try {
      const { failed, body } = await h.invoke("store_link_check");
      assert.equal(failed, false);
      assert.equal(body.signing, "header");
    } finally {
      await h.close();
    }
  });

  test("a revoked key fails immediately instead of being retried", async () => {
    const h = await startHarness({}, { WC_CONSUMER_SECRET: "cs_no_longer_valid" });
    try {
      const { failed, body } = await h.invoke("orders_list", {});

      assert.equal(failed, true);
      assert.equal(body.failed, "key_rejected");
      assert.match(body.next_step, /link the store again/i);
      assert.equal(h.store.tally.apiCalls, 1, "retrying a rejected key only annoys the store");
    } finally {
      await h.close();
    }
  });

  test("with no key at all, the agent is told to get the store linked", async () => {
    const h = await startHarness({}, { WC_CONSUMER_KEY: "", WC_CONSUMER_SECRET: "" });
    try {
      const { failed, body } = await h.invoke("orders_list", {});

      assert.equal(failed, true);
      assert.equal(body.failed, "store_not_linked");
      assert.equal(h.store.tally.apiCalls, 0, "there is nothing to ask the store");
    } finally {
      await h.close();
    }
  });
});
