// src/index.ts
import { loadConfig, parseCommand, ServerConfig } from "./config.js";
import { ToolRegistry } from "./registry.js";
import { SessionManager } from "./session.js";
import { MetaToolHandler } from "./meta-tools.js";
import { BackendManager } from "./backend.js";
import { Router } from "./router.js";
import { GatewayServer } from "./server.js";
import { ConfigWatcher } from "./watcher.js";
import { createLogger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { createAuthMiddleware } from "./auth.js";
import { createPolicyEvaluator } from "./rbac.js";
import { RateLimiter } from "./rate-limiter.js";

const CONFIG_PATH = process.env.MCP_GATEWAY_CONFIG ?? "mcp-gateway.yaml";
const RETRY_INTERVAL_MS = 30_000;
const STDIO_MAX_RETRIES = 5;

interface UnavailableEntry {
  name: string;
  type: "http" | "stdio";
  url?: string;
  stdioParams?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
  };
  retryCount: number;
  timeoutMs?: number;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const metrics = new MetricsRegistry();

  // Define all metrics
  metrics.defineCounter(
    "gateway_tool_calls_total",
    "Total tool calls routed through the gateway"
  );
  metrics.defineHistogram(
    "gateway_tool_call_duration_seconds",
    "Tool call latency in seconds",
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  );
  metrics.defineCounter(
    "gateway_tool_activations_total",
    "Tool activations"
  );
  metrics.defineCounter(
    "gateway_tool_deactivations_total",
    "Tool deactivations"
  );
  metrics.defineCounter(
    "gateway_backend_connections_total",
    "Backend connection attempts"
  );
  metrics.defineGauge(
    "gateway_active_sessions",
    "Current active session count"
  );
  metrics.defineCounter(
    "gateway_errors_total",
    "Error counts by type"
  );
  metrics.defineCounter(
    "gateway_tool_call_timeouts_total",
    "Total tool call timeouts"
  );
  metrics.defineCounter(
    "gateway_rate_limited_total",
    "Requests rejected due to rate limiting"
  );

  logger.info("Loading config", { path: CONFIG_PATH });
  const config = loadConfig(CONFIG_PATH);

  const registry = new ToolRegistry();
  const sessions = new SessionManager();
  const metaTools = new MetaToolHandler(registry, sessions);
  const backendManager = new BackendManager();
  const router = new Router(registry, backendManager);

  // Will be assigned after GatewayServer is created; the subscribeToToolChanges
  // closure captures the variable, not the value.
  let server: GatewayServer;

  /**
   * Extracted helper: subscribes to tools/list_changed from a backend and
   * refreshes the registry + notifies ALL sessions on any change.
   */
  function subscribeToToolChanges(
    serverName: string,
    getDescription: () => string | undefined
  ) {
    backendManager.onToolsChanged(serverName, async () => {
      logger.info("Backend tools changed, refreshing", { server: serverName });
      try {
        const newTools = await backendManager.refreshTools(serverName);
        const oldToolNames = registry.getToolNamesForServer(serverName);
        registry.removeServer(serverName);
        registry.registerServer(serverName, {
          description: getDescription(),
          tools: newTools,
          policy: config.servers.find((s) => s.name === serverName)?.tools,
        });
        const newToolNames = new Set(registry.getToolNamesForServer(serverName));
        const removedTools = oldToolNames.filter((n) => !newToolNames.has(n));
        if (removedTools.length > 0) {
          sessions.deactivateServerToolsFromAll(removedTools);
        }
        await server.notifyAllSessions();
      } catch (error) {
        logger.error("Failed to refresh tools", {
          server: serverName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async function connectServer(
    serverConfig: ServerConfig
  ): Promise<{
    tools: import("./registry.js").ToolDefinition[];
    entry: UnavailableEntry;
  }> {
    // Resolve timeout: server-specific > global default > 30s
    const timeoutSec = serverConfig.timeout ?? config.gateway.timeout ?? 30;
    const timeoutMs = timeoutSec * 1000;

    if (serverConfig.url) {
      const tools = await backendManager.connect(
        serverConfig.name,
        serverConfig.url,
        timeoutMs
      );
      return {
        tools,
        entry: {
          name: serverConfig.name,
          type: "http",
          url: serverConfig.url,
          retryCount: 0,
        },
      };
    } else {
      const parsed = parseCommand(serverConfig.command!);
      const stdioParams = {
        command: parsed.command,
        args: parsed.args,
        env: serverConfig.env,
        cwd: serverConfig.cwd,
        timeoutMs,
      };
      const tools = await backendManager.connectStdio(
        serverConfig.name,
        stdioParams
      );
      return {
        tools,
        entry: {
          name: serverConfig.name,
          type: "stdio",
          stdioParams,
          retryCount: 0,
        },
      };
    }
  }

  function subscribeToCrash(serverName: string, entry: UnavailableEntry) {
    if (entry.type !== "stdio") return;
    backendManager.onClose(serverName, async () => {
      logger.warn("Stdio backend crashed, marking unavailable", {
        server: serverName,
      });
      metrics.incrementCounter("gateway_errors_total", {
        server: serverName,
        type: "crash",
      });
      const toolNames = registry.getToolNamesForServer(serverName);
      sessions.deactivateServerToolsFromAll(toolNames);
      registry.markUnavailable(serverName);
      if (!unavailable.find((u) => u.name === serverName)) {
        unavailable.push({ ...entry, retryCount: 0 });
        startRetryLoop();
      }
      await server.notifyAllSessions();
    });
  }

  // Connect to backends
  const unavailable: UnavailableEntry[] = [];
  for (const serverConfig of config.servers) {
    try {
      const label = serverConfig.url ?? serverConfig.command;
      logger.info("Connecting to backend", {
        server: serverConfig.name,
        endpoint: label,
      });
      const { tools, entry } = await connectServer(serverConfig);
      registry.registerServer(serverConfig.name, {
        description: serverConfig.description,
        tools,
        policy: serverConfig.tools,
      });
      logger.info("Connected to backend", {
        server: serverConfig.name,
        tools: tools.length,
      });
      metrics.incrementCounter("gateway_backend_connections_total", {
        server: serverConfig.name,
        status: "success",
      });

      subscribeToToolChanges(
        serverConfig.name,
        () =>
          config.servers.find((s) => s.name === serverConfig.name)?.description
      );
      subscribeToCrash(serverConfig.name, entry);
    } catch (error) {
      logger.warn("Failed to connect to backend", {
        server: serverConfig.name,
        error: error instanceof Error ? error.message : String(error),
      });
      metrics.incrementCounter("gateway_backend_connections_total", {
        server: serverConfig.name,
        status: "error",
      });
      metrics.incrementCounter("gateway_errors_total", {
        server: serverConfig.name,
        type: "connection",
      });
      registry.markUnavailable(serverConfig.name);
      const timeoutSec = serverConfig.timeout ?? config.gateway.timeout ?? 30;
      const timeoutMs = timeoutSec * 1000;
      if (serverConfig.url) {
        unavailable.push({
          name: serverConfig.name,
          type: "http",
          url: serverConfig.url,
          timeoutMs,
          retryCount: 0,
        });
      } else {
        const parsed = parseCommand(serverConfig.command!);
        unavailable.push({
          name: serverConfig.name,
          type: "stdio",
          stdioParams: {
            command: parsed.command,
            args: parsed.args,
            env: serverConfig.env,
            cwd: serverConfig.cwd,
            timeoutMs,
          },
          retryCount: 0,
        });
      }
    }
  }

  // Create auth middleware and policy evaluator
  const authMiddleware = createAuthMiddleware(config.gateway.auth);
  const policyEvaluator = createPolicyEvaluator(config.rbac);

  // Create rate limiter if enabled
  let rateLimiter: RateLimiter | undefined;
  if (config.gateway.rateLimit?.enabled) {
    rateLimiter = new RateLimiter(
      config.gateway.rateLimit.maxRequests,
      config.gateway.rateLimit.windowSeconds
    );
    logger.info("Rate limiting enabled", {
      maxRequests: config.gateway.rateLimit.maxRequests,
      windowSeconds: config.gateway.rateLimit.windowSeconds,
    });
  } else {
    logger.info("Rate limiting disabled");
  }

  // Log auth and RBAC status
  const authType = config.gateway.auth?.type ?? "none";
  logger.info("Auth configuration", { mode: authType });
  if (config.rbac) {
    logger.info("RBAC enabled", {
      defaultPolicy: config.rbac.defaultPolicy,
      roles: Object.keys(config.rbac.roles).length,
    });
  } else {
    logger.info("RBAC disabled");
  }

  const serverUrls = new Map(
    config.servers.filter((s) => s.url).map((s) => [s.name, s.url!])
  );
  server = new GatewayServer({
    registry,
    sessions,
    metaTools,
    router,
    serverUrls,
    logger,
    metrics,
    authMiddleware,
    policyEvaluator,
    rateLimiter,
  });

  let retryInterval: ReturnType<typeof setInterval> | null = null;

  function startRetryLoop() {
    if (retryInterval || unavailable.length === 0) return;
    retryInterval = setInterval(async () => {
      for (let i = unavailable.length - 1; i >= 0; i--) {
        const entry = unavailable[i];

        if (entry.type === "stdio" && entry.retryCount >= STDIO_MAX_RETRIES) {
          logger.error("Server failed to start, giving up", {
            server: entry.name,
            maxRetries: STDIO_MAX_RETRIES,
          });
          unavailable.splice(i, 1);
          continue;
        }

        try {
          let tools: import("./registry.js").ToolDefinition[];
          if (entry.type === "http") {
            tools = await backendManager.connect(entry.name, entry.url!, entry.timeoutMs);
          } else {
            tools = await backendManager.connectStdio(
              entry.name,
              entry.stdioParams!
            );
          }

          registry.removeServer(entry.name);
          registry.registerServer(entry.name, {
            description: config.servers.find((s) => s.name === entry.name)
              ?.description,
            tools,
            policy: config.servers.find((s) => s.name === entry.name)?.tools,
          });
          subscribeToToolChanges(
            entry.name,
            () =>
              config.servers.find((s) => s.name === entry.name)?.description
          );
          subscribeToCrash(entry.name, entry);

          unavailable.splice(i, 1);
          logger.info("Reconnected to backend", {
            server: entry.name,
            tools: tools.length,
          });
          metrics.incrementCounter("gateway_backend_connections_total", {
            server: entry.name,
            status: "success",
          });
          await server.notifyAllSessions();
        } catch {
          if (entry.type === "stdio") {
            entry.retryCount++;
          }
          metrics.incrementCounter("gateway_backend_connections_total", {
            server: entry.name,
            status: "error",
          });
          metrics.incrementCounter("gateway_errors_total", {
            server: entry.name,
            type: "connection",
          });
        }
      }
      if (unavailable.length === 0 && retryInterval) {
        clearInterval(retryInterval);
        retryInterval = null;
      }
    }, RETRY_INTERVAL_MS);
    retryInterval.unref();
  }

  startRetryLoop();

  // Config hot reload
  const watcher = new ConfigWatcher(
    CONFIG_PATH,
    async (newConfig) => {
      logger.info("Config changed, reloading");
      const oldNames = new Set(config.servers.map((s) => s.name));
      const newNames = new Set(newConfig.servers.map((s) => s.name));

      // Remove servers no longer in config
      for (const name of oldNames) {
        if (!newNames.has(name)) {
          const staleIdx = unavailable.findIndex((u) => u.name === name);
          if (staleIdx !== -1) unavailable.splice(staleIdx, 1);
          logger.info("Removing backend", { server: name });
          const toolNames = registry.getToolNamesForServer(name);
          sessions.deactivateServerToolsFromAll(toolNames);
          registry.removeServer(name);
          await backendManager.disconnect(name);
          await server.notifyAllSessions();
        }
      }

      // Detect modified servers (URL or description changed)
      for (const sc of newConfig.servers) {
        if (oldNames.has(sc.name) && newNames.has(sc.name)) {
          const oldSc = config.servers.find((s) => s.name === sc.name);
          if (
            oldSc &&
            (oldSc.url !== sc.url ||
              oldSc.command !== sc.command ||
              oldSc.description !== sc.description ||
              JSON.stringify(oldSc.env) !== JSON.stringify(sc.env) ||
              oldSc.cwd !== sc.cwd)
          ) {
            const staleIdx = unavailable.findIndex((u) => u.name === sc.name);
            if (staleIdx !== -1) unavailable.splice(staleIdx, 1);
            logger.info("Backend config changed, reconnecting", {
              server: sc.name,
            });
            const toolNames = registry.getToolNamesForServer(sc.name);
            sessions.deactivateServerToolsFromAll(toolNames);
            registry.removeServer(sc.name);
            await backendManager.disconnect(sc.name);
            try {
              const { tools, entry } = await connectServer(sc);
              registry.registerServer(sc.name, {
                description: sc.description,
                tools,
                policy: sc.tools,
              });
              subscribeToToolChanges(
                sc.name,
                () =>
                  config.servers.find((s) => s.name === sc.name)?.description
              );
              subscribeToCrash(sc.name, entry);
              logger.info("Reconnected to backend", {
                server: sc.name,
                tools: tools.length,
              });
            } catch (error) {
              logger.warn("Failed to reconnect to backend", {
                server: sc.name,
                error: error instanceof Error ? error.message : String(error),
              });
              registry.markUnavailable(sc.name);
            }
            await server.notifyAllSessions();
          }
        }
      }

      // Add new servers
      for (const sc of newConfig.servers) {
        if (!oldNames.has(sc.name)) {
          const label = sc.url ?? sc.command;
          logger.info("Adding backend", { server: sc.name, endpoint: label });
          try {
            const { tools, entry } = await connectServer(sc);
            registry.registerServer(sc.name, {
              description: sc.description,
              tools,
              policy: sc.tools,
            });
            subscribeToToolChanges(
              sc.name,
              () =>
                config.servers.find((s) => s.name === sc.name)?.description
            );
            subscribeToCrash(sc.name, entry);
            logger.info("Connected to backend", {
              server: sc.name,
              tools: tools.length,
            });
          } catch (error) {
            logger.warn("Failed to connect to backend", {
              server: sc.name,
              error: error instanceof Error ? error.message : String(error),
            });
            registry.markUnavailable(sc.name);
          }
          await server.notifyAllSessions();
        }
      }

      // Update config reference
      config.servers = newConfig.servers;
      config.gateway = newConfig.gateway;
    },
    (error) => {
      logger.error("Config reload failed, keeping previous config", {
        error: error.message,
      });
    }
  );
  watcher.start();

  // Start gateway
  const port = config.gateway.port;
  const host = config.gateway.host;
  await server.startMcp(port, host);
  logger.info("MCP Gateway listening", {
    host,
    port,
    url: `http://${host}:${port}/mcp`,
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down");
    watcher.stop();
    await server.stop();
    await backendManager.disconnectAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
