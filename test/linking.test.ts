import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startFixtureStore } from "../fixture/store.js";
import { authorizeUrl, judgeGrant, linkStore } from "../src/link.js";
import { StoreReader } from "../src/store.js";

let store: Awaited<ReturnType<typeof startFixtureStore>>;
const scratch = mkdtempSync(join(tmpdir(), "clayhouse-link-"));

/** Plays the store admin: opens the approval page, then submits the form. */
async function approve(url: string, meddle: (form: URLSearchParams) => void = () => {}) {
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /wants to connect/i);

  const form = new URL(url).searchParams;
  meddle(form);

  return fetch(`${store.url}/wc-auth/v1/access_granted`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
}

describe("judgeGrant", () => {
  const nonce = "a".repeat(32);
  const base = {
    user_id: nonce,
    consumer_key: "ck_x",
    consumer_secret: "cs_x",
    key_permissions: "read",
    key_id: 3,
  };

  test("accepts a read-only grant that answers the challenge", () => {
    const verdict = judgeGrant(base, nonce, "http://shop.test/");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.key.store_url, "http://shop.test", "the trailing slash is normalised away");
  });

  test("a mismatched challenge is rejected but does not end the flow", () => {
    const verdict = judgeGrant({ ...base, user_id: "b".repeat(32) }, nonce, "http://shop.test");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.fatal, false, "keep waiting for the real callback");
  });

  test("a grant with more than read access ends the flow", () => {
    const verdict = judgeGrant({ ...base, key_permissions: "read_write" }, nonce, "http://shop.test");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.fatal, true);
  });

  test("a callback carrying no key is rejected", () => {
    const verdict = judgeGrant({ user_id: nonce, key_permissions: "read" }, nonce, "http://shop.test");
    assert.equal(verdict.ok, false);
  });
});

describe("linking a store through /wc-auth/v1/authorize", () => {
  before(async () => {
    store = await startFixtureStore();
  });
  after(async () => store.close());

  test("the authorize URL never asks for more than read", () => {
    const url = new URL(authorizeUrl("https://shop.test/", "abc", "https://cb.test/grant", "https://cb.test/linked", "Tester"));
    assert.equal(url.pathname, "/wc-auth/v1/authorize");
    assert.equal(url.searchParams.get("scope"), "read");
    assert.equal(url.searchParams.get("app_name"), "Tester");
  });

  test("approval yields a read-only key that works against the API", async () => {
    const keyFile = join(scratch, "granted.json");
    let submitted: Promise<Response> | undefined;

    const key = await linkStore({
      storeUrl: store.url,
      port: 14466,
      keyFile,
      waitMs: 10_000,
      announce: (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("scope"), "read");
        assert.match(parsed.searchParams.get("user_id")!, /^[0-9a-f]{32}$/, "the challenge must be unguessable");
        submitted = approve(url);
      },
    });

    const redirect = await submitted!;
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location")!, /\/linked\?success=1/);

    assert.equal(key.scope, "read");
    const onDisk = JSON.parse(readFileSync(keyFile, "utf8"));
    assert.equal(onDisk.consumer_key, key.consumer_key);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600, "a secret must not be world-readable");

    // The real proof: the key the merchant just granted can actually read orders.
    const reader = new StoreReader({
      storeUrl: store.url,
      apiKey: { key: key.consumer_key, secret: key.consumer_secret },
      signing: "auto",
      budget: { rps: 20, burst: 20, concurrency: 2, retries: 0, timeoutMs: 5000 },
      showContacts: false,
    });
    const listed = await reader.orders({ per_page: 2 });
    assert.equal(listed.rows.length, 2);
  });

  test("a key granted with write access is refused and not written to disk", async () => {
    const keyFile = join(scratch, "overscoped.json");

    await assert.rejects(
      linkStore({
        storeUrl: store.url,
        port: 14467,
        keyFile,
        waitMs: 10_000,
        announce: (url) => void approve(url, (form) => form.set("scope", "read_write")),
      }),
      /only accepts read-only keys/,
    );

    assert.throws(() => statSync(keyFile), /ENOENT/, "nothing should have been saved");
  });

  test("a forged callback is ignored rather than trusted", async () => {
    const attempt = linkStore({
      storeUrl: store.url,
      port: 14468,
      keyFile: join(scratch, "forged.json"),
      waitMs: 1500,
      announce: async () => {
        const forged = await fetch("http://localhost:14468/grant", {
          method: "POST",
          body: JSON.stringify({
            user_id: "whoever-is-guessing",
            consumer_key: "ck_attacker",
            consumer_secret: "cs_attacker",
            key_permissions: "read",
            key_id: 99,
          }),
        });
        assert.equal(forged.status, 400);
      },
    });

    await assert.rejects(attempt, /gave up waiting/);
  });

  test("the store will not post a key to a plaintext callback off-box", async () => {
    const refused = await fetch(
      `${store.url}/wc-auth/v1/authorize?app_name=x&scope=read&user_id=1` +
        `&return_url=http://a.test/&callback_url=http://somewhere-else.test/grant`,
    );
    assert.equal(refused.status, 400);
    const body = (await refused.json()) as { code?: string };
    assert.equal(body.code, "woocommerce_rest_invalid_callback");
  });

  test("an unknown scope is rejected before an admin ever sees a button", async () => {
    const refused = await fetch(
      `${store.url}/wc-auth/v1/authorize?app_name=x&scope=everything&user_id=1` +
        `&return_url=http://localhost/&callback_url=http://localhost/grant`,
    );
    assert.equal(refused.status, 400);
  });
});
