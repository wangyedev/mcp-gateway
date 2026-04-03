# Observability Design

**Goal:** Add structured logging and Prometheus metrics to the MCP gateway so operators can monitor tool call rates, latency, errors, and session usage in production, while developers get readable output during development.

**Architecture:** Two new modules — `src/logger.ts` (structured logging wrapper) and `src/metrics.ts` (in-memory counters/histograms/gauges with Prometheus text export). Both are dependency-free. Existing `console.*` calls are migrated to the logger. Metrics are collected at the boundary points (tool calls, backend connections, sessions) and exposed via `GET /metrics`.

**Tech Stack:** No new dependencies. Logger wraps `console`. Metrics are plain objects with Prometheus text serialization.

---

## Logger Module (`src/logger.ts`)

### Levels

`debug`, `info`, `warn`, `error` — controlled by `LOG_LEVEL` env var (default: `info`). Messages below the configured level are suppressed.

### Output Modes

- **Pretty mode** (default when `LOG_FORMAT` is not `json`): Human-readable with timestamps and levels. Uses `console.log` (info/debug), `console.warn` (warn), `console.error` (error) internally so terminal colors are preserved. Example: `2026-04-03T21:30:00.000Z [INFO] Connected to backend server=postgres tools=3`
- **JSON mode** (when `LOG_FORMAT=json`): Structured JSON, one object per line. Example: `{"timestamp":"2026-04-03T21:30:00.000Z","level":"info","msg":"Connected to backend","server":"postgres","tools":3}`

### API

```typescript
interface Logger {
  debug(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
}

function createLogger(): Logger;
```

- Create one instance at startup in `index.ts`.
- Pass to components that need it (`GatewayServer`, `BackendManager`, `ConfigWatcher`).
- Context fields are structured data (server name, tool count, latency), never interpolated into the message string.

### Security

Do not log tool call arguments — they could contain secrets. Log tool names and server names only.

---

## Metrics Module (`src/metrics.ts`)

### Metrics Collected

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `gateway_tool_calls_total` | Counter | `server`, `tool`, `status` (success/error) | Total tool calls routed through the gateway |
| `gateway_tool_call_duration_seconds` | Histogram | `server`, `tool` | Tool call latency in seconds |
| `gateway_tool_activations_total` | Counter | `server`, `tool` | Tool activations |
| `gateway_tool_deactivations_total` | Counter | `server`, `tool` | Tool deactivations |
| `gateway_backend_connections_total` | Counter | `server`, `status` (success/error) | Backend connection attempts |
| `gateway_active_sessions` | Gauge | — | Current active session count |
| `gateway_errors_total` | Counter | `server`, `type` (connection/tool_call/crash) | Error counts by type |

### Histogram Buckets

Standard Prometheus defaults for latency: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` seconds.

### API

```typescript
class MetricsRegistry {
  incrementCounter(name: string, labels?: Record<string, string>): void;
  observeHistogram(name: string, value: number, labels?: Record<string, string>): void;
  setGauge(name: string, value: number): void;
  toPrometheus(): string;
}
```

- One instance created at startup in `index.ts`.
- Passed to `GatewayServer` via constructor options.
- Labels must be low cardinality — `server` and `tool` are bounded by config. Never use session IDs, timestamps, or user data as labels.

### Prometheus Text Format

`toPrometheus()` returns standard Prometheus exposition format:

```
# HELP gateway_tool_calls_total Total tool calls routed through the gateway
# TYPE gateway_tool_calls_total counter
gateway_tool_calls_total{server="postgres",tool="query",status="success"} 42
```

Counters include a `_total` suffix. Histograms include `_bucket`, `_sum`, and `_count` lines. Gauges have no suffix.

### Endpoint

`GET /metrics` added to `server.ts`, returns `metrics.toPrometheus()` with `Content-Type: text/plain; charset=utf-8`.

---

## Integration Points

### `server.ts` — Tool Call Instrumentation

- **`handleToolCall()`**: Start a timer before the call. After the call, record `gateway_tool_calls_total` with `status=success` or `status=error`, and `gateway_tool_call_duration_seconds`. For `activate_tool` meta-tool, record `gateway_tool_activations_total`. For `deactivate_tool`, record `gateway_tool_deactivations_total`.
- **`handleNewSession()`**: Increment `gateway_active_sessions` gauge.
- **Transport `onclose`**: Decrement `gateway_active_sessions` gauge.

### `backend.ts` — Connection Instrumentation

- **`connect()` and `connectStdio()`**: On success, record `gateway_backend_connections_total` with `status=success`. On failure, record with `status=error`.
- **`onclose` crash handler**: Record `gateway_errors_total` with `type=crash`.

### `index.ts` — Lifecycle Logging

- Replace all `console.*` calls with logger calls.
- Add structured context fields (server name, tool count, error messages).
- Create logger and metrics instances at startup.
- Pass logger and metrics to `GatewayServer` and `BackendManager` via constructor options.

### `watcher.ts` — Config Reload Logging

- Accept logger via constructor parameter.
- Replace internal error logging with logger calls.

### `GET /metrics` Endpoint

- Added to `server.ts` alongside existing `GET /status`.
- Returns `metrics.toPrometheus()` with text/plain content type.

---

## What Doesn't Change

These modules have no I/O and need no logging or metrics:

- `registry.ts` — pure data store
- `session.ts` — pure data store
- `meta-tools.ts` — builds catalog from registry
- `router.ts` — resolves namespaced tools, delegates to BackendManager
- `config.ts` — pure parsing and validation

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Minimum log level: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `pretty` | Log output format: `pretty` (human-readable) or `json` (structured) |

---

## Testing

### Logger Tests (`tests/logger.test.ts`)

- JSON mode outputs valid JSON with timestamp, level, msg, and context fields.
- Pretty mode outputs human-readable format with timestamp and level.
- Level filtering works (debug messages suppressed at info level).
- `LOG_LEVEL` env var controls level.
- `LOG_FORMAT=json` forces JSON mode.

### Metrics Tests (`tests/metrics.test.ts`)

- Counter increments correctly.
- Counter with labels tracks separately per label combination.
- Histogram records observations into correct buckets.
- Histogram output includes `_bucket`, `_sum`, and `_count` lines.
- Gauge sets and updates value.
- `toPrometheus()` outputs correct text format with HELP, TYPE, and metric lines.
- Empty registry returns empty string.

### Integration

- `GET /metrics` returns 200 with `text/plain` content type.
- After tool calls, metrics reflect correct counts and latency.
- All existing tests still pass after logger migration.

### What We Won't Test

- Pretty vs JSON visual appearance beyond structural correctness.
- Exact timestamp values — test that the field exists, not its value.
- Actual Prometheus scraping — we test the text output format.

---

## Design Principles

This implementation follows established observability best practices:

- **USE method**: Utilization (active sessions), Saturation (approaching session limit), Errors (error counts by type).
- **RED method**: Rate (tool_calls_total), Errors (status=error), Duration (duration_seconds).
- **Low cardinality labels**: `server` and `tool` are bounded by operator config.
- **Counters always go up**: Prometheus computes rates via `rate()`.
- **Instrument at the boundary**: Measure latency where the gateway hands off to backends, not internal logic.
- **No sensitive data in logs**: Tool names and server names only, never tool arguments.
- **OTel-ready**: Interfaces are designed so OpenTelemetry can be plugged in later as an optional integration without rewriting consumers.
