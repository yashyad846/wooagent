import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StoreReader } from "../store.js";
import { READ_ONLY, catalogArgs, reply } from "./shared.js";

export function registerCatalogTools(server: McpServer, store: StoreReader): void {
  server.registerTool(
    "catalog_list",
    {
      title: "List products",
      description:
        "Browse published products with price, stock state and quantity on hand. " +
        "Narrow by stock state, category or product type.",
      inputSchema: catalogArgs,
      annotations: READ_ONLY,
    },
    (args) => reply(() => store.catalog(args)),
  );

  server.registerTool(
    "catalog_search",
    {
      title: "Search products",
      description:
        "Find products by words in the name or description, or by exact SKU. At least one of text or sku is required. " +
        "SKU lookup is exact, not fuzzy -- if it finds nothing, try the same string as text.",
      inputSchema: {
        text: z.string().trim().min(2).optional().describe("Words from the product's name or description."),
        sku: z.string().trim().min(1).optional().describe("An exact SKU; comma-separate to look up several."),
        ...catalogArgs,
      },
      annotations: READ_ONLY,
    },
    ({ text, sku, ...rest }) => reply(() => store.searchCatalog(text, sku, rest)),
  );

  server.registerTool(
    "product_detail",
    {
      title: "Product detail",
      description:
        "One product in full: list and offer price, its reorder level, backorder policy, and -- for a variable " +
        'product -- every variant with its options, price and stock. Use this to answer "is it in medium?".',
      inputSchema: {
        product_id: z.number().int().positive().describe("The product's ID."),
      },
      annotations: READ_ONLY,
    },
    ({ product_id }) => reply(() => store.product(product_id)),
  );

  server.registerTool(
    "stock_alerts",
    {
      title: "Stock alerts",
      description:
        "Everything sold out or at/below its reorder level, most urgent first, each tagged sold_out or low. " +
        "Levels come from each product, then the store's own setting, unless you pass reorder_at to override both. " +
        "This sweeps the catalogue, so check conclusive before reporting it as the whole picture.",
      inputSchema: {
        reorder_at: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Override: treat anything at or below this quantity as low."),
        include_sold_out: z.boolean().default(true).describe("Include items already at zero."),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(10)
          .describe("Ceiling on pages of 100 products to read."),
      },
      annotations: READ_ONLY,
    },
    ({ reorder_at, include_sold_out, max_pages }) =>
      reply(() => store.stockAlerts(reorder_at, include_sold_out, max_pages)),
  );
}
