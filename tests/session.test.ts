// tests/session.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { SessionManager } from "../src/session.js";

describe("SessionManager", () => {
  let sessions: SessionManager;

  beforeEach(() => {
    sessions = new SessionManager();
  });

  test("creates a session", () => {
    const id = sessions.createSession();
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
  });

  test("activates a tool for a session", () => {
    const id = sessions.createSession();
    sessions.activateTool(id, "postgres.query");

    expect(sessions.getActivatedTools(id)).toEqual(["postgres.query"]);
  });

  test("deactivates a tool for a session", () => {
    const id = sessions.createSession();
    sessions.activateTool(id, "postgres.query");
    sessions.deactivateTool(id, "postgres.query");

    expect(sessions.getActivatedTools(id)).toEqual([]);
  });

  test("throws when activating already active tool", () => {
    const id = sessions.createSession();
    sessions.activateTool(id, "postgres.query");

    expect(() => sessions.activateTool(id, "postgres.query")).toThrow("already activated");
  });

  test("throws when deactivating inactive tool", () => {
    const id = sessions.createSession();

    expect(() => sessions.deactivateTool(id, "postgres.query")).toThrow("not activated");
  });

  test("throws for unknown session", () => {
    expect(() => sessions.getActivatedTools("unknown")).toThrow("not found");
  });

  test("removes a session", () => {
    const id = sessions.createSession();
    sessions.activateTool(id, "postgres.query");
    sessions.removeSession(id);

    expect(() => sessions.getActivatedTools(id)).toThrow("not found");
  });

  test("isToolActivated returns correct state", () => {
    const id = sessions.createSession();
    expect(sessions.isToolActivated(id, "postgres.query")).toBe(false);

    sessions.activateTool(id, "postgres.query");
    expect(sessions.isToolActivated(id, "postgres.query")).toBe(true);
  });

  test("deactivates a tool across all sessions", () => {
    const id1 = sessions.createSession();
    const id2 = sessions.createSession();
    sessions.activateTool(id1, "postgres.query");
    sessions.activateTool(id2, "postgres.query");
    sessions.activateTool(id2, "postgres.list_tables");

    const affected = sessions.deactivateToolFromAll("postgres.query");

    expect(affected).toEqual([id1, id2]);
    expect(sessions.getActivatedTools(id1)).toEqual([]);
    expect(sessions.getActivatedTools(id2)).toEqual(["postgres.list_tables"]);
  });

  test("deactivates all tools for a server across all sessions", () => {
    const id1 = sessions.createSession();
    const id2 = sessions.createSession();
    sessions.activateTool(id1, "postgres.query");
    sessions.activateTool(id1, "github.repos");
    sessions.activateTool(id2, "postgres.list_tables");

    const affected = sessions.deactivateServerToolsFromAll(["postgres.query", "postgres.list_tables"]);

    expect(affected).toContain(id1);
    expect(affected).toContain(id2);
    expect(sessions.getActivatedTools(id1)).toEqual(["github.repos"]);
    expect(sessions.getActivatedTools(id2)).toEqual([]);
  });
});
