import { describe, test, expect, beforeEach, vi } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test("allows requests within limit", () => {
    const limiter = new RateLimiter(5, 60); // 5 requests per 60 seconds
    const sessionId = "session-1";

    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
  });

  test("blocks requests exceeding limit", () => {
    const limiter = new RateLimiter(3, 60);
    const sessionId = "session-1";

    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(false); // 4th request blocked
    expect(limiter.tryAcquire(sessionId)).toBe(false); // 5th request blocked
  });

  test("resets window after expiry", () => {
    const limiter = new RateLimiter(2, 60);
    const sessionId = "session-1";

    // Use up the limit
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(false);

    // Advance time by 60 seconds
    vi.advanceTimersByTime(60 * 1000);

    // Window should be reset
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(false);
  });

  test("handles multiple independent sessions", () => {
    const limiter = new RateLimiter(2, 60);

    expect(limiter.tryAcquire("session-1")).toBe(true);
    expect(limiter.tryAcquire("session-1")).toBe(true);
    expect(limiter.tryAcquire("session-1")).toBe(false);

    // session-2 should have its own limit
    expect(limiter.tryAcquire("session-2")).toBe(true);
    expect(limiter.tryAcquire("session-2")).toBe(true);
    expect(limiter.tryAcquire("session-2")).toBe(false);

    // session-1 still blocked
    expect(limiter.tryAcquire("session-1")).toBe(false);
  });

  test("removeSession cleans up session data", () => {
    const limiter = new RateLimiter(2, 60);
    const sessionId = "session-1";

    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(false);

    // Remove session
    limiter.removeSession(sessionId);

    // Should get a fresh window
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
    expect(limiter.tryAcquire(sessionId)).toBe(false);
  });

  test("tracks active window count", () => {
    const limiter = new RateLimiter(5, 60);

    expect(limiter.getActiveWindowCount()).toBe(0);

    limiter.tryAcquire("session-1");
    expect(limiter.getActiveWindowCount()).toBe(1);

    limiter.tryAcquire("session-2");
    expect(limiter.getActiveWindowCount()).toBe(2);

    limiter.removeSession("session-1");
    expect(limiter.getActiveWindowCount()).toBe(1);

    limiter.removeSession("session-2");
    expect(limiter.getActiveWindowCount()).toBe(0);
  });

  test("handles window expiry correctly", () => {
    const limiter = new RateLimiter(3, 10); // 3 requests per 10 seconds
    const sessionId = "session-1";

    // Use up limit
    limiter.tryAcquire(sessionId);
    limiter.tryAcquire(sessionId);
    limiter.tryAcquire(sessionId);
    expect(limiter.tryAcquire(sessionId)).toBe(false);

    // Advance time by 9.9 seconds (just before expiry)
    vi.advanceTimersByTime(9900);
    expect(limiter.tryAcquire(sessionId)).toBe(false);

    // Advance time by 0.1 second more (window expires)
    vi.advanceTimersByTime(100);
    expect(limiter.tryAcquire(sessionId)).toBe(true);
  });

  test("different window durations work independently", () => {
    const limiter1 = new RateLimiter(5, 10); // 10 second window
    const limiter2 = new RateLimiter(5, 60); // 60 second window

    const session = "test-session";

    // Fill both limiters
    for (let i = 0; i < 5; i++) {
      limiter1.tryAcquire(session);
      limiter2.tryAcquire(session);
    }

    expect(limiter1.tryAcquire(session)).toBe(false);
    expect(limiter2.tryAcquire(session)).toBe(false);

    // Advance 10 seconds
    vi.advanceTimersByTime(10 * 1000);

    // limiter1 should reset, limiter2 should not
    expect(limiter1.tryAcquire(session)).toBe(true);
    expect(limiter2.tryAcquire(session)).toBe(false);
  });
});
