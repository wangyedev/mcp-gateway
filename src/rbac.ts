export interface PolicyEvaluator {
  canAccessServer(roles: string[], serverName: string): boolean;
}

export interface RbacRole {
  servers: "*" | string[];
}

export interface RbacConfig {
  defaultPolicy: "deny" | "allow";
  roles: Record<string, RbacRole>;
}

export function createPolicyEvaluator(config?: RbacConfig): PolicyEvaluator {
  if (!config) {
    return { canAccessServer: () => true };
  }

  return {
    canAccessServer(roles: string[], serverName: string): boolean {
      for (const role of roles) {
        const roleConfig = config.roles[role];
        if (!roleConfig) continue;
        if (roleConfig.servers === "*") return true;
        if (roleConfig.servers.includes(serverName)) return true;
      }
      return config.defaultPolicy === "allow";
    },
  };
}
