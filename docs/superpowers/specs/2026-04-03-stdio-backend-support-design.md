# Stdio Backend Support Design

**Goal:** Allow the MCP gateway to connect to stdio-based MCP servers (child processes) in addition to Streamable HTTP backends, dramatically expanding the range of compatible servers.

**Architecture:** Extend `BackendManager` with a second connection method (`connectStdio`) that uses the SDK's `StdioClientTransport` to spawn and communicate with child processes. The rest of the system (registry, sessions, router, meta-tools, server) remains unchanged — they already operate on the transport-agnostic `Client` abstraction.

**Tech Stack:** Uses `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`. No new dependencies.

---

## Config

`ServerConfig` becomes a union — a server has either `url` (HTTP) or `command` (stdio):

```yaml
# HTTP backend (existing)
- name: postgres
  url: http://localhost:3001/mcp

# Stdio backend (new)
- name: filesystem
  command: npx -y @modelcontextprotocol/server-filesystem /tmp
  env:
    SOME_VAR: value
  cwd: /opt/servers
```

### Validation Rules

- A server must have exactly one of `url` or `command`. Both present or both absent is a validation error.
- `env` and `cwd` are optional, stdio-only fields. If specified on an HTTP server (one with `url`), validation error.
- `command` is a single string, split on whitespace (simple `split(/\s+/)`): first token = executable, rest = args. Passed to the SDK's `StdioServerParameters` as `command` and `args`. No shell quoting or glob expansion — this is not a shell command. For paths with spaces, operators should use symlinks or wrapper scripts.
- `env` values go through the existing `${VAR}` substitution, so `env: { DB_URL: ${PG_URL} }` pulls from the gateway's environment.
- Inherited env: stdio processes receive the SDK's default safe environment variables, merged with per-server `env`. Per-server values win on conflict.

### Updated ServerConfig Interface

```typescript
export interface ServerConfig {
  name: string;
  url?: string;       // HTTP backend
  command?: string;    // Stdio backend (mutually exclusive with url)
  description?: string;
  env?: Record<string, string>;  // Stdio-only
  cwd?: string;                  // Stdio-only
}
```

## BackendManager

### New Public Method

```typescript
async connectStdio(name: string, params: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<ToolDefinition[]>
```

Creates a `StdioClientTransport` with the given params, connects a `Client`, calls `listTools()`, and stores in the same `clients` Map as HTTP connections. All existing methods (`callTool`, `disconnect`, `refreshTools`, `onToolsChanged`) work identically regardless of transport type.

### Crash Detection

`StdioClientTransport` exposes an `onclose` callback that fires when the child process exits unexpectedly. `BackendManager` exposes a new method:

```typescript
onClose(name: string, callback: () => void): void
```

This registers a handler so `index.ts` can detect crashes and feed the server back into the retry loop.

### Process Cleanup

`disconnect()` calls `client.close()`, which sends SIGTERM to the child process (handled by the SDK). `disconnectAll()` works as-is.

## Retry Behavior

### HTTP Backends (Unchanged)

Retry indefinitely every 30 seconds until the server becomes reachable.

### Stdio Backends

Retry up to 5 times, then stop and log:

```
Server 'filesystem' failed to start after 5 attempts, giving up. Fix the command and reload config.
```

Rationale: HTTP servers fail for transient reasons (network, restarts). Stdio servers fail for permanent reasons (wrong binary, missing package). Capping retries avoids pointless process spawning.

A config hot-reload resets the retry counter for that server, so operators can fix the command and recover without restarting the gateway.

### Crash Recovery

When a running stdio backend crashes (process exits unexpectedly):

1. The `onClose` callback fires in `BackendManager`.
2. `index.ts` marks the server unavailable in the registry.
3. The server is added to the retry loop with the stdio retry cap (5 attempts).
4. Sessions with activated tools from that server see them as unavailable.
5. All sessions are notified via `tools/list_changed`.

## index.ts Orchestration

### Connection Dispatch

When iterating `config.servers`, check for `url` vs `command`:

- If `url`: call `backendManager.connect(name, url)` (existing path).
- If `command`: split the command string, call `backendManager.connectStdio(name, { command, args, env, cwd })`.

### Retry Loop Extension

The `unavailable` array tracks additional metadata per entry:

- `type: "http" | "stdio"` — determines which connect method to call.
- `retryCount` — for stdio only, incremented on each failure. Removed from the list at 5.
- `params` — the original connection params needed for reconnection.

### Hot Reload

Same logic as today (remove/modify/add), but:

- Add/modify dispatch to the right connect method based on config type.
- A config change to a stdio server resets its retry counter.

### Shutdown

`disconnectAll()` handles everything — stdio child processes get killed via the SDK's `close()`.

## What Doesn't Change

These modules are unaware of transport types and require no modifications:

- `registry.ts` — stores tools, doesn't care how they were discovered.
- `session.ts` — tracks activated tools per session.
- `meta-tools.ts` — builds catalog from registry.
- `router.ts` — resolves namespaced tools, delegates to BackendManager.
- `server.ts` — handles MCP protocol, sessions, and HTTP endpoints.
- `watcher.ts` — watches config file for changes.

## Testing

### Unit Tests: Config

- Valid stdio config (command only, command + env, command + cwd).
- Valid HTTP config (url only — existing tests still pass).
- Reject both `url` and `command` present.
- Reject neither `url` nor `command`.
- Reject `env`/`cwd` on HTTP servers.
- Command string splitting (single word, multiple args, extra whitespace).
- `${VAR}` substitution works in `env` values.

### Unit Tests: BackendManager

- `connectStdio()` creates client and returns tools (mock the SDK transport).
- Crash callback fires on unexpected process exit.
- Disconnect kills stdio process.
- Both HTTP and stdio clients coexist in the same manager.

### Integration Tests

- Full flow with stdio backend: connect, activate, call tool, deactivate.
- Stdio crash: server marked unavailable, retry, reconnect.
- Stdio retry cap: 5 failures, gives up.
- Hot reload: add stdio server, remove stdio server, modify command.
- Config reload resets retry counter.

### What We Won't Test

Actual `npx` spawning in CI — we mock the transport layer. Real stdio servers would make tests slow and flaky.

## Example Config

```yaml
gateway:
  port: 8080

servers:
  # HTTP backend
  - name: postgres
    url: http://localhost:3001/mcp

  # Stdio backends
  - name: filesystem
    command: npx -y @modelcontextprotocol/server-filesystem /tmp
    description: "File system access"

  - name: github
    command: npx -y @modelcontextprotocol/server-github
    env:
      GITHUB_TOKEN: ${GH_TOKEN}

  - name: custom-tool
    command: /usr/local/bin/my-mcp-server --verbose
    cwd: /opt/my-tool
    env:
      LOG_LEVEL: debug
```
