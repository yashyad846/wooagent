#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadSettings } from "./settings.js";
import { StoreReader } from "./store.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = "wc-storefront-reader";
export const SERVER_VERSION = "0.4.0";

/** What the model is told about this connector before it picks a tool. */
const BRIEFING = [
  "Read-only access to a single WooCommerce storefront: its orders, the notes on those orders, and its product catalogue with stock.",
  "You cannot change anything here. There is no tool to refund, cancel, edit or restock -- if the merchant needs that done, say so and let a human do it.",
  "Buyer emails and phone numbers arrive partly veiled, and street addresses are withheld; city and postcode are not. That is enough to confirm an identity, not to contact anyone.",
  "The store belongs to a merchant and may be on shared hosting. Filter narrowly, page small, and prefer a direct lookup over a sweep.",
  "When a tool returns a `failed` code, read `next_step` and follow it rather than retrying the same call.",
].join(" ");

export function buildServer() {
  const settings = loadSettings();
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: BRIEFING },
  );
  registerTools(server, new StoreReader(settings));
  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; anything human-readable has to go to stderr.
  console.error(`${SERVER_NAME} ${SERVER_VERSION} listening on stdio`);
}

main().catch((thrown: unknown) => {
  console.error(thrown instanceof Error ? thrown.message : String(thrown));
  process.exit(1);
});
