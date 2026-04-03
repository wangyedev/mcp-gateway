# Docker Support Design

**Goal:** Enable the MCP Gateway to run in containerized environments via Docker, supporting both development workflows and production deployments. Provide a minimal, secure Docker image with proper configuration management and a complete docker-compose setup for local testing with backend servers.

**Architecture:** Multi-stage Docker build producing a slim production image. The container runs the compiled TypeScript application from `dist/`, accepts configuration via mounted volumes or environment variables, and exposes port 8080 for HTTP/MCP traffic.

**Tech Stack:** Node.js 22 LTS (slim variant), Docker multi-stage builds, docker-compose for orchestration. No Kubernetes, Helm, or CI/CD automation at this stage (YAGNI).

---

## Dockerfile

A multi-stage build minimizes image size and separates build-time dependencies from runtime dependencies.

### Build Stage

```dockerfile
FROM node:22-slim AS builder

WORKDIR /build

# Copy package files for dependency installation
COPY package*.json ./

# Install ALL dependencies (including devDependencies for TypeScript compilation)
RUN npm ci

# Copy source code and TypeScript config
COPY src/ ./src/
COPY tsconfig.json ./

# Compile TypeScript to dist/
RUN npm run build
```

**Rationale:**
- `node:22-slim` — Latest LTS with minimal base (Debian slim, no unnecessary tools).
- `npm ci` — Clean install from lock file, faster and more reliable than `npm install` in CI/Docker.
- Build stage includes devDependencies (TypeScript, tsx) needed for compilation.
- Named stage `builder` allows copying artifacts to production stage.

### Production Stage

```dockerfile
FROM node:22-slim

WORKDIR /app

# Copy package files and install production-only dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from build stage
COPY --from=builder /build/dist ./dist

# Copy example config for reference (not used by default)
COPY mcp-gateway.example.yaml ./

# Gateway listens on this port
EXPOSE 8080

# Run as non-root user for security
USER node

# Default to looking for config at /app/config/mcp-gateway.yaml (volume mount)
ENV MCP_GATEWAY_CONFIG=/app/config/mcp-gateway.yaml

CMD ["node", "dist/index.js"]
```

**Rationale:**
- Fresh stage eliminates build artifacts and devDependencies, reducing image size by ~50%.
- `npm ci --omit=dev` — Production dependencies only (express, yaml, chokidar, MCP SDK).
- `USER node` — Runs as unprivileged user (included in official Node images), improves security.
- `ENV MCP_GATEWAY_CONFIG` — Default path for mounted config file. Users can override with `-e` or in docker-compose.
- `EXPOSE 8080` — Documents the port, works with `-P` flag and container orchestration.
- Example config copied for documentation, actual config expected as volume mount.

### Environment Variables Supported in Container

Per the application's existing env var support:

| Variable | Default in Image | Description |
|----------|------------------|-------------|
| `MCP_GATEWAY_CONFIG` | `/app/config/mcp-gateway.yaml` | Path to config file inside container |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |
| `LOG_FORMAT` | `json` | Log output format (json or pretty) |

### Image Size Estimate

- Base: ~200 MB (node:22-slim)
- Production deps: ~30 MB (express, yaml, chokidar, MCP SDK)
- Compiled app: ~100 KB
- **Total: ~230 MB**

Significantly smaller than a full Node image (~1 GB) or including devDependencies (~300 MB).

---

## docker-compose.yml

Orchestrates the gateway and a demo backend server for local development and testing.

```yaml
version: '3.9'

services:
  # MCP Gateway
  gateway:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    volumes:
      # Mount config file from host
      - ./mcp-gateway.yaml:/app/config/mcp-gateway.yaml:ro
    environment:
      LOG_LEVEL: debug
      LOG_FORMAT: pretty
    depends_on:
      - demo-backend
    restart: unless-stopped

  # Demo backend MCP server (from demo/backend.ts)
  demo-backend:
    build:
      context: .
      dockerfile: Dockerfile.demo
    ports:
      - "3001:3001"
    environment:
      PORT: 3001
    restart: unless-stopped
```

### Gateway Service

- **Build context:** Current directory (entire repo available for COPY).
- **Port mapping:** Exposes gateway on host `localhost:8080`.
- **Volume mount:** Binds `mcp-gateway.yaml` from host into container at expected path. Read-only (`:ro`) prevents accidental modification from inside container.
- **Environment:** Override defaults for local debugging (debug logging, human-readable format).
- **Depends on:** Ensures demo backend starts before gateway (gateway will retry connection).
- **Restart policy:** Automatically restarts on failure, except when manually stopped.

### Demo Backend Service

Requires a separate Dockerfile (`Dockerfile.demo`) to run the demo backend server from `demo/backend.ts`.

```dockerfile
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY demo/ ./demo/
COPY tsconfig.json ./

# Run with tsx (development mode, no pre-compilation needed)
CMD ["npx", "tsx", "demo/backend.ts"]
```

**Rationale:**
- Separate image for the demo backend (different entry point, simpler build).
- Uses `tsx` for direct TypeScript execution (demo code, no need for production optimization).
- Listens on port 3001 (matches example config).

### Example docker-compose Workflow

```bash
# Start all services
docker-compose up --build

# Gateway available at: http://localhost:8080/mcp
# Demo backend at: http://localhost:3001/mcp

# Tail logs
docker-compose logs -f gateway

# Stop everything
docker-compose down
```

### Config File for docker-compose

Example `mcp-gateway.yaml` for the docker-compose setup:

```yaml
gateway:
  port: 8080
  host: "0.0.0.0"

servers:
  # HTTP backend running in docker-compose
  - name: demo
    url: http://demo-backend:3001/mcp
    description: "Demo backend server"
```

**Note:** Uses Docker's internal DNS (`demo-backend` resolves to the service name). External users connecting to the host would use `http://localhost:3001/mcp`.

---

## .dockerignore

Exclude unnecessary files from the Docker build context to speed up builds and reduce image size.

```
# Dependencies (installed via npm ci in Dockerfile)
node_modules/

# Build artifacts (created during Docker build)
dist/

# Git history (not needed in container)
.git/
.gitignore

# CI/CD
.github/

# Documentation
docs/
*.md

# Tests
tests/
*.test.ts
vitest.config.ts

# IDE and local configs
.vscode/
.idea/
.DS_Store
*.swp
*.swo
.claude/
.superpowers/

# Environment files (may contain secrets)
.env
.env.*

# Logs
*.log
npm-debug.log*

# Actual config (should be mounted, not baked into image)
mcp-gateway.yaml
```

**Rationale:**
- Prevents accidentally copying `node_modules/` from host (Docker installs its own).
- Excludes `dist/` from context (build stage creates it fresh).
- Blocks secret files (`.env`), config files (mounted instead), and development artifacts.
- Reduces build context size from ~100 MB to ~1 MB.

---

## Testing Approach

### 1. Build the Image

```bash
docker build -t mcp-gateway:test .
```

**Verify:**
- Build completes without errors.
- Image size is ~230 MB or less (`docker images mcp-gateway:test`).
- Both stages execute (see `builder` and final stage in output).

### 2. Run with Mounted Config

```bash
# Create a minimal config
cat > test-config.yaml <<EOF
gateway:
  port: 8080
  host: "0.0.0.0"

servers:
  - name: demo
    url: http://localhost:3001/mcp
EOF

# Run container
docker run -d \
  --name mcp-gateway-test \
  -p 8080:8080 \
  -v "$(pwd)/test-config.yaml:/app/config/mcp-gateway.yaml:ro" \
  -e LOG_LEVEL=debug \
  -e LOG_FORMAT=pretty \
  mcp-gateway:test

# Check logs
docker logs mcp-gateway-test
```

**Expected output:**
```
MCP Gateway starting...
Loaded configuration from /app/config/mcp-gateway.yaml
Listening on http://0.0.0.0:8080
Server 'demo' unavailable, will retry every 30 seconds
```

**Verify:**
- Container starts and listens on port 8080.
- Logs show config loaded from mounted path.
- Unavailable backend marked for retry (expected, no backend running yet).

### 3. Test with docker-compose

```bash
# Build and start all services
docker-compose up --build -d

# Wait for services to be ready
sleep 5

# Check gateway status
curl http://localhost:8080/status

# Check metrics
curl http://localhost:8080/metrics
```

**Expected status response:**
```json
{
  "status": "ok",
  "servers": {
    "demo": {
      "available": true,
      "toolCount": <number>
    }
  },
  "sessions": {
    "active": 0,
    "limit": 100
  }
}
```

**Verify:**
- Gateway and demo backend both running.
- Status endpoint shows demo server as available.
- Metrics endpoint returns Prometheus text format.

### 4. Test MCP Client Connection

```bash
# Use demo client script (if available)
npx tsx demo/client.ts http://localhost:8080/mcp

# Or test with curl (MCP protocol)
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Expected:**
- Client connects successfully.
- `tools/list` returns `activate_tool` and `deactivate_tool`.
- Can activate and call tools from the demo backend.

### 5. Test Hot Reload

```bash
# Modify the mounted config file
echo "  - name: test
    command: echo test" >> mcp-gateway.yaml

# Check logs for reload
docker-compose logs gateway | grep "Configuration reloaded"
```

**Verify:**
- Config changes detected (chokidar watches mounted file).
- Gateway reloads without container restart.
- New server appears in status endpoint.

### 6. Test Resource Limits

```bash
# Run with memory limit
docker run -d \
  --name mcp-gateway-limited \
  -p 8080:8080 \
  -m 256m \
  -v "$(pwd)/test-config.yaml:/app/config/mcp-gateway.yaml:ro" \
  mcp-gateway:test

# Monitor memory usage
docker stats mcp-gateway-limited --no-stream
```

**Verify:**
- Container runs within 256 MB limit (should use ~50-80 MB under normal load).
- No OOM kills.

### 7. Security Scan (Optional)

```bash
# Scan for vulnerabilities (requires Docker Scout or Trivy)
docker scout cves mcp-gateway:test
# or
trivy image mcp-gateway:test
```

**Verify:**
- No critical vulnerabilities in base image or dependencies.
- Non-root user in use (check with `docker inspect`).

### 8. Cleanup

```bash
docker-compose down
docker rm -f mcp-gateway-test mcp-gateway-limited
docker rmi mcp-gateway:test
```

---

## Production Considerations (Future Work)

**Not included in this design (YAGNI):**

- **Multi-architecture builds** — Add `docker buildx` for arm64/amd64 when needed.
- **Container registry publishing** — Add CI/CD workflow to push to Docker Hub/GHCR when ready.
- **Kubernetes manifests** — Premature without production requirements (ingress, autoscaling, secrets management).
- **Health checks** — Can add `HEALTHCHECK` directive once `/health` endpoint exists (requires code change).
- **Init system** — Node.js handles signals correctly in PID 1, but could add `tini` if zombie process issues arise.
- **Read-only filesystem** — Could add `--read-only` flag and `tmpfs` mounts once we verify no writes to disk.

**When to add them:**
- Multi-arch: When deploying to ARM servers (e.g., AWS Graviton, Raspberry Pi).
- Registry: When sharing images across team/users (not just local dev).
- Kubernetes: When scaling beyond single-node deployments.
- Health checks: After adding `/health` endpoint to the application.

---

## Files to Create

1. **`Dockerfile`** — Multi-stage build for production image.
2. **`Dockerfile.demo`** — Simple image for demo backend server.
3. **`docker-compose.yml`** — Orchestrates gateway + demo backend.
4. **`.dockerignore`** — Excludes unnecessary files from build context.
5. **`docs/docker.md`** (optional) — User-facing guide for Docker usage.

---

## Summary

This design provides production-ready Docker support via a multi-stage build, reducing image size to ~230 MB while maintaining security (non-root user, minimal dependencies). The docker-compose setup enables instant local testing with a demo backend. The testing approach validates builds, runtime behavior, config mounting, hot reload, and resource constraints.

The design intentionally excludes Kubernetes, CI/CD, and multi-arch builds (YAGNI), but the Dockerfile is structured to support these additions when production requirements emerge.
