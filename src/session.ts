// src/session.ts
import { randomUUID } from "crypto";

export class SessionManager {
  private sessions = new Map<string, Set<string>>();

  createSession(): string {
    const id = randomUUID();
    this.sessions.set(id, new Set());
    return id;
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  activateTool(sessionId: string, toolName: string): void {
    const tools = this.getSession(sessionId);
    if (tools.has(toolName)) {
      throw new Error(`Tool '${toolName}' is already activated`);
    }
    tools.add(toolName);
  }

  deactivateTool(sessionId: string, toolName: string): void {
    const tools = this.getSession(sessionId);
    if (!tools.has(toolName)) {
      throw new Error(`Tool '${toolName}' is not activated`);
    }
    tools.delete(toolName);
  }

  isToolActivated(sessionId: string, toolName: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.has(toolName);
  }

  getActivatedTools(sessionId: string): string[] {
    return [...this.getSession(sessionId)];
  }

  deactivateToolFromAll(toolName: string): string[] {
    const affected: string[] = [];
    for (const [sessionId, tools] of this.sessions) {
      if (tools.has(toolName)) {
        tools.delete(toolName);
        affected.push(sessionId);
      }
    }
    return affected;
  }

  deactivateServerToolsFromAll(toolNames: string[]): string[] {
    const nameSet = new Set(toolNames);
    const affected = new Set<string>();
    for (const [sessionId, tools] of this.sessions) {
      for (const name of nameSet) {
        if (tools.has(name)) {
          tools.delete(name);
          affected.add(sessionId);
        }
      }
    }
    return [...affected];
  }

  private getSession(sessionId: string): Set<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found`);
    }
    return session;
  }
}
