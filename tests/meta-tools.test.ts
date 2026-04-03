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
      expect(defs).toHaveLength(2);
      const names = defs.map((d) => d.name);
      expect(names).toContain("activate_tool");
      expect(names).toContain("deactivate_tool");
    });

    test("activate_tool description includes tool catalog", () => {
      const defs = handler.getToolDefinitions();
      const activateTool = defs.find((d) => d.name === "activate_tool")!;
      expect(activateTool.description).toContain("postgres.query");
      expect(activateTool.description).toContain("postgres.list_tables");
      expect(activateTool.description).toContain("Execute SQL");
    });

    test("activate_tool description shows offline servers", () => {
      registry.markUnavailable("broken");
      const defs = handler.getToolDefinitions();
      const activateTool = defs.find((d) => d.name === "activate_tool")!;
      expect(activateTool.description).toContain("[offline] broken");
    });

    test("activate_tool description handles no servers", () => {
      registry.removeServer("postgres");
      const defs = handler.getToolDefinitions();
      const activateTool = defs.find((d) => d.name === "activate_tool")!;
      expect(activateTool.description).toContain("No tools are currently available");
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
