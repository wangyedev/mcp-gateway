# Authentication Design

**Goal:** Add MCP-spec-compliant OAuth 2.1 authentication to the gateway so operators can restrict access to authorized clients. The implementation leverages the SDK's built-in auth middleware and supports both the gateway acting as its own OAuth server and delegating to a third-party OAuth provider (proxy mode).

**Architecture:** Use the MCP SDK's `mcpAuthRouter` and `requireBearerAuth` middleware, which implement the full OAuth 2.1 flow including authorization code grant with PKCE, client credentials grant, dynamic client registration, token refresh, and server metadata discovery. The gateway operator chooses between three modes: `none` (default, no auth), `proxy` (delegate to an external OAuth provider like Keycloak/Auth0), or `builtin` (gateway runs its own OAuth server with in-memory or configurable token storage).

**Tech Stack:** `@modelcontextprotocol/sdk` built-in auth modules. No new dependencies.

---

## Why OAuth 2.1 (Not API Keys)

The MCP specification requires OAuth 2.1 for HTTP transports:
- MCP auth implementations **MUST** implement OAuth 2.1
- Clients **MUST** use `Authorization: Bearer <token>` headers
- Servers **MUST** return 401 when auth is required but not provided
- Servers **SHOULD** support dynamic client registration (RFC 7591)
- Servers **SHOULD** support metadata discovery (RFC 8414)

The SDK already implements all of this. Using API keys would be non-compliant and would break standard MCP clients that expect OAuth flows.

---

## Configuration

### Mode: `none` (Default, Backwards Compatible)

No auth. Current behavior. All clients can connect.

```yaml
gateway:
  port: 8080
  # auth not specified = no auth
```

### Mode: `proxy` (Recommended for Production)

Delegate OAuth to an external provider (Keycloak, Auth0, Okta, etc.). The gateway validates bearer tokens by forwarding them to the provider's introspection/userinfo endpoint. The gateway itself does not issue tokens.

```yaml
gateway:
  port: 8080
  auth:
    type: proxy
    issuer: https://auth.example.com/realms/mcp  # OAuth server base URL
    audience: mcp-gateway                          # Expected audience claim (optional)
    publicEndpoints:                               # Endpoints that skip auth
      - /status
      - /metrics
```

How it works:
1. Client obtains a token from the external OAuth provider (out of band)
2. Client sends `Authorization: Bearer <token>` to the gateway
3. Gateway uses the SDK's `requireBearerAuth` middleware with a custom `OAuthTokenVerifier` that validates the token against the issuer (via JWKS or introspection)
4. If valid, request proceeds. If not, 401.

This is the recommended approach for production because:
- Operators already have an identity provider
- Token management (issuance, refresh, revocation) is handled by specialized software
- The gateway stays simple — it just validates tokens

### Mode: `builtin` (Development / Simple Deployments)

The gateway runs its own OAuth server using the SDK's `mcpAuthRouter`. Suitable for development, demos, and simple single-gateway deployments.

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
1. Gateway exposes OAuth endpoints at well-known paths: `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`
2. MCP clients discover these via RFC 8414 metadata discovery
3. Clients register dynamically (RFC 7591), then use authorization code + PKCE flow
4. Gateway issues and validates its own tokens using the SDK's `DemoInMemoryAuthProvider` (or a custom provider for persistence)

Limitations of builtin mode:
- In-memory token storage (tokens lost on restart)
- No user database (authorization prompt is a simple approve/deny)
- Not suitable for multi-instance deployments (no shared token store)

---

## Updated Config Interfaces

```typescript
export interface AuthConfig {
  type: "none" | "proxy" | "builtin";
  issuer?: string;            // proxy mode: OAuth server URL
  audience?: string;          // proxy mode: expected audience
  publicEndpoints?: string[]; // endpoints that skip auth
}

export interface GatewayConfig {
  port: number;
  host: string;
  auth?: AuthConfig;          // undefined = no auth
}
```

### Validation Rules

- `auth.type` is optional. Valid values: `none`, `proxy`, `builtin`. Default: `none`.
- If `type` is `proxy`, `issuer` is required. Must be a valid URL.
- If `type` is `builtin`, no additional config required.
- `publicEndpoints` is optional (default: `[]`). Exact path matches only.
- If `type` is `none`, all other auth fields are ignored.

---

## Implementation

### New Module: `src/auth.ts`

Provides factory functions for creating auth middleware based on config:

```typescript
import { mcpAuthRouter, requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth";

export function createAuthMiddleware(config: AuthConfig): express.RequestHandler[] {
  if (config.type === "none") return [];
  if (config.type === "proxy") return createProxyAuth(config);
  if (config.type === "builtin") return createBuiltinAuth(config);
}
```

**Proxy mode:** Uses `requireBearerAuth` with a custom `OAuthTokenVerifier` that validates tokens against the issuer's JWKS endpoint. The SDK's `ProxyOAuthServerProvider` may also be used to proxy the full OAuth flow.

**Builtin mode:** Uses `mcpAuthRouter` to install OAuth endpoints (`/authorize`, `/token`, `/register`, `/.well-known/oauth-authorization-server`). Uses a provider that implements `OAuthServerProvider` — initially the SDK's `DemoInMemoryAuthProvider`, which can be swapped for a persistent implementation later.

### Changes to `src/server.ts`

- Accept `authMiddleware` in constructor options
- Apply middleware in `startMcp()` before MCP routes
- Public endpoints bypass auth via path checking

### Changes to `src/config.ts`

- Add `AuthConfig` to `GatewayConfig`
- Validate auth config (type, issuer requirement for proxy mode)

### Changes to `src/index.ts`

- Create auth middleware from config
- Pass to GatewayServer
- Log auth mode at startup

---

## SDK Auth Components Used

| SDK Component | Usage |
|---------------|-------|
| `mcpAuthRouter` | Installs OAuth endpoints for builtin mode |
| `requireBearerAuth` | Validates bearer tokens on MCP endpoints |
| `OAuthServerProvider` | Interface for token issuance/validation |
| `OAuthTokenVerifier` | Simplified interface for token validation only (proxy mode) |
| `DemoInMemoryAuthProvider` | Reference implementation for builtin mode |
| `AuthInfo` | Token metadata (clientId, scopes, expiration) passed to handlers |

---

## What Doesn't Change

- `registry.ts`, `session.ts`, `meta-tools.ts`, `router.ts` — unaware of auth
- `backend.ts` — backends handle their own auth
- `watcher.ts` — watches config (auth changes require restart)
- `metrics.ts`, `logger.ts` — no auth metrics (reverse proxy handles this)

---

## Security Considerations

- **TLS required:** OAuth tokens must be transmitted over HTTPS. The gateway should run behind a TLS-terminating reverse proxy.
- **No sensitive data in logs:** Tokens are never logged.
- **Token validation:** Proxy mode validates tokens against the issuer. Builtin mode validates its own tokens.
- **PKCE required:** The SDK enforces PKCE for all public clients.
- **Auth config not hot-reloaded:** Changing auth requires a gateway restart.

---

## Testing

### Unit Tests: `tests/auth.test.ts`

- Auth type `none` returns no middleware
- Proxy mode creates middleware that rejects requests without tokens (401)
- Proxy mode accepts valid bearer tokens
- Builtin mode installs OAuth endpoints
- Public endpoints bypass auth
- Invalid auth config throws validation error

### Integration Tests

- Gateway with auth disabled: client connects without token
- Gateway with builtin auth: full OAuth flow (register → authorize → token → MCP request)
- Public endpoints accessible without auth when configured

---

## Future Extensions (Out of Scope)

- **RBAC / Scopes:** Map OAuth scopes to tool access policies. Depends on Tool Policies feature.
- **Persistent token store for builtin mode:** Replace in-memory provider with database-backed store.
- **mTLS:** Mutual TLS for machine-to-machine auth. Use reverse proxy for now.
- **API key fallback:** Simple bearer tokens for non-OAuth clients. Could be added as a fourth auth type if needed.
