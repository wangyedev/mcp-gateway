import { describe, test, expect } from "vitest";
import { createPolicyEvaluator } from "../src/rbac.js";

describe("PolicyEvaluator", () => {
  test("no config allows everything", () => {
    const evaluator = createPolicyEvaluator();
    expect(evaluator.canAccessServer([], "postgres")).toBe(true);
    expect(evaluator.canAccessServer(["admin"], "anything")).toBe(true);
  });

  test("wildcard servers grants access to any server", () => {
    const evaluator = createPolicyEvaluator({
      defaultPolicy: "deny",
      roles: { admin: { servers: "*" } },
    });
    expect(evaluator.canAccessServer(["admin"], "postgres")).toBe(true);
    expect(evaluator.canAccessServer(["admin"], "github")).toBe(true);
  });

  test("specific servers grants access to listed servers only", () => {
    const evaluator = createPolicyEvaluator({
      defaultPolicy: "deny",
      roles: { analyst: { servers: ["postgres"] } },
    });
    expect(evaluator.canAccessServer(["analyst"], "postgres")).toBe(true);
    expect(evaluator.canAccessServer(["analyst"], "github")).toBe(false);
  });

  test("default policy deny rejects unrecognized roles", () => {
    const evaluator = createPolicyEvaluator({
      defaultPolicy: "deny",
      roles: { admin: { servers: "*" } },
    });
    expect(evaluator.canAccessServer(["unknown"], "postgres")).toBe(false);
  });

  test("default policy allow accepts unrecognized roles", () => {
    const evaluator = createPolicyEvaluator({
      defaultPolicy: "allow",
      roles: { admin: { servers: "*" } },
    });
    expect(evaluator.canAccessServer(["unknown"], "postgres")).toBe(true);
  });

  test("multiple roles: access granted if any role matches", () => {
    const evaluator = createPolicyEvaluator({
      defaultPolicy: "deny",
      roles: {
        analyst: { servers: ["postgres"] },
        dev: { servers: ["github"] },
      },
    });
    expect(evaluator.canAccessServer(["analyst", "dev"], "postgres")).toBe(true);
    expect(evaluator.canAccessServer(["analyst", "dev"], "github")).toBe(true);
    expect(evaluator.canAccessServer(["analyst", "dev"], "internal")).toBe(false);
  });

  test("empty roles array uses default policy", () => {
    const evaluator = createPolicyEvaluator({
      defaultPolicy: "deny",
      roles: { admin: { servers: "*" } },
    });
    expect(evaluator.canAccessServer([], "postgres")).toBe(false);
  });
});
