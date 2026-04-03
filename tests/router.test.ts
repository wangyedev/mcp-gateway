// tests/router.test.ts
import { describe, test, expect, beforeEach, vi } from "vitest";
import { Router } from "../src/router.js";
import { ToolRegistry } from "../src/registry.js";
import { BackendManager } from "../src/backend.js";

describe("Router", () => {
  let registry: ToolRegistry;
  let backendManager: BackendManager;
  let router: Router;

  beforeEach(() => {
    registry = new ToolRegistry();
    backendManager = new BackendManager();
    router = new Router(registry, backendManager);

    registry.registerServer("postgres", {
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
  });

  test("resolves a namespaced tool to server and original name", () => {
    const resolved = router.resolve("postgres.query");
    expect(resolved).toEqual({
      serverName: "postgres",
      toolName: "query",
    });
  });

  test("returns undefined for unknown tool", () => {
    const resolved = router.resolve("unknown.tool");
    expect(resolved).toBeUndefined();
  });

  test("routes a tool call to the backend", async () => {
    const mockResult = { content: [{ type: "text", text: "42" }] };
    vi.spyOn(backendManager, "callTool").mockResolvedValue(mockResult);

    const result = await router.routeToolCall("postgres.query", { sql: "SELECT 1" });

    expect(backendManager.callTool).toHaveBeenCalledWith("postgres", "query", {
      sql: "SELECT 1",
    });
    expect(result).toEqual(mockResult);
  });

  test("throws for unknown tool in routeToolCall", async () => {
    await expect(
      router.routeToolCall("unknown.tool", {})
    ).rejects.toThrow("not found");
  });

  test("propagates backend errors", async () => {
    vi.spyOn(backendManager, "callTool").mockRejectedValue(
      new Error("Backend server 'postgres' is unreachable")
    );

    await expect(
      router.routeToolCall("postgres.query", { sql: "SELECT 1" })
    ).rejects.toThrow("unreachable");
  });
});
