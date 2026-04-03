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
