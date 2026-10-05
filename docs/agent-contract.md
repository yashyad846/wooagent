# What the agent can do, and where it has to stop

This connector gives an agent **read-only** sight of a single WooCommerce store.
The list below is the whole of it: if a question is not answerable from orders,
order notes, or products and their stock, this connector cannot answer it.

## Questions it answers

| What someone asks | Tool |
|---|---|
| "How many payments failed this week?" | `orders_list` with `state` and a date range |
| "Find Revathi's order" / "What has this email bought?" | `orders_search` |
| "What was in #2104, was a coupon used, was any of it refunded?" | `order_detail` |
| "Why is this order still pending?" | `order_timeline` |
| "I was charged `pay_…` and nothing happened" | `order_by_gateway_ref` |
| "Which mugs are out of stock?" | `catalog_list` with `availability` |
| "Do we sell a banding wheel?" / "What is SKU CH22-007?" | `catalog_search` |
| "Is the apron in medium?" | `product_detail` |
| "What should we make more of?" | `stock_alerts` |
| "Is this store even connected?" | `store_link_check` |

## Questions it cannot answer

- **Anything that needs a change.** No refund, cancel, edit, restock or note. The
  transport only issues `GET`, and the linking flow rejects a key that could do
  more. When a merchant wants the stuck order advanced, say so and let a human
  do it — or add a narrow, confirmed write tool deliberately, later.
- **Full contact details, by default.** Emails arrive as `r***i@example.com`,
  phones as `***3210`, and street lines are dropped. City, state and postcode
  remain, because support needs to tell two customers apart and answer delivery
  questions. `WC_SHOW_CONTACTS=true` lifts this where a merchant needs it.
- **Anything off these three resources.** No customer records, coupons, reports,
  tax or shipping configuration, webhooks, or other plugins' data, beyond what
  already appears on an order or a product.
- **A second store.** One process, one store, one key.
- **Reliable aggregates.** "Revenue this quarter" means paging the whole order
  history, which is slow and capped. WooCommerce Analytics is the right source;
  say so rather than adding up a partial sweep.

## Failures are instructions

Every tool returns either its JSON result or exactly this shape:

```json
{
  "failed": "throttled",
  "detail": "Too many requests.",
  "next_step": "The store is throttling. Pause, then retry with narrower filters -- avoid full scans.",
  "retry_after_seconds": 7
}
```

`next_step` is written for the model to act on, not for a log. Read it instead of
retrying the same call.

| Code | What it means | What to do |
|---|---|---|
| `store_not_linked` | No key is configured | Ask the merchant to link the store |
| `key_rejected` | The key was refused, usually revoked | Ask the merchant to re-link |
| `scope_too_narrow` | The key cannot see this resource | A `read` key is required |
| `missing_resource` | No such record | Re-check the id, or search instead |
| `bad_parameters` | The store refused the filters | Correct them, then retry |
| `throttled` | The store is rate limiting | Wait `retry_after_seconds`, narrow the query |
| `store_offline` | Unreachable or erroring | Tell the user, suggest later |
| `store_too_slow` | No answer within the timeout | Ask for less: smaller page, tighter dates |
| `unreadable_reply` | Not the JSON expected | Report that the data could not be read; do not guess |

## Edge cases the agent should carry

**A gateway reference lookup is a bounded sweep, not an index.** WooCommerce does
not index `transaction_id` or order meta, so `order_by_gateway_ref` tries search
(cheap, occasionally lucky) and then reads up to `max_pages` × 100 recent orders.
`conclusive: false` means *the sweep ran out of budget* — it is not evidence the
payment does not exist. Either widen `max_pages` or tell the user it could not be
confirmed. Never report an inconclusive sweep as "no such payment".

**Paid but pending is a real state, not a contradiction.** A shopper can be charged
while the order stays `pending`, because the gateway captured the money but the
browser never came back to the store to advance it. In that case the order has
*no* `gateway_ref` of its own — the only trace is in the meta and the note trail.
That is the whole reason `order_by_gateway_ref` and `order_timeline` exist. The
honest answer is "the payment reached the gateway, the store never recorded it
against the order, and a human needs to reconcile it".

**`stock_alerts` cannot see variation stock.** A variable product holds stock on
its variations, so the sweep skips it. "Is the apron in medium?" needs
`product_detail`. A product that does not track stock at all is left out rather
than reported as zero.

**Order numbers are not always order ids.** `order_detail` takes WooCommerce's
internal id. Stores running a sequential-order-number plugin display something
else; put that number through `orders_search` instead.

**Timestamps are store-local.** WooCommerce returns them in the store's own
timezone with no offset. Do not re-interpret them as UTC, and resolve "yesterday"
to a date yourself — the date arguments only take `YYYY-MM-DD`.

**Currency is per order.** Read the `currency` field; nothing here converts.

**Money is a decimal string.** Keep it that way when quoting it back. Parsing it to
a float to re-print is how a total becomes `2419.9999999`.
