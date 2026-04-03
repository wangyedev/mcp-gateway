import { readFileSync } from "fs";
import { parse } from "yaml";

export interface ToolPolicyConfig {
  allow?: string[];
  deny?: string[];
}

export interface ServerConfig {
  name: string;
  url?: string;
  command?: string;
  description?: string;
  env?: Record<string, string>;
  cwd?: string;
  tools?: ToolPolicyConfig;
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
    // Validate tool policy
    if (server.tools) {
      const hasAllow = !!server.tools.allow;
      const hasDeny = !!server.tools.deny;
      if (hasAllow && hasDeny) {
        throw new Error(
          `Server '${server.name}' cannot have both 'allow' and 'deny' policies - they are mutually exclusive`
        );
      }
      if (hasAllow && (!Array.isArray(server.tools.allow) || server.tools.allow.length === 0)) {
        throw new Error(
          `Server '${server.name}' has empty 'allow' list - either specify tools or remove the field - must be non-empty`
        );
      }
      if (hasDeny && (!Array.isArray(server.tools.deny) || server.tools.deny.length === 0)) {
        throw new Error(
          `Server '${server.name}' has empty 'deny' list - either specify tools or remove the field - must be non-empty`
        );
      }
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

export function parseCommand(command: string): { command: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}
