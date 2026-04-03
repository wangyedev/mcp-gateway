// src/meta-tools.ts
import { ToolRegistry, ResolvedTool, ToolSchema } from "./registry.js";
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

  listServers(): { servers: Array<{ name: string; description?: string; status: string }> } {
    return { servers: this.registry.listServers() };
  }

  listServerTools(
    serverName: string
  ): { server: string; tools: Array<{ name: string; description: string }> } {
    const tools = this.registry.listServerTools(serverName);
    return { server: serverName, tools };
  }

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
  // connection time. For now, we embed the catalog in the `list_servers` tool
  // description, which is universally supported and updates via tools/list_changed.

  getToolDefinitions(): ToolDefinitionOutput[] {
    const serverSummary = this.buildServerSummary();

    return [
      {
        name: "list_servers",
        description: serverSummary,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list_server_tools",
        description:
          "List all tools available on a specific server. Returns tool names and descriptions. Use this to explore a server's capabilities before activating individual tools.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Server name from list_servers()",
            },
          },
          required: ["server"],
        },
      },
      {
        name: "activate_tool",
        description:
          "Activate a tool for use in this session. Once activated, the tool appears in your available tools and can be called directly. Returns the full tool schema.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Namespaced tool name (e.g., 'postgres.query'). Get names from list_server_tools().",
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

  private buildServerSummary(): string {
    const servers = this.registry.listServers();
    if (servers.length === 0) {
      return "List available MCP servers. No servers are currently registered.";
    }

    const entries = servers.map((s) => {
      const status = s.status === "available" ? "" : " [offline]";
      const desc = s.description ? ` - ${s.description}` : "";
      return `${s.name}${status}${desc}`;
    });

    return (
      "List available MCP servers. " +
      "Current servers: " +
      entries.join("; ") +
      ". Call list_server_tools(server) to see tools, then activate_tool(name) to enable one."
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
