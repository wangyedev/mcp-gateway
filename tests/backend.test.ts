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

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  const mockTransport = {
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
  };
  return {
    StdioClientTransport: vi.fn(() => mockTransport),
    __mockStdioTransport: mockTransport,
  };
});

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

  test("connects to a stdio backend and fetches tools", async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    });

    const tools = await manager.connectStdio("filesystem", {
      command: "node",
      args: ["server.js"],
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("read_file");
    expect(manager.isConnected("filesystem")).toBe(true);
  });

  test("stdio and http clients coexist", async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({ tools: [] });

    await manager.connect("http-server", "http://localhost:3001/mcp");
    await manager.connectStdio("stdio-server", {
      command: "node",
      args: ["server.js"],
    });

    expect(manager.isConnected("http-server")).toBe(true);
    expect(manager.isConnected("stdio-server")).toBe(true);
  });

  test("onClose callback fires for stdio backend", async () => {
    const mod = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const mockStdioTransport = (mod as any).__mockStdioTransport;

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({ tools: [] });

    await manager.connectStdio("filesystem", {
      command: "node",
      args: ["server.js"],
    });

    const closeFn = vi.fn();
    manager.onClose("filesystem", closeFn);

    // Simulate process crash by calling the transport's onclose
    mockStdioTransport.onclose?.();

    expect(closeFn).toHaveBeenCalledOnce();
  });

  test("disconnect works for stdio backend", async () => {
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({ tools: [] });

    await manager.connectStdio("filesystem", {
      command: "node",
      args: ["server.js"],
    });
    await manager.disconnect("filesystem");

    expect(manager.isConnected("filesystem")).toBe(false);
  });
});
