import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StoreReader } from "../store.js";
import { registerCatalogTools } from "./catalog.js";
import { registerOrderTools } from "./orders.js";
import { READ_ONLY, reply } from "./shared.js";

export function registerTools(server: McpServer, store: StoreReader): void {
  registerOrderTools(server, store);
  registerCatalogTools(server, store);

  server.registerTool(
    "store_link_check",
    {
      title: "Check the store link",
      description:
        "Confirm the connector can actually reach this store, and report how it is configured: " +
        "the store URL, how requests are signed, round-trip time, how many orders the key can see, " +
        "whether contact details are veiled, and the pacing budget. " +
        "Use this first when another tool fails in a way that smells like setup rather than data.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => reply(() => store.checkLink()),
  );
}
