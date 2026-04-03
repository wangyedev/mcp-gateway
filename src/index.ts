// src/index.ts
import { loadConfig } from "./config.js";
import { ToolRegistry } from "./registry.js";
import { SessionManager } from "./session.js";
import { MetaToolHandler } from "./meta-tools.js";
import { BackendManager } from "./backend.js";
import { Router } from "./router.js";
import { GatewayServer } from "./server.js";
import { ConfigWatcher } from "./watcher.js";

const CONFIG_PATH = process.env.MCP_GATEWAY_CONFIG ?? "mcp-gateway.yaml";
const RETRY_INTERVAL_MS = 30_000;

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

  // Connect to backends
  const unavailable: Array<{ name: string; url: string }> = [];
  for (const serverConfig of config.servers) {
    try {
      console.log(`Connecting to backend '${serverConfig.name}' at ${serverConfig.url}`);
      const tools = await backendManager.connect(serverConfig.name, serverConfig.url);
      registry.registerServer(serverConfig.name, {
        description: serverConfig.description,
        tools,
      });
      console.log(
        `Connected to '${serverConfig.name}' — ${tools.length} tools registered`
      );

      // Subscribe to tools/list_changed from backend
      subscribeToToolChanges(
        serverConfig.name,
        () => config.servers.find((s) => s.name === serverConfig.name)?.description
      );
    } catch (error) {
      console.warn(
        `Failed to connect to '${serverConfig.name}': ${error instanceof Error ? error.message : error}`
      );
      registry.markUnavailable(serverConfig.name);
      unavailable.push({ name: serverConfig.name, url: serverConfig.url });
    }
  }

  const serverUrls = new Map(config.servers.map((s) => [s.name, s.url]));
  server = new GatewayServer({ registry, sessions, metaTools, router, serverUrls });

  // Retry unavailable backends
  if (unavailable.length > 0) {
    const retryInterval = setInterval(async () => {
      for (let i = unavailable.length - 1; i >= 0; i--) {
        const { name, url } = unavailable[i];
        try {
          const tools = await backendManager.connect(name, url);
          registry.removeServer(name);
          registry.registerServer(name, {
            description: config.servers.find((s) => s.name === name)?.description,
            tools,
          });
          // Subscribe to tools/list_changed from backend
          subscribeToToolChanges(
            name,
            () => config.servers.find((s) => s.name === name)?.description
          );

          unavailable.splice(i, 1);
          console.log(`Reconnected to '${name}' — ${tools.length} tools registered`);
          await server.notifyAllSessions();
        } catch {
          // Still unavailable, will retry
        }
      }
      if (unavailable.length === 0) {
        clearInterval(retryInterval);
      }
    }, RETRY_INTERVAL_MS);
    retryInterval.unref();
  }

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
          if (oldSc && (oldSc.url !== sc.url || oldSc.description !== sc.description)) {
            console.log(`Backend '${sc.name}' config changed, reconnecting...`);
            const toolNames = registry.getToolNamesForServer(sc.name);
            sessions.deactivateServerToolsFromAll(toolNames);
            registry.removeServer(sc.name);
            await backendManager.disconnect(sc.name);
            try {
              const tools = await backendManager.connect(sc.name, sc.url);
              registry.registerServer(sc.name, {
                description: sc.description,
                tools,
              });
              subscribeToToolChanges(
                sc.name,
                () => config.servers.find((s) => s.name === sc.name)?.description
              );
              console.log(`Reconnected to '${sc.name}' — ${tools.length} tools`);
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
          console.log(`Adding backend '${sc.name}' at ${sc.url}`);
          try {
            const tools = await backendManager.connect(sc.name, sc.url);
            registry.registerServer(sc.name, {
              description: sc.description,
              tools,
            });

            // Subscribe to tools/list_changed from backend
            subscribeToToolChanges(
              sc.name,
              () => config.servers.find((s) => s.name === sc.name)?.description
            );

            console.log(`Connected to '${sc.name}' — ${tools.length} tools`);
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
