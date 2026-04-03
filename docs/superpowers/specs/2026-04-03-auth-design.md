# Authentication & RBAC Design

**Goal:** Add MCP-spec-compliant OAuth 2.1 authentication with server-level RBAC to the gateway, so operators can restrict which clients can access which backend servers.

**Architecture:** Three independent layers that compose cleanly: (1) Auth validates OAuth tokens and extracts roles, (2) RBAC checks if the role can access the target server, (3) Tool Policies (separate spec) filters which tools are exposed globally. Auth uses the MCP SDK's built-in middleware. RBAC is a simple config-based policy evaluator with server-level granularity. No tool-level RBAC — that's handled by Tool Policies.

**Tech Stack:** `@modelcontextprotocol/sdk` built-in auth modules. No new dependencies.

---

## Three-Layer Access Control

```
Request comes in
  → Auth: is this token valid? what role?       (OAuth 2.1)
  → RBAC: can this role access this server?     (server-level, config-based)
  → Tool Policies: is this tool exposed?         (operator filter, separate spec)
  → Tool call proceeds
```

Each layer is independent:
- **Auth** answers "who are you?"
- **RBAC** answers "what servers can you access?"
- **Tool Policies** answers "what tools exist in this gateway?" (applies to everyone)

---

## Why OAuth 2.1

The MCP specification requires OAuth 2.1 for HTTP transports:
- MCP auth implementations **MUST** implement OAuth 2.1
- Clients **MUST** use `Authorization: Bearer <token>` headers
- Servers **MUST** return 401 when auth is required but not provided
- Servers **SHOULD** support dynamic client registration (RFC 7591)
- Servers **SHOULD** support metadata discovery (RFC 8414)

The SDK already implements all of this.

---

## Configuration

### Auth Modes

#### Mode: `none` (Default, Backwards Compatible)

No auth. Current behavior. All clients can connect to all servers.

```yaml
gateway:
  port: 8080
```

#### Mode: `proxy` (Recommended for Production)

Delegate OAuth to an external provider (Keycloak, Auth0, Okta, etc.). The gateway validates bearer tokens and extracts roles from JWT claims.

```yaml
gateway:
  port: 8080
  auth:
    type: proxy
    issuer: https://keycloak.example.com/realms/mcp
    rolesClaim: realm_access.roles  # path to roles array in JWT
    audience: mcp-gateway           # expected audience claim (optional)
    publicEndpoints:
      - /status
      - /metrics
```

How it works:
1. Client obtains a token from the external OAuth provider (out of band)
2. Client sends `Authorization: Bearer <token>` to the gateway
3. Gateway validates the token against the issuer (via JWKS or introspection)
4. Gateway extracts roles from the configured claim path
5. RBAC checks if the role has access to the requested server

#### Mode: `builtin` (Development / Simple Deployments)

The gateway runs its own OAuth server using the SDK's `mcpAuthRouter`. Suitable for development and demos.

```yaml
gateway:
  port: 8080
  auth:
    type: builtin
    publicEndpoints:
      - /status
      - /metrics
```

How it works:
1. Gateway exposes OAuth endpoints (`/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`)
2. MCP clients discover these via RFC 8414 metadata discovery
3. Clients register dynamically (RFC 7591), then use authorization code + PKCE flow
4. Gateway issues and validates its own tokens

Limitations: in-memory token storage (lost on restart), no user database, not suitable for multi-instance deployments.

### RBAC Configuration

Server-level role mapping. Operators already know their server names — they're in the same config file.

```yaml
servers:
  - name: postgres
    url: http://localhost:3001/mcp
  - name: github
    command: npx -y @modelcontextprotocol/server-github
  - name: internal
    url: http://localhost:3003/mcp

rbac:
  defaultPolicy: deny     # deny | allow. Default: deny

  roles:
    admin:
      servers: "*"                              # full access to all servers

    analyst:
      servers: ["postgres"]                     # only postgres

    developer:
      servers: ["postgres", "github"]           # postgres and github

    operator:
      servers: ["postgres", "github", "internal"]
```

Rules:
- `servers: "*"` grants access to all servers (current and future)
- `servers: ["name1", "name2"]` grants access to listed servers only
- `defaultPolicy: deny` rejects tokens with unrecognized roles (safe default)
- `defaultPolicy: allow` allows unrecognized roles to access all servers (useful during migration)
- When auth is `none`, RBAC is skipped entirely (no token = no role to check)
- RBAC applies to tool activation and tool calls — if a role can't access server X, they can't activate or call any tool from server X
- The tool catalog (`activate_tool` description) only shows tools from accessible servers

### Why No Tool-Level RBAC

Other systems (Kubernetes, AWS IAM, PostgreSQL) do access control on **well-defined categories** (resource types, services, schemas), not individual resource names. MCP tools don't have categories — they're just named functions that can change when backends update.

Tool-level filtering is handled by **Tool Policies** (separate spec), which is a global operator decision ("never expose `drop_table`"), not a per-role decision. This separation keeps both systems simple and avoids fragile tool-name-based policies.

If tool-level RBAC is needed in the future, the right approach would be for MCP backends to annotate tools with scopes/categories, and RBAC maps roles to scopes.

---

## Updated Config Interfaces

```typescript
export interface AuthConfig {
  type: "none" | "proxy" | "builtin";
  issuer?: string;            // proxy mode: OAuth server URL
  rolesClaim?: string;        // proxy mode: JWT claim path for roles (default: "roles")
  audience?: string;          // proxy mode: expected audience
  publicEndpoints?: string[]; // endpoints that skip auth
}

export interface RbacRole {
  servers: "*" | string[];    // which servers this role can access
}

export interface RbacConfig {
  defaultPolicy: "deny" | "allow";
  roles: Record<string, RbacRole>;
}

export interface GatewayConfig {
  port: number;
  host: string;
  auth?: AuthConfig;
}

export interface Config {
  gateway: GatewayConfig;
  servers: ServerConfig[];
  rbac?: RbacConfig;          // undefined = no RBAC (all access allowed)
}
```

### Validation Rules

- `auth.type` is optional. Valid values: `none`, `proxy`, `builtin`. Default: `none`.
- If `type` is `proxy`, `issuer` is required. Must be a valid URL.
- If `type` is `builtin`, no additional config required.
- `rolesClaim` defaults to `"roles"`. Supports nested paths like `"realm_access.roles"`.
- `publicEndpoints` is optional (default: `[]`). Exact path matches only.
- `rbac` is optional. If absent and auth is enabled, all authenticated clients have full access.
- `rbac.defaultPolicy` defaults to `"deny"`.
- Server names in `rbac.roles[].servers` are validated against configured server names (warning if a role references a server not in config).

---

## Implementation

### New Module: `src/auth.ts`

Creates auth middleware based on config:

```typescript
export function createAuthMiddleware(config: AuthConfig): express.RequestHandler[]
```

- **`none`:** Returns empty array (no middleware).
- **`proxy`:** Uses SDK's `requireBearerAuth` with a custom `OAuthTokenVerifier` that validates tokens against the issuer's JWKS endpoint.
- **`builtin`:** Uses SDK's `mcpAuthRouter` to install OAuth endpoints and `requireBearerAuth` for MCP routes.

### New Module: `src/rbac.ts`

Policy evaluator with a clean interface (OPA-ready for future):

```typescript
export interface PolicyEvaluator {
  canAccessServer(roles: string[], serverName: string): boolean;
}

export function createPolicyEvaluator(config?: RbacConfig): PolicyEvaluator
```

Default implementation: config-based set lookup. If no RBAC config, allows everything. If RBAC is configured, checks if any of the user's roles grant access to the server.

### Changes to `src/server.ts`

- Accept `authMiddleware` and `policyEvaluator` in constructor options
- Apply auth middleware in `startMcp()` before MCP routes
- In `handleToolCall()`, check RBAC before routing: extract server name from namespaced tool, check `policyEvaluator.canAccessServer(roles, server)`
- In `getToolsForSession()`, filter the catalog to only show tools from accessible servers
- Extract roles from `req.auth?.extra?.roles` or configured claim path
- Public endpoints bypass auth

### Changes to `src/config.ts`

- Add `AuthConfig` and `RbacConfig` to config interfaces
- Parse and validate auth and rbac sections
- Validate server names in rbac roles against configured servers

### Changes to `src/index.ts`

- Create auth middleware and policy evaluator from config
- Pass to GatewayServer
- Log auth mode and RBAC status at startup

---

## SDK Auth Components Used

| SDK Component | Usage |
|---------------|-------|
| `mcpAuthRouter` | Installs OAuth endpoints for builtin mode |
| `requireBearerAuth` | Validates bearer tokens on MCP endpoints |
| `OAuthServerProvider` | Interface for token issuance/validation (builtin mode) |
| `OAuthTokenVerifier` | Simplified token validation interface (proxy mode) |
| `DemoInMemoryAuthProvider` | Reference provider for builtin mode |
| `AuthInfo` | Token metadata (clientId, scopes, expiration) passed to handlers |

---

## Request Flow with Auth + RBAC

```
1. Client sends POST /mcp with Authorization: Bearer <token>
2. Auth middleware validates token → extracts AuthInfo (clientId, scopes, roles)
3. MCP server receives request
4. For tool activation:
   a. Extract server name from tool name (e.g., "postgres" from "postgres.query")
   b. Extract roles from AuthInfo
   c. PolicyEvaluator.canAccessServer(roles, "postgres") → true/false
   d. If denied: return error "Access denied: role does not have access to server 'postgres'"
5. For tool calls: same check (server extracted from namespaced tool name)
6. Tool catalog (activate_tool description): only shows tools from accessible servers
```

---

## What Doesn't Change

- `registry.ts` — pure data store
- `session.ts` — pure data store
- `meta-tools.ts` — builds catalog (will receive filtered tool list)
- `router.ts` — routes tool calls to backends
- `backend.ts` — connects to backend servers (backends handle their own auth)
- `watcher.ts` — watches config (auth changes require restart)
- `metrics.ts`, `logger.ts` — no auth-specific metrics

---

## Security Considerations

- **TLS required:** OAuth tokens must be transmitted over HTTPS. Deploy behind a TLS-terminating reverse proxy.
- **No sensitive data in logs:** Tokens and client secrets are never logged.
- **PKCE required:** The SDK enforces PKCE for all public clients.
- **Auth config not hot-reloaded:** Changing auth/RBAC requires a gateway restart.
- **Default deny:** When RBAC is enabled, unrecognized roles are denied by default.
- **Fail closed:** Auth middleware rejects requests before any business logic runs.

---

## Testing

### Unit Tests: `tests/auth.test.ts`

- Auth type `none` returns no middleware
- Proxy mode rejects requests without tokens (401)
- Proxy mode accepts valid bearer tokens
- Builtin mode installs OAuth endpoints
- Public endpoints bypass auth
- Invalid auth config throws validation error

### Unit Tests: `tests/rbac.test.ts`

- `servers: "*"` grants access to any server
- `servers: ["postgres"]` grants access to postgres only, denies others
- Default policy deny: unrecognized role is denied
- Default policy allow: unrecognized role has full access
- No RBAC config: all access allowed
- Multiple roles: access granted if any role has access

### Integration Tests

- Gateway with auth disabled: client connects without token
- Gateway with builtin auth: full OAuth flow (register → authorize → token → MCP request)
- Gateway with RBAC: analyst role can only activate/call postgres tools, not github tools
- Tool catalog respects RBAC: analyst only sees postgres tools in activate_tool description
- Public endpoints accessible without auth

---

## Future Extensions (Out of Scope)

- **Persistent token store for builtin mode:** Replace in-memory provider with database-backed store.
- **OPA integration:** Swap the config-based `PolicyEvaluator` for an OPA-backed implementation. The interface is ready.
- **Scope-based tool access:** When MCP backends annotate tools with scopes/categories, map roles to scopes instead of servers.
- **mTLS:** Mutual TLS for machine-to-machine auth. Use reverse proxy for now.
- **Audit logging:** Log auth decisions for compliance. Add when there's a real compliance requirement.

---

## Example Configurations

### Development (No Auth)

```yaml
gateway:
  port: 8080

servers:
  - name: postgres
    url: http://localhost:3001/mcp
```

### Production (Keycloak + RBAC)

```yaml
gateway:
  port: 8080
  auth:
    type: proxy
    issuer: https://keycloak.example.com/realms/mcp
    rolesClaim: realm_access.roles
    publicEndpoints:
      - /status
      - /metrics

servers:
  - name: postgres
    url: http://postgres-mcp:3001/mcp
  - name: github
    command: npx -y @modelcontextprotocol/server-github
    env:
      GITHUB_TOKEN: ${GH_TOKEN}
  - name: internal
    url: ${INTERNAL_MCP_URL}

rbac:
  defaultPolicy: deny
  roles:
    admin:
      servers: "*"
    analyst:
      servers: ["postgres"]
    developer:
      servers: ["postgres", "github"]
```

### Demo (Builtin Auth, No RBAC)

```yaml
gateway:
  port: 8080
  auth:
    type: builtin
    publicEndpoints:
      - /status

servers:
  - name: demo
    url: http://localhost:3001/mcp
```
