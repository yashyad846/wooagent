import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FIXTURE_KEY, FIXTURE_SECRET, type FixtureOptions, startFixtureStore } from "./store.js";

/**
 * Stands up the whole stack the way a real deployment runs it: a fixture store on
 * a loopback port, and the connector as a separate process spoken to over stdio
 * MCP. Nothing is stubbed, so a passing test says the protocol, the signing and
 * the pacing all work -- not just that the functions return.
 */
export interface Harness {
  store: Awaited<ReturnType<typeof startFixtureStore>>;
  client: Client;
  invoke: (tool: string, args?: Record<string, unknown>) => Promise<{ failed: boolean; body: any }>;
  close: () => Promise<void>;
}

export async function startHarness(
  fixture: FixtureOptions = {},
  overrides: Record<string, string> = {},
): Promise<Harness> {
  const store = await startFixtureStore(fixture);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/main.ts"],
    env: {
      PATH: process.env.PATH ?? "",
      WC_STORE_URL: store.url,
      WC_CONSUMER_KEY: FIXTURE_KEY,
      WC_CONSUMER_SECRET: FIXTURE_SECRET,
      // Point the key file somewhere that cannot exist, so a developer's own
      // linked store never leaks into a test run.
      WC_KEY_FILE: "/nonexistent/clayhouse/.store-key.json",
      // Pacing is exercised by its own suite; elsewhere it should stay out of the way.
      WC_RPS: "60",
      WC_BURST: "60",
      ...overrides,
    },
    stderr: "ignore",
  });

  const client = new Client({ name: "harness-agent", version: "1.0.0" });
  await client.connect(transport);

  async function invoke(tool: string, args: Record<string, unknown> = {}) {
    const result = (await client.callTool({ name: tool, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    const text = result.content[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { failed: Boolean(result.isError), body: body as any };
  }

  return {
    store,
    client,
    invoke,
    async close() {
      await client.close();
      await store.close();
    },
  };
}
