// tests/registry.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../src/registry.js";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  test("registers a server with tools", () => {
    registry.registerServer("postgres", {
      description: "Database tools",
      tools: [
        {
          name: "query",
          description: "Execute SQL",
          inputSchema: {
            type: "object" as const,
            properties: { sql: { type: "string" } },
            required: ["sql"],
          },
        },
        {
          name: "list_tables",
          description: "List all tables",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    });

    const servers = registry.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("postgres");
    expect(servers[0].description).toBe("Database tools");
    expect(servers[0].status).toBe("available");
  });

  test("auto-generates description from tools", () => {
    registry.registerServer("postgres", {
      tools: [
        {
          name: "query",
          description: "Execute SQL",
          inputSchema: { type: "object" as const, properties: {} },
        },
        {
          name: "list_tables",
          description: "List all tables",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    });

    const servers = registry.listServers();
    expect(servers[0].description).toBe(
      "Provides tools: query - Execute SQL, list_tables - List all tables"
    );
  });

  test("truncates auto-generated description at word boundary", () => {
    const tools = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      description: `This is a somewhat long description for tool number ${i}`,
      inputSchema: { type: "object" as const, properties: {} },
    }));

    registry.registerServer("big", { tools });

    const servers = registry.listServers();
    expect(servers[0].description!.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(servers[0].description!.endsWith("...")).toBe(true);
  });

  test("lists tools for a server with namespaced names", () => {
    registry.registerServer("postgres", {
      tools: [
        {
          name: "query",
          description: "Execute SQL",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    });

    const tools = registry.listServerTools("postgres");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("postgres.query");
    expect(tools[0].description).toBe("Execute SQL");
  });

  test("returns full schema for a namespaced tool", () => {
    const schema = {
      type: "object" as const,
      properties: { sql: { type: "string" } },
      required: ["sql"],
    };
    registry.registerServer("postgres", {
      tools: [{ name: "query", description: "Execute SQL", inputSchema: schema }],
    });

    const tool = registry.getTool("postgres.query");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("postgres.query");
    expect(tool!.inputSchema).toEqual(schema);
    expect(tool!.serverName).toBe("postgres");
    expect(tool!.originalName).toBe("query");
  });

  test("returns undefined for unknown tool", () => {
    expect(registry.getTool("unknown.tool")).toBeUndefined();
  });

  test("throws for unknown server in listServerTools", () => {
    expect(() => registry.listServerTools("unknown")).toThrow("not found");
  });

  test("marks server as unavailable", () => {
    registry.markUnavailable("postgres");

    const servers = registry.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("postgres");
    expect(servers[0].status).toBe("unavailable");
    expect(servers[0].description).toBeUndefined();
  });

  test("throws for unavailable server in listServerTools", () => {
    registry.markUnavailable("postgres");

    expect(() => registry.listServerTools("postgres")).toThrow("unavailable");
  });

  test("isServerUnavailable returns true for unavailable server", () => {
    registry.markUnavailable("postgres");
    expect(registry.isServerUnavailable("postgres.query")).toBe(true);
  });

  test("isServerUnavailable returns false for available server", () => {
    registry.registerServer("postgres", {
      tools: [
        {
          name: "query",
          description: "Execute SQL",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    });
    expect(registry.isServerUnavailable("postgres.query")).toBe(false);
  });

  test("isServerUnavailable returns false for unknown server", () => {
    expect(registry.isServerUnavailable("unknown.tool")).toBe(false);
  });

  test("isServerUnavailable returns false for name without dot", () => {
    expect(registry.isServerUnavailable("nodot")).toBe(false);
  });

  test("removes a server", () => {
    registry.registerServer("postgres", {
      tools: [
        {
          name: "query",
          description: "Execute SQL",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    });
    registry.removeServer("postgres");

    expect(registry.listServers()).toHaveLength(0);
    expect(registry.getTool("postgres.query")).toBeUndefined();
  });

  test("returns all namespaced tool names for a server", () => {
    registry.registerServer("pg", {
      tools: [
        {
          name: "query",
          description: "SQL",
          inputSchema: { type: "object" as const, properties: {} },
        },
        {
          name: "list_tables",
          description: "Tables",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    });

    const names = registry.getToolNamesForServer("pg");
    expect(names).toEqual(["pg.query", "pg.list_tables"]);
  });
});
