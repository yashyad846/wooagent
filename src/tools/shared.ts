import { z } from "zod";
import { asFailure } from "../failures.js";

/** Nothing in this connector writes, so every tool carries the same annotations. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const ORDER_STATES = [
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
  "checkout-draft",
] as const;

/**
 * 50 rather than WooCommerce's 100: a page of orders is the single biggest thing
 * a tool can drop into the model's context, and 50 briefs is already a lot.
 */
export const PAGE_CAP = 50;

export const pageArgs = {
  page: z.number().int().min(1).default(1).describe("1-based page number."),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(PAGE_CAP)
    .default(10)
    .describe(`Rows per page, at most ${PAGE_CAP}. Ask for the fewest you can use.`),
};

/** Models are fond of "yesterday" and "last tuesday"; the store only takes dates. */
export const dateArg = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/,
    "Must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS -- resolve relative dates yourself first.",
  );

export const orderArgs = {
  state: z
    .array(z.enum(ORDER_STATES))
    .nonempty()
    .optional()
    .describe("Keep only orders in these states. Omit to span every state."),
  from: dateArg.optional().describe("Placed on or after this date, in the store's timezone."),
  to: dateArg.optional().describe("Placed on or before this date, in the store's timezone."),
  account_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Keep only orders belonging to this registered account."),
  product_id: z.number().int().positive().optional().describe("Keep only orders containing this product."),
  newest_first: z.boolean().default(true).describe("Sort by date placed; false for oldest first."),
  ...pageArgs,
};

export const catalogArgs = {
  availability: z
    .enum(["instock", "outofstock", "onbackorder"])
    .optional()
    .describe("Keep only products with this stock state."),
  section_id: z.number().int().positive().optional().describe("Keep only products in this category."),
  kind: z.enum(["simple", "variable", "grouped", "external"]).optional().describe("Product type."),
  sort_by: z.enum(["date", "title", "price", "popularity"]).default("date"),
  ascending: z.boolean().default(false),
  ...pageArgs,
};

/** Merchants say "#1042"; the REST API wants 1042. */
export const orderRef = z
  .union([z.number().int().positive(), z.string().regex(/^#?\d+$/)])
  .describe('The order\'s internal ID, as a number or as "#1042".');

export const toOrderId = (ref: number | string): number =>
  typeof ref === "number" ? ref : Number(ref.replace(/^#/, ""));

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

const asText = (value: unknown): ToolResult["content"] => [
  { type: "text", text: JSON.stringify(value, null, 2) },
];

/**
 * The single exit point for every tool. A thrown error must never escape as a
 * transport-level fault -- the agent needs a readable body it can reason about
 * and, where relevant, recover from.
 */
export async function reply(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: asText(await work()) };
  } catch (thrown) {
    return { isError: true, content: asText(asFailure(thrown).forAgent()) };
  }
}
