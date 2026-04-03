// Demo backend MCP server with a few tools
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { z } from "zod";

const app = express();
app.use(express.json());

const transports = new Map<string, StreamableHTTPServerTransport>();

function createServer(): McpServer {
  const server = new McpServer({
    name: "demo-backend",
    version: "1.0.0",
  });

  server.registerTool("greet", {
    description: "Generate a greeting message for a person",
    inputSchema: { name: z.string().describe("Name of the person to greet") },
  }, async ({ name }: { name: string }) => ({
    content: [{ type: "text" as const, text: `Hello, ${name}! Welcome to the MCP Gateway demo.` }],
  }));

  server.registerTool("add", {
    description: "Add two numbers together",
    inputSchema: {
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    },
  }, async ({ a, b }: { a: number; b: number }) => ({
    content: [{ type: "text" as const, text: `${a} + ${b} = ${a + b}` }],
  }));

  server.registerTool("echo", {
    description: "Echo back a message",
    inputSchema: { message: z.string().describe("Message to echo") },
  }, async ({ message }: { message: string }) => ({
    content: [{ type: "text" as const, text: `Echo: ${message}` }],
  }));

  return server;
}

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    transports.set(transport.sessionId, transport);
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports.get(sessionId);
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "No session" });
  }
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports.get(sessionId);
  if (transport) {
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
  } else {
    res.status(400).json({ error: "No session" });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Demo backend MCP server running on http://localhost:${PORT}/mcp`);
  console.log("Tools: greet, add, echo");
});
