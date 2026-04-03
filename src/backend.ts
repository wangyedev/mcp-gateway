// src/backend.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolDefinition } from "./registry.js";

export class BackendManager {
  private clients = new Map<string, Client>();

  async connect(name: string, url: string): Promise<ToolDefinition[]> {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ name: `mcp-gateway-${name}`, version: "0.1.0" });

    await client.connect(transport);
    this.clients.set(name, client);

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
      await client.close();
      this.clients.delete(name);
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
    client.setNotificationHandler(
      { method: "notifications/tools/list_changed" },
      callback
    );
  }
}
