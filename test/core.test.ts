import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { StoreFailure, classify, plainText } from "../src/failures.js";
import { briefOrder, fullOrder, veilEmail, veilPhone } from "../src/shape.js";
import { canonicalParams, percentEncode, pickMode } from "../src/signing.js";
import { Throttle } from "../src/throttle.js";
import { cooldownFrom, nextWait } from "../src/transport.js";
import { SPOTLIGHT } from "../fixture/seed.js";

describe("Throttle", () => {
  test("lets the configured burst through at once, then spaces the rest", async () => {
    const throttle = new Throttle(10, 3, 10); // 100ms apart, 3 may run ahead
    const start = Date.now();
    const at: number[] = [];

    await Promise.all(
      Array.from({ length: 6 }, () => throttle.submit(async () => at.push(Date.now() - start))),
    );
    at.sort((a, b) => a - b);

    assert.ok(at[2] < 50, `three should start immediately, third was at ${at[2]}ms`);
    assert.ok(at[5] >= 250, `the rest should be paced ~100ms apart, sixth was at ${at[5]}ms`);
  });

  test("never exceeds the concurrency ceiling", async () => {
    const throttle = new Throttle(1000, 1000, 2);
    let live = 0;
    let highest = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        throttle.submit(async () => {
          highest = Math.max(highest, ++live);
          await new Promise((done) => setTimeout(done, 15));
          live--;
        }),
      ),
    );

    assert.equal(highest, 2);
  });

  test("holdFor stalls every caller, not just the one that was told to wait", async () => {
    const throttle = new Throttle(1000, 1000, 8);
    throttle.holdFor(200);
    const start = Date.now();
    await Promise.all([throttle.submit(async () => 0), throttle.submit(async () => 0)]);
    assert.ok(Date.now() - start >= 190);
  });
});

describe("signing", () => {
  test("percent-encodes the characters encodeURIComponent leaves alone", () => {
    assert.equal(percentEncode("a b!*'()"), "a%20b%21%2A%27%28%29");
  });

  test("canonical params sort by encoded key, then by encoded value", () => {
    const canonical = canonicalParams([
      ["page", "2"],
      ["oauth_nonce", "zz"],
      ["status", "pending"],
      ["status", "failed"],
    ]);
    assert.equal(canonical, "oauth_nonce=zz&page=2&status=failed&status=pending");
  });

  test("auto mode keeps the secret out of the query string when TLS is available", () => {
    assert.equal(pickMode("auto", new URL("https://shop.test")), "header");
    assert.equal(pickMode("auto", new URL("http://shop.test")), "query");
    assert.equal(pickMode("query", new URL("https://shop.test")), "query", "an explicit mode wins");
  });
});

describe("retry arithmetic", () => {
  test("Retry-After is read as seconds, as an HTTP date, and as nonsense", () => {
    assert.equal(cooldownFrom("5"), 5);
    assert.equal(cooldownFrom(null), undefined);
    assert.equal(cooldownFrom(""), undefined);
    assert.equal(cooldownFrom("shortly"), undefined);

    const soon = cooldownFrom(new Date(Date.now() + 10_000).toUTCString())!;
    assert.ok(soon > 8 && soon <= 10, `expected ~10s, got ${soon}`);
  });

  test("backoff grows but stays inside its floor and ceiling", () => {
    let wait = 0;
    const seen: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      wait = nextWait(wait);
      assert.ok(wait >= 400, `never below the floor, got ${wait}`);
      assert.ok(wait <= 30_000, `never above the patience ceiling, got ${wait}`);
      seen.push(wait);
    }
    assert.ok(Math.max(...seen) > 400, "jitter should produce some spread");
  });
});

describe("failures", () => {
  test("WordPress statuses map onto codes the agent can branch on", () => {
    assert.equal(classify(401, { message: "Consumer key is invalid." }).code, "key_rejected");
    assert.equal(classify(403, {}).code, "scope_too_narrow");
    assert.equal(classify(404, {}).code, "missing_resource");
    assert.equal(classify(429, {}).code, "throttled");
    assert.equal(classify(400, {}).code, "bad_parameters");
    assert.equal(classify(503, {}).code, "store_offline");
    assert.equal(classify(418, {}).code, "unreadable_reply");
  });

  test("the agent payload always carries advice, and a cooldown when there is one", () => {
    const payload = classify(429, { message: "Too many requests." }, 7).forAgent();
    assert.equal(payload.failed, "throttled");
    assert.equal(payload.retry_after_seconds, 7);
    assert.ok(payload.next_step.length > 20);

    const plain = new StoreFailure("missing_resource", "nope").forAgent();
    assert.ok(!("retry_after_seconds" in plain));
  });

  test("markup in a store's error message is flattened before the model sees it", () => {
    assert.equal(plainText("<b>Invalid</b>&nbsp;ID.".replace("&nbsp;", " ")), "Invalid ID.");
  });
});

describe("shaping", () => {
  test("contact details keep only what is needed to recognise someone", () => {
    assert.equal(veilEmail("revathi.pillai@example.com"), "r***i@example.com");
    assert.equal(veilEmail("ab@example.com"), "***@example.com", "too short to redact usefully");
    assert.equal(veilEmail(undefined), undefined);
    assert.equal(veilPhone("+91 98765 43210"), "***3210");
    assert.equal(veilPhone("12"), "***");
  });

  test("a brief is small; the detail carries the rest", () => {
    const order = SPOTLIGHT.withCoupon;
    const brief = briefOrder(order, { showContacts: false });
    const detail = fullOrder(order, { showContacts: false });

    assert.ok(brief.preview.length > 0);
    assert.ok(!("lines" in brief), "a brief must not carry line items");
    assert.equal(detail.lines.length, order.line_items.length);
    assert.deepEqual(detail.coupons, ["STUDIO10"]);
    assert.equal(detail.money.charged, order.total);
    assert.ok(Object.keys(brief).length < Object.keys(detail).length);
  });

  test("street lines are withheld by default and restored on request", () => {
    const order = SPOTLIGHT.withCoupon;
    const veiled = fullOrder(order, { showContacts: false });
    const open = fullOrder(order, { showContacts: true });

    assert.equal("street" in veiled.bill_to, false);
    assert.ok(veiled.bill_to.city, "the region is never hidden");
    assert.ok((open.bill_to as { street?: string }).street);
    assert.equal(open.buyer.email, order.billing.email);
  });

  test("a part refund is reported as its own amount, not the order total", () => {
    const detail = fullOrder(SPOTLIGHT.partlyRefunded, { showContacts: false });
    assert.equal(detail.refunds.length, 1);
    assert.ok(Number(detail.money.refunded) > 0);
    assert.ok(Number(detail.money.refunded) < Number(detail.money.charged));
  });
});
