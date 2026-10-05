import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StoreReader } from "../store.js";
import { READ_ONLY, orderArgs, orderRef, reply, toOrderId } from "./shared.js";

export function registerOrderTools(server: McpServer, store: StoreReader): void {
  server.registerTool(
    "orders_list",
    {
      title: "List orders",
      description:
        "Browse the store's orders, newest first, narrowed by state, date range, account or product. " +
        "Each row is a brief: state, amount, gateway and its reference, plus the buyer's name and veiled contact. " +
        "Call order_detail when you need line items, addresses, refunds or totals.",
      inputSchema: orderArgs,
      annotations: READ_ONLY,
    },
    (args) => reply(() => store.orders(args)),
  );

  server.registerTool(
    "orders_search",
    {
      title: "Search orders",
      description:
        "Free-text search over orders: buyer name, email, phone, address, or a product's name. " +
        "Reach for this when someone contacts support and all you have is who they are. " +
        "It will NOT find gateway references such as pay_... -- use order_by_gateway_ref for those.",
      inputSchema: {
        text: z.string().trim().min(2).describe("What to look for, e.g. an email address or a surname."),
        ...orderArgs,
      },
      annotations: READ_ONLY,
    },
    ({ text, ...rest }) => reply(() => store.searchOrders(text, rest)),
  );

  server.registerTool(
    "order_detail",
    {
      title: "Order detail",
      description:
        "One order in full: every line with its SKU, the totals broken out, coupons used, delivery method, " +
        "refunds, the buyer's own note, and each timestamp the order carries.",
      inputSchema: { order: orderRef },
      annotations: READ_ONLY,
    },
    ({ order }) => reply(() => store.order(toOrderId(order))),
  );

  server.registerTool(
    "order_timeline",
    {
      title: "Order timeline",
      description:
        "The order's notes in the order they happened: state changes, whatever the payment gateway reported " +
        "(captured, failed, webhook received), and anything staff wrote. This is where the answer to " +
        '"why is this order still pending?" usually is.',
      inputSchema: { order: orderRef },
      annotations: READ_ONLY,
    },
    ({ order }) => reply(() => store.timeline(toOrderId(order))),
  );

  server.registerTool(
    "order_by_gateway_ref",
    {
      title: "Find order by gateway reference",
      description:
        "Given a payment reference from the gateway -- a Razorpay payment id (pay_...) or order id (order_...), " +
        "or any gateway's equivalent -- find the order it belongs to. This is the tool for " +
        '"I was charged but my order never confirmed". ' +
        "WooCommerce does not index these, so it sweeps recent orders and can be slow: keep window_days tight. " +
        "matched=false with conclusive=true means no order in that window carries the reference; " +
        "conclusive=false means the sweep ran out of pages and proves nothing.",
      inputSchema: {
        reference: z
          .string()
          .trim()
          .min(4)
          .max(64)
          .regex(/^[A-Za-z0-9_-]+$/, "Gateway references are alphanumeric with _ or -.")
          .describe("The gateway's payment or order reference."),
        window_days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(30)
          .describe("How far back to sweep, by last-modified date."),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Ceiling on pages of 100 orders to read. Raise only if a sweep came back inconclusive."),
      },
      annotations: READ_ONLY,
    },
    ({ reference, window_days, max_pages }) =>
      reply(() => store.orderByGatewayRef(reference, window_days, max_pages)),
  );
}
