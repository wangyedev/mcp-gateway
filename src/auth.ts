import type { RequestHandler, Request, Response, NextFunction } from "express";

export interface AuthConfig {
  type: "none" | "proxy" | "builtin";
  issuer?: string;
  rolesClaim?: string;
  audience?: string;
  publicEndpoints?: string[];
}

// Extend Express Request to include auth info
declare global {
  namespace Express {
    interface Request {
      authRoles?: string[];
    }
  }
}

export function createAuthMiddleware(config?: AuthConfig): RequestHandler[] {
  if (!config || config.type === "none") return [];

  const publicPaths = new Set(config.publicEndpoints ?? []);
  const rolesClaim = config.rolesClaim ?? "roles";

  if (config.type === "proxy") {
    return [
      (req: Request, res: Response, next: NextFunction) => {
        // Skip public endpoints
        if (publicPaths.has(req.path)) return next();

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Unauthorized: missing Authorization header" },
            id: null,
          });
        }

        const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
        if (!match) {
          return res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Unauthorized: invalid Authorization header format" },
            id: null,
          });
        }

        const token = match[1];

        try {
          // Decode JWT payload (base64url decode, no signature verification for MVP)
          // TODO: Add JWKS-based signature verification for production
          const parts = token.split(".");
          if (parts.length !== 3) {
            return res.status(401).json({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Unauthorized: invalid token format" },
              id: null,
            });
          }

          const payload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString()
          );

          // Extract roles from configured claim path
          const roles = getNestedClaim(payload, rolesClaim);
          req.authRoles = Array.isArray(roles) ? roles : [];

          next();
        } catch {
          return res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Unauthorized: invalid token" },
            id: null,
          });
        }
      },
    ];
  }

  if (config.type === "builtin") {
    // Simplified builtin mode for development
    // In production, this would use the SDK's mcpAuthRouter
    // For MVP, accept any well-formed JWT without verification
    return [
      (req: Request, res: Response, next: NextFunction) => {
        if (publicPaths.has(req.path)) return next();

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Unauthorized: missing Authorization header" },
            id: null,
          });
        }

        const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
        if (!match) {
          return res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Unauthorized: invalid Authorization header format" },
            id: null,
          });
        }

        const token = match[1];
        try {
          const parts = token.split(".");
          if (parts.length !== 3) throw new Error("Invalid JWT");
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
          req.authRoles = Array.isArray(payload[rolesClaim]) ? payload[rolesClaim] : [];
          next();
        } catch {
          return res.status(401).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Unauthorized: invalid token" },
            id: null,
          });
        }
      },
    ];
  }

  return [];
}

function getNestedClaim(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}
