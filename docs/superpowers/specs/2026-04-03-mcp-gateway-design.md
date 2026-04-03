# MCP Gateway — MVP Design Spec

## Overview

An MCP gateway server that acts as a single entry point for LLM clients, orchestrating multiple backend MCP servers with progressive tool disclosure. Instead of loading all tool definitions upfront (overwhelming the context window), the gateway exposes a small set of meta-tools that let the LLM discover and activate tools on demand.

## Problem

LLM clients connected to multiple MCP servers receive all tool definitions at once. With dozens or hundreds of tools, this wastes context window tokens before any real work happens. There is no standard mechanism for progressive disclosure of MCP tools.

## Solution

A gateway MCP server that:

1. Connects to multiple backend MCP servers
2. Exposes only meta-tools to clients at startup
3. Lets the LLM discover available servers and tools via meta-tools
4. Dynamically adds activated tools to the client's tool list
5. Proxies tool calls to the correct backend server

This mirrors the "agent skills" pattern: discovery (lightweight metadata) → activation (full definition) → execution (call the tool).

## Architecture

### Thin Proxy

The gateway is a lightweight router. It holds metadata in memory, exposes meta-tools, and proxies tool calls directly to backend servers. No middleware, no transformation layer.

### Internal Components

**Meta-Tool Handler** — Implements the 4 meta-tools (`list_servers`, `list_server_tools`, `activate_tool`, `deactivate_tool`). Reads from Tool Registry, writes to Session Manager.

**Tool Registry** — In-memory index of all tools from all backend servers. Stores server metadata (name, description), tool metadata (name, description), and full tool schemas. Built at startup by connecting to each backend and calling `tools/list`. Rebuilt on config reload or when a backend emits `tools/list_changed`.

**Session Manager** — Tracks which tools each client session has activated. Each session has its own active tool set. Sessions are tied to HTTP connections and cleaned up on disconnect.

**Router** — Maps namespaced tool names to backend servers. When a client calls `postgres.query`, the router strips the prefix, identifies the `postgres` backend, and forwards the call as `query`. Returns the backend's response to the client.

**Config Loader** — Parses the YAML config file at startup. Watches the file for changes and triggers Tool Registry rebuilds on modification. Supports environment variable substitution in values.

### Component Interaction

```
Client ←→ [Meta-Tool Handler] ←→ [Tool Registry]
                                ←→ [Session Manager]
       ←→ [Router] ←→ Backend MCP Servers
       
[Config Loader] → [Tool Registry] (rebuild on reload)
Backend `tools/list_changed` → [Tool Registry] (refresh cache)
```

## Meta-Tools

The gateway exposes exactly 4 tools to every client session. These are always present and cannot be deactivated.

### `list_servers()`

Returns all registered backend servers with descriptions and availability status.

**Parameters:** None

**Response:**
```json
{
  "servers": [
    {
      "name": "postgres",
      "description": "Execute SQL queries, list and describe tables",
      "status": "available"
    },
    {
      "name": "github",
      "description": "Manage repos, PRs, issues, and code search",
      "status": "unavailable"
    }
  ]
}
```

**Status values:** `available` (connected and tools fetched), `unavailable` (cannot reach backend, retrying).

**Description source:** If the admin provides a `description` in config, use that. Otherwise, auto-generate from the server's tool descriptions using the template: `"Provides tools: {tool1_name} - {tool1_desc}, {tool2_name} - {tool2_desc}, ..."`. Truncate at a word boundary with trailing ellipsis if longer than 200 characters.

### `list_server_tools(server)`

Returns tool names and descriptions for a specific server.

**Parameters:**
- `server` (string, required) — Server name from `list_servers()`

**Response:**
```json
{
  "server": "postgres",
  "tools": [
    { "name": "postgres.query", "description": "Execute SQL against PostgreSQL" },
    { "name": "postgres.list_tables", "description": "List all tables in a database" },
    { "name": "postgres.describe_table", "description": "Get column info for a table" }
  ]
}
```

**Error:** Returns an error if the server name is not found.

### `activate_tool(name)`

Activates a tool for the current session. The tool appears in the client's `tools/list` response.

**Parameters:**
- `name` (string, required) — Namespaced tool name (e.g., `postgres.query`)

**Behavior:**
1. Validates the tool exists in the Tool Registry
2. Adds the tool to the session's active set
3. Emits `notifications/tools/list_changed` to the client
4. Returns the full tool schema

**Response:**
```json
{
  "success": true,
  "tool": {
    "name": "postgres.query",
    "description": "Execute SQL against PostgreSQL",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sql": { "type": "string", "description": "SQL query to execute" }
      },
      "required": ["sql"]
    }
  }
}
```

**Error:** Returns an error if the tool name is not found or already activated.

### `deactivate_tool(name)`

Removes a tool from the current session's active set.

**Parameters:**
- `name` (string, required) — Namespaced tool name

**Behavior:**
1. Removes the tool from the session's active set
2. Emits `notifications/tools/list_changed` to the client

**Response:**
```json
{
  "success": true
}
```

**Note:** Deactivation removes the tool from `tools/list` but does not reclaim context window tokens — the tool schema already exists in conversation history. The primary value is signaling to the LLM to stop using the tool and keeping the active tool list clean.

**Error:** Returns an error if the tool is not currently activated.

## Tool Namespacing

All tools are namespaced as `{server_name}.{tool_name}`.

- Client sees: `postgres.query`
- Gateway strips prefix and forwards to postgres backend as: `query`
- Backend never sees the namespace prefix
- Client never needs to know the backend's internal naming

This prevents collisions when multiple backends expose tools with the same name.

## Request Flow

### Fresh Session

1. Client connects via Streamable HTTP, completes MCP initialization
2. Client calls `tools/list` → receives 4 meta-tools only
3. No real tools are visible until the client actively discovers and activates them

### Discovery → Activation → Execution

1. Client calls `list_servers()` → gets server names and descriptions
2. Client calls `list_server_tools(server="postgres")` → gets tool names and descriptions
3. Client calls `activate_tool("postgres.query")` → gateway adds to session, emits `tools/list_changed`, returns full schema
4. Client's MCP SDK auto-re-fetches `tools/list` → now sees `postgres.query` alongside meta-tools
5. Client calls `postgres.query(sql="SELECT * FROM users")` → gateway routes to postgres backend as `query(sql="...")` → returns result

### Deactivation

1. Client calls `deactivate_tool("postgres.query")` → gateway removes from session, emits `tools/list_changed`
2. Client's tool list no longer includes `postgres.query`

## Transport

- **Client-facing:** Streamable HTTP
- **Backend connections:** Streamable HTTP
- Both sides use the same transport for MVP simplicity

## Configuration

### Config File Format

```yaml
# mcp-gateway.yaml

gateway:
  port: 8080
  host: "0.0.0.0"

servers:
  - name: postgres
    url: http://localhost:3001/mcp

  - name: github
    url: http://localhost:3002/mcp
    description: "Manage repos, PRs, issues, and code search"

  - name: internal-api
    url: ${INTERNAL_API_MCP_URL}
    description: "Company internal APIs for user management and billing"
```

### Fields

**`gateway` section:**
- `port` (number, default: 8080) — Port the gateway listens on
- `host` (string, default: "0.0.0.0") — Host to bind to

**`servers` array:**
- `name` (string, required) — Unique server identifier. Used as namespace prefix for tools.
- `url` (string, required) — Streamable HTTP URL of the backend MCP server. Supports `${ENV_VAR}` substitution.
- `description` (string, optional) — Human-readable description. If omitted, auto-generated from the server's tool descriptions.

### Hot Reload

The gateway watches the config file for changes using filesystem events. On change:

1. Parse the new config
2. Identify added, removed, and modified servers
3. Connect to new servers, disconnect from removed servers, reconnect to modified servers
4. Rebuild the Tool Registry
5. For active sessions with tools from removed servers: remove those tools from the session's active set and emit `tools/list_changed`
6. For in-flight tool calls to removed servers: let them fail naturally with a clear error message

### Environment Variable Substitution

Values in the config file can reference environment variables using `${VAR_NAME}` syntax. Variables are resolved at config load time (including hot reload). Missing variables cause a startup error with a clear message.

## Client Requirements

The gateway requires clients to support the `tools.listChanged` capability. During MCP initialization, the gateway checks the client's declared capabilities. If the client does not include `capabilities.tools.listChanged: true`, the gateway rejects the connection with a clear error message explaining that this capability is required for progressive tool disclosure.

Without `tools/list_changed` support, activated tools would never appear in the client's tool list, making the gateway non-functional.

## Session Management

- Sessions are created when a client connects and completes MCP initialization (after capability check passes)
- Each session maintains its own set of activated tools
- `tools/list` returns the 4 meta-tools plus whatever tools the session has activated
- Sessions end when the HTTP connection closes
- On session end, all session state (activated tools) is cleaned up

## Backend Server Management

### Startup

1. Gateway reads config and resolves environment variables
2. Attempts to connect to each backend server via Streamable HTTP
3. For each reachable backend, calls `tools/list` to fetch tool metadata
4. For unreachable backends, marks them as unavailable in the Tool Registry — they appear in `list_servers()` with a status indicating they are offline
5. Builds the Tool Registry with all available server and tool information
6. Starts listening for client connections
7. Periodically retries connections to unavailable backends (every 30 seconds)

The gateway does not fail startup if some backends are unreachable. It starts with whatever is available and recovers as backends come online.

### Backend `tools/list_changed`

The gateway subscribes to `tools/list_changed` notifications from each backend server. When a backend's tool list changes:

1. Re-fetch the backend's `tools/list`
2. Update the Tool Registry
3. For active sessions with affected tools: if a tool was removed from the backend, remove it from the session and emit `tools/list_changed` to the client

### Backend Unavailability

If a backend server is unreachable when a tool call is made, the gateway returns a clear MCP error:

```json
{
  "error": {
    "code": -32000,
    "message": "Backend server 'postgres' is unreachable"
  }
}
```

No retries, no circuit breakers for MVP.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Unknown server name in `list_server_tools` | Return error: "Server '{name}' not found" |
| Unavailable server in `list_server_tools` | Return error: "Server '{name}' is currently unavailable" |
| Activate tool from unavailable server | Return error: "Server '{server}' is currently unavailable" |
| Unknown tool name in `activate_tool` | Return error: "Tool '{name}' not found" |
| Already activated tool in `activate_tool` | Return error: "Tool '{name}' is already activated" |
| Not activated tool in `deactivate_tool` | Return error: "Tool '{name}' is not activated" |
| Tool call to non-activated tool | Should not happen (tool not in `tools/list`), but return error if it does |
| Backend unreachable during tool call | Return MCP error with descriptive message |
| Backend removed during active session | Remove tools, emit `tools/list_changed`, error on subsequent calls |
| Invalid config file on reload | Log error, keep running with previous config |
| Missing env var in config | Startup error with clear message |

## Technology

- **Language:** TypeScript
- **Runtime:** Node.js
- **MCP SDK:** `@modelcontextprotocol/sdk` (latest)
- **Config parsing:** `yaml` package
- **File watching:** `chokidar` or Node.js `fs.watch`

## Out of Scope (MVP)

- Authentication / authorization
- Health checks / readiness probes
- Logging / observability / request tracing
- Rate limiting
- stdio transport (either side)
- Server-level activation (activate all tools from a server at once)
- Tool response transformation or enrichment
- Caching of tool call results
- Multiple config files or config directories
