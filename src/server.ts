// src/server.ts
import { ToolRegistry } from "./registry.js";
import { SessionManager } from "./session.js";
import { MetaToolHandler } from "./meta-tools.js";
import { Router } from "./router.js";
import { ToolSchema } from "./registry.js";
import { Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { PolicyEvaluator } from "./rbac.js";
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
import type { RequestHandler } from "express";

interface ToolDefinitionOutput {
  name: string;
  description: string;
  inputSchema: ToolSchema;
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  _meta?: { [key: string]: unknown };
  [key: string]: unknown;
}

interface GatewayServerOptions {
  registry: ToolRegistry;
  sessions: SessionManager;
  metaTools: MetaToolHandler;
  router: Router;
  serverUrls?: Map<string, string>;
  maxSessions?: number;
  logger?: Logger;
  metrics?: MetricsRegistry;
  policyEvaluator?: PolicyEvaluator;
  authMiddleware?: RequestHandler[];
}

const DEFAULT_MAX_SESSIONS = 100;

// Internal state for a connected MCP session
interface McpSessionState {
  gatewaySessionId: string;
  transport: StreamableHTTPServerTransport;
  mcpServer: Server;
  roles?: string[];
}

const META_TOOL_NAMES = new Set([
  "activate_tool",
  "deactivate_tool",
]);

export class GatewayServer {
  private registry: ToolRegistry;
  private sessions: SessionManager;
  private metaTools: MetaToolHandler;
  private router: Router;
  private serverUrls: Map<string, string>;
  private maxSessions: number;
  private logger?: Logger;
  private metrics?: MetricsRegistry;
  private policyEvaluator?: PolicyEvaluator;
  private authMiddleware?: RequestHandler[];

  // MCP protocol state
  private httpServer: HttpServer | null = null;
  // Maps transport session ID -> McpSessionState
  private mcpSessions = new Map<string, McpSessionState>();
  // Maps gateway session ID -> roles
  private sessionRoles = new Map<string, string[]>();

  constructor(options: GatewayServerOptions) {
    this.registry = options.registry;
    this.sessions = options.sessions;
    this.metaTools = options.metaTools;
    this.router = options.router;
    this.serverUrls = options.serverUrls ?? new Map();
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.policyEvaluator = options.policyEvaluator;
    this.authMiddleware = options.authMiddleware;
  }

  getToolsForSession(sessionId: string): ToolDefinitionOutput[] {
    const metaToolDefs = this.metaTools.getToolDefinitions();
    let activatedDefs = this.metaTools.getActivatedToolDefinitions(sessionId);

    // Filter tools based on RBAC
    if (this.policyEvaluator) {
      const roles = this.sessionRoles.get(sessionId) ?? [];
      activatedDefs = activatedDefs.filter((tool) => {
        const dotIdx = tool.name.indexOf(".");
        if (dotIdx > 0) {
          const serverName = tool.name.substring(0, dotIdx);
          return this.policyEvaluator!.canAccessServer(roles, serverName);
        }
        return true;
      });
    }

    return [...metaToolDefs, ...activatedDefs];
  }

  async handleToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const startTime = Date.now();
    try {
      if (META_TOOL_NAMES.has(toolName)) {
        // Check RBAC for activate_tool
        if (toolName === "activate_tool" && this.policyEvaluator) {
          const name = args.name as string;
          const dotIdx = name?.indexOf(".");
          if (dotIdx > 0) {
            const serverName = name.substring(0, dotIdx);
            const roles = this.sessionRoles.get(sessionId) ?? [];
            if (!this.policyEvaluator.canAccessServer(roles, serverName)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Access denied: insufficient permissions for server '${serverName}'`,
                  },
                ],
                isError: true,
              };
            }
          }
        }

        const result = this.handleMetaToolCall(sessionId, toolName, args);

        // Track activations/deactivations
        if (toolName === "activate_tool") {
          const name = args.name as string;
          const dotIdx = name?.indexOf(".");
          if (dotIdx > 0) {
            this.metrics?.incrementCounter("gateway_tool_activations_total", {
              server: name.substring(0, dotIdx),
              tool: name.substring(dotIdx + 1),
            });
          }
        } else if (toolName === "deactivate_tool") {
          const name = args.name as string;
          const dotIdx = name?.indexOf(".");
          if (dotIdx > 0) {
            this.metrics?.incrementCounter("gateway_tool_deactivations_total", {
              server: name.substring(0, dotIdx),
              tool: name.substring(dotIdx + 1),
            });
          }
        }

        if (toolName === "activate_tool" || toolName === "deactivate_tool") {
          this.notifyToolListChangedForSessions([sessionId]).catch(() => {});
        }

        return result;
      }

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

      // Check RBAC for regular tool calls
      if (this.policyEvaluator) {
        const roles = this.sessionRoles.get(sessionId) ?? [];
        const dotIdx = toolName.indexOf(".");
        if (dotIdx > 0) {
          const serverName = toolName.substring(0, dotIdx);
          if (!this.policyEvaluator.canAccessServer(roles, serverName)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Access denied: insufficient permissions for server '${serverName}'`,
                },
              ],
              isError: true,
            };
          }
        }
      }

      const result = await this.router.routeToolCall(toolName, args);

      // Record success metrics
      const dotIdx = toolName.indexOf(".");
      if (dotIdx > 0) {
        const server = toolName.substring(0, dotIdx);
        const tool = toolName.substring(dotIdx + 1);
        const durationSec = (Date.now() - startTime) / 1000;
        this.metrics?.incrementCounter("gateway_tool_calls_total", {
          server,
          tool,
          status: "success",
        });
        this.metrics?.observeHistogram(
          "gateway_tool_call_duration_seconds",
          durationSec,
          { server, tool }
        );
      }

      return result;
    } catch (error) {
      // Record error metrics
      const dotIdx = toolName.indexOf(".");
      if (dotIdx > 0) {
        const server = toolName.substring(0, dotIdx);
        const tool = toolName.substring(dotIdx + 1);
        const durationSec = (Date.now() - startTime) / 1000;
        this.metrics?.incrementCounter("gateway_tool_calls_total", {
          server,
          tool,
          status: "error",
        });
        this.metrics?.observeHistogram(
          "gateway_tool_call_duration_seconds",
          durationSec,
          { server, tool }
        );
        this.metrics?.incrementCounter("gateway_errors_total", {
          server,
          type: "tool_call",
        });
      }

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

    // Apply auth middleware before routes
    if (this.authMiddleware) {
      for (const mw of this.authMiddleware) {
        app.use(mw);
      }
    }

    // GET /status -- returns server status and active session count
    app.get("/status", (_req, res) => {
      const servers = this.registry.listServers().map((s) => ({
        name: s.name,
        url: this.serverUrls?.get(s.name) ?? "unknown",
        status: s.status,
        tools: this.registry.getToolNamesForServer(s.name),
      }));
      res.json({
        servers,
        activeSessions: this.mcpSessions.size,
      });
    });

    // GET /metrics -- returns Prometheus-format metrics
    app.get("/metrics", (_req, res) => {
      const body = this.metrics?.toPrometheus() ?? "";
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(body);
    });

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

    return new Promise<number>((resolve, reject) => {
      this.httpServer = app.listen(port, host, () => {
        const addr = this.httpServer!.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
      this.httpServer.on("error", (err) => reject(err));
    });
  }

  /**
   * Returns the underlying HTTP server instance, or null if not started.
   */
  getHttpServer(): HttpServer | null {
    return this.httpServer;
  }

  /**
   * Sends notifications/tools/list_changed to sessions matching the given gateway session IDs.
   */
  async notifyToolListChangedForSessions(
    gatewaySessionIds: string[]
  ): Promise<void> {
    const idSet = new Set(gatewaySessionIds);
    const promises: Promise<void>[] = [];
    for (const [, state] of this.mcpSessions) {
      if (idSet.has(state.gatewaySessionId)) {
        promises.push(
          state.mcpServer.sendToolListChanged().catch(() => {})
        );
      }
    }
    await Promise.all(promises);
  }

  /**
   * Sends notifications/tools/list_changed to ALL active sessions.
   */
  async notifyAllSessions(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [, state] of this.mcpSessions) {
      promises.push(
        state.mcpServer.sendToolListChanged().catch(() => {})
      );
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
    // Enforce session limit
    if (this.mcpSessions.size >= this.maxSessions) {
      res.status(503).json({ error: "Too many active sessions" });
      return;
    }

    // Check client capabilities for tools.listChanged support
    const clientCapabilities = req.body?.params?.capabilities;
    if (!clientCapabilities?.tools?.listChanged) {
      console.warn(
        "Client does not declare tools.listChanged capability. " +
          "Tool list change notifications may not be handled by this client."
      );
    }

    // Create gateway-level session
    const gatewaySessionId = this.sessions.createSession();
    this.metrics?.setGauge("gateway_active_sessions", this.mcpSessions.size + 1);

    // Extract and store roles from auth middleware
    const roles = req.authRoles ?? [];
    this.sessionRoles.set(gatewaySessionId, roles);

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
        this.sessionRoles.delete(gatewaySessionId);
        this.metrics?.setGauge("gateway_active_sessions", this.mcpSessions.size);
      }
    };

    // Connect MCP server to transport
    await mcpServer.connect(transport);

    // Handle the initial request
    await transport.handleRequest(req, res, req.body);
  }

}
