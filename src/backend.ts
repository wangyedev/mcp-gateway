// src/backend.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ToolDefinition } from "./registry.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class BackendManager {
  private clients = new Map<string, Client>();
  private transports = new Map<string, Transport>();
  private closeCallbacks = new Map<string, () => void>();

  async connect(name: string, url: string): Promise<ToolDefinition[]> {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    return this.connectWithTransport(name, transport);
  }

  async connectStdio(
    name: string,
    params: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  ): Promise<ToolDefinition[]> {
    const transport = new StdioClientTransport({
      command: params.command,
      args: params.args,
      env: params.env,
      cwd: params.cwd,
    });

    transport.onclose = () => {
      // Only fire crash callback if we still consider this client connected
      // (i.e., this wasn't a deliberate disconnect)
      if (this.clients.has(name)) {
        this.clients.delete(name);
        this.transports.delete(name);
        this.closeCallbacks.get(name)?.();
      }
    };

    return this.connectWithTransport(name, transport);
  }

  private async connectWithTransport(
    name: string,
    transport: Transport
  ): Promise<ToolDefinition[]> {
    const client = new Client({
      name: `mcp-gateway-${name}`,
      version: "0.1.0",
    });

    await client.connect(transport);
    this.clients.set(name, client);
    this.transports.set(name, transport);

    const response = await client.listTools();
    return response.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as ToolDefinition["inputSchema"],
    }));
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      this.clients.delete(name);
      this.transports.delete(name);
      this.closeCallbacks.delete(name);
      await client.close();
    }
  }

  async disconnectAll(): Promise<void> {
    const names = [...this.clients.keys()];
    await Promise.all(names.map((name) => this.disconnect(name)));
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text?: string; [key: string]: unknown }> }> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Backend server '${serverName}' is not connected`);
    }

    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      return result as {
        content: Array<{ type: string; text?: string; [key: string]: unknown }>;
      };
    } catch (error) {
      throw new Error(
        `Backend server '${serverName}' is unreachable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async refreshTools(name: string): Promise<ToolDefinition[]> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`Backend server '${name}' is not connected`);
    }
    const response = await client.listTools();
    return response.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as ToolDefinition["inputSchema"],
    }));
  }

  isConnected(name: string): boolean {
    return this.clients.has(name);
  }

  onToolsChanged(name: string, callback: () => void): void {
    const client = this.clients.get(name);
    if (!client) return;
    client.setNotificationHandler(ToolListChangedNotificationSchema, callback);
  }

  onClose(name: string, callback: () => void): void {
    this.closeCallbacks.set(name, callback);
  }
}
