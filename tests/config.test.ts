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
