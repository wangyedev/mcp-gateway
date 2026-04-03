# MCP Gateway

An MCP server that acts as a single entry point for multiple backend MCP servers, with progressive tool disclosure to reduce context window bloat.

Instead of loading all tool definitions from all servers upfront, the gateway exposes just 2 meta-tools. The LLM reads a flat tool catalog from the description, activates what it needs, and calls tools directly. This follows the same pattern as agent skills: lightweight discovery at startup, full definitions loaded on demand.

## How It Works

```
LLM connects to gateway
    |
    v
tools/list returns 2 meta-tools:
  - activate_tool (description contains catalog of ALL available tools)
  - deactivate_tool

LLM reads activate_tool description:
  "Available tools: postgres.query - Execute SQL; github.search - Search repos..."

User: "Run a SQL query"
LLM:  -> activate_tool("postgres.query")    # loads full schema
LLM:  -> postgres.query(sql="SELECT ...")   # routed to backend
```

## Quick Start

```bash
npm install
cp mcp-gateway.example.yaml mcp-gateway.yaml
```

Edit `mcp-gateway.yaml` with your backend MCP servers:

```yaml
gateway:
  port: 8080
  host: "0.0.0.0"

servers:
  # Streamable HTTP backend
  - name: postgres
    url: http://localhost:3001/mcp

  # Stdio backend (spawns child process)
  - name: filesystem
    command: npx -y @modelcontextprotocol/server-filesystem /tmp

  # Stdio with environment variables
  - name: github
    command: npx -y @modelcontextprotocol/server-github
    env:
      GITHUB_TOKEN: ${GH_TOKEN}
```

Start the gateway:

```bash
npm run dev     # development (tsx)
npm run build   # compile TypeScript
npm start       # production (node)
```

Connect any MCP client to `http://localhost:8080/mcp`.

## Features

- **Progressive tool disclosure** -- LLM sees tool names + descriptions at startup, full schemas only on activation. Matches the agent skills pattern.
- **Flat tool catalog** -- All tools across all servers listed in the `activate_tool` description. LLM can skip straight to activation without discovery calls.
- **Tool namespacing** -- Tools are namespaced as `{server}.{tool}` (e.g., `postgres.query`). No collisions between servers.
- **Stdio backend support** -- Connect to stdio-based MCP servers by specifying a `command` instead of a `url`. The gateway spawns and manages child processes automatically.
- **YAML config with hot reload** -- Add/remove/modify servers without restarting. Changes propagate to connected clients via `tools/list_changed`.
- **Environment variable substitution** -- Use `${VAR_NAME}` in config values.
- **Startup resilience** -- Gateway starts even if some backends are down. Unavailable servers are marked `[offline]` and retried every 30 seconds.
- **Session isolation** -- Each client session has its own set of activated tools.
- **Admin status endpoint** -- `GET /status` returns structured JSON with server health, tools, and active session count.
- **Session limits** -- Configurable max sessions (default 100) to prevent resource exhaustion.

## Configuration

### Config File

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `gateway.port` | No | `8080` | Port to listen on |
| `gateway.host` | No | `0.0.0.0` | Host to bind to |
| `servers[].name` | Yes | -- | Unique server name (used as namespace prefix) |
| `servers[].url` | * | -- | Streamable HTTP URL of the backend MCP server |
| `servers[].command` | * | -- | Command to spawn a stdio MCP server (mutually exclusive with `url`) |
| `servers[].description` | No | Auto-generated | Human-readable description |
| `servers[].env` | No | -- | Environment variables for stdio servers |
| `servers[].cwd` | No | Inherited | Working directory for stdio servers |

\* Each server must have exactly one of `url` or `command`.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MCP_GATEWAY_CONFIG` | Path to config file (default: `mcp-gateway.yaml`) |

## API

### MCP Tools (for LLM clients)

| Tool | Description |
|------|-------------|
| `activate_tool(name)` | Activate a tool by namespaced name. Returns full schema. Tool appears in `tools/list`. |
| `deactivate_tool(name)` | Remove a tool from the session. |

### HTTP Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /mcp` | MCP Streamable HTTP protocol endpoint |
| `GET /mcp` | SSE endpoint for server-to-client notifications |
| `DELETE /mcp` | Session cleanup |
| `GET /status` | Server health and active sessions (JSON) |

### Status Response

```json
{
  "servers": [
    {
      "name": "postgres",
      "url": "http://localhost:3001/mcp",
      "status": "available",
      "tools": ["postgres.query", "postgres.list_tables"]
    }
  ],
  "activeSessions": 3
}
```

## Architecture

```
Client <--Streamable HTTP--> Gateway <--Streamable HTTP--> Backend MCP Servers
                               |
                          +---------+
                          | Meta-Tool Handler (activate/deactivate)
                          | Tool Registry (server + tool metadata)
                          | Session Manager (per-client tool state)
                          | Router (namespace stripping + proxying)
                          | Config Loader (YAML + hot reload)
                          +---------+
```

## Development

```bash
npm test              # run tests (65 tests)
npm run test:watch    # watch mode
npm run build         # compile TypeScript
```

## Requirements

- Node.js 18+
- Backend MCP servers must support Streamable HTTP or stdio transport

## License

Apache-2.0
