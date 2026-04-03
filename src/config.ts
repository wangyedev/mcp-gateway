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
  const parsed = parse(raw);
  const substituted = substituteEnvVarsInObject(parsed);

  const gateway: GatewayConfig = {
    port: substituted?.gateway?.port ?? 8080,
    host: substituted?.gateway?.host ?? "0.0.0.0",
  };

  const servers: ServerConfig[] = substituted?.servers;
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

function substituteEnvVarsInObject(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (match, varName) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new Error(`Environment variable '${varName}' is not set. Referenced in config as \${${varName}}`);
      }
      return value;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(item => substituteEnvVarsInObject(item));
  }
  if (obj !== null && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVarsInObject(value);
    }
    return result;
  }
  return obj;
}
