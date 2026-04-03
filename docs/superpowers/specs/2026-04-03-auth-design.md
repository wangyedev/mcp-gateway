# Authentication Design

**Goal:** Add optional API key authentication to the MCP gateway so operators can restrict access to authorized clients. The implementation must be simple, backward-compatible (auth off by default), and work with all MCP clients.

**Architecture:** Express middleware checks `Authorization: Bearer <key>` header on incoming requests to `/mcp` endpoints. API keys are configured in YAML (with env var substitution support) or directly via environment variable. Public endpoints (`/status`, `/metrics`) can be configured as protected or public. Zero new dependencies.

**Tech Stack:** Plain Express middleware. No JWT, no OAuth, no database — just string comparison against configured keys.

---

## Configuration

### YAML Schema

```yaml
gateway:
  port: 8080
  host: 0.0.0.0
  auth:
    type: bearer          # "bearer" enables auth, "none" disables (default)
    keys:                 # List of valid API keys
      - ${API_KEY_1}      # Env var substitution works
      - ${API_KEY_2}
    publicEndpoints:      # Optional: endpoints that don't require auth
      - /status
      - /metrics

servers:
  - name: postgres
    url: http://localhost:3001/mcp
```

### Environment Variable Fallback

If `gateway.auth` is not specified in YAML but `MCP_GATEWAY_API_KEY` is set, the gateway enables bearer auth with that single key. This provides a simple one-key setup for environments like Docker where mounting a full config file is inconvenient:

```bash
MCP_GATEWAY_API_KEY=secret-token npm start
```

### Validation Rules

- `auth.type` is optional. Valid values: `bearer`, `none`. Default: `none`.
- If `auth.type` is `none`, `auth.keys` and `auth.publicEndpoints` are ignored.
- If `auth.type` is `bearer`, at least one key must be configured (from `auth.keys` array or `MCP_GATEWAY_API_KEY` env var). Empty keys array + no env var = validation error.
- Keys must be non-empty strings after env var substitution. Empty string is rejected.
- Keys should be at least 32 characters (warning logged, not an error — operators can make bad choices).
- `auth.publicEndpoints` is an optional array of path strings (e.g., `["/status", "/metrics"]`). Default: `[]` (all endpoints require auth).
- Public endpoint paths are exact matches, not patterns. `/status` matches `/status` only, not `/status/foo`.

### Updated Config Interfaces

```typescript
export interface AuthConfig {
  type: "bearer" | "none";
  keys: string[];
  publicEndpoints?: string[];
}

export interface GatewayConfig {
  port: number;
  host: string;
  auth?: AuthConfig;
}
```

---

## Implementation

### New Module: `src/auth.ts`

Provides a single factory function that returns Express middleware:

```typescript
export interface AuthOptions {
  type: "bearer" | "none";
  keys: string[];
  publicEndpoints?: string[];
}

export function createAuthMiddleware(options: AuthOptions): express.RequestHandler {
  // If auth is disabled, return no-op middleware
  if (options.type === "none") {
    return (_req, _res, next) => next();
  }

  const keySet = new Set(options.keys);
  const publicPaths = new Set(options.publicEndpoints ?? []);

  return (req, res, next) => {
    // Allow public endpoints without auth
    if (publicPaths.has(req.path)) {
      return next();
    }

    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing Authorization header",
      });
    }

    // Parse "Bearer <token>"
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!match) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid Authorization header format. Expected: Bearer <token>",
      });
    }

    const token = match[1];

    // Constant-time comparison to prevent timing attacks
    if (!constantTimeCompare(token, keySet)) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Invalid API key",
      });
    }

    next();
  };
}

// Constant-time string comparison against a set of valid keys
function constantTimeCompare(provided: string, validKeys: Set<string>): boolean {
  let valid = false;
  for (const key of validKeys) {
    // Compare every key to prevent timing leaks
    const isMatch = timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(key)
    );
    valid = valid || isMatch;
  }
  return valid;
}

// Timing-safe comparison (available in Node crypto)
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    // Prevent length-based timing leaks by comparing against a constant
    const crypto = require("crypto");
    crypto.timingSafeEqual(a, a);
    return false;
  }
  const crypto = require("crypto");
  return crypto.timingSafeEqual(a, b);
}
```

### Changes to `src/config.ts`

**Add auth config parsing and validation:**

```typescript
const auth: AuthConfig = {
  type: substituted?.gateway?.auth?.type ?? "none",
  keys: substituted?.gateway?.auth?.keys ?? [],
  publicEndpoints: substituted?.gateway?.auth?.publicEndpoints ?? [],
};

// Apply fallback: if auth not configured but MCP_GATEWAY_API_KEY exists, use it
if (auth.type === "none" && !substituted?.gateway?.auth && process.env.MCP_GATEWAY_API_KEY) {
  auth.type = "bearer";
  auth.keys = [process.env.MCP_GATEWAY_API_KEY];
}

// Validation
if (auth.type === "bearer") {
  if (auth.keys.length === 0) {
    throw new Error(
      "Auth type is 'bearer' but no API keys configured. " +
      "Set gateway.auth.keys in config or MCP_GATEWAY_API_KEY env var."
    );
  }
  for (const key of auth.keys) {
    if (typeof key !== "string" || key.trim() === "") {
      throw new Error("API keys must be non-empty strings");
    }
    if (key.length < 32) {
      console.warn(
        `WARNING: API key is shorter than 32 characters (${key.length}). ` +
        "Use a strong, randomly-generated key in production."
      );
    }
  }
}

const gateway: GatewayConfig = {
  port: substituted?.gateway?.port ?? 8080,
  host: substituted?.gateway?.host ?? "0.0.0.0",
  auth,
};
```

**Extend return type:**

```typescript
return { gateway, servers };
```

### Changes to `src/server.ts`

**Accept auth options in constructor:**

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
  authOptions?: AuthOptions;  // New field
}
```

**Apply middleware in `startMcp()`:**

```typescript
async startMcp(port: number, host: string): Promise<number> {
  const app = express();
  app.use(express.json());

  // Apply auth middleware BEFORE all routes
  if (this.authOptions) {
    app.use(createAuthMiddleware(this.authOptions));
  }

  // ... existing routes (GET /status, GET /metrics, POST /mcp, etc.)
}
```

### Changes to `src/index.ts`

**Pass auth options to GatewayServer:**

```typescript
const server = new GatewayServer({
  registry,
  sessions,
  metaTools,
  router,
  serverUrls,
  logger,
  metrics,
  authOptions: config.gateway.auth,  // New field
});
```

**Log auth status at startup:**

```typescript
if (config.gateway.auth?.type === "bearer") {
  logger.info("Authentication enabled", {
    type: "bearer",
    keyCount: config.gateway.auth.keys.length,
    publicEndpoints: config.gateway.auth.publicEndpoints ?? [],
  });
} else {
  logger.info("Authentication disabled");
}
```

---

## Security Considerations

### What We Protect Against

- **Unauthorized access**: Only clients with valid API keys can initialize MCP sessions or call tools.
- **Timing attacks**: Constant-time comparison prevents attackers from guessing keys one character at a time.
- **Key leakage via logs**: API keys are never logged. Only key count is logged.
- **Accidental exposure**: Env var substitution keeps keys out of version control.

### What We Don't Protect Against

- **Key theft**: If an API key leaks, rotate it by updating the config. This is inherent to bearer tokens.
- **Man-in-the-middle attacks**: Use TLS (HTTPS) in production. The gateway should run behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel) that terminates TLS. Auth alone is not enough — TLS is mandatory.
- **Replay attacks**: MCP is session-based and stateful. Replaying old requests would still require a valid session ID, which is tied to the client's connection lifecycle. This is not a vulnerability.
- **Rate limiting**: Not in scope for auth. Operators should use a reverse proxy (nginx `limit_req`) or a service mesh.
- **Per-tool authorization**: This is the "Tool Policies" feature, tracked separately. Auth answers "who are you?", not "what can you do?".

### Key Management Best Practices

Documented in `README.md` (not part of this spec, but recommended):

- Generate keys with `openssl rand -base64 32` or equivalent.
- Store keys in a secrets manager (Vault, AWS Secrets Manager) and inject via env vars, not in the YAML file directly.
- Rotate keys periodically.
- Use different keys per environment (dev, staging, prod).
- Never commit keys to version control. Use `${VAR}` substitution in the YAML file.

---

## Backward Compatibility

### Default Behavior

Auth is **off by default**. Existing deployments continue to work without modification. This matches MCP's current state: most implementations have no auth because the spec is evolving.

### Migration Path

Operators can enable auth incrementally:

1. **Add auth to config** (set `gateway.auth.type: bearer` and `gateway.auth.keys`).
2. **Deploy without downtime** — the gateway continues serving existing sessions. New sessions require auth.
3. **Update clients** to send `Authorization: Bearer <key>` header in their MCP initialize request.
4. **Lock down public endpoints** by removing `/status` and `/metrics` from `publicEndpoints` if desired.

### Config Hot Reload

Auth config changes are **not** hot-reloaded. Changing auth requires a gateway restart because:

- Middleware is set up once at server start, not per-request.
- Rotating keys mid-flight could invalidate active sessions, causing confusing errors.

Operators should:

- Update config and restart the gateway during a maintenance window.
- Use a load balancer to do a rolling restart with zero downtime.

---

## Client Integration

### How Clients Send API Keys

MCP clients using Streamable HTTP transport must include the `Authorization` header in all requests:

```javascript
// Example: JavaScript client
const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:8080/mcp")
);

// Override fetch to inject auth header
const originalFetch = transport.fetch;
transport.fetch = (url, options) => {
  return originalFetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: "Bearer your-secret-key-here",
    },
  });
};
```

Most MCP client libraries will add first-class support for auth headers once the spec stabilizes. Until then, this is the workaround.

### Error Handling

Clients receive a 401 response with a JSON error body:

```json
{
  "error": "Unauthorized",
  "message": "Invalid API key"
}
```

Clients should:

- Not retry with the same key (it's invalid).
- Prompt the user to check their API key configuration.
- Log the error message (but not the key).

---

## Testing

### Unit Tests: `tests/auth.test.ts`

- Middleware allows requests with valid API key.
- Middleware rejects requests with invalid API key (401).
- Middleware rejects requests with missing Authorization header (401).
- Middleware rejects requests with malformed Authorization header (401).
- Middleware allows public endpoints without auth.
- Middleware works with multiple keys (any valid key passes).
- Constant-time comparison works correctly (cannot test timing, but verify functionality).
- Auth type `none` disables all checks (middleware is no-op).

### Unit Tests: `tests/config.test.ts`

- Parse `gateway.auth` from YAML.
- Fallback to `MCP_GATEWAY_API_KEY` when YAML auth is absent.
- Reject `bearer` auth with no keys.
- Reject empty string keys.
- Warn on short keys (< 32 chars).
- `auth.publicEndpoints` defaults to empty array.
- Env var substitution works in `auth.keys`.

### Integration Tests: `tests/integration/auth.test.ts`

- End-to-end flow: start gateway with auth, client sends valid key, session succeeds.
- End-to-end flow: start gateway with auth, client sends invalid key, session rejected.
- End-to-end flow: start gateway with auth, client hits `/status` (public), succeeds without key.
- End-to-end flow: start gateway with auth disabled (`type: none`), client connects without key.

### Manual Testing

- Deploy gateway with `MCP_GATEWAY_API_KEY=test-key`.
- Use `curl` to test:
  ```bash
  # Should fail (no auth)
  curl -X POST http://localhost:8080/mcp

  # Should succeed
  curl -X POST http://localhost:8080/mcp \
    -H "Authorization: Bearer test-key" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"initialize","params":{...},"id":1}'

  # Should succeed (public endpoint)
  curl http://localhost:8080/status
  ```

### What We Won't Test

- Actual timing attack resistance (requires specialized tooling, not a unit test concern).
- TLS/HTTPS (out of scope — reverse proxy responsibility).
- Key rotation in production (operational concern, not a test).

---

## Metrics and Logging

### New Metrics

No new metrics. Auth failures are not security events worth tracking in Prometheus (they'd create a DoS vector — attackers spamming metrics). Legitimate auth failures are rare and should be debugged via logs.

If operators want auth failure metrics, they should use their reverse proxy's metrics (nginx, Envoy).

### Logging

- **Startup**: Log auth mode (`enabled` or `disabled`) and public endpoints.
- **Auth failures**: Not logged. Logging every failed auth attempt creates a DoS vector and pollutes logs. Operators who need this should enable access logs in their reverse proxy.
- **Key warnings**: Log a warning if a key is shorter than 32 characters.

Rationale: The gateway is behind a reverse proxy in production. The proxy already logs all HTTP requests, including auth failures. Duplicating that in the gateway adds no value.

---

## What Doesn't Change

These modules are unaware of auth and require no modifications:

- `registry.ts` — pure data store.
- `session.ts` — pure data store.
- `meta-tools.ts` — builds catalog from registry.
- `router.ts` — routes tool calls to backends.
- `backend.ts` — connects to backend MCP servers (backends handle their own auth).
- `watcher.ts` — watches config file.
- `metrics.ts` — Prometheus metrics.
- `logger.ts` — structured logging.

---

## Future Extensions (Out of Scope)

These are explicitly **not** included in this design but could be added later:

### OAuth 2.0 / OIDC

Operators who need this should deploy a reverse proxy (nginx with `auth_request`, Pomerium, oauth2-proxy) in front of the gateway. The proxy validates OAuth tokens and forwards requests to the gateway with a simple bearer token. This keeps the gateway simple and delegates complex auth flows to specialized tools.

### Per-Tool Authorization (Tool Policies)

"User A can activate tools X and Y, but not Z." This is a separate feature, not part of authentication. The implementation would:

- Add a `policies` section to config mapping API keys to allowed tool patterns.
- Check policies in `MetaToolHandler.activateTool()` before allowing activation.
- Return an error if the client tries to activate a forbidden tool.

This is tracked separately and depends on stable auth being in place first.

### API Key Scopes

"Key A is read-only, key B is admin." This requires defining what "read-only" means in MCP (list tools? call tools? activate tools?). The MCP spec doesn't define scopes yet, so this is premature. If added, it would be a label on each key in the config, checked in the auth middleware or tool handler.

### Key Expiration

"Key X expires on 2026-05-01." Requires storing expiration timestamps alongside keys and checking them in the middleware. Out of scope for MVP — operators can rotate keys manually or use a secrets manager that handles expiration (e.g., Vault dynamic secrets).

---

## Example Configurations

### Minimal (Auth Off, Backward Compatible)

```yaml
gateway:
  port: 8080

servers:
  - name: postgres
    url: http://localhost:3001/mcp
```

### Single Key via Env Var

```yaml
gateway:
  port: 8080
  # Auth enabled via MCP_GATEWAY_API_KEY env var

servers:
  - name: postgres
    url: http://localhost:3001/mcp
```

```bash
MCP_GATEWAY_API_KEY=$(openssl rand -base64 32) npm start
```

### Multiple Keys, Public Status Endpoint

```yaml
gateway:
  port: 8080
  auth:
    type: bearer
    keys:
      - ${API_KEY_PROD}
      - ${API_KEY_DEV}
    publicEndpoints:
      - /status

servers:
  - name: postgres
    url: http://localhost:3001/mcp
```

### Locked Down (All Endpoints Require Auth)

```yaml
gateway:
  port: 8080
  auth:
    type: bearer
    keys:
      - ${API_KEY_1}
      - ${API_KEY_2}
    # publicEndpoints is empty, so /status and /metrics require auth

servers:
  - name: postgres
    url: http://localhost:3001/mcp
```

---

## Design Principles

This implementation follows industry best practices for API authentication:

- **Simplicity**: Bearer tokens are universally understood. No complex flows, no token exchange, no refresh tokens.
- **Defense in depth**: Constant-time comparison, no key logging, TLS required in production.
- **Fail closed**: Auth is checked before any business logic. A bug in auth middleware rejects requests, it doesn't bypass checks.
- **Separation of concerns**: Auth answers "who are you?", not "what can you do?". Authorization (policies) is a separate layer.
- **Extensibility**: The `AuthOptions` interface can grow to support new auth types (`oauth`, `mtls`) without changing the middleware contract.
- **Zero trust**: Even internal endpoints (`/status`, `/metrics`) can be protected. Public endpoints are opt-in, not opt-out.
- **Operator-friendly**: Config validation prevents typos. Warnings guide best practices. Env var substitution keeps secrets safe.
