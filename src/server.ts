// src/server.ts
import { ToolRegistry } from "./registry.js";
import { SessionManager } from "./session.js";
import { MetaToolHandler } from "./meta-tools.js";
import { Router } from "./router.js";
import { ToolSchema } from "./registry.js";

interface ToolDefinitionOutput {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

interface GatewayServerOptions {
  registry: ToolRegistry;
  sessions: SessionManager;
  metaTools: MetaToolHandler;
  router: Router;
}

const META_TOOL_NAMES = new Set([
  "list_servers",
  "list_server_tools",
  "activate_tool",
  "deactivate_tool",
]);

export class GatewayServer {
  private registry: ToolRegistry;
  private sessions: SessionManager;
  private metaTools: MetaToolHandler;
  private router: Router;

  constructor(options: GatewayServerOptions) {
    this.registry = options.registry;
    this.sessions = options.sessions;
    this.metaTools = options.metaTools;
    this.router = options.router;
  }

  getToolsForSession(sessionId: string): ToolDefinitionOutput[] {
    const metaToolDefs = this.metaTools.getToolDefinitions();
    const activatedDefs = this.metaTools.getActivatedToolDefinitions(sessionId);
    return [...metaToolDefs, ...activatedDefs];
  }

  async handleToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    try {
      if (META_TOOL_NAMES.has(toolName)) {
        return this.handleMetaToolCall(sessionId, toolName, args);
      }

      // Check if tool is activated for this session
      if (!this.sessions.isToolActivated(sessionId, toolName)) {
        return {
          content: [
            {
              type: "text",
              text: `Tool '${toolName}' is not activated. Call activate_tool first.`,
            },
          ],
          isError: true,
        };
      }

      const result = await this.router.routeToolCall(toolName, args);
      return result;
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  }

  private handleMetaToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): ToolCallResult {
    let result: unknown;

    switch (toolName) {
      case "list_servers":
        result = this.metaTools.listServers();
        break;
      case "list_server_tools":
        result = this.metaTools.listServerTools(sessionId, args.server as string);
        break;
      case "activate_tool":
        result = this.metaTools.activateTool(sessionId, args.name as string);
        break;
      case "deactivate_tool":
        result = this.metaTools.deactivateTool(sessionId, args.name as string);
        break;
      default:
        throw new Error(`Unknown meta-tool: ${toolName}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  }

  async stop(): Promise<void> {
    // Will be extended in Task 9 with HTTP server shutdown
  }
}
