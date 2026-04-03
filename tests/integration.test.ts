// tests/integration.test.ts
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  isInitializeRequest,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import express from "express";
import type { Server as HttpServer } from "http";
import * as z from "zod";

import { ToolRegistry } from "../src/registry.js";
import { SessionManager } from "../src/session.js";
import { MetaToolHandler } from "../src/meta-tools.js";
import { Router } from "../src/router.js";
import { BackendManager } from "../src/backend.js";
import { GatewayServer } from "../src/server.js";

// Helper: registers tools on a McpServer using Zod schemas
function registerMockTools(server: McpServer): void {
  server.registerTool("echo", {
    description: "Echoes back the input message",
    inputSchema: {
      message: z.string().describe("Message to echo"),
    },
  }, async ({ message }: { message: string }) => {
    return {
      content: [{ type: "text" as const, text: `echo: ${message}` }],
    };
  });

  server.registerTool("add", {
    description: "Adds two numbers",
    inputSchema: {
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    },
  }, async ({ a, b }: { a: number; b: number }) => {
    return {
      content: [{ type: "text" as const, text: String(a + b) }],
    };
  });
}

// Helper to start a mock backend MCP server
async function startMockBackend(): Promise<{
  server: HttpServer;
  port: number;
  url: string;
}> {
  const app = express();
  app.use(express.json());

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };
      const newServer = new McpServer(
        { name: "test-backend", version: "1.0.0" },
        { capabilities: { tools: {} } }
      );
      registerMockTools(newServer);
      await newServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request" },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  return new Promise<{ server: HttpServer; port: number; url: string }>(
    (resolve) => {
      const server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        const url = `http://127.0.0.1:${addr.port}/mcp`;
        resolve({ server, port: addr.port, url });
      });
    }
  );
}

describe("Integration: MCP Gateway end-to-end", () => {
  let mockBackend: { server: HttpServer; port: number; url: string };
  let gateway: GatewayServer;
  let gatewayPort: number;

  beforeAll(async () => {
    // 1. Start mock backend
    mockBackend = await startMockBackend();

    // 2. Set up gateway components
    const registry = new ToolRegistry();
    const sessions = new SessionManager();
    const metaTools = new MetaToolHandler(registry, sessions);
    const backendManager = new BackendManager();
    const router = new Router(registry, backendManager);

    gateway = new GatewayServer({
      registry,
      sessions,
      metaTools,
      router,
    });

    // 3. Connect gateway to mock backend and register tools
    const tools = await backendManager.connect(
      "test-backend",
      mockBackend.url
    );
    registry.registerServer("test-backend", {
      description: "A test backend server",
      tools,
    });

    // 4. Start the gateway MCP server
    gatewayPort = await gateway.startMcp(0, "127.0.0.1");
  }, 30000);

  afterAll(async () => {
    await gateway.stop();
    // Force-close the mock backend (closeAllConnections handles lingering keep-alive)
    mockBackend.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      mockBackend.server.close(() => resolve());
    });
  }, 15000);

  test("full flow: read catalog -> activate -> call -> deactivate", async () => {
    // Create MCP client connecting to the gateway
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${gatewayPort}/mcp`)
    );
    await client.connect(transport);

    try {
      // Step 1: List tools -- should only have 2 meta-tools
      const initialTools = await client.listTools();
      const initialNames = initialTools.tools.map((t) => t.name);
      expect(initialNames).toContain("activate_tool");
      expect(initialNames).toContain("deactivate_tool");
      expect(initialNames).toHaveLength(2);

      // Step 2: Read activate_tool description to find available tools
      const activateToolDef = initialTools.tools.find(
        (t) => t.name === "activate_tool"
      )!;
      expect(activateToolDef.description).toContain("test-backend.echo");
      expect(activateToolDef.description).toContain("test-backend.add");

      // Step 3: Activate a tool
      const activateResult = await client.callTool({
        name: "activate_tool",
        arguments: { name: "test-backend.echo" },
      });
      const activateData = JSON.parse(
        (activateResult.content as Array<{ type: string; text: string }>)[0]
          .text
      );
      expect(activateData.success).toBe(true);
      expect(activateData.tool.name).toBe("test-backend.echo");

      // Step 4: Verify tool list now includes the activated tool
      const afterActivateTools = await client.listTools();
      const afterNames = afterActivateTools.tools.map((t) => t.name);
      expect(afterNames).toContain("test-backend.echo");
      expect(afterNames).toHaveLength(3); // 2 meta + 1 activated

      // Step 5: Call the activated tool
      const echoResult = await client.callTool({
        name: "test-backend.echo",
        arguments: { message: "hello world" },
      });
      expect(
        (echoResult.content as Array<{ type: string; text: string }>)[0].text
      ).toBe("echo: hello world");

      // Step 6: Deactivate the tool
      const deactivateResult = await client.callTool({
        name: "deactivate_tool",
        arguments: { name: "test-backend.echo" },
      });
      const deactivateData = JSON.parse(
        (deactivateResult.content as Array<{ type: string; text: string }>)[0]
          .text
      );
      expect(deactivateData.success).toBe(true);

      // Step 7: Verify tool list is back to meta-tools only
      const afterDeactivateTools = await client.listTools();
      const afterDeactivateNames = afterDeactivateTools.tools.map(
        (t) => t.name
      );
      expect(afterDeactivateNames).toHaveLength(2);
      expect(afterDeactivateNames).not.toContain("test-backend.echo");
    } finally {
      await client.close();
    }
  }, 30000);

  test("GET /status returns server status and active sessions", async () => {
    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/status`
    );
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.servers).toBeDefined();
    expect(Array.isArray(data.servers)).toBe(true);
    expect(data.servers.length).toBeGreaterThanOrEqual(1);

    const backend = data.servers.find(
      (s: { name: string }) => s.name === "test-backend"
    );
    expect(backend).toBeDefined();
    expect(backend.status).toBe("available");
    expect(backend.tools).toContain("test-backend.echo");
    expect(backend.tools).toContain("test-backend.add");

    expect(typeof data.activeSessions).toBe("number");
  }, 15000);

  test("calling a non-activated tool returns an error", async () => {
    const client = new Client(
      { name: "test-client-2", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${gatewayPort}/mcp`)
    );
    await client.connect(transport);

    try {
      const result = await client.callTool({
        name: "test-backend.echo",
        arguments: { message: "should fail" },
      });
      expect(result.isError).toBe(true);
      expect(
        (result.content as Array<{ type: string; text: string }>)[0].text
      ).toContain("not activated");
    } finally {
      await client.close();
    }
  }, 15000);

  test("tools/list_changed notification is received after activate and deactivate", async () => {
    const client = new Client(
      { name: "test-client-3", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${gatewayPort}/mcp`)
    );
    await client.connect(transport);

    try {
      // Track notifications
      const notifications: string[] = [];
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async () => {
          notifications.push("tools_changed");
        }
      );

      // Open an SSE stream to receive notifications (GET /mcp)
      // The client should auto-establish this when connected

      // Activate a tool -- should trigger tools/list_changed
      await client.callTool({
        name: "activate_tool",
        arguments: { name: "test-backend.add" },
      });

      // Give a moment for the notification to propagate
      await new Promise((r) => setTimeout(r, 500));

      // Deactivate -- should trigger tools/list_changed again
      await client.callTool({
        name: "deactivate_tool",
        arguments: { name: "test-backend.add" },
      });

      await new Promise((r) => setTimeout(r, 500));

      // We expect at least 2 notifications (one for activate, one for deactivate)
      expect(notifications.length).toBeGreaterThanOrEqual(2);
    } finally {
      await client.close();
    }
  }, 15000);

  test("multiple sessions are independent", async () => {
    // Create two clients
    const client1 = new Client(
      { name: "client-1", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport1 = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${gatewayPort}/mcp`)
    );
    await client1.connect(transport1);

    const client2 = new Client(
      { name: "client-2", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport2 = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${gatewayPort}/mcp`)
    );
    await client2.connect(transport2);

    try {
      // Client 1 activates echo
      await client1.callTool({
        name: "activate_tool",
        arguments: { name: "test-backend.echo" },
      });

      // Client 1 should see the tool
      const tools1 = await client1.listTools();
      expect(tools1.tools.map((t) => t.name)).toContain("test-backend.echo");

      // Client 2 should NOT see the tool
      const tools2 = await client2.listTools();
      expect(tools2.tools.map((t) => t.name)).not.toContain(
        "test-backend.echo"
      );

      // Client 2 trying to call the tool should fail
      const result = await client2.callTool({
        name: "test-backend.echo",
        arguments: { message: "from client 2" },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client1.close();
      await client2.close();
    }
  }, 15000);
});
