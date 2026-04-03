# MCP Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP gateway server that orchestrates multiple backend MCP servers with progressive tool disclosure via meta-tools.

**Architecture:** Thin proxy — gateway holds tool metadata in memory, exposes 4 meta-tools for discovery/activation, and proxies tool calls to the correct backend. Five internal components: Config Loader, Tool Registry, Session Manager, Meta-Tool Handler, Router.

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk`, `yaml`, `chokidar`, `vitest`, `express`

**Spec:** `docs/superpowers/specs/2026-04-03-mcp-gateway-design.md`

---

## File Structure

```
src/
  index.ts              - Entry point: loads config, connects backends, starts server
  config.ts             - YAML parsing, env var substitution, config types
  registry.ts           - In-memory server/tool metadata index
  session.ts            - Per-session activated tool tracking
  meta-tools.ts         - list_servers, list_server_tools, activate_tool, deactivate_tool
  router.ts             - Tool name → backend mapping, proxy calls
  backend.ts            - MCP client connections to backends, retry logic
  server.ts             - Gateway MCP server, Streamable HTTP, capability check
tests/
  config.test.ts
  registry.test.ts
  session.test.ts
  meta-tools.test.ts
  router.test.ts
  backend.test.ts
  integration.test.ts
mcp-gateway.example.yaml  - Example configuration
package.json
tsconfig.json
vitest.config.ts
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "mcp-gateway",
  "version": "0.1.0",
  "description": "MCP gateway server with progressive tool disclosure",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "express": "^5.1.0",
    "yaml": "^2.7.1",
    "chokidar": "^4.0.3"
  },
  "devDependencies": {
    "@types/express": "^5.0.2",
    "@types/node": "^22.15.3",
    "tsx": "^4.19.4",
    "typescript": "^5.8.3",
    "vitest": "^3.1.2"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10000,
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.superpowers/
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules` created, `package-lock.json` generated, no errors

- [ ] **Step 6: Verify TypeScript compiles**

Run: `mkdir -p src && echo 'console.log("ok");' > src/index.ts && npx tsc`
Expected: `dist/index.js` created, no errors

- [ ] **Step 7: Verify vitest runs**

Run: `mkdir -p tests && echo 'import { test, expect } from "vitest"; test("setup", () => { expect(true).toBe(true); });' > tests/setup.test.ts && npx vitest run`
Expected: 1 test passes

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/index.ts tests/setup.test.ts
git commit -m "chore: scaffold project with TypeScript, vitest, MCP SDK"
```

---

### Task 2: Config Module

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests for config types and parsing**

```typescript
// tests/config.test.ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mcp-gateway-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parses minimal config with defaults", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
`
    );

    const config = loadConfig(configPath);

    expect(config.gateway.port).toBe(8080);
    expect(config.gateway.host).toBe("0.0.0.0");
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].name).toBe("postgres");
    expect(config.servers[0].url).toBe("http://localhost:3001/mcp");
    expect(config.servers[0].description).toBeUndefined();
  });

  test("parses full config", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
gateway:
  port: 9090
  host: "127.0.0.1"

servers:
  - name: postgres
    url: http://localhost:3001/mcp
    description: "Database tools"
  - name: github
    url: http://localhost:3002/mcp
`
    );

    const config = loadConfig(configPath);

    expect(config.gateway.port).toBe(9090);
    expect(config.gateway.host).toBe("127.0.0.1");
    expect(config.servers).toHaveLength(2);
    expect(config.servers[0].description).toBe("Database tools");
    expect(config.servers[1].description).toBeUndefined();
  });

  test("substitutes environment variables", () => {
    process.env.TEST_MCP_URL = "http://envhost:4000/mcp";
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: test
    url: \${TEST_MCP_URL}
`
    );

    const config = loadConfig(configPath);

    expect(config.servers[0].url).toBe("http://envhost:4000/mcp");
    delete process.env.TEST_MCP_URL;
  });

  test("throws on missing environment variable", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: test
    url: \${MISSING_VAR_THAT_DOES_NOT_EXIST}
`
    );

    expect(() => loadConfig(configPath)).toThrow("MISSING_VAR_THAT_DOES_NOT_EXIST");
  });

  test("throws on missing servers", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `gateway:\n  port: 8080`);

    expect(() => loadConfig(configPath)).toThrow();
  });

  test("throws on duplicate server names", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
  - name: postgres
    url: http://localhost:3002/mcp
`
    );

    expect(() => loadConfig(configPath)).toThrow("duplicate");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `loadConfig` not found

- [ ] **Step 3: Implement config module**

```typescript
// src/config.ts
import { readFileSync } from "fs";
import { parse } from "yaml";

export interface ServerConfig {
  name: string;
  url: string;
  description?: string;
}

export interface GatewayConfig {
  port: number;
  host: string;
}

export interface Config {
  gateway: GatewayConfig;
  servers: ServerConfig[];
}

export function loadConfig(filePath: string): Config {
  const raw = readFileSync(filePath, "utf-8");
  const substituted = substituteEnvVars(raw);
  const parsed = parse(substituted);

  const gateway: GatewayConfig = {
    port: parsed?.gateway?.port ?? 8080,
    host: parsed?.gateway?.host ?? "0.0.0.0",
  };

  const servers: ServerConfig[] = parsed?.servers;
  if (!servers || !Array.isArray(servers) || servers.length === 0) {
    throw new Error("Config must include at least one server in 'servers' array");
  }

  const names = new Set<string>();
  for (const server of servers) {
    if (!server.name || !server.url) {
      throw new Error(`Each server must have 'name' and 'url' fields`);
    }
    if (names.has(server.name)) {
      throw new Error(`Config has duplicate server name: '${server.name}'`);
    }
    names.add(server.name);
  }

  return { gateway, servers };
}

function substituteEnvVars(content: string): string {
  return content.replace(/\$\{(\w+)\}/g, (match, varName) => {
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(
        `Environment variable '${varName}' is not set. ` +
          `Referenced in config as \${${varName}}`
      );
    }
    return value;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: All 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config module with YAML parsing and env var substitution"
```

---

### Task 3: Tool Registry

**Files:**
- Create: `src/registry.ts`
- Create: `tests/registry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — `ToolRegistry` not found

- [ ] **Step 3: Implement Tool Registry**

```typescript
// src/registry.ts

export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

export interface ServerRegistration {
  description?: string;
  tools: ToolDefinition[];
}

export interface ServerInfo {
  name: string;
  description?: string;
  status: "available" | "unavailable";
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface ResolvedTool {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  serverName: string;
  originalName: string;
}

export class ToolRegistry {
  private servers = new Map<
    string,
    { description?: string; status: "available" | "unavailable"; tools: ToolDefinition[] }
  >();

  registerServer(name: string, registration: ServerRegistration): void {
    const description =
      registration.description ?? this.generateDescription(registration.tools);
    this.servers.set(name, {
      description,
      status: "available",
      tools: registration.tools,
    });
  }

  markUnavailable(name: string): void {
    this.servers.set(name, {
      description: undefined,
      status: "unavailable",
      tools: [],
    });
  }

  removeServer(name: string): void {
    this.servers.delete(name);
  }

  listServers(): ServerInfo[] {
    const result: ServerInfo[] = [];
    for (const [name, entry] of this.servers) {
      result.push({
        name,
        description: entry.description,
        status: entry.status,
      });
    }
    return result;
  }

  listServerTools(serverName: string): ToolInfo[] {
    const entry = this.servers.get(serverName);
    if (!entry) {
      throw new Error(`Server '${serverName}' not found`);
    }
    if (entry.status === "unavailable") {
      throw new Error(`Server '${serverName}' is currently unavailable`);
    }
    return entry.tools.map((t) => ({
      name: `${serverName}.${t.name}`,
      description: t.description,
    }));
  }

  getTool(namespacedName: string): ResolvedTool | undefined {
    const dotIndex = namespacedName.indexOf(".");
    if (dotIndex === -1) return undefined;

    const serverName = namespacedName.substring(0, dotIndex);
    const toolName = namespacedName.substring(dotIndex + 1);

    const entry = this.servers.get(serverName);
    if (!entry || entry.status === "unavailable") return undefined;

    const tool = entry.tools.find((t) => t.name === toolName);
    if (!tool) return undefined;

    return {
      name: namespacedName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      serverName,
      originalName: toolName,
    };
  }

  getToolNamesForServer(serverName: string): string[] {
    const entry = this.servers.get(serverName);
    if (!entry) return [];
    return entry.tools.map((t) => `${serverName}.${t.name}`);
  }

  private generateDescription(tools: ToolDefinition[]): string {
    const parts = tools.map((t) => `${t.name} - ${t.description}`);
    const full = `Provides tools: ${parts.join(", ")}`;
    if (full.length <= 200) return full;

    let truncated = full.substring(0, 200);
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > 100) {
      truncated = truncated.substring(0, lastSpace);
    }
    return truncated + "...";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/registry.test.ts`
Expected: All 11 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts tests/registry.test.ts
git commit -m "feat: add tool registry with server/tool indexing and auto-descriptions"
```

---

### Task 4: Session Manager

**Files:**
- Create: `src/session.ts`
- Create: `tests/session.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/session.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { SessionManager } from "../src/session.js";

describe("SessionManager", () => {
  let sessions: SessionManager;

  beforeEach(() => {
    sessions = new SessionManager();
  });

  test("creates a session", () => {
    const id = sessions.createSession();
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
  });

  test("activates a tool for a session", () => {
    const id = sessions.createSession();
    sessions.activateTool(id, "postgres.query");

    expect(sessions.getActivatedTools(id)).toEqual(["postgres.query"]);
  });

  test("deactivates a tool for a session", () => {
    const id = sessions.createSession();
    sessions.activateTool(id, "postgres.query");
    sessions.deactivateTool(id, "postgres.query");

    expect(sessions.getActivatedTools(id)).toEqual([]);
  });

  test("throws when activating already active tool", () => {
    const id = sessions.createSession();
    sessions.activateTool(id, "postgres.query");

    expect(() => sessions.activateTool(id, "postgres.query")).toThrow("already activated");
  });

  test("throws when deactivating inactive tool", () => {
    const id = sessions.createSession();

    expect(() => sessions.deactivateTool(id, "postgres.query")).toThrow("not activated");
  });

  test("throws for unknown session", () => {
    expect(() => sessions.getActivatedTools("unknown")).toThrow("not found");
  });

  test("removes a session", () => {
    const id = sessions.createSession();
    sessions.activateTool(id, "postgres.query");
    sessions.removeSession(id);

    expect(() => sessions.getActivatedTools(id)).toThrow("not found");
  });

  test("isToolActivated returns correct state", () => {
    const id = sessions.createSession();
    expect(sessions.isToolActivated(id, "postgres.query")).toBe(false);

    sessions.activateTool(id, "postgres.query");
    expect(sessions.isToolActivated(id, "postgres.query")).toBe(true);
  });

  test("deactivates a tool across all sessions", () => {
    const id1 = sessions.createSession();
    const id2 = sessions.createSession();
    sessions.activateTool(id1, "postgres.query");
    sessions.activateTool(id2, "postgres.query");
    sessions.activateTool(id2, "postgres.list_tables");

    const affected = sessions.deactivateToolFromAll("postgres.query");

    expect(affected).toEqual([id1, id2]);
    expect(sessions.getActivatedTools(id1)).toEqual([]);
    expect(sessions.getActivatedTools(id2)).toEqual(["postgres.list_tables"]);
  });

  test("deactivates all tools for a server across all sessions", () => {
    const id1 = sessions.createSession();
    const id2 = sessions.createSession();
    sessions.activateTool(id1, "postgres.query");
    sessions.activateTool(id1, "github.repos");
    sessions.activateTool(id2, "postgres.list_tables");

    const affected = sessions.deactivateServerToolsFromAll(["postgres.query", "postgres.list_tables"]);

    expect(affected).toContain(id1);
    expect(affected).toContain(id2);
    expect(sessions.getActivatedTools(id1)).toEqual(["github.repos"]);
    expect(sessions.getActivatedTools(id2)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — `SessionManager` not found

- [ ] **Step 3: Implement Session Manager**

```typescript
// src/session.ts
import { randomUUID } from "crypto";

export class SessionManager {
  private sessions = new Map<string, Set<string>>();

  createSession(): string {
    const id = randomUUID();
    this.sessions.set(id, new Set());
    return id;
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  activateTool(sessionId: string, toolName: string): void {
    const tools = this.getSession(sessionId);
    if (tools.has(toolName)) {
      throw new Error(`Tool '${toolName}' is already activated`);
    }
    tools.add(toolName);
  }

  deactivateTool(sessionId: string, toolName: string): void {
    const tools = this.getSession(sessionId);
    if (!tools.has(toolName)) {
      throw new Error(`Tool '${toolName}' is not activated`);
    }
    tools.delete(toolName);
  }

  isToolActivated(sessionId: string, toolName: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.has(toolName);
  }

  getActivatedTools(sessionId: string): string[] {
    return [...this.getSession(sessionId)];
  }

  deactivateToolFromAll(toolName: string): string[] {
    const affected: string[] = [];
    for (const [sessionId, tools] of this.sessions) {
      if (tools.has(toolName)) {
        tools.delete(toolName);
        affected.push(sessionId);
      }
    }
    return affected;
  }

  deactivateServerToolsFromAll(toolNames: string[]): string[] {
    const nameSet = new Set(toolNames);
    const affected = new Set<string>();
    for (const [sessionId, tools] of this.sessions) {
      for (const name of nameSet) {
        if (tools.has(name)) {
          tools.delete(name);
          affected.add(sessionId);
        }
      }
    }
    return [...affected];
  }

  private getSession(sessionId: string): Set<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    return session;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/session.test.ts`
Expected: All 10 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/session.ts tests/session.test.ts
git commit -m "feat: add session manager for per-client tool activation tracking"
```

---

### Task 5: Backend Manager

**Files:**
- Create: `src/backend.ts`
- Create: `tests/backend.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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

  beforeEach(() => {
    manager = new BackendManager();
    const mod = vi.mocked(await import("@modelcontextprotocol/sdk/client/index.js"));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/backend.test.ts`
Expected: FAIL — `BackendManager` not found

- [ ] **Step 3: Implement Backend Manager**

```typescript
// src/backend.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolDefinition } from "./registry.js";

export class BackendManager {
  private clients = new Map<string, Client>();

  async connect(name: string, url: string): Promise<ToolDefinition[]> {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ name: `mcp-gateway-${name}`, version: "0.1.0" });

    await client.connect(transport);
    this.clients.set(name, client);

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
      await client.close();
      this.clients.delete(name);
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
  ): Promise<{ content: Array<{ type: string; text?: string; [key: string]: unknown }> }> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Backend server '${serverName}' is not connected`);
    }

    try {
      const result = await client.callTool({ name: toolName, arguments: args });
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
    client.setNotificationHandler(
      { method: "notifications/tools/list_changed" },
      callback
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/backend.test.ts`
Expected: All 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/backend.ts tests/backend.test.ts
git commit -m "feat: add backend manager for MCP client connections to sub-servers"
```

---

### Task 6: Meta-Tools

**Files:**
- Create: `src/meta-tools.ts`
- Create: `tests/meta-tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
      const result = handler.listServerTools(sessionId, "postgres");
      expect(result.server).toBe("postgres");
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe("postgres.query");
    });

    test("throws for unknown server", () => {
      expect(() => handler.listServerTools(sessionId, "unknown")).toThrow("not found");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/meta-tools.test.ts`
Expected: FAIL — `MetaToolHandler` not found

- [ ] **Step 3: Implement Meta-Tools**

```typescript
// src/meta-tools.ts
import { ToolRegistry, ResolvedTool, ToolSchema } from "./registry.js";
import { SessionManager } from "./session.js";

interface ToolDefinitionOutput {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

export class MetaToolHandler {
  constructor(
    private registry: ToolRegistry,
    private sessions: SessionManager
  ) {}

  listServers(): { servers: Array<{ name: string; description?: string; status: string }> } {
    return { servers: this.registry.listServers() };
  }

  listServerTools(
    sessionId: string,
    serverName: string
  ): { server: string; tools: Array<{ name: string; description: string }> } {
    const tools = this.registry.listServerTools(serverName);
    return { server: serverName, tools };
  }

  activateTool(
    sessionId: string,
    toolName: string
  ): { success: true; tool: ToolDefinitionOutput } {
    const tool = this.registry.getTool(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found`);
    }
    this.sessions.activateTool(sessionId, toolName);
    return {
      success: true,
      tool: {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
    };
  }

  deactivateTool(sessionId: string, toolName: string): { success: true } {
    this.sessions.deactivateTool(sessionId, toolName);
    return { success: true };
  }

  getToolDefinitions(): ToolDefinitionOutput[] {
    return [
      {
        name: "list_servers",
        description:
          "List all available backend MCP servers with their descriptions and status. Call this first to discover what servers are available.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_server_tools",
        description:
          "List all tools available on a specific server. Returns tool names and descriptions. Use this to explore a server's capabilities before activating individual tools.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Server name from list_servers()",
            },
          },
          required: ["server"],
        },
      },
      {
        name: "activate_tool",
        description:
          "Activate a tool for use in this session. Once activated, the tool appears in your available tools and can be called directly. Returns the full tool schema.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Namespaced tool name (e.g., 'postgres.query'). Get names from list_server_tools().",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "deactivate_tool",
        description:
          "Remove a previously activated tool from this session. Use this when you no longer need a tool to keep your tool list clean.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Namespaced tool name to deactivate",
            },
          },
          required: ["name"],
        },
      },
    ];
  }

  getActivatedToolDefinitions(sessionId: string): ToolDefinitionOutput[] {
    const toolNames = this.sessions.getActivatedTools(sessionId);
    const definitions: ToolDefinitionOutput[] = [];
    for (const name of toolNames) {
      const tool = this.registry.getTool(name);
      if (tool) {
        definitions.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return definitions;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/meta-tools.test.ts`
Expected: All 9 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/meta-tools.ts tests/meta-tools.test.ts
git commit -m "feat: add meta-tool handler for discovery, activation, and deactivation"
```

---

### Task 7: Router

**Files:**
- Create: `src/router.ts`
- Create: `tests/router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/router.test.ts`
Expected: FAIL — `Router` not found

- [ ] **Step 3: Implement Router**

```typescript
// src/router.ts
import { ToolRegistry } from "./registry.js";
import { BackendManager } from "./backend.js";

export interface RouteTarget {
  serverName: string;
  toolName: string;
}

export class Router {
  constructor(
    private registry: ToolRegistry,
    private backendManager: BackendManager
  ) {}

  resolve(namespacedName: string): RouteTarget | undefined {
    const tool = this.registry.getTool(namespacedName);
    if (!tool) return undefined;
    return {
      serverName: tool.serverName,
      toolName: tool.originalName,
    };
  }

  async routeToolCall(
    namespacedName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text?: string; [key: string]: unknown }> }> {
    const target = this.resolve(namespacedName);
    if (!target) {
      throw new Error(`Tool '${namespacedName}' not found`);
    }
    return this.backendManager.callTool(target.serverName, target.toolName, args);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/router.test.ts`
Expected: All 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/router.ts tests/router.test.ts
git commit -m "feat: add router for namespaced tool call proxying to backends"
```

---

### Task 8: Gateway Server

**Files:**
- Create: `src/server.ts`
- Create: `tests/server.test.ts`

This is the central module. It creates the MCP server with Streamable HTTP transport, registers meta-tools, handles `tools/list` dynamically per session, checks client capabilities, and wires everything together.

- [ ] **Step 1: Write failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — `GatewayServer` not found

- [ ] **Step 3: Implement Gateway Server**

```typescript
// src/server.ts
import express from "express";
import { Server } from "http";
import { ToolRegistry } from "./registry.js";
import { SessionManager } from "./session.js";
import { MetaToolHandler } from "./meta-tools.js";
import { Router } from "./router.js";

interface ToolDefinitionOutput {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

interface GatewayServerOptions {
  registry: ToolRegistry;
  sessions: SessionManager;
  metaTools: MetaToolHandler;
  router: Router;
}

const META_TOOL_NAMES = new Set([
  "list_servers",
  "list_server_tools",
  "activate_tool",
  "deactivate_tool",
]);

export class GatewayServer {
  private registry: ToolRegistry;
  private sessions: SessionManager;
  private metaTools: MetaToolHandler;
  private router: Router;
  private httpServer: Server | null = null;

  constructor(options: GatewayServerOptions) {
    this.registry = options.registry;
    this.sessions = options.sessions;
    this.metaTools = options.metaTools;
    this.router = options.router;
  }

  getToolsForSession(sessionId: string): ToolDefinitionOutput[] {
    const metaToolDefs = this.metaTools.getToolDefinitions();
    const activatedDefs = this.metaTools.getActivatedToolDefinitions(sessionId);
    return [...metaToolDefs, ...activatedDefs];
  }

  async handleToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    try {
      if (META_TOOL_NAMES.has(toolName)) {
        return this.handleMetaToolCall(sessionId, toolName, args);
      }

      // Check if tool is activated for this session
      if (!this.sessions.isToolActivated(sessionId, toolName)) {
        return {
          content: [
            {
              type: "text",
              text: `Tool '${toolName}' is not activated. Call activate_tool first.`,
            },
          ],
          isError: true,
        };
      }

      const result = await this.router.routeToolCall(toolName, args);
      return result;
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  }

  private handleMetaToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): ToolCallResult {
    let result: unknown;

    switch (toolName) {
      case "list_servers":
        result = this.metaTools.listServers();
        break;
      case "list_server_tools":
        result = this.metaTools.listServerTools(sessionId, args.server as string);
        break;
      case "activate_tool":
        result = this.metaTools.activateTool(sessionId, args.name as string);
        break;
      case "deactivate_tool":
        result = this.metaTools.deactivateTool(sessionId, args.name as string);
        break;
      default:
        throw new Error(`Unknown meta-tool: ${toolName}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  async start(port: number, host: string): Promise<void> {
    // Full MCP Streamable HTTP integration will be wired in Task 9
    const app = express();
    this.httpServer = app.listen(port, host);
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => resolve());
      });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server.test.ts`
Expected: All 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: add gateway server with meta-tool dispatch and session-aware tool list"
```

---

### Task 9: MCP Protocol Integration & HTTP Transport

**Files:**
- Modify: `src/server.ts`
- Create: `tests/integration.test.ts`

Wire the gateway server to the MCP SDK's Streamable HTTP transport so it actually serves MCP protocol over HTTP. This integrates `tools/list`, `tools/call`, `tools/list_changed` notifications, and client capability checking.

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration.test.ts
import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { Server } from "http";
import { ToolRegistry } from "../src/registry.js";
import { SessionManager } from "../src/session.js";
import { MetaToolHandler } from "../src/meta-tools.js";
import { Router } from "../src/router.js";
import { BackendManager } from "../src/backend.js";
import { GatewayServer } from "../src/server.js";

describe("Integration", () => {
  let mockBackendServer: Server;
  let gatewayHttpServer: Server;
  let backendPort: number;
  let gatewayPort: number;

  // Start a mock backend MCP server
  async function startMockBackend(): Promise<number> {
    const app = express();
    app.use(express.json());

    const mcpServer = new McpServer({ name: "mock-postgres", version: "1.0.0" });

    mcpServer.tool(
      "query",
      "Execute SQL against PostgreSQL",
      {
        sql: { type: "string", description: "SQL query" },
      },
      async (args) => ({
        content: [{ type: "text", text: `Result of: ${args.sql}` }],
      })
    );

    mcpServer.tool(
      "list_tables",
      "List all tables",
      {},
      async () => ({
        content: [{ type: "text", text: "users, orders, products" }],
      })
    );

    const transports = new Map<string, StreamableHTTPServerTransport>();

    app.post("/mcp", async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };
        await mcpServer.connect(transport);
        if (transport.sessionId) {
          transports.set(transport.sessionId, transport);
        }
      }

      await transport.handleRequest(req, res, req.body);
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

    return new Promise((resolve) => {
      mockBackendServer = app.listen(0, () => {
        const addr = mockBackendServer.address();
        resolve(typeof addr === "object" ? addr!.port : 0);
      });
    });
  }

  beforeEach(async () => {
    backendPort = await startMockBackend();
  });

  afterEach(async () => {
    if (gatewayHttpServer) {
      await new Promise<void>((r) => gatewayHttpServer.close(() => r()));
    }
    if (mockBackendServer) {
      await new Promise<void>((r) => mockBackendServer.close(() => r()));
    }
  });

  test("rejects clients without tools.listChanged capability", async () => {
    const registry = new ToolRegistry();
    const sessions = new SessionManager();
    const metaTools = new MetaToolHandler(registry, sessions);
    const backendManager = new BackendManager();
    const router = new Router(registry, backendManager);

    const server = new GatewayServer({ registry, sessions, metaTools, router });
    const port = await server.startMcp(0, "127.0.0.1");
    gatewayHttpServer = server.getHttpServer()!;

    // Client without tools.listChanged capability
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`)
    );

    // Connection should fail or the server should close it
    await expect(client.connect(transport)).rejects.toThrow();

    await server.stop();
  });

  test("full discovery → activation → execution flow", async () => {
    // Setup gateway
    const registry = new ToolRegistry();
    const sessions = new SessionManager();
    const metaTools = new MetaToolHandler(registry, sessions);
    const backendManager = new BackendManager();
    const router = new Router(registry, backendManager);

    // Connect to mock backend
    const tools = await backendManager.connect(
      "postgres",
      `http://localhost:${backendPort}/mcp`
    );
    registry.registerServer("postgres", { description: "Database tools", tools });

    const server = new GatewayServer({ registry, sessions, metaTools, router });
    gatewayPort = await server.startMcp(0, "127.0.0.1");
    gatewayHttpServer = server.getHttpServer()!;

    // Connect client to gateway
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${gatewayPort}/mcp`)
    );
    await client.connect(transport);

    // Step 1: List tools — should only see meta-tools
    const initialTools = await client.listTools();
    const initialNames = initialTools.tools.map((t) => t.name);
    expect(initialNames).toContain("list_servers");
    expect(initialNames).toContain("activate_tool");
    expect(initialNames).not.toContain("postgres.query");

    // Step 2: Discover servers
    const serversResult = await client.callTool({
      name: "list_servers",
      arguments: {},
    });
    const servers = JSON.parse((serversResult.content as any)[0].text);
    expect(servers.servers[0].name).toBe("postgres");

    // Step 3: Discover server tools
    const toolsResult = await client.callTool({
      name: "list_server_tools",
      arguments: { server: "postgres" },
    });
    const serverTools = JSON.parse((toolsResult.content as any)[0].text);
    expect(serverTools.tools[0].name).toBe("postgres.query");

    // Step 4: Activate tool
    const activateResult = await client.callTool({
      name: "activate_tool",
      arguments: { name: "postgres.query" },
    });
    const activated = JSON.parse((activateResult.content as any)[0].text);
    expect(activated.success).toBe(true);

    // Step 5: Tool should now appear in tools/list
    const updatedTools = await client.listTools();
    const updatedNames = updatedTools.tools.map((t) => t.name);
    expect(updatedNames).toContain("postgres.query");

    // Step 6: Call the activated tool
    const queryResult = await client.callTool({
      name: "postgres.query",
      arguments: { sql: "SELECT 1" },
    });
    expect((queryResult.content as any)[0].text).toBe("Result of: SELECT 1");

    // Step 7: Deactivate
    await client.callTool({
      name: "deactivate_tool",
      arguments: { name: "postgres.query" },
    });
    const finalTools = await client.listTools();
    const finalNames = finalTools.tools.map((t) => t.name);
    expect(finalNames).not.toContain("postgres.query");

    await client.close();
    await backendManager.disconnectAll();
  });
});
```

- [ ] **Step 2: Run integration test to verify it fails**

Run: `npx vitest run tests/integration.test.ts`
Expected: FAIL — `startMcp` and `getHttpServer` methods don't exist on `GatewayServer`

- [ ] **Step 3: Update GatewayServer with full MCP protocol integration**

Replace the `start` and `stop` methods in `src/server.ts` and add MCP protocol wiring:

```typescript
// src/server.ts
import express, { Request, Response } from "express";
import { Server } from "http";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolRegistry } from "./registry.js";
import { SessionManager } from "./session.js";
import { MetaToolHandler } from "./meta-tools.js";
import { Router } from "./router.js";

interface ToolDefinitionOutput {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

interface GatewayServerOptions {
  registry: ToolRegistry;
  sessions: SessionManager;
  metaTools: MetaToolHandler;
  router: Router;
}

const META_TOOL_NAMES = new Set([
  "list_servers",
  "list_server_tools",
  "activate_tool",
  "deactivate_tool",
]);

interface SessionState {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
}

export class GatewayServer {
  private registry: ToolRegistry;
  private sessions: SessionManager;
  private metaTools: MetaToolHandler;
  private router: Router;
  private httpServer: Server | null = null;
  private sessionStates = new Map<string, SessionState>();

  constructor(options: GatewayServerOptions) {
    this.registry = options.registry;
    this.sessions = options.sessions;
    this.metaTools = options.metaTools;
    this.router = options.router;
  }

  getToolsForSession(sessionId: string): ToolDefinitionOutput[] {
    const metaToolDefs = this.metaTools.getToolDefinitions();
    const activatedDefs = this.metaTools.getActivatedToolDefinitions(sessionId);
    return [...metaToolDefs, ...activatedDefs];
  }

  async handleToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    try {
      if (META_TOOL_NAMES.has(toolName)) {
        const result = this.handleMetaToolCall(sessionId, toolName, args);

        // Emit tools/list_changed for activate/deactivate
        if (toolName === "activate_tool" || toolName === "deactivate_tool") {
          await this.notifyToolListChanged(sessionId);
        }

        return result;
      }

      if (!this.sessions.isToolActivated(sessionId, toolName)) {
        return {
          content: [
            {
              type: "text",
              text: `Tool '${toolName}' is not activated. Call activate_tool first.`,
            },
          ],
          isError: true,
        };
      }

      const result = await this.router.routeToolCall(toolName, args);
      return result;
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  }

  private handleMetaToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): ToolCallResult {
    let result: unknown;

    switch (toolName) {
      case "list_servers":
        result = this.metaTools.listServers();
        break;
      case "list_server_tools":
        result = this.metaTools.listServerTools(sessionId, args.server as string);
        break;
      case "activate_tool":
        result = this.metaTools.activateTool(sessionId, args.name as string);
        break;
      case "deactivate_tool":
        result = this.metaTools.deactivateTool(sessionId, args.name as string);
        break;
      default:
        throw new Error(`Unknown meta-tool: ${toolName}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  private async notifyToolListChanged(sessionId: string): Promise<void> {
    const state = this.findSessionStateBySessionId(sessionId);
    if (state) {
      await state.mcpServer.server.sendToolListChanged();
    }
  }

  async notifyToolListChangedForSessions(sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.notifyToolListChanged(sessionId);
    }
  }

  private findSessionStateBySessionId(sessionId: string): SessionState | undefined {
    for (const state of this.sessionStates.values()) {
      if (state.sessionId === sessionId) return state;
    }
    return undefined;
  }

  async startMcp(port: number, host: string): Promise<number> {
    const app = express();
    app.use(express.json());

    app.post("/mcp", async (req: Request, res: Response) => {
      const existingSessionId = req.headers["mcp-session-id"] as string | undefined;

      if (existingSessionId && this.sessionStates.has(existingSessionId)) {
        const state = this.sessionStates.get(existingSessionId)!;
        await state.transport.handleRequest(req, res, req.body);
        return;
      }

      // New session
      const gatewaySessionId = this.sessions.createSession();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const mcpServer = this.createMcpServerForSession(gatewaySessionId);
      await mcpServer.connect(transport);

      // Check client capabilities — reject if tools.listChanged not supported
      // The MCP SDK stores client capabilities after initialize handshake.
      // Access via mcpServer.server.getClientCapabilities() or similar.
      // If not available, check the initialize request params in a custom handler.
      // Implementation note: the exact API depends on SDK version. If
      // getClientCapabilities() is not available, wrap the initialize handler
      // to inspect request.params.capabilities.tools.listChanged and throw
      // an McpError with InvalidRequest code if missing.

      const transportSessionId = transport.sessionId!;
      this.sessionStates.set(transportSessionId, {
        sessionId: gatewaySessionId,
        transport,
        mcpServer,
      });

      transport.onclose = () => {
        this.sessionStates.delete(transportSessionId);
        this.sessions.removeSession(gatewaySessionId);
      };

      await transport.handleRequest(req, res, req.body);
    });

    app.get("/mcp", async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string;
      const state = this.sessionStates.get(sessionId);
      if (state) {
        await state.transport.handleRequest(req, res);
      } else {
        res.status(400).json({ error: "No active session" });
      }
    });

    app.delete("/mcp", async (req: Request, res: Response) => {
      const sessionId = req.headers["mcp-session-id"] as string;
      const state = this.sessionStates.get(sessionId);
      if (state) {
        await state.transport.handleRequest(req, res);
        this.sessionStates.delete(sessionId);
        this.sessions.removeSession(state.sessionId);
      } else {
        res.status(400).json({ error: "No active session" });
      }
    });

    return new Promise((resolve) => {
      this.httpServer = app.listen(port, host, () => {
        const addr = this.httpServer!.address();
        const actualPort = typeof addr === "object" ? addr!.port : port;
        resolve(actualPort);
      });
    });
  }

  private createMcpServerForSession(gatewaySessionId: string): McpServer {
    const self = this;
    const mcpServer = new McpServer(
      { name: "mcp-gateway", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } }
    );

    // Register meta-tools
    const metaToolDefs = this.metaTools.getToolDefinitions();
    for (const def of metaToolDefs) {
      mcpServer.tool(
        def.name,
        def.description,
        def.inputSchema.properties as Record<string, any>,
        async (args) => {
          const result = await self.handleToolCall(gatewaySessionId, def.name, args);
          return result;
        }
      );
    }

    // Override the tools/list handler to include activated tools
    const originalServer = mcpServer.server;
    originalServer.setRequestHandler(
      { method: "tools/list" } as any,
      async () => {
        const tools = self.getToolsForSession(gatewaySessionId);
        return { tools };
      }
    );

    // Override the tools/call handler
    originalServer.setRequestHandler(
      { method: "tools/call" } as any,
      async (request: any) => {
        const { name, arguments: args } = request.params;
        return await self.handleToolCall(gatewaySessionId, name, args ?? {});
      }
    );

    return mcpServer;
  }

  getHttpServer(): Server | null {
    return this.httpServer;
  }

  async start(port: number, host: string): Promise<void> {
    await this.startMcp(port, host);
  }

  async stop(): Promise<void> {
    for (const state of this.sessionStates.values()) {
      await state.mcpServer.close();
    }
    this.sessionStates.clear();

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => resolve());
      });
    }
  }
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All unit tests pass. Integration test passes — full discovery → activation → execution → deactivation flow works end to end.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/integration.test.ts
git commit -m "feat: wire MCP protocol with Streamable HTTP transport and add integration test"
```

---

### Task 10: Config Hot Reload

**Files:**
- Create: `src/watcher.ts`
- Create: `tests/watcher.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/watcher.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigWatcher } from "../src/watcher.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ConfigWatcher", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mcp-gateway-watcher-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "config.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("calls onChange when config file changes", async () => {
    writeFileSync(
      configPath,
      `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
`
    );

    const onChange = vi.fn();
    const watcher = new ConfigWatcher(configPath, onChange);
    watcher.start();

    // Modify the file
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(
      configPath,
      `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
  - name: github
    url: http://localhost:3002/mcp
`
    );

    // Wait for the watcher to fire
    await new Promise((r) => setTimeout(r, 1000));
    watcher.stop();

    expect(onChange).toHaveBeenCalled();
  });

  test("does not crash on invalid config during reload", async () => {
    writeFileSync(
      configPath,
      `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
`
    );

    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = new ConfigWatcher(configPath, onChange, onError);
    watcher.start();

    // Write invalid config
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(configPath, `invalid: [yaml: {{`);

    await new Promise((r) => setTimeout(r, 1000));
    watcher.stop();

    // onChange should not have been called, onError should have been called
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/watcher.test.ts`
Expected: FAIL — `ConfigWatcher` not found

- [ ] **Step 3: Implement ConfigWatcher**

```typescript
// src/watcher.ts
import { watch, FSWatcher } from "chokidar";
import { loadConfig, Config } from "./config.js";

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private configPath: string,
    private onChange: (config: Config) => void,
    private onError?: (error: Error) => void
  ) {}

  start(): void {
    this.watcher = watch(this.configPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    this.watcher.on("change", () => {
      try {
        const config = loadConfig(this.configPath);
        this.onChange(config);
      } catch (error) {
        if (this.onError) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/watcher.test.ts`
Expected: All 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/watcher.ts tests/watcher.test.ts
git commit -m "feat: add config file watcher for hot reload support"
```

---

### Task 11: Entry Point & Startup Orchestration

**Files:**
- Modify: `src/index.ts`
- Create: `mcp-gateway.example.yaml`

- [ ] **Step 1: Create example config**

```yaml
# mcp-gateway.example.yaml
#
# MCP Gateway configuration
# Copy to mcp-gateway.yaml and adjust for your setup.

gateway:
  port: 8080
  host: "0.0.0.0"

servers:
  - name: postgres
    url: http://localhost:3001/mcp
    # description: "Database tools" # optional — auto-generated from tool descriptions

  # Environment variables are supported:
  # - name: internal
  #   url: ${INTERNAL_MCP_URL}
  #   description: "Internal company APIs"
```

- [ ] **Step 2: Implement entry point**

```typescript
// src/index.ts
import { loadConfig } from "./config.js";
import { ToolRegistry } from "./registry.js";
import { SessionManager } from "./session.js";
import { MetaToolHandler } from "./meta-tools.js";
import { BackendManager } from "./backend.js";
import { Router } from "./router.js";
import { GatewayServer } from "./server.js";
import { ConfigWatcher } from "./watcher.js";

const CONFIG_PATH = process.env.MCP_GATEWAY_CONFIG ?? "mcp-gateway.yaml";
const RETRY_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  console.log(`Loading config from ${CONFIG_PATH}`);
  const config = loadConfig(CONFIG_PATH);

  const registry = new ToolRegistry();
  const sessions = new SessionManager();
  const metaTools = new MetaToolHandler(registry, sessions);
  const backendManager = new BackendManager();
  const router = new Router(registry, backendManager);

  // Connect to backends
  const unavailable: Array<{ name: string; url: string }> = [];
  for (const serverConfig of config.servers) {
    try {
      console.log(`Connecting to backend '${serverConfig.name}' at ${serverConfig.url}`);
      const tools = await backendManager.connect(serverConfig.name, serverConfig.url);
      registry.registerServer(serverConfig.name, {
        description: serverConfig.description,
        tools,
      });
      console.log(
        `Connected to '${serverConfig.name}' — ${tools.length} tools registered`
      );

      // Subscribe to tools/list_changed from backend
      backendManager.onToolsChanged(serverConfig.name, async () => {
        console.log(`Backend '${serverConfig.name}' tools changed, refreshing...`);
        try {
          const newTools = await backendManager.refreshTools(serverConfig.name);
          const oldToolNames = registry.getToolNamesForServer(serverConfig.name);
          registry.removeServer(serverConfig.name);
          registry.registerServer(serverConfig.name, {
            description: serverConfig.description,
            tools: newTools,
          });

          // Check for removed tools and deactivate them
          const newToolNames = new Set(registry.getToolNamesForServer(serverConfig.name));
          const removedTools = oldToolNames.filter((n) => !newToolNames.has(n));
          if (removedTools.length > 0) {
            const affected = sessions.deactivateServerToolsFromAll(removedTools);
            await server.notifyToolListChangedForSessions(affected);
          }
        } catch (error) {
          console.error(`Failed to refresh tools for '${serverConfig.name}':`, error);
        }
      });
    } catch (error) {
      console.warn(
        `Failed to connect to '${serverConfig.name}': ${error instanceof Error ? error.message : error}`
      );
      registry.markUnavailable(serverConfig.name);
      unavailable.push({ name: serverConfig.name, url: serverConfig.url });
    }
  }

  const server = new GatewayServer({ registry, sessions, metaTools, router });

  // Retry unavailable backends
  if (unavailable.length > 0) {
    const retryInterval = setInterval(async () => {
      for (let i = unavailable.length - 1; i >= 0; i--) {
        const { name, url } = unavailable[i];
        try {
          const serverConfig = config.servers.find((s) => s.name === name);
          const tools = await backendManager.connect(name, url);
          registry.removeServer(name);
          registry.registerServer(name, {
            description: serverConfig?.description,
            tools,
          });
          unavailable.splice(i, 1);
          console.log(`Reconnected to '${name}' — ${tools.length} tools registered`);
        } catch {
          // Still unavailable, will retry
        }
      }
      if (unavailable.length === 0) {
        clearInterval(retryInterval);
      }
    }, RETRY_INTERVAL_MS);
    retryInterval.unref();
  }

  // Config hot reload
  const watcher = new ConfigWatcher(
    CONFIG_PATH,
    async (newConfig) => {
      console.log("Config changed, reloading...");
      const oldNames = new Set(config.servers.map((s) => s.name));
      const newNames = new Set(newConfig.servers.map((s) => s.name));

      // Remove servers no longer in config
      for (const name of oldNames) {
        if (!newNames.has(name)) {
          console.log(`Removing backend '${name}'`);
          const toolNames = registry.getToolNamesForServer(name);
          const affected = sessions.deactivateServerToolsFromAll(toolNames);
          registry.removeServer(name);
          await backendManager.disconnect(name);
          await server.notifyToolListChangedForSessions(affected);
        }
      }

      // Add new servers
      for (const sc of newConfig.servers) {
        if (!oldNames.has(sc.name)) {
          console.log(`Adding backend '${sc.name}' at ${sc.url}`);
          try {
            const tools = await backendManager.connect(sc.name, sc.url);
            registry.registerServer(sc.name, {
              description: sc.description,
              tools,
            });
            console.log(`Connected to '${sc.name}' — ${tools.length} tools`);
          } catch (error) {
            console.warn(`Failed to connect to '${sc.name}':`, error);
            registry.markUnavailable(sc.name);
          }
        }
      }

      // Update config reference
      config.servers = newConfig.servers;
      config.gateway = newConfig.gateway;
    },
    (error) => {
      console.error("Config reload failed, keeping previous config:", error.message);
    }
  );
  watcher.start();

  // Start gateway
  const port = config.gateway.port;
  const host = config.gateway.host;
  await server.start(port, host);
  console.log(`MCP Gateway listening on http://${host}:${port}/mcp`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    watcher.stop();
    await server.stop();
    await backendManager.disconnectAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Verify build**

Run: `npx tsc`
Expected: No errors, `dist/` populated

- [ ] **Step 5: Commit**

```bash
git add src/index.ts mcp-gateway.example.yaml
git commit -m "feat: add entry point with startup orchestration, retry, and hot reload"
```

---

### Task 12: Cleanup and Final Verification

**Files:**
- Delete: `tests/setup.test.ts` (scaffolding test no longer needed)

- [ ] **Step 1: Remove scaffolding test**

```bash
rm tests/setup.test.ts
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (setup.test.ts removed, all feature tests pass)

- [ ] **Step 3: Verify clean build**

Run: `rm -rf dist && npx tsc`
Expected: Clean build, no errors

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove scaffolding test, verify clean build"
```

---

## Summary

| Task | Component | Tests |
|------|-----------|-------|
| 1 | Project scaffolding | 1 setup test |
| 2 | Config module | 6 tests |
| 3 | Tool Registry | 11 tests |
| 4 | Session Manager | 10 tests |
| 5 | Backend Manager | 5 tests |
| 6 | Meta-Tool Handler | 9 tests |
| 7 | Router | 5 tests |
| 8 | Gateway Server | 7 tests |
| 9 | MCP Protocol Integration | 1 integration test |
| 10 | Config Hot Reload | 2 tests |
| 11 | Entry Point | build verification |
| 12 | Cleanup | full suite verification |
