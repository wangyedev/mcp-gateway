import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, parseCommand } from "../src/config.js";
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

  test("parses server with tools allow list", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
    tools:
      allow: ["query", "list_tables"]
`);
    const config = loadConfig(configPath);
    expect(config.servers[0].tools).toEqual({ allow: ["query", "list_tables"] });
  });

  test("parses server with tools deny list", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
    tools:
      deny: ["drop_table"]
`);
    const config = loadConfig(configPath);
    expect(config.servers[0].tools).toEqual({ deny: ["drop_table"] });
  });

  test("throws when server has both allow and deny", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
    tools:
      allow: ["query"]
      deny: ["drop_table"]
`);
    expect(() => loadConfig(configPath)).toThrow("mutually exclusive");
  });

  test("throws when allow list is empty", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
    tools:
      allow: []
`);
    expect(() => loadConfig(configPath)).toThrow("non-empty");
  });

  test("throws when deny list is empty", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
    tools:
      deny: []
`);
    expect(() => loadConfig(configPath)).toThrow("non-empty");
  });

  test("server without tools field is valid", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.servers[0].tools).toBeUndefined();
  });

  test("parses auth config", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  auth:
    type: proxy
    issuer: https://auth.example.com
    rolesClaim: realm_access.roles
    publicEndpoints:
      - /status
      - /metrics
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.auth?.type).toBe("proxy");
    expect(config.gateway.auth?.issuer).toBe("https://auth.example.com");
    expect(config.gateway.auth?.rolesClaim).toBe("realm_access.roles");
    expect(config.gateway.auth?.publicEndpoints).toEqual(["/status", "/metrics"]);
  });

  test("parses rbac config", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: postgres
    url: http://localhost:3001/mcp
rbac:
  defaultPolicy: deny
  roles:
    admin:
      servers: "*"
    analyst:
      servers:
        - postgres
`);
    const config = loadConfig(configPath);
    expect(config.rbac?.defaultPolicy).toBe("deny");
    expect(config.rbac?.roles.admin.servers).toBe("*");
    expect(config.rbac?.roles.analyst.servers).toEqual(["postgres"]);
  });

  test("throws when proxy auth missing issuer", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  auth:
    type: proxy
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    expect(() => loadConfig(configPath)).toThrow("issuer");
  });

  test("default auth type is none", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.auth).toBeUndefined();
  });

  test("parses global timeout", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  timeout: 60
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.timeout).toBe(60);
  });

  test("parses per-server timeout", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: slow
    url: http://localhost:3001/mcp
    timeout: 120
  - name: fast
    url: http://localhost:3002/mcp
    timeout: 10
`);
    const config = loadConfig(configPath);
    expect(config.servers[0].timeout).toBe(120);
    expect(config.servers[1].timeout).toBe(10);
  });

  test("allows mixing global and per-server timeouts", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  timeout: 30
servers:
  - name: slow
    url: http://localhost:3001/mcp
    timeout: 120
  - name: fast
    url: http://localhost:3002/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.timeout).toBe(30);
    expect(config.servers[0].timeout).toBe(120);
    expect(config.servers[1].timeout).toBeUndefined();
  });

  test("throws when timeout is not a number", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  timeout: "thirty"
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    expect(() => loadConfig(configPath)).toThrow("timeout must be a positive number");
  });

  test("throws when timeout is zero", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  timeout: 0
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    expect(() => loadConfig(configPath)).toThrow("timeout must be a positive number");
  });

  test("throws when timeout is negative", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: test
    url: http://localhost:3001/mcp
    timeout: -10
`);
    expect(() => loadConfig(configPath)).toThrow("invalid timeout");
  });

  test("timeout is optional - no timeout specified", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.timeout).toBeUndefined();
    expect(config.servers[0].timeout).toBeUndefined();
  });

  test("parses rate limit config when enabled", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  rateLimit:
    enabled: true
    maxRequests: 100
    windowSeconds: 60
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.rateLimit?.enabled).toBe(true);
    expect(config.gateway.rateLimit?.maxRequests).toBe(100);
    expect(config.gateway.rateLimit?.windowSeconds).toBe(60);
  });

  test("rate limit disabled by default", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.rateLimit).toBeUndefined();
  });

  test("rate limit config with enabled false", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  rateLimit:
    enabled: false
    maxRequests: 100
    windowSeconds: 60
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.rateLimit?.enabled).toBe(false);
  });

  test("uses default values for rate limit when not specified", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  rateLimit:
    enabled: true
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.rateLimit?.enabled).toBe(true);
    expect(config.gateway.rateLimit?.maxRequests).toBe(100);
    expect(config.gateway.rateLimit?.windowSeconds).toBe(60);
  });

  test("throws when rate limit maxRequests is zero", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  rateLimit:
    enabled: true
    maxRequests: 0
    windowSeconds: 60
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    expect(() => loadConfig(configPath)).toThrow("maxRequests must be a positive number");
  });

  test("throws when rate limit maxRequests is negative", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  rateLimit:
    enabled: true
    maxRequests: -10
    windowSeconds: 60
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    expect(() => loadConfig(configPath)).toThrow("maxRequests must be a positive number");
  });

  test("throws when rate limit windowSeconds is zero", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  rateLimit:
    enabled: true
    maxRequests: 100
    windowSeconds: 0
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    expect(() => loadConfig(configPath)).toThrow("windowSeconds must be a positive number");
  });

  test("throws when rate limit windowSeconds is negative", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  rateLimit:
    enabled: true
    maxRequests: 100
    windowSeconds: -30
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    expect(() => loadConfig(configPath)).toThrow("windowSeconds must be a positive number");
  });

  test("allows invalid rate limit values when disabled", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `
gateway:
  rateLimit:
    enabled: false
    maxRequests: 0
    windowSeconds: 0
servers:
  - name: test
    url: http://localhost:3001/mcp
`);
    const config = loadConfig(configPath);
    expect(config.gateway.rateLimit?.enabled).toBe(false);
  });
});

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
