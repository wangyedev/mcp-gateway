# Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured logging and Prometheus metrics to the MCP gateway for production monitoring and developer debugging.

**Architecture:** Two new modules — `src/logger.ts` (structured logging with level filtering and JSON/pretty output) and `src/metrics.ts` (in-memory counters/histograms/gauges with Prometheus text export). Both are dependency-free. Components accept optional logger/metrics via constructor options. Existing `console.*` calls are migrated to the logger. A `GET /metrics` endpoint exposes Prometheus-format metrics.

**Tech Stack:** No new dependencies. Logger wraps `console`. Metrics use plain objects.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/logger.ts` | Create | Structured logger with levels, JSON/pretty output |
| `tests/logger.test.ts` | Create | Logger tests (levels, formats, filtering) |
| `src/metrics.ts` | Create | In-memory metrics registry with Prometheus export |
| `tests/metrics.test.ts` | Create | Metrics tests (counters, histograms, gauges, export) |
| `src/server.ts` | Modify | Tool call instrumentation, session gauge, `/metrics` endpoint |
| `src/index.ts` | Modify | Create logger/metrics, migrate console.* calls, pass to components |
| `src/backend.ts` | Modify | Accept optional logger for connection logging |
| `src/watcher.ts` | Modify | Accept optional logger for reload logging |
| `README.md` | Modify | Document `/metrics` endpoint and env vars |

---

### Task 1: Logger Module

**Files:**
- Create: `src/logger.ts`
- Create: `tests/logger.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/logger.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger, LogLevel } from "../src/logger.js";

describe("Logger", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      LOG_LEVEL: process.env.LOG_LEVEL,
      LOG_FORMAT: process.env.LOG_FORMAT,
    };
  });

  afterEach(() => {
    process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
    process.env.LOG_FORMAT = originalEnv.LOG_FORMAT;
  });

  test("JSON mode outputs valid JSON with required fields", () => {
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("test message", { key: "value" });

    expect(spy).toHaveBeenCalledOnce();
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.level).toBe("info");
    expect(output.msg).toBe("test message");
    expect(output.key).toBe("value");
    expect(output.timestamp).toBeDefined();
    spy.mockRestore();
  });

  test("pretty mode outputs human-readable format", () => {
    process.env.LOG_FORMAT = "pretty";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("test message", { server: "postgres" });

    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("[INFO]");
    expect(output).toContain("test message");
    expect(output).toContain("server=postgres");
    spy.mockRestore();
  });

  test("debug messages suppressed at info level", () => {
    process.env.LOG_LEVEL = "info";
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.debug("should not appear");

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("debug messages shown at debug level", () => {
    process.env.LOG_LEVEL = "debug";
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.debug("should appear");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("warn uses console.warn", () => {
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logger.warn("warning message");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("error uses console.error", () => {
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.error("error message");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("level filtering respects hierarchy", () => {
    process.env.LOG_LEVEL = "warn";
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.debug("no");
    logger.info("no");
    logger.warn("yes");
    logger.error("yes");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("defaults to info level when LOG_LEVEL not set", () => {
    delete process.env.LOG_LEVEL;
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.debug("should not appear");
    logger.info("should appear");

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("context with no extra fields works", () => {
    process.env.LOG_FORMAT = "json";
    const logger = createLogger();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("simple message");

    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output.msg).toBe("simple message");
    expect(output.level).toBe("info");
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/logger.test.ts`
Expected: Failures because `src/logger.ts` doesn't exist.

- [ ] **Step 3: Implement the logger module**

Create `src/logger.ts`:

```typescript
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

export function createLogger(): Logger {
  const minLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
  const format = process.env.LOG_FORMAT === "json" ? "json" : "pretty";
  const minOrder = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info;

  function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= minOrder;
  }

  function formatJson(
    level: LogLevel,
    msg: string,
    context?: Record<string, unknown>
  ): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      msg,
      ...context,
    });
  }

  function formatPretty(
    level: LogLevel,
    msg: string,
    context?: Record<string, unknown>
  ): string {
    const timestamp = new Date().toISOString();
    const tag = `[${level.toUpperCase()}]`;
    const contextStr = context
      ? " " +
        Object.entries(context)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      : "";
    return `${timestamp} ${tag} ${msg}${contextStr}`;
  }

  function log(
    level: LogLevel,
    msg: string,
    context?: Record<string, unknown>
  ): void {
    if (!shouldLog(level)) return;
    const formatted =
      format === "json"
        ? formatJson(level, msg, context)
        : formatPretty(level, msg, context);

    switch (level) {
      case "error":
        console.error(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
        break;
    }
  }

  return {
    debug: (msg, context) => log("debug", msg, context),
    info: (msg, context) => log("info", msg, context),
    warn: (msg, context) => log("warn", msg, context),
    error: (msg, context) => log("error", msg, context),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/logger.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/logger.ts tests/logger.test.ts
git commit -m "feat: add structured logger module with JSON/pretty output"
```

---

### Task 2: Metrics Module

**Files:**
- Create: `src/metrics.ts`
- Create: `tests/metrics.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/metrics.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { MetricsRegistry } from "../src/metrics.js";

describe("MetricsRegistry", () => {
  test("counter increments", () => {
    const metrics = new MetricsRegistry();
    metrics.defineCounter(
      "test_total",
      "A test counter"
    );
    metrics.incrementCounter("test_total");
    metrics.incrementCounter("test_total");

    const output = metrics.toPrometheus();
    expect(output).toContain("# HELP test_total A test counter");
    expect(output).toContain("# TYPE test_total counter");
    expect(output).toContain("test_total 2");
  });

  test("counter with labels tracks separately", () => {
    const metrics = new MetricsRegistry();
    metrics.defineCounter(
      "requests_total",
      "Total requests"
    );
    metrics.incrementCounter("requests_total", {
      status: "success",
    });
    metrics.incrementCounter("requests_total", {
      status: "success",
    });
    metrics.incrementCounter("requests_total", {
      status: "error",
    });

    const output = metrics.toPrometheus();
    expect(output).toContain(
      'requests_total{status="success"} 2'
    );
    expect(output).toContain(
      'requests_total{status="error"} 1'
    );
  });

  test("gauge sets and updates value", () => {
    const metrics = new MetricsRegistry();
    metrics.defineGauge(
      "active_sessions",
      "Active sessions"
    );
    metrics.setGauge("active_sessions", 5);

    let output = metrics.toPrometheus();
    expect(output).toContain("# TYPE active_sessions gauge");
    expect(output).toContain("active_sessions 5");

    metrics.setGauge("active_sessions", 3);
    output = metrics.toPrometheus();
    expect(output).toContain("active_sessions 3");
  });

  test("histogram records observations into buckets", () => {
    const metrics = new MetricsRegistry();
    metrics.defineHistogram(
      "duration_seconds",
      "Request duration",
      [0.01, 0.05, 0.1, 0.5, 1]
    );
    metrics.observeHistogram("duration_seconds", 0.03, {
      tool: "query",
    });
    metrics.observeHistogram("duration_seconds", 0.07, {
      tool: "query",
    });
    metrics.observeHistogram("duration_seconds", 0.5, {
      tool: "query",
    });

    const output = metrics.toPrometheus();
    expect(output).toContain("# TYPE duration_seconds histogram");
    // 0.03 fits in 0.05 bucket and above
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="0.01"} 0'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="0.05"} 1'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="0.1"} 2'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="0.5"} 3'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="1"} 3'
    );
    expect(output).toContain(
      'duration_seconds_bucket{tool="query",le="+Inf"} 3'
    );
    expect(output).toContain(
      'duration_seconds_sum{tool="query"} 0.6'
    );
    expect(output).toContain(
      'duration_seconds_count{tool="query"} 3'
    );
  });

  test("histogram with multiple label sets", () => {
    const metrics = new MetricsRegistry();
    metrics.defineHistogram(
      "duration_seconds",
      "Request duration",
      [0.1, 1]
    );
    metrics.observeHistogram("duration_seconds", 0.05, {
      server: "a",
    });
    metrics.observeHistogram("duration_seconds", 0.5, {
      server: "b",
    });

    const output = metrics.toPrometheus();
    expect(output).toContain(
      'duration_seconds_bucket{server="a",le="0.1"} 1'
    );
    expect(output).toContain(
      'duration_seconds_bucket{server="b",le="0.1"} 0'
    );
  });

  test("empty registry returns empty string", () => {
    const metrics = new MetricsRegistry();
    expect(metrics.toPrometheus()).toBe("");
  });

  test("multiple metric types in output", () => {
    const metrics = new MetricsRegistry();
    metrics.defineCounter("calls_total", "Total calls");
    metrics.defineGauge("sessions", "Active sessions");
    metrics.incrementCounter("calls_total");
    metrics.setGauge("sessions", 2);

    const output = metrics.toPrometheus();
    expect(output).toContain("# TYPE calls_total counter");
    expect(output).toContain("# TYPE sessions gauge");
    expect(output).toContain("calls_total 1");
    expect(output).toContain("sessions 2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/metrics.test.ts`
Expected: Failures because `src/metrics.ts` doesn't exist.

- [ ] **Step 3: Implement the metrics module**

Create `src/metrics.ts`:

```typescript
type MetricType = "counter" | "gauge" | "histogram";

interface MetricDefinition {
  type: MetricType;
  help: string;
  buckets?: number[]; // histogram only
}

function labelsKey(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return "";
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
}

function formatLabels(key: string): string {
  return key ? `{${key}}` : "";
}

export class MetricsRegistry {
  private definitions = new Map<string, MetricDefinition>();
  private counters = new Map<string, Map<string, number>>();
  private gauges = new Map<string, number>();
  private histograms = new Map<
    string,
    Map<string, { buckets: number[]; counts: number[]; sum: number; count: number }>
  >();

  defineCounter(name: string, help: string): void {
    this.definitions.set(name, { type: "counter", help });
    if (!this.counters.has(name)) {
      this.counters.set(name, new Map());
    }
  }

  defineGauge(name: string, help: string): void {
    this.definitions.set(name, { type: "gauge", help });
  }

  defineHistogram(name: string, help: string, buckets: number[]): void {
    this.definitions.set(name, {
      type: "histogram",
      help,
      buckets: [...buckets].sort((a, b) => a - b),
    });
    if (!this.histograms.has(name)) {
      this.histograms.set(name, new Map());
    }
  }

  incrementCounter(
    name: string,
    labels?: Record<string, string>
  ): void {
    const map = this.counters.get(name);
    if (!map) return;
    const key = labelsKey(labels);
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observeHistogram(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): void {
    const map = this.histograms.get(name);
    if (!map) return;
    const def = this.definitions.get(name);
    if (!def || !def.buckets) return;

    const key = labelsKey(labels);
    let entry = map.get(key);
    if (!entry) {
      entry = {
        buckets: def.buckets,
        counts: new Array(def.buckets.length + 1).fill(0), // +1 for +Inf
        sum: 0,
        count: 0,
      };
      map.set(key, entry);
    }

    for (let i = 0; i < entry.buckets.length; i++) {
      if (value <= entry.buckets[i]) {
        entry.counts[i]++;
      }
    }
    entry.counts[entry.buckets.length]++; // +Inf
    entry.sum += value;
    entry.count++;
  }

  toPrometheus(): string {
    const lines: string[] = [];

    for (const [name, def] of this.definitions) {
      if (def.type === "counter") {
        const map = this.counters.get(name);
        if (!map || map.size === 0) continue;
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} counter`);
        for (const [key, value] of map) {
          lines.push(`${name}${formatLabels(key)} ${value}`);
        }
      } else if (def.type === "gauge") {
        const value = this.gauges.get(name);
        if (value === undefined) continue;
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} gauge`);
        lines.push(`${name} ${value}`);
      } else if (def.type === "histogram") {
        const map = this.histograms.get(name);
        if (!map || map.size === 0) continue;
        lines.push(`# HELP ${name} ${def.help}`);
        lines.push(`# TYPE ${name} histogram`);
        for (const [key, entry] of map) {
          const baseLabels = key;
          for (let i = 0; i < entry.buckets.length; i++) {
            const leLabel = `le="${entry.buckets[i]}"`;
            const combined = baseLabels
              ? `${baseLabels},${leLabel}`
              : leLabel;
            lines.push(
              `${name}_bucket{${combined}} ${entry.counts[i]}`
            );
          }
          const infLabel = `le="+Inf"`;
          const infCombined = baseLabels
            ? `${baseLabels},${infLabel}`
            : infLabel;
          lines.push(
            `${name}_bucket{${infCombined}} ${entry.counts[entry.buckets.length]}`
          );
          lines.push(
            `${name}_sum${formatLabels(baseLabels)} ${entry.sum}`
          );
          lines.push(
            `${name}_count${formatLabels(baseLabels)} ${entry.count}`
          );
        }
      }
    }

    return lines.length > 0 ? lines.join("\n") + "\n" : "";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/metrics.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/metrics.ts tests/metrics.test.ts
git commit -m "feat: add metrics registry with Prometheus text export"
```

---

### Task 3: Instrument server.ts — Tool Calls, Sessions, /metrics Endpoint

**Files:**
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts` (if exists, otherwise integration tests cover it)

- [ ] **Step 1: Add logger and metrics imports and constructor params**

At the top of `src/server.ts`, add imports:

```typescript
import { Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
```

Update the `GatewayServerOptions` interface (currently at line 31) to add optional logger and metrics:

```typescript
interface GatewayServerOptions {
  registry: ToolRegistry;
  sessions: SessionManager;
  metaTools: MetaToolHandler;
  router: Router;
  serverUrls?: Map<string, string>;
  maxSessions?: number;
  logger?: Logger;
  metrics?: MetricsRegistry;
}
```

Add fields to the `GatewayServer` class and update the constructor:

```typescript
  private logger?: Logger;
  private metrics?: MetricsRegistry;
```

In the constructor, add:

```typescript
    this.logger = options.logger;
    this.metrics = options.metrics;
```

- [ ] **Step 2: Instrument handleToolCall**

In `handleToolCall()` (currently at line 82), wrap the method body to track latency and counts. Replace the method with:

```typescript
  async handleToolCall(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const startTime = Date.now();
    try {
      if (META_TOOL_NAMES.has(toolName)) {
        const result = this.handleMetaToolCall(sessionId, toolName, args);

        // Track activations/deactivations
        if (toolName === "activate_tool") {
          const name = args.name as string;
          const dotIdx = name?.indexOf(".");
          if (dotIdx > 0) {
            this.metrics?.incrementCounter("gateway_tool_activations_total", {
              server: name.substring(0, dotIdx),
              tool: name.substring(dotIdx + 1),
            });
          }
        } else if (toolName === "deactivate_tool") {
          const name = args.name as string;
          const dotIdx = name?.indexOf(".");
          if (dotIdx > 0) {
            this.metrics?.incrementCounter("gateway_tool_deactivations_total", {
              server: name.substring(0, dotIdx),
              tool: name.substring(dotIdx + 1),
            });
          }
        }

        if (toolName === "activate_tool" || toolName === "deactivate_tool") {
          this.notifyToolListChangedForSessions([sessionId]).catch(() => {});
        }

        return result;
      }

      if (!this.sessions.isToolActivated(sessionId, toolName)) {
        return {
          content: [
            {
              type: "text",
              text: `Tool '${toolName}' is not activated. Call activate_tool first.`,
            },
          ],
          isError: true,
        };
      }

      const result = await this.router.routeToolCall(toolName, args);

      // Record success metrics
      const dotIdx = toolName.indexOf(".");
      if (dotIdx > 0) {
        const server = toolName.substring(0, dotIdx);
        const tool = toolName.substring(dotIdx + 1);
        const durationSec = (Date.now() - startTime) / 1000;
        this.metrics?.incrementCounter("gateway_tool_calls_total", {
          server,
          tool,
          status: "success",
        });
        this.metrics?.observeHistogram(
          "gateway_tool_call_duration_seconds",
          durationSec,
          { server, tool }
        );
      }

      return result;
    } catch (error) {
      // Record error metrics
      const dotIdx = toolName.indexOf(".");
      if (dotIdx > 0) {
        const server = toolName.substring(0, dotIdx);
        const tool = toolName.substring(dotIdx + 1);
        const durationSec = (Date.now() - startTime) / 1000;
        this.metrics?.incrementCounter("gateway_tool_calls_total", {
          server,
          tool,
          status: "error",
        });
        this.metrics?.observeHistogram(
          "gateway_tool_call_duration_seconds",
          durationSec,
          { server, tool }
        );
        this.metrics?.incrementCounter("gateway_errors_total", {
          server,
          type: "tool_call",
        });
      }

      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  }
```

- [ ] **Step 3: Instrument session tracking**

In `handleNewSession()`, after `const gatewaySessionId = this.sessions.createSession();` add:

```typescript
    this.metrics?.setGauge("gateway_active_sessions", this.mcpSessions.size + 1);
```

In the `transport.onclose` handler (inside `handleNewSession`), after `this.sessions.removeSession(gatewaySessionId);` add:

```typescript
        this.metrics?.setGauge("gateway_active_sessions", this.mcpSessions.size);
```

- [ ] **Step 4: Add /metrics endpoint**

In `startMcp()`, after the existing `app.get("/status", ...)` handler, add:

```typescript
    // GET /metrics -- returns Prometheus-format metrics
    app.get("/metrics", (_req, res) => {
      const body = this.metrics?.toPrometheus() ?? "";
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(body);
    });
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass. Existing server tests don't pass logger/metrics, so they'll use undefined (which is fine — the `?.` optional chaining handles it).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "feat: instrument server with tool call metrics and /metrics endpoint"
```

---

### Task 4: Integrate Logger and Metrics into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

At the top of `src/index.ts`, add:

```typescript
import { createLogger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
```

- [ ] **Step 2: Create logger and metrics instances at the start of main()**

After line 29 (`const config = loadConfig(CONFIG_PATH);`), but before the component creation, add:

```typescript
  const logger = createLogger();
  const metrics = new MetricsRegistry();

  // Define all metrics
  metrics.defineCounter(
    "gateway_tool_calls_total",
    "Total tool calls routed through the gateway"
  );
  metrics.defineHistogram(
    "gateway_tool_call_duration_seconds",
    "Tool call latency in seconds",
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
  );
  metrics.defineCounter(
    "gateway_tool_activations_total",
    "Tool activations"
  );
  metrics.defineCounter(
    "gateway_tool_deactivations_total",
    "Tool deactivations"
  );
  metrics.defineCounter(
    "gateway_backend_connections_total",
    "Backend connection attempts"
  );
  metrics.defineGauge(
    "gateway_active_sessions",
    "Current active session count"
  );
  metrics.defineCounter(
    "gateway_errors_total",
    "Error counts by type"
  );
```

- [ ] **Step 3: Pass logger and metrics to GatewayServer**

Update the `new GatewayServer({...})` call to include logger and metrics:

```typescript
  server = new GatewayServer({
    registry,
    sessions,
    metaTools,
    router,
    serverUrls,
    logger,
    metrics,
  });
```

- [ ] **Step 4: Replace all console.* calls in index.ts with logger calls**

Replace every `console.log(...)` with `logger.info(...)`, every `console.warn(...)` with `logger.warn(...)`, and every `console.error(...)` with `logger.error(...)`. Convert string interpolation to structured context fields.

Key replacements (apply to ALL occurrences — there are ~20):

```typescript
// Before:
console.log(`Loading config from ${CONFIG_PATH}`);
// After:
logger.info("Loading config", { path: CONFIG_PATH });

// Before:
console.log(`Backend '${serverName}' tools changed, refreshing...`);
// After:
logger.info("Backend tools changed, refreshing", { server: serverName });

// Before:
console.error(`Failed to refresh tools for '${serverName}':`, error);
// After:
logger.error("Failed to refresh tools", { server: serverName, error: error instanceof Error ? error.message : String(error) });

// Before:
console.warn(`Stdio backend '${serverName}' crashed, marking unavailable`);
// After:
logger.warn("Stdio backend crashed, marking unavailable", { server: serverName });

// Before:
console.log(`Connecting to backend '${serverConfig.name}' (${label})`);
// After:
logger.info("Connecting to backend", { server: serverConfig.name, endpoint: label });

// Before:
console.log(`Connected to '${serverConfig.name}' — ${tools.length} tools registered`);
// After:
logger.info("Connected to backend", { server: serverConfig.name, tools: tools.length });

// Before:
console.warn(`Failed to connect to '${serverConfig.name}': ${...}`);
// After:
logger.warn("Failed to connect to backend", { server: serverConfig.name, error: error instanceof Error ? error.message : String(error) });

// Before:
console.error(`Server '${entry.name}' failed to start after ${STDIO_MAX_RETRIES} attempts, giving up.`);
// After:
logger.error("Server failed to start, giving up", { server: entry.name, maxRetries: STDIO_MAX_RETRIES });

// Before:
console.log(`Reconnected to '${entry.name}' — ${tools.length} tools registered`);
// After:
logger.info("Reconnected to backend", { server: entry.name, tools: tools.length });

// Before:
console.log("Config changed, reloading...");
// After:
logger.info("Config changed, reloading");

// Before:
console.log(`Removing backend '${name}'`);
// After:
logger.info("Removing backend", { server: name });

// Before:
console.log(`Backend '${sc.name}' config changed, reconnecting...`);
// After:
logger.info("Backend config changed, reconnecting", { server: sc.name });

// Before:
console.log(`MCP Gateway listening on http://${host}:${port}/mcp`);
// After:
logger.info("MCP Gateway listening", { host, port, url: `http://${host}:${port}/mcp` });

// Before:
console.log("\nShutting down...");
// After:
logger.info("Shutting down");

// Before:
console.error("Fatal:", error);
// After (this one stays as console.error since logger might not exist):
console.error("Fatal:", error);
```

- [ ] **Step 5: Add connection metrics in the connection loop**

After successful `connectServer()` call in the connection loop, add:

```typescript
      metrics.incrementCounter("gateway_backend_connections_total", {
        server: serverConfig.name,
        status: "success",
      });
```

In the catch block, add:

```typescript
      metrics.incrementCounter("gateway_backend_connections_total", {
        server: serverConfig.name,
        status: "error",
      });
      metrics.incrementCounter("gateway_errors_total", {
        server: serverConfig.name,
        type: "connection",
      });
```

Do the same in the retry loop: after successful reconnection add connection success metric, and in the catch block add connection error metric.

In the `subscribeToCrash` handler, add:

```typescript
      metrics.incrementCounter("gateway_errors_total", {
        server: serverName,
        type: "crash",
      });
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: integrate logger and metrics into gateway orchestration"
```

---

### Task 5: Integration Test — /metrics Endpoint

**Files:**
- Modify: `tests/integration.test.ts`

- [ ] **Step 1: Add metrics imports**

Add to the imports in `tests/integration.test.ts`:

```typescript
import { createLogger } from "../src/logger.js";
import { MetricsRegistry } from "../src/metrics.js";
```

- [ ] **Step 2: Update the existing beforeAll to pass metrics**

In the first `describe("Integration: MCP Gateway end-to-end", ...)` block, update the `beforeAll` to create and pass metrics to GatewayServer. Add before the `gateway = new GatewayServer({...})` call:

```typescript
    const metrics = new MetricsRegistry();
    metrics.defineCounter("gateway_tool_calls_total", "Total tool calls");
    metrics.defineHistogram(
      "gateway_tool_call_duration_seconds",
      "Tool call latency",
      [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    );
    metrics.defineCounter("gateway_tool_activations_total", "Tool activations");
    metrics.defineCounter("gateway_tool_deactivations_total", "Tool deactivations");
    metrics.defineGauge("gateway_active_sessions", "Active sessions");
    metrics.defineCounter("gateway_errors_total", "Errors");
```

And update the GatewayServer constructor to include `metrics`:

```typescript
    gateway = new GatewayServer({
      registry,
      sessions,
      metaTools,
      router,
      metrics,
    });
```

- [ ] **Step 3: Add /metrics endpoint test**

Add a new test in the first integration describe block, after the existing `/status` test:

```typescript
  test("GET /metrics returns Prometheus-format metrics", async () => {
    // First, make a tool call to generate some metrics
    const client = new Client(
      { name: "metrics-test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${gatewayPort}/mcp`)
    );
    await client.connect(transport);

    try {
      // Activate and call a tool to generate metrics
      await client.callTool({
        name: "activate_tool",
        arguments: { name: "test-backend.echo" },
      });
      await client.callTool({
        name: "test-backend.echo",
        arguments: { message: "metrics test" },
      });

      // Check /metrics endpoint
      const response = await fetch(
        `http://127.0.0.1:${gatewayPort}/metrics`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");

      const body = await response.text();
      expect(body).toContain("gateway_tool_calls_total");
      expect(body).toContain("gateway_tool_call_duration_seconds");
      expect(body).toContain('status="success"');
      expect(body).toContain("gateway_tool_activations_total");
    } finally {
      await client.close();
    }
  }, 15000);
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: add /metrics endpoint integration test"
```

---

### Task 6: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add /metrics to HTTP Endpoints table**

In the HTTP Endpoints table, add a row:

```markdown
| `GET /metrics` | Prometheus-format metrics |
```

- [ ] **Step 2: Add Environment Variables section entries**

In the Environment Variables table, add:

```markdown
| `LOG_LEVEL` | Minimum log level: `debug`, `info` (default), `warn`, `error` |
| `LOG_FORMAT` | Log output format: `pretty` (default) or `json` |
```

- [ ] **Step 3: Add observability to Features list**

Add after the "Session limits" bullet:

```markdown
- **Structured logging** -- JSON or human-readable output with levels, controlled by `LOG_LEVEL` and `LOG_FORMAT` environment variables.
- **Prometheus metrics** -- `GET /metrics` exposes tool call counts, latency histograms, error rates, and active sessions in Prometheus text format.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add observability to README"
```
