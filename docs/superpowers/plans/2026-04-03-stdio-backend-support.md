# Stdio Backend Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the gateway to connect to stdio-based MCP servers (child processes spawned by the gateway) alongside existing Streamable HTTP backends.

**Architecture:** Extend `ServerConfig` to accept `command` instead of `url`, add `connectStdio()` to `BackendManager` using the SDK's `StdioClientTransport`, and update `index.ts` to dispatch connections and handle stdio-specific retry behavior (5-attempt cap, crash recovery). No changes to registry, session, meta-tools, router, server, or watcher modules.

**Tech Stack:** `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js` (already installed). No new dependencies.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Modify | Add `command`, `env`, `cwd` to `ServerConfig`; add validation for mutual exclusivity; add `parseCommand()` helper |
| `tests/config.test.ts` | Modify | Add tests for stdio config parsing and validation |
| `src/backend.ts` | Modify | Add `connectStdio()` method and `onClose()` callback registration |
| `tests/backend.test.ts` | Modify | Add tests for `connectStdio()`, crash callback, coexistence with HTTP |
| `src/index.ts` | Modify | Connection dispatch, retry loop with stdio cap, crash handler, hot reload for stdio |
| `tests/helpers/stdio-echo-server.ts` | Create | Minimal stdio MCP server for integration testing |
| `tests/integration.test.ts` | Modify | Add stdio integration test using the stdio echo server |
| `mcp-gateway.example.yaml` | Modify | Add commented stdio server examples |
| `README.md` | Modify | Document stdio support in config table, features, and examples |

---

### Task 1: Config — Validation and Parsing

**Files:**
- Modify: `src/config.ts:1-70`
- Modify: `tests/config.test.ts:1-122`

- [ ] **Step 1: Write failing tests for stdio config validation**

Add these tests to `tests/config.test.ts` inside the existing `describe("loadConfig", ...)` block, after the last existing test:

```typescript
  test("parses stdio server config", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: filesystem
    command: npx -y @modelcontextprotocol/server-filesystem /tmp
`
    );

    const config = loadConfig(configPath);

    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].name).toBe("filesystem");
    expect(config.servers[0].command).toBe(
      "npx -y @modelcontextprotocol/server-filesystem /tmp"
    );
    expect(config.servers[0].url).toBeUndefined();
  });

  test("parses stdio server with env and cwd", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: github
    command: npx -y @modelcontextprotocol/server-github
    env:
      GITHUB_TOKEN: my-token
    cwd: /opt/servers
`
    );

    const config = loadConfig(configPath);

    expect(config.servers[0].env).toEqual({ GITHUB_TOKEN: "my-token" });
    expect(config.servers[0].cwd).toBe("/opt/servers");
  });

  test("throws when server has both url and command", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: bad
    url: http://localhost:3001/mcp
    command: npx some-server
`
    );

    expect(() => loadConfig(configPath)).toThrow(
      "must have either 'url' or 'command'"
    );
  });

  test("throws when server has neither url nor command", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: bad
`
    );

    expect(() => loadConfig(configPath)).toThrow(
      "must have either 'url' or 'command'"
    );
  });

  test("throws when HTTP server has env field", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: bad
    url: http://localhost:3001/mcp
    env:
      FOO: bar
`
    );

    expect(() => loadConfig(configPath)).toThrow(
      "'env' and 'cwd' are only allowed for stdio servers"
    );
  });

  test("throws when HTTP server has cwd field", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: bad
    url: http://localhost:3001/mcp
    cwd: /tmp
`
    );

    expect(() => loadConfig(configPath)).toThrow(
      "'env' and 'cwd' are only allowed for stdio servers"
    );
  });

  test("substitutes env vars in stdio server env values", () => {
    process.env.TEST_STDIO_TOKEN = "secret-123";
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: github
    command: npx -y @modelcontextprotocol/server-github
    env:
      GITHUB_TOKEN: \${TEST_STDIO_TOKEN}
`
    );

    const config = loadConfig(configPath);

    expect(config.servers[0].env).toEqual({ GITHUB_TOKEN: "secret-123" });
    delete process.env.TEST_STDIO_TOKEN;
  });

  test("allows mixed HTTP and stdio servers", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
  - name: filesystem
    command: npx -y @modelcontextprotocol/server-filesystem /tmp
`
    );

    const config = loadConfig(configPath);

    expect(config.servers).toHaveLength(2);
    expect(config.servers[0].url).toBe("http://localhost:3001/mcp");
    expect(config.servers[0].command).toBeUndefined();
    expect(config.servers[1].command).toBe(
      "npx -y @modelcontextprotocol/server-filesystem /tmp"
    );
    expect(config.servers[1].url).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: Failures because `ServerConfig` doesn't have `command`/`env`/`cwd` fields and validation doesn't exist yet.

- [ ] **Step 3: Write the parseCommand helper**

Add this function to `src/config.ts` after the `substituteEnvVarsInObject` function:

```typescript
export function parseCommand(command: string): { command: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}
```

- [ ] **Step 4: Update ServerConfig interface and validation**

In `src/config.ts`, update the `ServerConfig` interface to:

```typescript
export interface ServerConfig {
  name: string;
  url?: string;
  command?: string;
  description?: string;
  env?: Record<string, string>;
  cwd?: string;
}
```

Replace the existing validation loop inside `loadConfig` (the `for (const server of servers)` block, currently lines 36-44) with:

```typescript
  const names = new Set<string>();
  for (const server of servers) {
    if (!server.name) {
      throw new Error(`Each server must have a 'name' field`);
    }
    const hasUrl = !!server.url;
    const hasCommand = !!server.command;
    if (hasUrl === hasCommand) {
      throw new Error(
        `Server '${server.name}' must have either 'url' or 'command', not ${hasUrl ? "both" : "neither"}`
      );
    }
    if (hasUrl && (server.env || server.cwd)) {
      throw new Error(
        `Server '${server.name}': 'env' and 'cwd' are only allowed for stdio servers (using 'command')`
      );
    }
    if (names.has(server.name)) {
      throw new Error(`Config has duplicate server name: '${server.name}'`);
    }
    names.add(server.name);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: All tests pass (existing + new).

- [ ] **Step 6: Write test for parseCommand**

Add to `tests/config.test.ts`, as a new `describe` block after the existing one. Also add the import at the top of the file:

```typescript
import { loadConfig, parseCommand } from "../src/config.js";
```

(Replace the existing `import { loadConfig } from "../src/config.js";` line.)

Then add at the end of the file:

```typescript
describe("parseCommand", () => {
  test("parses single-word command", () => {
    const result = parseCommand("node");
    expect(result).toEqual({ command: "node", args: [] });
  });

  test("parses command with arguments", () => {
    const result = parseCommand("npx -y @modelcontextprotocol/server-filesystem /tmp");
    expect(result).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
  });

  test("handles extra whitespace", () => {
    const result = parseCommand("  node   --inspect   server.js  ");
    expect(result).toEqual({
      command: "node",
      args: ["--inspect", "server.js"],
    });
  });
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add stdio server config support with validation"
```

---

### Task 2: BackendManager — connectStdio and onClose

**Files:**
- Modify: `src/backend.ts:1-82`
- Modify: `tests/backend.test.ts:1-103`

- [ ] **Step 1: Write failing tests for connectStdio**

Add the stdio transport mock at the top of `tests/backend.test.ts`, after the existing `vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", ...)` call:

```typescript
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
```

Then add these tests inside the existing `describe("BackendManager", ...)` block, after the last existing test:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/backend.test.ts`
Expected: Failures because `connectStdio` and `onClose` don't exist.

- [ ] **Step 3: Implement connectStdio and onClose in BackendManager**

Replace the entire contents of `src/backend.ts` with:

```typescript
// src/backend.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition } from "./registry.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class BackendManager {
  private clients = new Map<string, Client>();
  private transports = new Map<string, Transport>();
  private closeCallbacks = new Map<string, () => void>();

  async connect(name: string, url: string): Promise<ToolDefinition[]> {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    return this.connectWithTransport(name, transport);
  }

  async connectStdio(
    name: string,
    params: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  ): Promise<ToolDefinition[]> {
    const transport = new StdioClientTransport({
      command: params.command,
      args: params.args,
      env: params.env,
      cwd: params.cwd,
    });

    transport.onclose = () => {
      // Only fire crash callback if we still consider this client connected
      // (i.e., this wasn't a deliberate disconnect)
      if (this.clients.has(name)) {
        this.clients.delete(name);
        this.transports.delete(name);
        this.closeCallbacks.get(name)?.();
      }
    };

    return this.connectWithTransport(name, transport);
  }

  private async connectWithTransport(
    name: string,
    transport: Transport
  ): Promise<ToolDefinition[]> {
    const client = new Client({
      name: `mcp-gateway-${name}`,
      version: "0.1.0",
    });

    await client.connect(transport);
    this.clients.set(name, client);
    this.transports.set(name, transport);

    const response = await client.listTools();
    return response.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as ToolDefinition["inputSchema"],
    }));
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      this.clients.delete(name);
      this.transports.delete(name);
      this.closeCallbacks.delete(name);
      await client.close();
    }
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.clients.keys()];
    await Promise.all(names.map((name) => this.disconnect(name)));
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  }> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Backend server '${serverName}' is not connected`);
    }

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });
      return result as {
        content: Array<{ type: string; text?: string; [key: string]: unknown }>;
      };
    } catch (error) {
      throw new Error(
        `Backend server '${serverName}' is unreachable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async refreshTools(name: string): Promise<ToolDefinition[]> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`Backend server '${name}' is not connected`);
    }
    const response = await client.listTools();
    return response.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as ToolDefinition["inputSchema"],
    }));
  }

  isConnected(name: string): boolean {
    return this.clients.has(name);
  }

  onToolsChanged(name: string, callback: () => void): void {
    const client = this.clients.get(name);
    if (!client) return;
    client.setNotificationHandler(ToolListChangedNotificationSchema, callback);
  }

  onClose(name: string, callback: () => void): void {
    this.closeCallbacks.set(name, callback);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/backend.test.ts`
Expected: All tests pass (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/backend.ts tests/backend.test.ts
git commit -m "feat: add connectStdio and onClose to BackendManager"
```

---

### Task 3: index.ts — Connection Dispatch and Retry Logic

**Files:**
- Modify: `src/index.ts:1-229`

- [ ] **Step 1: Add parseCommand import**

At the top of `src/index.ts`, change line 1 from:

```typescript
import { loadConfig } from "./config.js";
```

to:

```typescript
import { loadConfig, parseCommand } from "./config.js";
```

- [ ] **Step 2: Add UnavailableEntry type and STDIO_MAX_RETRIES constant**

After the existing `RETRY_INTERVAL_MS` constant (line 12), add:

```typescript
const STDIO_MAX_RETRIES = 5;

interface UnavailableEntry {
  name: string;
  type: "http" | "stdio";
  url?: string;
  stdioParams?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
  };
  retryCount: number;
}
```

- [ ] **Step 3: Add connectServer helper inside main()**

Add this function inside `main()`, after the `subscribeToToolChanges` function (after line 56):

```typescript
  async function connectServer(
    serverConfig: ServerConfig
  ): Promise<{
    tools: import("./registry.js").ToolDefinition[];
    entry: UnavailableEntry;
  }> {
    if (serverConfig.url) {
      const tools = await backendManager.connect(
        serverConfig.name,
        serverConfig.url
      );
      return {
        tools,
        entry: {
          name: serverConfig.name,
          type: "http",
          url: serverConfig.url,
          retryCount: 0,
        },
      };
    } else {
      const parsed = parseCommand(serverConfig.command!);
      const stdioParams = {
        command: parsed.command,
        args: parsed.args,
        env: serverConfig.env,
        cwd: serverConfig.cwd,
      };
      const tools = await backendManager.connectStdio(
        serverConfig.name,
        stdioParams
      );
      return {
        tools,
        entry: {
          name: serverConfig.name,
          type: "stdio",
          stdioParams,
          retryCount: 0,
        },
      };
    }
  }
```

Also add the `ServerConfig` import. Change line 1 to:

```typescript
import { loadConfig, parseCommand, ServerConfig } from "./config.js";
```

- [ ] **Step 4: Add subscribeToCrash helper inside main()**

Add this function after `connectServer`, inside `main()`:

```typescript
  function subscribeToCrash(serverName: string, entry: UnavailableEntry) {
    if (entry.type !== "stdio") return;
    backendManager.onClose(serverName, async () => {
      console.warn(
        `Stdio backend '${serverName}' crashed, marking unavailable`
      );
      const toolNames = registry.getToolNamesForServer(serverName);
      sessions.deactivateServerToolsFromAll(toolNames);
      registry.markUnavailable(serverName);
      if (!unavailable.find((u) => u.name === serverName)) {
        unavailable.push({ ...entry, retryCount: 0 });
        startRetryLoop();
      }
      await server.notifyAllSessions();
    });
  }
```

- [ ] **Step 5: Replace the connection loop (lines 59-84)**

Replace the block from `// Connect to backends` through the end of the for loop with:

```typescript
  // Connect to backends
  const unavailable: UnavailableEntry[] = [];
  for (const serverConfig of config.servers) {
    try {
      const label = serverConfig.url ?? serverConfig.command;
      console.log(
        `Connecting to backend '${serverConfig.name}' (${label})`
      );
      const { tools, entry } = await connectServer(serverConfig);
      registry.registerServer(serverConfig.name, {
        description: serverConfig.description,
        tools,
      });
      console.log(
        `Connected to '${serverConfig.name}' — ${tools.length} tools registered`
      );

      subscribeToToolChanges(
        serverConfig.name,
        () =>
          config.servers.find((s) => s.name === serverConfig.name)?.description
      );
      subscribeToCrash(serverConfig.name, entry);
    } catch (error) {
      console.warn(
        `Failed to connect to '${serverConfig.name}': ${error instanceof Error ? error.message : error}`
      );
      registry.markUnavailable(serverConfig.name);
      if (serverConfig.url) {
        unavailable.push({
          name: serverConfig.name,
          type: "http",
          url: serverConfig.url,
          retryCount: 0,
        });
      } else {
        const parsed = parseCommand(serverConfig.command!);
        unavailable.push({
          name: serverConfig.name,
          type: "stdio",
          stdioParams: {
            command: parsed.command,
            args: parsed.args,
            env: serverConfig.env,
            cwd: serverConfig.cwd,
          },
          retryCount: 0,
        });
      }
    }
  }
```

- [ ] **Step 6: Replace the serverUrls + retry block (lines 86-118)**

Replace from `const serverUrls = ...` through `retryInterval.unref(); }` with:

```typescript
  const serverUrls = new Map(
    config.servers.filter((s) => s.url).map((s) => [s.name, s.url!])
  );
  server = new GatewayServer({
    registry,
    sessions,
    metaTools,
    router,
    serverUrls,
  });

  let retryInterval: ReturnType<typeof setInterval> | null = null;

  function startRetryLoop() {
    if (retryInterval || unavailable.length === 0) return;
    retryInterval = setInterval(async () => {
      for (let i = unavailable.length - 1; i >= 0; i--) {
        const entry = unavailable[i];

        if (entry.type === "stdio" && entry.retryCount >= STDIO_MAX_RETRIES) {
          console.error(
            `Server '${entry.name}' failed to start after ${STDIO_MAX_RETRIES} attempts, giving up. Fix the command and reload config.`
          );
          unavailable.splice(i, 1);
          continue;
        }

        try {
          let tools: import("./registry.js").ToolDefinition[];
          if (entry.type === "http") {
            tools = await backendManager.connect(entry.name, entry.url!);
          } else {
            tools = await backendManager.connectStdio(
              entry.name,
              entry.stdioParams!
            );
          }

          registry.removeServer(entry.name);
          registry.registerServer(entry.name, {
            description: config.servers.find((s) => s.name === entry.name)
              ?.description,
            tools,
          });
          subscribeToToolChanges(
            entry.name,
            () =>
              config.servers.find((s) => s.name === entry.name)?.description
          );
          subscribeToCrash(entry.name, entry);

          unavailable.splice(i, 1);
          console.log(
            `Reconnected to '${entry.name}' — ${tools.length} tools registered`
          );
          await server.notifyAllSessions();
        } catch {
          if (entry.type === "stdio") {
            entry.retryCount++;
          }
        }
      }
      if (unavailable.length === 0 && retryInterval) {
        clearInterval(retryInterval);
        retryInterval = null;
      }
    }, RETRY_INTERVAL_MS);
    retryInterval.unref();
  }

  startRetryLoop();
```

- [ ] **Step 7: Update the hot-reload handler**

In the config watcher callback, make these changes:

**7a.** In the "Remove servers no longer in config" loop, add stale entry cleanup. After `if (!newNames.has(name)) {`, add as the first line inside:

```typescript
          const staleIdx = unavailable.findIndex((u) => u.name === name);
          if (staleIdx !== -1) unavailable.splice(staleIdx, 1);
```

**7b.** Update the "Detect modified servers" condition. Replace:

```typescript
          if (oldSc && (oldSc.url !== sc.url || oldSc.description !== sc.description)) {
```

with:

```typescript
          if (
            oldSc &&
            (oldSc.url !== sc.url ||
              oldSc.command !== sc.command ||
              oldSc.description !== sc.description ||
              JSON.stringify(oldSc.env) !== JSON.stringify(sc.env) ||
              oldSc.cwd !== sc.cwd)
          ) {
```

**7c.** Inside the modified server reconnection block, add retry counter reset. After the opening brace of the `if (oldSc && ...)` block, add:

```typescript
            const staleIdx = unavailable.findIndex((u) => u.name === sc.name);
            if (staleIdx !== -1) unavailable.splice(staleIdx, 1);
```

**7d.** Replace the reconnection try/catch inside the modified server block. Replace:

```typescript
            try {
              const tools = await backendManager.connect(sc.name, sc.url);
              registry.registerServer(sc.name, {
                description: sc.description,
                tools,
              });
              subscribeToToolChanges(
                sc.name,
                () => config.servers.find((s) => s.name === sc.name)?.description
              );
              console.log(`Reconnected to '${sc.name}' — ${tools.length} tools`);
            } catch (error) {
              console.warn(`Failed to reconnect to '${sc.name}':`, error);
              registry.markUnavailable(sc.name);
            }
```

with:

```typescript
            try {
              const { tools, entry } = await connectServer(sc);
              registry.registerServer(sc.name, {
                description: sc.description,
                tools,
              });
              subscribeToToolChanges(
                sc.name,
                () =>
                  config.servers.find((s) => s.name === sc.name)?.description
              );
              subscribeToCrash(sc.name, entry);
              console.log(
                `Reconnected to '${sc.name}' — ${tools.length} tools`
              );
            } catch (error) {
              console.warn(`Failed to reconnect to '${sc.name}':`, error);
              registry.markUnavailable(sc.name);
            }
```

**7e.** Replace the "Add new servers" try/catch block similarly. Replace:

```typescript
          try {
            const tools = await backendManager.connect(sc.name, sc.url);
            registry.registerServer(sc.name, {
              description: sc.description,
              tools,
            });

            // Subscribe to tools/list_changed from backend
            subscribeToToolChanges(
              sc.name,
              () => config.servers.find((s) => s.name === sc.name)?.description
            );

            console.log(`Connected to '${sc.name}' — ${tools.length} tools`);
          } catch (error) {
            console.warn(`Failed to connect to '${sc.name}':`, error);
            registry.markUnavailable(sc.name);
          }
```

with:

```typescript
          try {
            const { tools, entry } = await connectServer(sc);
            registry.registerServer(sc.name, {
              description: sc.description,
              tools,
            });
            subscribeToToolChanges(
              sc.name,
              () =>
                config.servers.find((s) => s.name === sc.name)?.description
            );
            subscribeToCrash(sc.name, entry);
            console.log(
              `Connected to '${sc.name}' — ${tools.length} tools`
            );
          } catch (error) {
            console.warn(`Failed to connect to '${sc.name}':`, error);
            registry.markUnavailable(sc.name);
          }
```

- [ ] **Step 8: Run all tests to verify nothing is broken**

Run: `npx vitest run`
Expected: All existing tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts
git commit -m "feat: add stdio connection dispatch, retry cap, and crash recovery"
```

---

### Task 4: Integration Test — Stdio Backend End-to-End

**Files:**
- Create: `tests/helpers/stdio-echo-server.ts`
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Create the stdio echo server**

Create `tests/helpers/stdio-echo-server.ts`:

```typescript
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
```

- [ ] **Step 2: Add the stdio integration test**

Add these imports at the top of `tests/integration.test.ts`, after the existing imports:

```typescript
import { fileURLToPath } from "url";
import { dirname } from "path";
```

Add at the end of the file, after the closing `});` of the existing describe block:

```typescript
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Integration: Stdio backend end-to-end", () => {
  let gateway: GatewayServer;
  let gatewayPort: number;
  let backendManager: BackendManager;

  beforeAll(async () => {
    const registry = new ToolRegistry();
    const sessions = new SessionManager();
    const metaTools = new MetaToolHandler(registry, sessions);
    backendManager = new BackendManager();
    const router = new Router(registry, backendManager);

    gateway = new GatewayServer({
      registry,
      sessions,
      metaTools,
      router,
    });

    // Connect to the stdio test backend
    const serverPath = `${__dirname}/helpers/stdio-echo-server.ts`;
    const tools = await backendManager.connectStdio("stdio-test", {
      command: "npx",
      args: ["tsx", serverPath],
    });
    registry.registerServer("stdio-test", {
      description: "Stdio test backend",
      tools,
    });

    gatewayPort = await gateway.startMcp(0, "127.0.0.1");
  }, 30000);

  afterAll(async () => {
    await gateway.stop();
    await backendManager.disconnectAll();
  }, 15000);

  test("full flow with stdio backend: activate -> call -> deactivate", async () => {
    const client = new Client(
      { name: "stdio-test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${gatewayPort}/mcp`)
    );
    await client.connect(transport);

    try {
      // Should see 2 meta-tools with stdio-test.echo in the catalog
      const initialTools = await client.listTools();
      expect(initialTools.tools).toHaveLength(2);
      const activateDef = initialTools.tools.find(
        (t) => t.name === "activate_tool"
      )!;
      expect(activateDef.description).toContain("stdio-test.echo");

      // Activate
      const activateResult = await client.callTool({
        name: "activate_tool",
        arguments: { name: "stdio-test.echo" },
      });
      const activateData = JSON.parse(
        (activateResult.content as Array<{ type: string; text: string }>)[0]
          .text
      );
      expect(activateData.success).toBe(true);

      // Call
      const echoResult = await client.callTool({
        name: "stdio-test.echo",
        arguments: { message: "hello from stdio" },
      });
      expect(
        (echoResult.content as Array<{ type: string; text: string }>)[0].text
      ).toBe("stdio-echo: hello from stdio");

      // Deactivate
      await client.callTool({
        name: "deactivate_tool",
        arguments: { name: "stdio-test.echo" },
      });
      const finalTools = await client.listTools();
      expect(finalTools.tools).toHaveLength(2);
    } finally {
      await client.close();
    }
  }, 30000);
});
```

- [ ] **Step 3: Run the integration tests**

Run: `npx vitest run tests/integration.test.ts`
Expected: All tests pass, including the new stdio test.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/stdio-echo-server.ts tests/integration.test.ts
git commit -m "test: add stdio backend integration test"
```

---

### Task 5: Update Example Config and README

**Files:**
- Modify: `mcp-gateway.example.yaml`
- Modify: `README.md`

- [ ] **Step 1: Update example config**

Replace the contents of `mcp-gateway.example.yaml` with:

```yaml
# mcp-gateway.example.yaml
#
# MCP Gateway configuration
# Copy to mcp-gateway.yaml and adjust for your setup.

gateway:
  port: 8080
  host: "0.0.0.0"

servers:
  # Streamable HTTP backend
  - name: postgres
    url: http://localhost:3001/mcp
    # description: "Database tools" # optional — auto-generated from tool descriptions

  # Stdio backend — spawns a child process
  # - name: filesystem
  #   command: npx -y @modelcontextprotocol/server-filesystem /tmp
  #   description: "File system access"

  # Stdio backend with environment variables and working directory
  # - name: github
  #   command: npx -y @modelcontextprotocol/server-github
  #   env:
  #     GITHUB_TOKEN: ${GH_TOKEN}
  #   cwd: /opt/servers

  # Environment variables are supported in URLs too:
  # - name: internal
  #   url: ${INTERNAL_MCP_URL}
  #   description: "Internal company APIs"
```

- [ ] **Step 2: Update README config table**

In `README.md`, replace the Config File table with:

```markdown
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `gateway.port` | No | `8080` | Port to listen on |
| `gateway.host` | No | `0.0.0.0` | Host to bind to |
| `servers[].name` | Yes | -- | Unique server name (used as namespace prefix) |
| `servers[].url` | * | -- | Streamable HTTP URL of the backend MCP server |
| `servers[].command` | * | -- | Command to spawn a stdio MCP server (mutually exclusive with `url`) |
| `servers[].description` | No | Auto-generated | Human-readable description |
| `servers[].env` | No | -- | Environment variables for stdio servers |
| `servers[].cwd` | No | Inherited | Working directory for stdio servers |

\* Each server must have exactly one of `url` or `command`.
```

- [ ] **Step 3: Update README Quick Start config example**

Replace the YAML config block in the Quick Start section with:

```yaml
gateway:
  port: 8080
  host: "0.0.0.0"

servers:
  # Streamable HTTP backend
  - name: postgres
    url: http://localhost:3001/mcp

  # Stdio backend (spawns child process)
  - name: filesystem
    command: npx -y @modelcontextprotocol/server-filesystem /tmp

  # Stdio with environment variables
  - name: github
    command: npx -y @modelcontextprotocol/server-github
    env:
      GITHUB_TOKEN: ${GH_TOKEN}
```

- [ ] **Step 4: Add stdio to Features list**

In the Features section, add this bullet after "Tool namespacing":

```markdown
- **Stdio backend support** -- Connect to stdio-based MCP servers by specifying a `command` instead of a `url`. The gateway spawns and manages child processes automatically.
```

- [ ] **Step 5: Update Requirements section**

Replace:

```markdown
- Backend MCP servers must support Streamable HTTP transport
```

with:

```markdown
- Backend MCP servers must support Streamable HTTP or stdio transport
```

- [ ] **Step 6: Commit**

```bash
git add mcp-gateway.example.yaml README.md
git commit -m "docs: add stdio backend support to example config and README"
```
