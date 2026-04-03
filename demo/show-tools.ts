import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const client = new Client(
    { name: "test", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8080/mcp"))
  );

  const tools = await client.listTools();
  console.log("=== What the LLM sees in its tool list ===\n");
  for (const t of tools.tools) {
    console.log(`[${t.name}]`);
    console.log(`  ${t.description}\n`);
  }

  await client.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
