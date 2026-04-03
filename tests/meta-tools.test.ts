// tests/meta-tools.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { MetaToolHandler } from "../src/meta-tools.js";
import { ToolRegistry } from "../src/registry.js";
import { SessionManager } from "../src/session.js";

describe("MetaToolHandler", () => {
  let registry: ToolRegistry;
  let sessions: SessionManager;
  let handler: MetaToolHandler;
  let sessionId: string;

  beforeEach(() => {
    registry = new ToolRegistry();
    sessions = new SessionManager();
    handler = new MetaToolHandler(registry, sessions);
    sessionId = sessions.createSession();

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
        {
          name: "list_tables",
          description: "List tables",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  });

  describe("listServers", () => {
    test("returns all servers", () => {
      const result = handler.listServers();
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].name).toBe("postgres");
      expect(result.servers[0].description).toBe("Database tools");
      expect(result.servers[0].status).toBe("available");
    });
  });

  describe("listServerTools", () => {
    test("returns tools for a server", () => {
      const result = handler.listServerTools("postgres");
      expect(result.server).toBe("postgres");
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe("postgres.query");
    });

    test("throws for unknown server", () => {
      expect(() => handler.listServerTools("unknown")).toThrow("not found");
    });
  });

  describe("activateTool", () => {
    test("activates a tool and returns schema", () => {
      const result = handler.activateTool(sessionId, "postgres.query");
      expect(result.success).toBe(true);
      expect(result.tool.name).toBe("postgres.query");
      expect(result.tool.inputSchema.required).toEqual(["sql"]);
      expect(sessions.isToolActivated(sessionId, "postgres.query")).toBe(true);
    });

    test("throws for unknown tool", () => {
      expect(() => handler.activateTool(sessionId, "postgres.unknown")).toThrow(
        "not found"
      );
    });

    test("throws unavailable error when server is unavailable", () => {
      registry.markUnavailable("offline");
      expect(() => handler.activateTool(sessionId, "offline.some_tool")).toThrow(
        "currently unavailable"
      );
    });

    test("throws for already activated tool", () => {
      handler.activateTool(sessionId, "postgres.query");
      expect(() => handler.activateTool(sessionId, "postgres.query")).toThrow(
        "already activated"
      );
    });
  });

  describe("deactivateTool", () => {
    test("deactivates a tool", () => {
      handler.activateTool(sessionId, "postgres.query");
      const result = handler.deactivateTool(sessionId, "postgres.query");
      expect(result.success).toBe(true);
      expect(sessions.isToolActivated(sessionId, "postgres.query")).toBe(false);
    });

    test("throws for non-activated tool", () => {
      expect(() => handler.deactivateTool(sessionId, "postgres.query")).toThrow(
        "not activated"
      );
    });
  });

  describe("getToolDefinitions", () => {
    test("returns meta-tool definitions", () => {
      const defs = handler.getToolDefinitions();
      expect(defs).toHaveLength(4);
      const names = defs.map((d) => d.name);
      expect(names).toContain("list_servers");
      expect(names).toContain("list_server_tools");
      expect(names).toContain("activate_tool");
      expect(names).toContain("deactivate_tool");
    });

    test("list_servers description includes server catalog", () => {
      const defs = handler.getToolDefinitions();
      const listServers = defs.find((d) => d.name === "list_servers")!;
      expect(listServers.description).toContain("postgres");
      expect(listServers.description).toContain("Database tools");
      expect(listServers.description).toContain("list_server_tools");
    });

    test("list_servers description shows offline servers", () => {
      registry.markUnavailable("broken");
      const defs = handler.getToolDefinitions();
      const listServers = defs.find((d) => d.name === "list_servers")!;
      expect(listServers.description).toContain("broken [offline]");
    });

    test("list_servers description handles no servers", () => {
      registry.removeServer("postgres");
      const defs = handler.getToolDefinitions();
      const listServers = defs.find((d) => d.name === "list_servers")!;
      expect(listServers.description).toContain("No servers are currently registered");
    });
  });

  describe("getActivatedToolDefinitions", () => {
    test("returns activated tool schemas for a session", () => {
      handler.activateTool(sessionId, "postgres.query");

      const defs = handler.getActivatedToolDefinitions(sessionId);
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe("postgres.query");
      expect(defs[0].inputSchema).toBeDefined();
    });
  });
});
