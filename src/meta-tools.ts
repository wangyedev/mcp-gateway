// src/meta-tools.ts
import { ToolRegistry, ToolSchema } from "./registry.js";
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

  activateTool(
    sessionId: string,
    toolName: string
  ): { success: true; tool: ToolDefinitionOutput } {
    const tool = this.registry.getTool(toolName);
    if (!tool) {
      if (this.registry.isServerUnavailable(toolName)) {
        throw new Error(`Server for tool '${toolName}' is currently unavailable`);
      }
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

  // Future enhancement: The MCP protocol supports an `instructions` field in
  // the initialize response, which clients inject into the LLM's system prompt.
  // When client support for `instructions` matures, the gateway should set it
  // dynamically with the server catalog for richer context injection at
  // connection time. For now, we embed the catalog in the `activate_tool` tool
  // description, which is universally supported and updates via tools/list_changed.

  getToolDefinitions(): ToolDefinitionOutput[] {
    const catalogDescription = this.buildToolCatalog();

    return [
      {
        name: "activate_tool",
        description: catalogDescription,
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Namespaced tool name (e.g., 'postgres.query') from the catalog above.",
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

  private buildToolCatalog(): string {
    const servers = this.registry.listServers();
    if (servers.length === 0) {
      return "Activate a tool for use in this session. No tools are currently available.";
    }

    const entries: string[] = [];
    for (const server of servers) {
      if (server.status === "unavailable") {
        entries.push(`[offline] ${server.name}`);
        continue;
      }
      const tools = this.registry.listServerTools(server.name);
      for (const tool of tools) {
        entries.push(`${tool.name} - ${tool.description}`);
      }
    }

    return (
      "Activate a tool for use in this session. Available tools: " +
      entries.join("; ") +
      ". Call activate_tool(name) to enable a tool, then call it directly."
    );
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
