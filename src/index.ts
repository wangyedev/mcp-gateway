// src/index.ts
import { loadConfig, parseCommand, ServerConfig } from "./config.js";
import { ToolRegistry } from "./registry.js";
import { SessionManager } from "./session.js";
import { MetaToolHandler } from "./meta-tools.js";
import { BackendManager } from "./backend.js";
import { Router } from "./router.js";
import { GatewayServer } from "./server.js";
import { ConfigWatcher } from "./watcher.js";

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
  };
  retryCount: number;
}

async function main(): Promise<void> {
  console.log(`Loading config from ${CONFIG_PATH}`);
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
      console.log(`Backend '${serverName}' tools changed, refreshing...`);
      try {
        const newTools = await backendManager.refreshTools(serverName);
        const oldToolNames = registry.getToolNamesForServer(serverName);
        registry.removeServer(serverName);
        registry.registerServer(serverName, {
          description: getDescription(),
          tools: newTools,
        });
        const newToolNames = new Set(registry.getToolNamesForServer(serverName));
        const removedTools = oldToolNames.filter((n) => !newToolNames.has(n));
        if (removedTools.length > 0) {
          sessions.deactivateServerToolsFromAll(removedTools);
        }
        await server.notifyAllSessions();
      } catch (error) {
        console.error(`Failed to refresh tools for '${serverName}':`, error);
      }
    });
  }

  async function connectServer(
    serverConfig: ServerConfig
  ): Promise<{
    tools: import("./registry.js").ToolDefinition[];
    entry: UnavailableEntry;
  }> {
    if (serverConfig.url) {
      const tools = await backendManager.connect(
        serverConfig.name,
        serverConfig.url
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
      console.warn(
        `Stdio backend '${serverName}' crashed, marking unavailable`
      );
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
      console.log(
        `Connecting to backend '${serverConfig.name}' (${label})`
      );
      const { tools, entry } = await connectServer(serverConfig);
      registry.registerServer(serverConfig.name, {
        description: serverConfig.description,
        tools,
      });
      console.log(
        `Connected to '${serverConfig.name}' — ${tools.length} tools registered`
      );

      subscribeToToolChanges(
        serverConfig.name,
        () =>
          config.servers.find((s) => s.name === serverConfig.name)?.description
      );
      subscribeToCrash(serverConfig.name, entry);
    } catch (error) {
      console.warn(
        `Failed to connect to '${serverConfig.name}': ${error instanceof Error ? error.message : error}`
      );
      registry.markUnavailable(serverConfig.name);
      if (serverConfig.url) {
        unavailable.push({
          name: serverConfig.name,
          type: "http",
          url: serverConfig.url,
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
          },
          retryCount: 0,
        });
      }
    }
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
  });

  let retryInterval: ReturnType<typeof setInterval> | null = null;

  function startRetryLoop() {
    if (retryInterval || unavailable.length === 0) return;
    retryInterval = setInterval(async () => {
      for (let i = unavailable.length - 1; i >= 0; i--) {
        const entry = unavailable[i];

        if (entry.type === "stdio" && entry.retryCount >= STDIO_MAX_RETRIES) {
          console.error(
            `Server '${entry.name}' failed to start after ${STDIO_MAX_RETRIES} attempts, giving up. Fix the command and reload config.`
          );
          unavailable.splice(i, 1);
          continue;
        }

        try {
          let tools: import("./registry.js").ToolDefinition[];
          if (entry.type === "http") {
            tools = await backendManager.connect(entry.name, entry.url!);
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
          });
          subscribeToToolChanges(
            entry.name,
            () =>
              config.servers.find((s) => s.name === entry.name)?.description
          );
          subscribeToCrash(entry.name, entry);

          unavailable.splice(i, 1);
          console.log(
            `Reconnected to '${entry.name}' — ${tools.length} tools registered`
          );
          await server.notifyAllSessions();
        } catch {
          if (entry.type === "stdio") {
            entry.retryCount++;
          }
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
      console.log("Config changed, reloading...");
      const oldNames = new Set(config.servers.map((s) => s.name));
      const newNames = new Set(newConfig.servers.map((s) => s.name));

      // Remove servers no longer in config
      for (const name of oldNames) {
        if (!newNames.has(name)) {
          const staleIdx = unavailable.findIndex((u) => u.name === name);
          if (staleIdx !== -1) unavailable.splice(staleIdx, 1);
          console.log(`Removing backend '${name}'`);
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
            console.log(`Backend '${sc.name}' config changed, reconnecting...`);
            const toolNames = registry.getToolNamesForServer(sc.name);
            sessions.deactivateServerToolsFromAll(toolNames);
            registry.removeServer(sc.name);
            await backendManager.disconnect(sc.name);
            try {
              const { tools, entry } = await connectServer(sc);
              registry.registerServer(sc.name, {
                description: sc.description,
                tools,
              });
              subscribeToToolChanges(
                sc.name,
                () =>
                  config.servers.find((s) => s.name === sc.name)?.description
              );
              subscribeToCrash(sc.name, entry);
              console.log(
                `Reconnected to '${sc.name}' — ${tools.length} tools`
              );
            } catch (error) {
              console.warn(`Failed to reconnect to '${sc.name}':`, error);
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
          console.log(`Adding backend '${sc.name}' (${label})`);
          try {
            const { tools, entry } = await connectServer(sc);
            registry.registerServer(sc.name, {
              description: sc.description,
              tools,
            });
            subscribeToToolChanges(
              sc.name,
              () =>
                config.servers.find((s) => s.name === sc.name)?.description
            );
            subscribeToCrash(sc.name, entry);
            console.log(
              `Connected to '${sc.name}' — ${tools.length} tools`
            );
          } catch (error) {
            console.warn(`Failed to connect to '${sc.name}':`, error);
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
      console.error("Config reload failed, keeping previous config:", error.message);
    }
  );
  watcher.start();

  // Start gateway
  const port = config.gateway.port;
  const host = config.gateway.host;
  await server.startMcp(port, host);
  console.log(`MCP Gateway listening on http://${host}:${port}/mcp`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
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
