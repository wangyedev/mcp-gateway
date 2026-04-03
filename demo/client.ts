// Demo client that exercises the full gateway flow
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  console.log("=== MCP Gateway Demo ===\n");

  // Connect to gateway
  const client = new Client(
    { name: "demo-client", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:8080/mcp")
  );
  await client.connect(transport);
  console.log("Connected to gateway\n");

  // Step 1: List initial tools
  const initial = await client.listTools();
  console.log("Step 1 — Initial tools (should be 4 meta-tools only):");
  for (const t of initial.tools) {
    console.log(`  - ${t.name}: ${t.description?.slice(0, 60)}...`);
  }
  console.log();

  // Step 2: Discover servers
  const serversResult = await client.callTool({ name: "list_servers", arguments: {} });
  const servers = JSON.parse((serversResult.content as any)[0].text);
  console.log("Step 2 — Discover servers:");
  for (const s of servers.servers) {
    console.log(`  - ${s.name} [${s.status}]: ${s.description}`);
  }
  console.log();

  // Step 3: Discover tools on the demo server
  const toolsResult = await client.callTool({
    name: "list_server_tools",
    arguments: { server: "demo" },
  });
  const serverTools = JSON.parse((toolsResult.content as any)[0].text);
  console.log("Step 3 — Tools on 'demo' server:");
  for (const t of serverTools.tools) {
    console.log(`  - ${t.name}: ${t.description}`);
  }
  console.log();

  // Step 4: Activate a tool
  const activateResult = await client.callTool({
    name: "activate_tool",
    arguments: { name: "demo.greet" },
  });
  const activated = JSON.parse((activateResult.content as any)[0].text);
  console.log("Step 4 — Activated 'demo.greet':");
  console.log(`  Schema: ${JSON.stringify(activated.tool.inputSchema)}`);
  console.log();

  // Step 5: Check tools/list — should now include demo.greet
  const updated = await client.listTools();
  console.log(`Step 5 — Tools after activation (${updated.tools.length} total):`);
  for (const t of updated.tools) {
    console.log(`  - ${t.name}`);
  }
  console.log();

  // Step 6: Call the activated tool
  const greetResult = await client.callTool({
    name: "demo.greet",
    arguments: { name: "World" },
  });
  console.log("Step 6 — Call demo.greet({name: 'World'}):");
  console.log(`  Result: ${(greetResult.content as any)[0].text}`);
  console.log();

  // Step 7: Activate and call another tool
  await client.callTool({
    name: "activate_tool",
    arguments: { name: "demo.add" },
  });
  const addResult = await client.callTool({
    name: "demo.add",
    arguments: { a: 17, b: 25 },
  });
  console.log("Step 7 — Activate and call demo.add({a: 17, b: 25}):");
  console.log(`  Result: ${(addResult.content as any)[0].text}`);
  console.log();

  // Step 8: Deactivate
  await client.callTool({
    name: "deactivate_tool",
    arguments: { name: "demo.greet" },
  });
  const afterDeactivate = await client.listTools();
  console.log("Step 8 — After deactivating 'demo.greet':");
  for (const t of afterDeactivate.tools) {
    console.log(`  - ${t.name}`);
  }
  console.log();

  console.log("=== Demo complete! ===");
  await client.close();
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
