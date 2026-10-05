# wc-storefront-reader

An MCP server that gives one agent read-only sight of one WooCommerce store: its
orders, the note trail on those orders, and its catalogue with stock levels. It
speaks stdio MCP, so it drops into any MCP-capable runtime without changes.

It exists because of a specific support conversation. A shopper writes in saying
"my card was charged and nothing happened". Answering that means holding two
facts side by side — what the payment gateway recorded, and what the store thinks
happened — and the store half of that is the half an agent normally cannot see.
A large share of small Indian merchants run exactly this stack, WooCommerce plus
the Razorpay plugin, and the same two or three questions dominate their inbox:
*did my payment go through*, *where is my order*, *is this back in stock*.

```
   agent
     │  stdio MCP
     ▼
  src/tools/*          10 tools, zod-validated arguments, failures as advice
     │
     ▼
  src/store.ts         reads expressed as store questions, not REST calls
     │
     ▼
  src/shape.ts         trim for the model's context, veil buyer contacts
     │
     ▼
  src/transport.ts     the only code that reaches the network; GET only
     │                 ├── src/signing.ts    Basic, or OAuth 1.0a signatures
     │                 └── src/throttle.ts   outbound pacing + concurrency cap
     ▼
  WooCommerce REST API v3
```

## Try it without a WooCommerce install

Needs Node 20.12 or newer.

```bash
npm install
npm test            # 59 tests: tools over real MCP, pacing, signing, linking
npm run demo        # the support questions above, answered end to end
```

`npm run demo` is the fastest way to see what this does. It prints each
question, the tool call an agent would make, and the answer — including a payment
that arrived against an order still marked pending, a lookup that fails on
purpose, and a store that throttles mid-conversation.

To poke at it by hand:

```bash
npm run fixture     # terminal 1: Clayhouse Ceramics on :4455
cp .env.example .env
npx @modelcontextprotocol/inspector npx tsx src/main.ts   # terminal 2
```

### What the fixture store is, and is not

`fixture/` is a stand-in WooCommerce store — a fictional pottery studio, with
invented people, invented payment references and nothing real anywhere in it. It
is faithful about what the connector depends on and nothing else: the
`/wp-json/wc/v3` routes and payload shapes, `X-WP-Total` paging headers, both
credential styles including real OAuth 1.0a signature verification,
WordPress-shaped error bodies, the `/wc-auth/v1/authorize` approval flow and its
HTTPS requirement, and a throttle that answers `429` with `Retry-After`.

It is not WooCommerce. Everything here was developed and tested against the
fixture; before a merchant relies on it, run `npm run link-store` against their real
store and make a handful of calls.

## Getting a key

Both routes end with a key whose permission is `read`. Nothing else is accepted.

**The approval flow** — WooCommerce's own `/wc-auth/v1/authorize` endpoint, which
means the merchant never pastes a secret anywhere:

```bash
npm run link-store -- --store http://localhost:4455                  # the fixture
npm run link-store -- --store https://shop.example.com \
                      --callback https://<tunnel>/grant        # a real store
```

1. The CLI starts a local callback listener and prints an authorize URL carrying
   `scope=read` and a 128-bit random challenge.
2. The merchant opens it signed in as an admin and clicks **Approve**.
3. WooCommerce mints a key and POSTs it back. The connector checks the challenge
   came back unchanged (so a forged POST is not mistaken for the real one) and
   that the permission is exactly `read` (so an admin who picked the wrong option
   does not hand over write access), then writes it to `.store-key.json` at mode
   `0600`.

A live store only posts keys to an **HTTPS** callback, so expose the local port
through a tunnel and pass `--callback`. In production that callback belongs on a
server, not a laptop.

**Or paste a key** — *WooCommerce → Settings → Advanced → REST API → Add key*,
permission **Read**, then set `WC_CONSUMER_KEY` and `WC_CONSUMER_SECRET`.

On the wire, with `WC_SIGNING=auto`: HTTP Basic for `https://` stores, one-legged
OAuth 1.0a HMAC-SHA256 signatures for `http://` ones. That split is WooCommerce's
rule, not a preference — Basic over plain HTTP would put the secret in clear text.

## Not flooding the merchant's store

WooCommerce core has no rate limit. Merchant hosts, CDNs and WAFs do, and shared
hosting falls over under a burst from an agent that fires six tool calls at once.
So:

- **Outbound pacing** via a virtual-scheduling clock (`WC_RPS`, `WC_BURST`) plus a
  **concurrency ceiling** (`WC_CONCURRENCY`). A burst is allowed, then requests are
  spaced exactly.
- **Retries** on `429`, `502`, `503`, `504`, timeouts and connection failures, with
  decorrelated jitter so simultaneous retries do not re-converge.
- **`Retry-After` is obeyed**, as seconds or as an HTTP date. A `429` holds the
  whole client, not just the one call that collected it.
- **A ceiling on patience.** If the store wants more than 30 seconds, the tool
  returns `throttled` with `retry_after_seconds` rather than stalling the
  conversation. The agent can say "the store is busy, try in a minute".
- **Sweeps are bounded.** The two tools that scan have hard page caps and report
  `conclusive: false` when they hit one, so "I did not find it" is never confused
  with "it is not there".

## The tools

| Tool | What it answers |
|---|---|
| `orders_list` | Orders by state, date range, account or product; paged |
| `orders_search` | Free text: buyer name, email, phone, address, product name |
| `order_detail` | One order whole: lines, totals, coupons, refunds, addresses |
| `order_timeline` | The note trail, including what the gateway reported |
| `order_by_gateway_ref` | A `pay_…` / `order_…` reference → the order it belongs to |
| `catalog_list` | Published products by stock state, category or type |
| `catalog_search` | By text, or by exact SKU |
| `product_detail` | One product, with each variant's own stock |
| `stock_alerts` | Everything sold out or below its reorder level |
| `store_link_check` | Is this store reachable, and how is the connector set up |

The generated contract — names, descriptions, JSON Schemas, annotations, taken
from the running server — is in [`docs/tool-spec.json`](docs/tool-spec.json)
(`npm run spec`). What the agent can and cannot do, and the edge cases it should
know about, is in [`docs/agent-contract.md`](docs/agent-contract.md).

### Two things worth knowing about the design

**Every tool returns JSON or advice, never an exception.** A failure comes back as
`{ "failed": "<code>", "detail": "...", "next_step": "..." }`, where `next_step` is
written for the model: *re-check the id, or use a search tool instead*. Codes are
`store_not_linked`, `key_rejected`, `scope_too_narrow`, `missing_resource`,
`bad_parameters`, `throttled`, `store_offline`, `store_too_slow`,
`unreadable_reply`.

**Lists carry a brief; details carry everything.** A raw WooCommerce order is
several kilobytes of mostly empty fields, and the model pays for every token. So
`orders_list` returns a summary with a line-item preview, and `order_detail`
returns the rest. Buyer emails and phones arrive partly veiled and street
addresses are dropped; city and postcode stay, because support needs to tell two
customers apart. `WC_SHOW_CONTACTS=true` lifts that for merchants who need it.

## Wiring it into a client

```bash
npm run build
```

```json
{
  "mcpServers": {
    "clayhouse": {
      "command": "node",
      "args": ["/absolute/path/to/wc-storefront-reader/dist/src/main.js"],
      "env": {
        "WC_STORE_URL": "https://shop.example.com",
        "WC_CONSUMER_KEY": "ck_...",
        "WC_CONSUMER_SECRET": "cs_..."
      }
    }
  }
}
```

Every setting is in [`.env.example`](.env.example). `.env` and `.store-key.json`
are git-ignored.

## Layout

```
src/main.ts         MCP server entry point and the model's briefing
src/tools/          tool definitions: shared schemas, orders, catalogue
src/store.ts        store reads, paging, the two bounded sweeps
src/shape.ts        context trimming and contact veiling
src/transport.ts    HTTP: signing, retries, Retry-After, timeouts
src/throttle.ts     outbound pacing and the concurrency ceiling
src/signing.ts      Basic and OAuth 1.0a
src/failures.ts     failure codes and the advice attached to each
src/settings.ts     environment and stored-key loading
src/link.ts         the /wc-auth approval flow
src/wc-schema.ts    the slice of WooCommerce's payloads that is read
fixture/            stand-in store, seed data, and the MCP test harness
test/               node:test suites
scripts/            the demo walkthrough, tool-spec generation
```

## What it assumes

- WooCommerce 3.5+, REST API v3, pretty permalinks on so `/wp-json/` resolves.
  A store on `?rest_route=` URLs is not supported; it reports `unreadable_reply`
  with a hint rather than failing silently.
- One process serves one store. Multi-tenant hosting is out of scope.
- Gateways record their reference in `transaction_id` or in order meta, which is
  what the Razorpay plugin and most others do. Matching is on the *value*, not a
  meta key name, so no plugin's naming is baked in — the `_razorpay_*` keys in
  the fixture are illustrative.

## Where it stops

- **Read-only by design.** There is no write tool, and the linking flow refuses a
  key that could write. If the merchant needs the stuck order moved to
  processing, a human does that.
- `order_by_gateway_ref` and `stock_alerts` sweep with page caps. On a store with
  tens of thousands of orders they can come back inconclusive, and they say so.
- `stock_alerts` does not reach per-variation stock; `product_detail` does.
- No caching. Every tool call is a live read.
- Pacing state is per process, so two processes against one store do not
  coordinate.
- The key lives in a local file or the environment.

## If this were going to production

- **Hosted and multi-tenant**: the callback on a real backend, keys in a secrets
  manager per merchant, per-merchant pacing in Redis, and revocation handled —
  a `401` marks the connection broken and prompts the merchant to re-link
  rather than retrying into a wall.
- **Webhooks instead of sweeps**: subscribe to `order.updated` and
  `product.updated`, keep a small index of gateway reference → order and a
  low-stock set. Both sweeps become instant lookups and stop loading the store.
- **A few narrow write tools**, each one confirmed by a human and logged: add a
  private note; move a paid-but-pending order to processing *after* verifying the
  payment against the gateway's own API.
- **Cross-check the gateway.** For the paid-but-pending case this connector can
  only report what the store believes. Confirming against Razorpay's Payments API
  is what turns that into an answer.
- **Observability** per merchant: tool latency, failure codes, `429` rate.
