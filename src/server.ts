// src/server.ts
import { ToolRegistry } from "./registry.js";
import { SessionManager } from "./session.js";
import { MetaToolHandler } from "./meta-tools.js";
import { Router } from "./router.js";
import { ToolSchema } from "./registry.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import express from "express";
import type { Server as HttpServer } from "http";

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

// Internal state for a connected MCP session
interface McpSessionState {
  gatewaySessionId: string;
  transport: StreamableHTTPServerTransport;
  mcpServer: Server;
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

  // MCP protocol state
  private httpServer: HttpServer | null = null;
  // Maps transport session ID -> McpSessionState
  private mcpSessions = new Map<string, McpSessionState>();

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
        const result = this.handleMetaToolCall(sessionId, toolName, args);

        // After activate/deactivate, emit tools/list_changed for the session
        if (toolName === "activate_tool" || toolName === "deactivate_tool") {
          const transportSessionIds = this.getTransportSessionIds(sessionId);
          if (transportSessionIds.length > 0) {
            this.notifyToolListChangedForSessions(transportSessionIds).catch(
              () => {}
            );
          }
        }

        return result;
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

  /**
   * Starts an Express HTTP server that serves the MCP Streamable HTTP protocol.
   * Each client session gets its own low-level MCP Server and transport.
   * Returns the actual port the server is listening on.
   */
  async startMcp(port: number, host: string): Promise<number> {
    const app = express();
    app.use(express.json());

    // POST /mcp -- handles MCP messages (initialize + subsequent requests)
    app.post("/mcp", async (req, res) => {
      const transportSessionId = req.headers["mcp-session-id"] as
        | string
        | undefined;

      try {
        if (transportSessionId && this.mcpSessions.has(transportSessionId)) {
          const state = this.mcpSessions.get(transportSessionId)!;
          await state.transport.handleRequest(req, res, req.body);
          return;
        }

        if (!transportSessionId && isInitializeRequest(req.body)) {
          await this.handleNewSession(req, res);
          return;
        }

        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });

    // GET /mcp -- SSE endpoint for server-to-client notifications
    app.get("/mcp", async (req, res) => {
      const transportSessionId = req.headers["mcp-session-id"] as
        | string
        | undefined;
      if (!transportSessionId || !this.mcpSessions.has(transportSessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      const state = this.mcpSessions.get(transportSessionId)!;
      await state.transport.handleRequest(req, res);
    });

    // DELETE /mcp -- session cleanup
    app.delete("/mcp", async (req, res) => {
      const transportSessionId = req.headers["mcp-session-id"] as
        | string
        | undefined;
      if (!transportSessionId || !this.mcpSessions.has(transportSessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
      }
      const state = this.mcpSessions.get(transportSessionId)!;
      await state.transport.handleRequest(req, res);
    });

    return new Promise<number>((resolve) => {
      this.httpServer = app.listen(port, host, () => {
        const addr = this.httpServer!.address() as { port: number };
        resolve(addr.port);
      });
    });
  }

  /**
   * Returns the underlying HTTP server instance, or null if not started.
   */
  getHttpServer(): HttpServer | null {
    return this.httpServer;
  }

  /**
   * Sends notifications/tools/list_changed to specified transport session IDs.
   */
  async notifyToolListChangedForSessions(
    sessionIds: string[]
  ): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const sid of sessionIds) {
      const state = this.mcpSessions.get(sid);
      if (state) {
        promises.push(
          state.mcpServer.sendToolListChanged().catch(() => {})
        );
      }
    }
    await Promise.all(promises);
  }

  async stop(): Promise<void> {
    // Close all MCP transports
    const closePromises: Promise<void>[] = [];
    for (const [, state] of this.mcpSessions) {
      closePromises.push(state.transport.close().catch(() => {}));
    }
    await Promise.all(closePromises);
    this.mcpSessions.clear();

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
      this.httpServer = null;
    }
  }

  // ---- Private helpers ----

  /**
   * Handles a new MCP session initialization.
   * Creates a new gateway session, a low-level MCP Server, and a transport.
   */
  private async handleNewSession(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    // Create gateway-level session
    const gatewaySessionId = this.sessions.createSession();

    // Create per-session low-level MCP server with tools capability
    const mcpServer = new Server(
      { name: "mcp-gateway", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    // Register tools/list handler -- dynamically returns tools for this session
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      const toolDefs = this.getToolsForSession(gatewaySessionId);
      return {
        tools: toolDefs.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    });

    // Register tools/call handler -- delegates to handleToolCall
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await this.handleToolCall(
        gatewaySessionId,
        name,
        (args as Record<string, unknown>) || {}
      );
      return result;
    });

    // Create transport
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (transportSessionId: string) => {
        this.mcpSessions.set(transportSessionId, {
          gatewaySessionId,
          transport,
          mcpServer,
        });
      },
    });

    // Handle transport close -- clean up session
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        this.mcpSessions.delete(sid);
        this.sessions.removeSession(gatewaySessionId);
      }
    };

    // Connect MCP server to transport
    await mcpServer.connect(transport);

    // Handle the initial request
    await transport.handleRequest(req, res, req.body);
  }

  /**
   * Returns all transport session IDs associated with a gateway session ID.
   */
  private getTransportSessionIds(gatewaySessionId: string): string[] {
    const result: string[] = [];
    for (const [transportId, state] of this.mcpSessions) {
      if (state.gatewaySessionId === gatewaySessionId) {
        result.push(transportId);
      }
    }
    return result;
  }
}
