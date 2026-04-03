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
      backendManager.onToolsChanged(serverConfig.name, async () => {
        console.log(`Backend '${serverConfig.name}' tools changed, refreshing...`);
        try {
          const newTools = await backendManager.refreshTools(serverConfig.name);
          const oldToolNames = registry.getToolNamesForServer(serverConfig.name);
          registry.removeServer(serverConfig.name);
          registry.registerServer(serverConfig.name, {
            description: serverConfig.description,
            tools: newTools,
          });

          // Check for removed tools and deactivate them
          const newToolNames = new Set(registry.getToolNamesForServer(serverConfig.name));
          const removedTools = oldToolNames.filter((n) => !newToolNames.has(n));
          if (removedTools.length > 0) {
            const affected = sessions.deactivateServerToolsFromAll(removedTools);
            await server.notifyToolListChangedForSessions(affected);
          }
        } catch (error) {
          console.error(`Failed to refresh tools for '${serverConfig.name}':`, error);
        }
      });
    } catch (error) {
      console.warn(
        `Failed to connect to '${serverConfig.name}': ${error instanceof Error ? error.message : error}`
      );
      registry.markUnavailable(serverConfig.name);
      unavailable.push({ name: serverConfig.name, url: serverConfig.url });
    }
  }

  const server = new GatewayServer({ registry, sessions, metaTools, router });

  // Retry unavailable backends
  if (unavailable.length > 0) {
    const retryInterval = setInterval(async () => {
      for (let i = unavailable.length - 1; i >= 0; i--) {
        const { name, url } = unavailable[i];
        try {
          const serverConfig = config.servers.find((s) => s.name === name);
          const tools = await backendManager.connect(name, url);
          registry.removeServer(name);
          registry.registerServer(name, {
            description: serverConfig?.description,
            tools,
          });
          // Subscribe to tools/list_changed from backend
          backendManager.onToolsChanged(name, async () => {
            console.log(`Backend '${name}' tools changed, refreshing...`);
            try {
              const newTools = await backendManager.refreshTools(name);
              const oldToolNames = registry.getToolNamesForServer(name);
              registry.removeServer(name);
              registry.registerServer(name, {
                description: serverConfig?.description,
                tools: newTools,
              });
              const newToolNames = new Set(registry.getToolNamesForServer(name));
              const removedTools = oldToolNames.filter((n) => !newToolNames.has(n));
              if (removedTools.length > 0) {
                const affected = sessions.deactivateServerToolsFromAll(removedTools);
                await server.notifyToolListChangedForSessions(affected);
              }
            } catch (error) {
              console.error(`Failed to refresh tools for '${name}':`, error);
            }
          });

          unavailable.splice(i, 1);
          console.log(`Reconnected to '${name}' — ${tools.length} tools registered`);
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
          const affected = sessions.deactivateServerToolsFromAll(toolNames);
          registry.removeServer(name);
          await backendManager.disconnect(name);
          await server.notifyToolListChangedForSessions(affected);
        }
      }

      // Detect modified servers (URL or description changed)
      for (const sc of newConfig.servers) {
        if (oldNames.has(sc.name) && newNames.has(sc.name)) {
          const oldSc = config.servers.find((s) => s.name === sc.name);
          if (oldSc && (oldSc.url !== sc.url || oldSc.description !== sc.description)) {
            console.log(`Backend '${sc.name}' config changed, reconnecting...`);
            const toolNames = registry.getToolNamesForServer(sc.name);
            const affected = sessions.deactivateServerToolsFromAll(toolNames);
            registry.removeServer(sc.name);
            await backendManager.disconnect(sc.name);
            try {
              const tools = await backendManager.connect(sc.name, sc.url);
              registry.registerServer(sc.name, {
                description: sc.description,
                tools,
              });
              backendManager.onToolsChanged(sc.name, async () => {
                console.log(`Backend '${sc.name}' tools changed, refreshing...`);
                try {
                  const newTools = await backendManager.refreshTools(sc.name);
                  const oldToolNames = registry.getToolNamesForServer(sc.name);
                  registry.removeServer(sc.name);
                  registry.registerServer(sc.name, {
                    description: sc.description,
                    tools: newTools,
                  });
                  const newToolNames = new Set(registry.getToolNamesForServer(sc.name));
                  const removedTools = oldToolNames.filter((n) => !newToolNames.has(n));
                  if (removedTools.length > 0) {
                    const aff = sessions.deactivateServerToolsFromAll(removedTools);
                    await server.notifyToolListChangedForSessions(aff);
                  }
                } catch (error) {
                  console.error(`Failed to refresh tools for '${sc.name}':`, error);
                }
              });
              console.log(`Reconnected to '${sc.name}' — ${tools.length} tools`);
            } catch (error) {
              console.warn(`Failed to reconnect to '${sc.name}':`, error);
              registry.markUnavailable(sc.name);
            }
            if (affected.length > 0) {
              await server.notifyToolListChangedForSessions(affected);
            }
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
            backendManager.onToolsChanged(sc.name, async () => {
              console.log(`Backend '${sc.name}' tools changed, refreshing...`);
              try {
                const newTools = await backendManager.refreshTools(sc.name);
                const oldToolNames = registry.getToolNamesForServer(sc.name);
                registry.removeServer(sc.name);
                registry.registerServer(sc.name, {
                  description: sc.description,
                  tools: newTools,
                });
                const newToolNames = new Set(registry.getToolNamesForServer(sc.name));
                const removedTools = oldToolNames.filter((n) => !newToolNames.has(n));
                if (removedTools.length > 0) {
                  const affected = sessions.deactivateServerToolsFromAll(removedTools);
                  await server.notifyToolListChangedForSessions(affected);
                }
              } catch (error) {
                console.error(`Failed to refresh tools for '${sc.name}':`, error);
              }
            });

            console.log(`Connected to '${sc.name}' — ${tools.length} tools`);
          } catch (error) {
            console.warn(`Failed to connect to '${sc.name}':`, error);
            registry.markUnavailable(sc.name);
          }
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
