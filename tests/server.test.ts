// tests/server.test.ts
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { GatewayServer } from "../src/server.js";
import { ToolRegistry } from "../src/registry.js";
import { SessionManager } from "../src/session.js";
import { MetaToolHandler } from "../src/meta-tools.js";
import { Router } from "../src/router.js";
import { BackendManager } from "../src/backend.js";

describe("GatewayServer", () => {
  let registry: ToolRegistry;
  let sessions: SessionManager;
  let metaTools: MetaToolHandler;
  let backendManager: BackendManager;
  let router: Router;
  let server: GatewayServer;

  beforeEach(() => {
    registry = new ToolRegistry();
    sessions = new SessionManager();
    metaTools = new MetaToolHandler(registry, sessions);
    backendManager = new BackendManager();
    router = new Router(registry, backendManager);

    registry.registerServer("postgres", {
      description: "Database tools",
      tools: [
        {
          name: "query",
          description: "Execute SQL",
          inputSchema: {
            type: "object",
            properties: { sql: { type: "string" } },
            required: ["sql"],
          },
        },
      ],
    });

    server = new GatewayServer({
      registry,
      sessions,
      metaTools,
      router,
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  test("constructs without error", () => {
    expect(server).toBeDefined();
  });

  test("getToolsForSession returns meta-tools for new session", () => {
    const sessionId = sessions.createSession();
    const tools = server.getToolsForSession(sessionId);

    const names = tools.map((t) => t.name);
    expect(names).toContain("list_servers");
    expect(names).toContain("list_server_tools");
    expect(names).toContain("activate_tool");
    expect(names).toContain("deactivate_tool");
    expect(names).toHaveLength(4);
  });

  test("getToolsForSession includes activated tools", () => {
    const sessionId = sessions.createSession();
    sessions.activateTool(sessionId, "postgres.query");

    const tools = server.getToolsForSession(sessionId);
    const names = tools.map((t) => t.name);
    expect(names).toContain("postgres.query");
    expect(names).toHaveLength(5);
  });

  test("handleToolCall routes meta-tool list_servers", async () => {
    const sessionId = sessions.createSession();
    const result = await server.handleToolCall(sessionId, "list_servers", {});

    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].name).toBe("postgres");
  });

  test("handleToolCall routes meta-tool activate_tool", async () => {
    const sessionId = sessions.createSession();
    const result = await server.handleToolCall(sessionId, "activate_tool", {
      name: "postgres.query",
    });

    const parsed = JSON.parse(result.content[0].text!);
    expect(parsed.success).toBe(true);
    expect(parsed.tool.name).toBe("postgres.query");
  });

  test("handleToolCall routes activated tools to backend", async () => {
    const sessionId = sessions.createSession();
    sessions.activateTool(sessionId, "postgres.query");

    vi.spyOn(router, "routeToolCall").mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    });

    const result = await server.handleToolCall(sessionId, "postgres.query", {
      sql: "SELECT 1",
    });

    expect(router.routeToolCall).toHaveBeenCalledWith("postgres.query", {
      sql: "SELECT 1",
    });
    expect(result.content[0].text).toBe("result");
  });

  test("handleToolCall rejects non-activated backend tools", async () => {
    const sessionId = sessions.createSession();

    const result = await server.handleToolCall(sessionId, "postgres.query", {
      sql: "SELECT 1",
    });

    expect(result.isError).toBe(true);
  });
});
