#!/usr/bin/env node
// A minimal stdio MCP server for integration testing.
// Exposes a single "echo" tool that returns the input message.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const server = new McpServer(
  { name: "stdio-test-backend", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.registerTool(
  "echo",
  {
    description: "Echoes back the input message",
    inputSchema: { message: z.string().describe("Message to echo") },
  },
  async ({ message }: { message: string }) => {
    return {
      content: [{ type: "text" as const, text: `stdio-echo: ${message}` }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
