/**
 * src/http/register.ts — T-0342 (E14): PUBLIC registration endpoint.
 *
 * POST /api/register — PUBLIC (no withAuth — this is pre-login; FF-1).
 * Thin HTTP adapter over the pure core service (src/core/register.ts).
 *
 * Error mapping:
 *   400 VALIDATION    — missing/invalid/short fields
 *   409 EMAIL_TAKEN   — KC user with that email already exists
 *   409 ORG_TAKEN     — tenant slug already exists
 *   503 AUTH_UNAVAILABLE — KC registrar unreachable / misconfigured
 *   500 INTERNAL      — DB failure after KC create (compensation attempted)
 *
 * 201 → { tenantId, tenantSlug, userId, email }
 */

import pg from "pg";
import { readJsonBody, HttpError, type Router } from "./router.js";
import { registerTenant, RegisterError } from "../core/register.js";
import type { KeycloakUserPort } from "../keycloak/admin-port.js";

// ---------------------------------------------------------------------------
// Deps shape (injected from server.ts)
// ---------------------------------------------------------------------------

export interface RegisterRouteDeps {
  pool: pg.Pool;
  kc: KeycloakUserPort;
}

// ---------------------------------------------------------------------------
// registerRegisterRoutes — wired in server.ts (deps-gated)
// ---------------------------------------------------------------------------

export function registerRegisterRoutes(router: Router, deps: RegisterRouteDeps): void {
  const nowMs = () => Date.now();

  /**
   * POST /api/register — PUBLIC (no withAuth wrapper; FF-1).
   *
   * Body: { orgName: string, email: string, password: string }
   * 201:  { tenantId: uuid, tenantSlug: string, userId: uuid, email: string }
   */
  router.register("POST", "/api/register", async (req, res) => {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      throw new HttpError(400, "VALIDATION", "Request body must be valid JSON");
    }

    const b = body as Record<string, unknown>;
    const orgName = typeof b["orgName"] === "string" ? b["orgName"] : "";
    const email = typeof b["email"] === "string" ? b["email"] : "";
    const password = typeof b["password"] === "string" ? b["password"] : "";

    try {
      const result = await registerTenant(
        { pool: deps.pool, kc: deps.kc, nowMs },
        { orgName, email, password },
      );
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (err) {
      if (err instanceof RegisterError) {
        const code = err.code;
        if (code === "VALIDATION") {
          throw new HttpError(400, "VALIDATION", err.message);
        }
        if (code === "EMAIL_TAKEN") {
          throw new HttpError(409, "EMAIL_TAKEN", err.message);
        }
        if (code === "ORG_TAKEN") {
          throw new HttpError(409, "ORG_TAKEN", err.message);
        }
        if (code === "AUTH_UNAVAILABLE") {
          throw new HttpError(503, "AUTH_UNAVAILABLE", err.message);
        }
        // Any other RegisterError → 500
        throw new HttpError(500, "INTERNAL", err.message);
      }
      // Unhandled error from core (DB failure etc.)
      throw new HttpError(500, "INTERNAL", "Registration failed due to an internal error");
    }
  });
}
