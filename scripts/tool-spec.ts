import { writeFileSync } from "node:fs";
import { startHarness } from "../fixture/agent.js";

/**
 * Writes docs/tool-spec.json from the server as it actually runs, so the published
 * tool contract can never drift from the code. Run it after touching any schema.
 */
const harness = await startHarness();
const target = "docs/tool-spec.json";

try {
  const { tools } = await harness.client.listTools();
  const spec = {
    generated_by: "npm run spec",
    server: harness.client.getServerVersion(),
    transport: "stdio",
    instructions: harness.client.getInstructions(),
    tool_count: tools.length,
    tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
  };

  writeFileSync(target, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(`wrote ${target}: ${tools.length} tools`);
} finally {
  await harness.close();
}
