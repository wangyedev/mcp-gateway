// Demo: 2-meta-tool agent skills pattern + /status endpoint
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  console.log("=== MCP Gateway v2 — Agent Skills Pattern ===\n");

  // 1. Connect
  const client = new Client(
    { name: "demo-client", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8080/mcp"))
  );

  // 2. Show what the LLM sees
  const tools = await client.listTools();
  console.log(`Step 1 — LLM sees ${tools.tools.length} meta-tools:\n`);
  for (const t of tools.tools) {
    console.log(`  [${t.name}]`);
    console.log(`  ${t.description}\n`);
  }

  // 3. Activate directly — no list_servers or list_server_tools needed!
  console.log("Step 2 — Activate demo.greet (LLM reads tool name from description):");
  const result = await client.callTool({
    name: "activate_tool",
    arguments: { name: "demo.greet" },
  });
  const activated = JSON.parse((result.content as any)[0].text);
  console.log(`  Schema: ${JSON.stringify(activated.tool.inputSchema)}\n`);

  // 4. Call it
  console.log("Step 3 — Call demo.greet:");
  const greetResult = await client.callTool({
    name: "demo.greet",
    arguments: { name: "World" },
  });
  console.log(`  Result: ${(greetResult.content as any)[0].text}\n`);

  // 5. Show /status endpoint (for operators)
  console.log("Bonus — GET /status (for operators, not LLMs):");
  const statusRes = await fetch("http://127.0.0.1:8080/status");
  const status = await statusRes.json();
  console.log(JSON.stringify(status, null, 2));

  await client.close();
  console.log("\n=== Done! 2 calls: activate → use. Agent skills pattern. ===");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
