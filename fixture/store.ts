import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { WcOrder, WcProduct } from "../src/wc-schema.js";
import { APRON_ID, STORE, notes, orders, products, storeSettings, variants } from "./seed.js";

/**
 * A stand-in WooCommerce store, enough of one to develop and test the connector
 * against without installing WordPress.
 *
 * It is faithful about the things the connector depends on, and nothing else:
 *   - the /wp-json/wc/v3 routes and payload shapes it reads
 *   - X-WP-Total and X-WP-TotalPages paging headers
 *   - both credential styles, including real OAuth 1.0a signature verification
 *   - WordPress-shaped error bodies, with the codes WooCommerce actually sends
 *   - the /wc-auth/v1/authorize approval flow, including its HTTPS requirement
 *   - throttling, because merchant hosts throttle even though WooCommerce does not
 *
 * It is not WooCommerce. Anything built on it should be confirmed against a real
 * store before a merchant relies on it.
 */

export const FIXTURE_KEY = "ck_fixture_8d41b0c2a97e5f36104b7e2d";
export const FIXTURE_SECRET = "cs_fixture_52a9f7e01c6b4d83ea5f90b7";

export type Scope = "read" | "write" | "read_write";

export interface FixtureOptions {
  port?: number;
  keys?: Record<string, { secret: string; scope: Scope }>;
  /** Sliding-window cap on API calls, standing in for a host, CDN or WAF. */
  throttle?: { calls: number; windowMs: number };
  verbose?: boolean;
}

/** Replies the fixture is told to fail with, one per entry, in order. */
export interface Injected {
  status: number;
  retryAfter?: string;
}

export interface Tally {
  injected: Injected[];
  apiCalls: number;
  throttled: number;
}

class Wp extends Error {
  constructor(
    readonly status: number,
    readonly wpCode: string,
    message: string,
    readonly extraHeaders: Record<string, string> = {},
  ) {
    super(message);
  }
}

const strictEncode = (raw: string) =>
  encodeURIComponent(raw).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

const SIGNATURE_WINDOW_SECONDS = 15 * 60;

/** The verifying half of what src/signing.ts produces. */
function checkSignature(method: string, url: URL, secret: string): void {
  const received = Object.fromEntries(url.searchParams);
  const offered = received.oauth_signature;
  delete received.oauth_signature;

  const algorithm = received.oauth_signature_method;
  if (algorithm !== "HMAC-SHA256" && algorithm !== "HMAC-SHA1") {
    throw new Wp(401, "woocommerce_rest_authentication_error", "Invalid signature method.");
  }
  const drift = Math.abs(Date.now() / 1000 - Number(received.oauth_timestamp));
  if (!Number.isFinite(drift) || drift > SIGNATURE_WINDOW_SECONDS) {
    throw new Wp(401, "woocommerce_rest_authentication_error", "Invalid timestamp.");
  }

  const canonical = Object.entries(received)
    .map(([name, value]) => [strictEncode(name), strictEncode(value)] as const)
    .sort(([an, av], [bn, bv]) => (an !== bn ? (an < bn ? -1 : 1) : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  const base = [
    method.toUpperCase(),
    strictEncode(`${url.protocol}//${url.host}${url.pathname}`),
    strictEncode(canonical),
  ].join("&");

  const expected = createHmac(algorithm === "HMAC-SHA1" ? "sha1" : "sha256", `${secret}&`)
    .update(base)
    .digest("base64");

  const mine = Buffer.from(expected);
  const theirs = Buffer.from(offered ?? "");
  if (mine.length !== theirs.length || !timingSafeEqual(mine, theirs)) {
    throw new Wp(
      401,
      "woocommerce_rest_authentication_error",
      "Invalid signature - provided signature does not match.",
    );
  }
}

const csv = (raw: string | null) =>
  raw ? raw.split(",").map((part) => part.trim()).filter(Boolean) : [];

function slice<T>(rows: T[], url: URL, res: ServerResponse): T[] {
  const perPage = Number(url.searchParams.get("per_page") ?? 10);
  const page = Number(url.searchParams.get("page") ?? 1);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new Wp(400, "rest_invalid_param", "Invalid parameter(s): per_page");
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new Wp(400, "rest_invalid_param", "Invalid parameter(s): page");
  }
  res.setHeader("X-WP-Total", String(rows.length));
  res.setHeader("X-WP-TotalPages", String(Math.max(1, Math.ceil(rows.length / perPage))));
  return rows.slice((page - 1) * perPage, page * perPage);
}

function ordered<T>(rows: T[], url: URL, keys: Record<string, (row: T) => string | number>, fallback: string): T[] {
  const read = keys[url.searchParams.get("orderby") ?? fallback] ?? keys[fallback];
  const sign = url.searchParams.get("order") === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = read(a);
    const right = read(b);
    return left > right ? sign : left < right ? -sign : 0;
  });
}

function selectOrders(url: URL): WcOrder[] {
  const q = url.searchParams;
  const states = csv(q.get("status")).filter((state) => state !== "any");
  const text = q.get("search")?.toLowerCase();

  const kept = orders.filter((order) => {
    if (states.length && !states.includes(order.status)) return false;
    if (q.get("after") && order.date_created < q.get("after")!) return false;
    if (q.get("before") && order.date_created > q.get("before")!) return false;
    if (q.get("modified_after") && (order.date_modified ?? "") < q.get("modified_after")!) return false;
    if (q.get("customer") && order.customer_id !== Number(q.get("customer"))) return false;
    if (q.get("product") && !order.line_items.some((line) => line.product_id === Number(q.get("product")))) {
      return false;
    }
    if (text) {
      // WooCommerce indexes the buyer and the line items -- and notably not
      // transaction_id or order meta, which is the whole reason the connector
      // has to sweep for gateway references.
      const { billing } = order;
      const haystack = [
        String(order.id),
        billing.first_name,
        billing.last_name,
        billing.email,
        billing.phone,
        billing.city,
        billing.address_1,
        ...order.line_items.map((line) => line.name),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });

  return ordered(kept, url, { date: (o) => o.date_created, id: (o) => o.id }, "date");
}

function selectProducts(url: URL): WcProduct[] {
  const q = url.searchParams;
  const status = q.get("status") ?? "any";
  const text = q.get("search")?.toLowerCase();
  const skus = csv(q.get("sku"));

  const kept = products.filter((product) => {
    if (status !== "any" && product.status !== status) return false;
    if (q.get("stock_status") && product.stock_status !== q.get("stock_status")) return false;
    if (q.get("type") && product.type !== q.get("type")) return false;
    if (q.get("category") && !product.categories?.some((term) => term.id === Number(q.get("category")))) {
      return false;
    }
    if (skus.length && !skus.includes(product.sku)) return false;
    if (text && !`${product.name} ${product.short_description ?? ""}`.toLowerCase().includes(text)) return false;
    return true;
  });

  return ordered(
    kept,
    url,
    {
      date: (p) => p.date_modified ?? "",
      id: (p) => p.id,
      title: (p) => p.name,
      price: (p) => Number(p.price),
      popularity: (p) => -p.id,
    },
    "date",
  );
}

type Handler = (match: RegExpMatchArray, url: URL, res: ServerResponse) => unknown;

const ROUTES: Array<[RegExp, Handler]> = [
  [/^\/orders$/, (_m, url, res) => slice(selectOrders(url), url, res)],
  [
    /^\/orders\/(\d+)$/,
    (m) => {
      const found = orders.find((order) => order.id === Number(m[1]));
      if (!found) throw new Wp(404, "woocommerce_rest_shop_order_invalid_id", "Invalid ID.");
      return found;
    },
  ],
  [
    /^\/orders\/(\d+)\/notes$/,
    (m) => {
      const trail = notes.get(Number(m[1]));
      if (!trail) throw new Wp(404, "woocommerce_rest_order_invalid_id", "Invalid order ID.");
      return trail;
    },
  ],
  [/^\/products$/, (_m, url, res) => slice(selectProducts(url), url, res)],
  [
    /^\/products\/(\d+)$/,
    (m) => {
      const found = products.find((product) => product.id === Number(m[1]));
      if (!found) throw new Wp(404, "woocommerce_rest_product_invalid_id", "Invalid ID.");
      return found;
    },
  ],
  [
    /^\/products\/(\d+)\/variations$/,
    (m, url, res) => slice(variants.get(Number(m[1])) ?? [], url, res),
  ],
  [
    /^\/settings\/products\/([\w-]+)$/,
    (m) => {
      const value = storeSettings[m[1]];
      if (value === undefined) throw new Wp(404, "rest_setting_setting_invalid", "Invalid setting.");
      return { id: m[1], value };
    },
  ],
];

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font:16px/1.55 ui-sans-serif,system-ui;max-width:32rem;margin:3.5rem auto;padding:0 1rem;color:#1b1917}` +
  `button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#8a4b2a;color:#fff;cursor:pointer}` +
  `code{background:#f3efe9;padding:.1rem .3rem;border-radius:.2rem}</style></head><body>${body}</body></html>`;

export interface Fixture {
  url: string;
  tally: Tally;
  keys: Map<string, { secret: string; scope: Scope }>;
  close: () => Promise<void>;
}

export function startFixtureStore(options: FixtureOptions = {}): Promise<Fixture> {
  const keys = new Map(
    Object.entries(options.keys ?? { [FIXTURE_KEY]: { secret: FIXTURE_SECRET, scope: "read" as Scope } }),
  );
  const tally: Tally = { injected: [], apiCalls: 0, throttled: 0 };

  /** Sliding window: timestamps of recent calls, trimmed on each request. */
  const recent: number[] = [];

  function identify(req: IncomingMessage, url: URL): void {
    const header = req.headers.authorization;
    if (header?.startsWith("Basic ")) {
      const [consumerKey, consumerSecret] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
      const entry = keys.get(consumerKey ?? "");
      if (!entry || entry.secret !== consumerSecret) {
        throw new Wp(401, "woocommerce_rest_authentication_error", "Consumer secret is invalid.");
      }
      return;
    }
    if (url.searchParams.has("oauth_consumer_key")) {
      const consumerKey = url.searchParams.get("oauth_consumer_key")!;
      const entry = keys.get(consumerKey);
      if (!entry) throw new Wp(401, "woocommerce_rest_authentication_error", "Consumer key is invalid.");
      checkSignature("GET", url, entry.secret);
      return;
    }
    throw new Wp(401, "woocommerce_rest_cannot_view", "Sorry, you cannot list resources.");
  }

  function gatekeep(): void {
    const forced = tally.injected.shift();
    if (forced) {
      if (forced.status === 429) tally.throttled++;
      throw new Wp(
        forced.status,
        forced.status === 429 ? "too_many_requests" : "service_unavailable",
        "Injected failure from the fixture store.",
        forced.retryAfter ? { "Retry-After": forced.retryAfter } : {},
      );
    }

    const limit = options.throttle;
    if (!limit) return;

    const now = Date.now();
    while (recent.length > 0 && now - recent[0] >= limit.windowMs) recent.shift();
    if (recent.length >= limit.calls) {
      tally.throttled++;
      const freesUpIn = limit.windowMs - (now - recent[0]);
      throw new Wp(429, "too_many_requests", "Too many requests.", {
        "Retry-After": String(Math.max(1, Math.ceil(freesUpIn / 1000))),
      });
    }
    recent.push(now);
  }

  function serveApi(req: IncomingMessage, url: URL, res: ServerResponse): unknown {
    tally.apiCalls++;
    gatekeep();
    identify(req, url);
    if (req.method !== "GET") {
      throw new Wp(405, "rest_no_route", "This fixture serves read endpoints only.");
    }

    const path = url.pathname.replace("/wp-json/wc/v3", "");
    for (const [pattern, handle] of ROUTES) {
      const match = path.match(pattern);
      if (match) return handle(match, url, res);
    }
    throw new Wp(404, "rest_no_route", "No route was found matching the URL and request method.");
  }

  async function serveAuthorize(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      const given = url.searchParams;
      for (const required of ["app_name", "scope", "user_id", "return_url", "callback_url"]) {
        if (!given.get(required)) {
          throw new Wp(400, "woocommerce_rest_missing_param", `Missing parameter ${required}`);
        }
      }
      if (!["read", "write", "read_write"].includes(given.get("scope")!)) {
        throw new Wp(400, "woocommerce_rest_invalid_scope", "Invalid scope.");
      }
      // Real WooCommerce will not hand a key to a plaintext endpoint off-box.
      const callback = new URL(given.get("callback_url")!);
      if (callback.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(callback.hostname)) {
        throw new Wp(400, "woocommerce_rest_invalid_callback", "The callback_url needs to be over SSL.");
      }

      const carried = [...given]
        .map(([name, value]) => `<input type="hidden" name="${name}" value="${value.replace(/"/g, "&quot;")}">`)
        .join("");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        shell(
          "Authorise application",
          `<h2><b>${given.get("app_name")}</b> wants to connect to ${STORE.name}</h2>` +
            `<p>Requested access: <code>${given.get("scope")}</code> &mdash; orders, products and settings.</p>` +
            `<p>Signed in as <b>studio admin</b> (fixture).</p>` +
            `<form method="post" action="/wc-auth/v1/access_granted">${carried}<button>Approve</button></form>`,
        ),
      );
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;
    const form = new URLSearchParams(raw);
    const scope = (form.get("scope") ?? "read") as Scope;

    const consumerKey = `ck_${randomBytes(20).toString("hex")}`;
    const consumerSecret = `cs_${randomBytes(20).toString("hex")}`;
    keys.set(consumerKey, { secret: consumerSecret, scope });

    const delivered = await fetch(form.get("callback_url")!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key_id: keys.size,
        user_id: form.get("user_id"),
        consumer_key: consumerKey,
        consumer_secret: consumerSecret,
        key_permissions: scope,
      }),
    });

    if (!delivered.ok) {
      // WooCommerce discards a key the application would not accept.
      keys.delete(consumerKey);
      throw new Wp(400, "woocommerce_rest_callback_failed", `Callback replied ${delivered.status}.`);
    }

    const back = new URL(form.get("return_url")!);
    back.searchParams.set("success", "1");
    back.searchParams.set("user_id", form.get("user_id")!);
    res.writeHead(302, { Location: back.toString() }).end();
  }

  const listener = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const startedAt = Date.now();

    void (async () => {
      try {
        if (url.pathname.startsWith("/wp-json/wc/v3/")) {
          const payload = JSON.stringify(serveApi(req, url, res));
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(payload);
        } else if (url.pathname.startsWith("/wc-auth/v1/")) {
          await serveAuthorize(req, url, res);
        } else if (url.pathname === "/") {
          res
            .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            .end(shell(STORE.name, `<h2>${STORE.name}</h2><p>Fixture WooCommerce store. Nothing here is real.</p>`));
        } else {
          throw new Wp(404, "rest_no_route", "Not found.");
        }
      } catch (thrown) {
        const failure =
          thrown instanceof Wp ? thrown : new Wp(500, "internal_server_error", (thrown as Error).message);
        res
          .writeHead(failure.status, { "Content-Type": "application/json; charset=utf-8", ...failure.extraHeaders })
          .end(
            JSON.stringify({
              code: failure.wpCode,
              message: failure.message,
              data: { status: failure.status },
            }),
          );
      } finally {
        if (options.verbose) {
          const shown = [...url.searchParams.entries()]
            .filter(([name]) => !name.startsWith("oauth_"))
            .map(([name, value]) => `${name}=${value}`)
            .join("&");
          console.log(
            `${req.method} ${url.pathname}${shown ? `?${shown}` : ""} -> ${res.statusCode} (${Date.now() - startedAt}ms)`,
          );
        }
      }
    })();
  });

  return new Promise((ready) => {
    listener.listen(options.port ?? 0, () => {
      const { port } = listener.address() as AddressInfo;
      ready({
        url: `http://localhost:${port}`,
        tally,
        keys,
        close: () => new Promise<void>((done) => listener.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FIXTURE_PORT ?? 4455);
  void startFixtureStore({
    port,
    verbose: true,
    throttle: { calls: 30, windowMs: 10_000 },
  }).then(({ url }) => {
    console.log(`${STORE.name} (fixture WooCommerce store) at ${url}`);
    console.log(`  read-only key : ${FIXTURE_KEY}`);
    console.log(`  secret        : ${FIXTURE_SECRET}`);
    console.log(`  catalogue     : ${products.length} products, variable apron is id ${APRON_ID}`);
    console.log(`  orders        : ${orders.length}`);
    console.log("  throttle      : 30 calls / 10s sliding window, 429 with Retry-After");
  });
}
