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

export interface AuthConfig {
  type: "none" | "proxy" | "builtin";
  issuer?: string;
  rolesClaim?: string;
  audience?: string;
  publicEndpoints?: string[];
}

export interface RbacRole {
  servers: "*" | string[];
}

export interface RbacConfig {
  defaultPolicy: "deny" | "allow";
  roles: Record<string, RbacRole>;
}

export interface GatewayConfig {
  port: number;
  host: string;
  auth?: AuthConfig;
}

export interface Config {
  gateway: GatewayConfig;
  servers: ServerConfig[];
  rbac?: RbacConfig;
}

export function loadConfig(filePath: string): Config {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw);
  const substituted = substituteEnvVarsInObject(parsed);

  // Parse auth config
  let auth: AuthConfig | undefined;
  if (substituted?.gateway?.auth) {
    const authConfig = substituted.gateway.auth;
    auth = {
      type: authConfig.type ?? "none",
      issuer: authConfig.issuer,
      rolesClaim: authConfig.rolesClaim,
      audience: authConfig.audience,
      publicEndpoints: authConfig.publicEndpoints,
    };

    // Validate auth config
    if (auth.type === "proxy" && !auth.issuer) {
      throw new Error("Auth type 'proxy' requires 'issuer' field");
    }
  }

  const gateway: GatewayConfig = {
    port: substituted?.gateway?.port ?? 8080,
    host: substituted?.gateway?.host ?? "0.0.0.0",
    auth,
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

  // Parse RBAC config
  let rbac: RbacConfig | undefined;
  if (substituted?.rbac) {
    const rbacConfig = substituted.rbac;
    rbac = {
      defaultPolicy: rbacConfig.defaultPolicy ?? "deny",
      roles: rbacConfig.roles ?? {},
    };

    // Validate RBAC config
    if (rbac.defaultPolicy !== "deny" && rbac.defaultPolicy !== "allow") {
      throw new Error("RBAC defaultPolicy must be 'deny' or 'allow'");
    }

    // Validate server names in RBAC roles
    for (const [roleName, roleConfig] of Object.entries(rbac.roles)) {
      if (roleConfig.servers !== "*" && Array.isArray(roleConfig.servers)) {
        for (const serverName of roleConfig.servers) {
          if (!names.has(serverName)) {
            console.warn(
              `Warning: Role '${roleName}' references server '${serverName}' which is not in config`
            );
          }
        }
      }
    }
  }

  return { gateway, servers, rbac };
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
