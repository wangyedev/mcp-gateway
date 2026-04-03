import { describe, test, expect } from "vitest";
import { createAuthMiddleware } from "../src/auth.js";

describe("createAuthMiddleware", () => {
  test("type none returns empty array", () => {
    const middleware = createAuthMiddleware({ type: "none" });
    expect(middleware).toEqual([]);
  });

  test("undefined config returns empty array", () => {
    const middleware = createAuthMiddleware();
    expect(middleware).toEqual([]);
  });

  test("proxy mode returns middleware", () => {
    const middleware = createAuthMiddleware({
      type: "proxy",
      issuer: "https://auth.example.com",
    });
    expect(middleware).toHaveLength(1);
    expect(typeof middleware[0]).toBe("function");
  });

  test("builtin mode returns middleware", () => {
    const middleware = createAuthMiddleware({
      type: "builtin",
    });
    expect(middleware).toHaveLength(1);
    expect(typeof middleware[0]).toBe("function");
  });
});
