// Demo client showing multi-server discovery including unavailable servers
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const client = new Client(
    { name: "demo-client", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8080/mcp"))
  );

  // Discover servers
  const result = await client.callTool({ name: "list_servers", arguments: {} });
  const servers = JSON.parse((result.content as any)[0].text);

  console.log("Registered servers:\n");
  for (const s of servers.servers) {
    const status = s.status === "available" ? "ONLINE" : "OFFLINE";
    console.log(`  [${status}] ${s.name}`);
    console.log(`          ${s.description ?? "(no description)"}\n`);
  }

  await client.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
