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
