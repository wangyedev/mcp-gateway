# Tool Policies Design

**Goal:** Allow operators to control which tools from backend MCP servers are exposed through the gateway by configuring per-server allow/deny lists. This enables hiding dangerous tools (like database `drop_table`) or limiting exposure to only specific approved tools, without modifying backend servers.

**Architecture:** Extend the YAML config with optional `tools.allow` and `tools.deny` lists per server. Filtering happens in the registry layer when tools are registered and when the catalog is built. Hidden tools cannot be activated — `activate_tool` returns an error if a client tries to activate a filtered tool.

**Backwards Compatibility:** If neither `allow` nor `deny` is configured for a server, all tools are exposed (current behavior). Existing configs continue to work unchanged.

---

## Config Schema Changes (`src/config.ts`)

### ServerConfig Interface

Add optional `tools` field with mutually exclusive `allow`/`deny` lists:

```typescript
export interface ToolsConfig {
  allow?: string[];  // Only expose these tools (allowlist mode)
  deny?: string[];   // Hide these tools (denylist mode)
}

export interface ServerConfig {
  name: string;
  url?: string;
  command?: string;
  description?: string;
  env?: Record<string, string>;
  cwd?: string;
  tools?: ToolsConfig;  // NEW: optional policy config
}
```

### Validation Rules

Add validation in `loadConfig()`:

1. `tools.allow` and `tools.deny` are mutually exclusive — if both are set, throw an error: `Server '{name}' cannot have both 'allow' and 'deny' policies`.
2. If `tools.allow` is set, it must be a non-empty array of strings. Empty array throws an error: `Server '{name}' has empty 'allow' list — either specify tools or remove the field`.
3. If `tools.deny` is set, it must be a non-empty array of strings. Empty array throws an error: `Server '{name}' has empty 'deny' list — either specify tools or remove the field`.
4. Tool names in `allow`/`deny` are the original tool names (without server prefix) — they match against the `name` field in the backend's tool definitions.

### Example Configs

**Deny mode** (hide specific dangerous tools):

```yaml
servers:
  - name: postgres
    url: http://localhost:3001/mcp
    tools:
      deny: ["drop_table", "truncate", "drop_database"]
```

**Allow mode** (only expose approved tools):

```yaml
servers:
  - name: github
    url: http://localhost:3002/mcp
    tools:
      allow: ["search_repos", "list_issues", "get_issue"]
```

**No policy** (all tools exposed — default):

```yaml
servers:
  - name: filesystem
    url: http://localhost:3003/mcp
```

---

## Registry Changes (`src/registry.ts`)

### Store Policy Config

Add policy storage to the registry:

```typescript
export class ToolRegistry {
  private servers = new Map<
    string,
    { 
      description?: string; 
      status: "available" | "unavailable"; 
      tools: ToolDefinition[];
      policy?: ToolsConfig;  // NEW: store policy config
    }
  >();
  
  registerServer(
    name: string, 
    registration: ServerRegistration,
    policy?: ToolsConfig  // NEW: accept policy from config
  ): void {
    const filteredTools = this.applyPolicy(registration.tools, policy);
    const description = 
      registration.description ?? this.generateDescription(filteredTools);
    this.servers.set(name, {
      description,
      status: "available",
      tools: filteredTools,
      policy,
    });
  }
}
```

### Policy Filtering Logic

Add private method to apply allow/deny filters:

```typescript
private applyPolicy(
  tools: ToolDefinition[], 
  policy?: ToolsConfig
): ToolDefinition[] {
  if (!policy) {
    return tools;  // No policy = all tools exposed
  }
  
  if (policy.allow) {
    const allowSet = new Set(policy.allow);
    return tools.filter(t => allowSet.has(t.name));
  }
  
  if (policy.deny) {
    const denySet = new Set(policy.deny);
    return tools.filter(t => !denySet.has(t.name));
  }
  
  return tools;  // Shouldn't reach here if validation is correct
}
```

### Behavior

- **Allow mode**: Only tools whose `name` appears in the `allow` list are stored. If a backend provides `["foo", "bar", "baz"]` and the policy is `allow: ["foo", "baz"]`, only `foo` and `baz` are stored in the registry.
- **Deny mode**: Tools whose `name` appears in the `deny` list are filtered out. If the policy is `deny: ["bar"]`, only `foo` and `baz` are stored.
- **No policy**: All tools are stored (current behavior).

### getTool() Behavior

No changes needed — `getTool()` already only returns tools that were stored in the registry. Hidden tools won't be found.

---

## Integration with BackendManager (`src/backend.ts`)

### Pass Policy to Registry

When registering a backend's tools, pass the policy config from `ServerConfig`:

```typescript
// In BackendManager.connect() or connectStdio(), after receiving tools from backend:

const serverConfig = this.getServerConfig(serverName);  // Get from config
this.registry.registerServer(
  serverName,
  { tools: backendTools, description: serverConfig.description },
  serverConfig.tools  // Pass policy config
);
```

The `BackendManager` constructor already has access to the full `ServerConfig[]` array, so it can look up the policy for each server by name.

---

## Meta-Tools Behavior (`src/meta-tools.ts`)

### Catalog Building

No changes needed to `buildToolCatalog()` — it calls `registry.listServerTools()`, which only returns tools that passed the policy filter. Hidden tools never appear in the `activate_tool` description.

### Activation Errors

`activateTool()` already calls `registry.getTool()`, which returns `undefined` for filtered tools. The existing error handling covers this:

```typescript
activateTool(sessionId: string, toolName: string) {
  const tool = this.registry.getTool(toolName);
  if (!tool) {
    throw new Error(`Tool '${toolName}' not found`);
  }
  // ... continue with activation
}
```

Clients attempting to activate a hidden tool get a clear error: `Tool 'postgres.drop_table' not found`.

---

## Security & Observability

### Logging

When a backend is registered, log the policy action:

```typescript
// In BackendManager after registration
if (policy?.allow) {
  logger.info("Applied tool allowlist", { 
    server: serverName, 
    allowed: policy.allow.length, 
    total: backendTools.length 
  });
} else if (policy?.deny) {
  logger.info("Applied tool denylist", { 
    server: serverName, 
    denied: policy.deny.length, 
    total: backendTools.length 
  });
}
```

### Metrics

Add optional metric to track policy enforcement:

```
gateway_policy_filtered_tools_total{server="postgres", mode="deny"} 3
```

This is optional — the primary value is in the logs.

### Status Endpoint

`GET /status` already shows `tools: this.registry.getToolNamesForServer(s.name)`, which will only include non-filtered tools. Operators can verify their policy is working by checking the status endpoint.

---

## What Doesn't Change

- **Session-level policies**: All clients see the same filtered catalog. Per-session or per-user policies are not supported (YAGNI).
- **Pattern matching**: Tool names must match exactly. No wildcards, globs, or regex (YAGNI for MVP).
- **Runtime policy updates**: Policies are loaded from config at startup. Changes require a config reload (existing behavior via `ConfigWatcher`).
- **Rate limiting**: Separate concern, not part of tool policies.
- **Capability filtering**: Only tool visibility is controlled. If a backend provides resources or prompts, those are unaffected.

---

## Testing Strategy

### Config Validation Tests (`tests/config.test.ts`)

- Reject config with both `allow` and `deny` for same server.
- Reject config with empty `allow` array.
- Reject config with empty `deny` array.
- Accept config with only `allow` set.
- Accept config with only `deny` set.
- Accept config with no `tools` field (backwards compatibility).
- Parse `allow`/`deny` as string arrays correctly.

### Registry Policy Tests (`tests/registry.test.ts`)

- **Allow mode**: Only allowed tools are stored and retrievable.
- **Deny mode**: Denied tools are filtered out, others remain.
- **No policy**: All tools are stored (current behavior).
- `listServerTools()` only returns non-filtered tools.
- `getTool()` returns `undefined` for filtered tools.
- Allow/deny against empty backend tool list returns empty (no crash).

### Meta-Tools Integration Tests (`tests/meta-tools.test.ts`)

- Catalog description does not include filtered tools.
- `activateTool()` throws error for filtered tool.
- `activateTool()` succeeds for non-filtered tool.

### End-to-End Tests (`tests/integration.test.ts`)

- Start gateway with deny policy, verify filtered tools don't appear in `tools/list`.
- Start gateway with allow policy, verify only allowed tools appear.
- Attempt to activate filtered tool, verify error response.
- Activate non-filtered tool, verify success.
- Config reload with new policy updates tool catalog.

### What We Won't Test

- Performance impact of filtering (negligible for realistic tool counts).
- Policy interaction with MCP protocol features not yet implemented (resources, prompts).
- Glob/pattern matching (not implemented).

---

## Migration Path

### Existing Deployments

1. No action required — configs without `tools` field work unchanged.
2. Operators can add policies incrementally, one server at a time.
3. No breaking changes to the MCP protocol or API.

### Recommended Rollout

1. Deploy gateway version with policy support.
2. Audit tool catalogs via `GET /status` to identify dangerous tools.
3. Add `deny` policies to config for high-risk tools.
4. Reload config via `ConfigWatcher` or restart.
5. Verify filtered tools are gone via `GET /status` and client testing.

---

## Implementation Checklist

- [ ] Update `ServerConfig` interface with `ToolsConfig` in `src/config.ts`
- [ ] Add validation for `allow`/`deny` mutual exclusion in `loadConfig()`
- [ ] Add validation for non-empty arrays
- [ ] Update `ToolRegistry.registerServer()` signature to accept `policy`
- [ ] Implement `applyPolicy()` filtering logic in `ToolRegistry`
- [ ] Store policy config in registry server entries
- [ ] Update `BackendManager` to pass policy from config to `registerServer()`
- [ ] Add logging when policies are applied during backend registration
- [ ] Write config validation tests
- [ ] Write registry policy filtering tests
- [ ] Write meta-tools integration tests
- [ ] Write end-to-end policy tests
- [ ] Update README with policy config examples
- [ ] Update schema documentation (if exists)

---

## Future Enhancements (Not in MVP)

These are explicitly deferred to avoid scope creep:

- **Pattern matching**: Support glob patterns like `deny: ["drop_*"]` for bulk filtering.
- **Per-session policies**: Different clients see different tool catalogs based on user identity or session attributes.
- **Policy inheritance**: Global deny list + per-server overrides.
- **Runtime policy API**: HTTP endpoint to update policies without config reload.
- **Audit logging**: Separate audit trail for policy violations.
- **Policy testing tool**: CLI to preview which tools would be exposed with a given policy.

---

## Design Principles

- **Fail closed**: Invalid policy config blocks startup (prevents accidental exposure).
- **Explicit over implicit**: Empty allow/deny lists are rejected (prevents operator mistakes).
- **Zero runtime cost for no-policy**: Filtering only happens when policy is configured.
- **Single source of truth**: Registry stores filtered tools, all consumers see the same view.
- **Operator-friendly errors**: Clear messages when activation fails due to policy.
