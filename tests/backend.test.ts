// tests/backend.test.ts
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { BackendManager } from "../src/backend.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  const mockClient = {
    connect: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
    close: vi.fn(),
    onclose: undefined as (() => void) | undefined,
    setNotificationHandler: vi.fn(),
  };
  return {
    Client: vi.fn(() => mockClient),
    __mockClient: mockClient,
  };
});

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

describe("BackendManager", () => {
  let manager: BackendManager;
  let mockClient: any;

  beforeEach(async () => {
    manager = new BackendManager();
    const mod = await import("@modelcontextprotocol/sdk/client/index.js");
    mockClient = (mod as any).__mockClient;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await manager.disconnectAll();
  });

  test("connects to a backend and fetches tools", async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({
      tools: [
        {
          name: "query",
          description: "Execute SQL",
          inputSchema: { type: "object", properties: { sql: { type: "string" } } },
        },
      ],
    });

    const tools = await manager.connect("postgres", "http://localhost:3001/mcp");

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("query");
    expect(tools[0].description).toBe("Execute SQL");
  });

  test("calls a tool on a backend", async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({ tools: [] });
    mockClient.callTool.mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    });

    await manager.connect("postgres", "http://localhost:3001/mcp");
    const result = await manager.callTool("postgres", "query", { sql: "SELECT 1" });

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "query",
      arguments: { sql: "SELECT 1" },
    });
    expect(result.content).toEqual([{ type: "text", text: "result" }]);
  });

  test("throws when calling tool on unknown backend", async () => {
    await expect(
      manager.callTool("unknown", "query", {})
    ).rejects.toThrow("not connected");
  });

  test("disconnects a backend", async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({ tools: [] });

    await manager.connect("postgres", "http://localhost:3001/mcp");
    await manager.disconnect("postgres");

    await expect(
      manager.callTool("postgres", "query", {})
    ).rejects.toThrow("not connected");
  });

  test("isConnected returns correct state", async () => {
    expect(manager.isConnected("postgres")).toBe(false);

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({ tools: [] });
    await manager.connect("postgres", "http://localhost:3001/mcp");

    expect(manager.isConnected("postgres")).toBe(true);
  });
});
