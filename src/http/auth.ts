/**
 * src/http/auth.ts
 *
 * Dev-stub authentication: reads dev-user identity from request header.
 * Routes: GET /api/users and GET /api/me for dev-session management.
 *
 * Migration seam (T-0054): CHOROS_AUTH_MODE controls the active auth path.
 *   'dev' (default) — x-dev-user header stub active; no JWT required.
 *                     All existing tests pass unchanged.
 *   'keycloak'      — x-dev-user path disabled; Bearer JWT expected.
 *                     The JWT validator is implemented by T-0060;
 *                     this branch is a stub until T-0060 activates it.
 */
import { HttpError, type Router } from "./router.js";
import { findEmployeeAsync, listSelectableUsersAsync } from "./org.js";
import { JobStore } from "../core/jobStore.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEV_USER_HEADER = "x-dev-user";

/**
 * Active auth mode — read once at startup.
 * Internal to the auth layer; not a public export.
 * T-0060 reads the same env var to activate the JWT validator branch.
 */
const AUTH_MODE = (process.env.CHOROS_AUTH_MODE ?? "dev") as "dev" | "keycloak";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAuthRoutes(router: Router, _store?: JobStore): void {
  // GET /api/users — return list of selectable users (humans only)
  router.register("GET", "/api/users", async (_req, res) => {
    const users = await listSelectableUsersAsync();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ users }));
  });

  // GET /api/me — return current user identity
  router.register("GET", "/api/me", async (req, res) => {
    if (AUTH_MODE === "keycloak") {
      // T-0060 implements the JWT validation branch.
      // Until T-0060 is active, return 501 to signal the stub boundary.
      throw new HttpError(501, "NOT_IMPLEMENTED", "keycloak auth mode requires T-0060 JWT validator");
    }

    // AUTH_MODE === 'dev': read identity from x-dev-user header (existing behaviour)
    let devUserId = req.headers[DEV_USER_HEADER];
    if (Array.isArray(devUserId)) {
      devUserId = devUserId[0];
    }

    if (!devUserId || typeof devUserId !== "string") {
      throw new HttpError(401, "UNAUTHENTICATED", "no valid dev identity");
    }

    const employee = await findEmployeeAsync(devUserId);
    if (!employee) {
      throw new HttpError(401, "UNAUTHENTICATED", "no valid dev identity");
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: employee.id,
        name: employee.name,
        type: employee.type,
        position: employee.position,
        department: employee.department,
      })
    );
  });
}
