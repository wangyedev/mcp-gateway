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
