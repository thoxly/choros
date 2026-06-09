/**
 * src/http/auth.ts
 *
 * Dev-stub authentication: reads dev-user identity from request header.
 * Routes: GET /api/users and GET /api/me for dev-session management.
 */
import { HttpError, type Router } from "./router.js";
import { findEmployee, listSelectableUsers } from "./org.js";
import { JobStore } from "../core/jobStore.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEV_USER_HEADER = "x-dev-user";

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAuthRoutes(router: Router, _store?: JobStore): void {
  // GET /api/users — return list of selectable users (humans only)
  router.register("GET", "/api/users", async (_req, res) => {
    const users = listSelectableUsers();
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ users }));
  });

  // GET /api/me — return current dev-user identity from header
  router.register("GET", "/api/me", async (req, res) => {
    // Read the dev-user header (handle both string and array cases)
    let devUserId = req.headers[DEV_USER_HEADER];
    if (Array.isArray(devUserId)) {
      devUserId = devUserId[0];
    }

    if (!devUserId || typeof devUserId !== "string") {
      throw new HttpError(401, "UNAUTHENTICATED", "no valid dev identity");
    }

    const employee = findEmployee(devUserId);
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
