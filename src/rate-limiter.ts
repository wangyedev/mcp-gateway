// src/rate-limiter.ts

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowSeconds: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowSeconds * 1000;
  }

  /**
   * Attempts to acquire a permit for the given session.
   * Returns true if the request is allowed, false if rate limit is exceeded.
   */
  tryAcquire(sessionId: string): boolean {
    const now = Date.now();
    const window = this.windows.get(sessionId);

    // No window exists or window has expired -> create new window
    if (!window || now >= window.resetAt) {
      this.windows.set(sessionId, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    // Window exists and is active -> check limit
    if (window.count >= this.maxRequests) {
      return false;
    }

    // Increment and allow
    window.count++;
    return true;
  }

  /**
   * Removes the session's rate limit window.
   * Called when a session is closed.
   */
  removeSession(sessionId: string): void {
    this.windows.delete(sessionId);
  }

  /**
   * Returns the number of active windows (for testing/monitoring).
   */
  getActiveWindowCount(): number {
    return this.windows.size;
  }
}
