/**
 * src/http/user-mgmt.ts — T-0583 (E5): manage user ACCOUNTS from the product.
 *
 * "A human is not harder to hire than an AI agent": agent = POST
 * /api/agents/hire (KC client); human = POST /api/users (KC user) — both
 * through the SAME KeycloakUserPort (src/keycloak/admin-port.ts, T-0342/T-0470).
 * This module does NOT introduce a second KC-integration path (N5): it
 * imports KeycloakUserPort and calls createHumanUser / setUserEnabled /
 * deleteUser — no direct Keycloak admin-REST HTTP call lives here (FF-583-8).
 *
 * Routes (all under the existing org-write gate, T-0469):
 *   POST   /api/users               — create a KC-backed login + employee(kind='human')
 *   GET    /api/users/accounts      — list human accounts of the actor's tenant
 *   PATCH  /api/users/:employee_id  — deactivate/reactivate an account
 *
 * KC-first + compensation (N4, mirrors src/core/register.ts): the KC user is
 * created BEFORE any DB write; if the DB transaction then fails, the KC user
 * is best-effort deleted (no KC-sibling orphan). EMAIL_TAKEN → 409; KC
 * unreachable → 503 (BEFORE any DB write — no partial state).
 *
 * The created account's READ visibility comes from the SAME hire-flow helper
 * T-0619 uses (src/core/reader-grant.ts, extracted from rights-intents.ts —
 * ADR-T0583 §5 contract FE-W23-0008) — ONE implementation, two callers.
 *
 * N1 (password never logged/audited/returned): the plaintext password is read
 * from the request body, passed ONLY to kc.createHumanUser, and never touches
 * a log line, the audit_event payload, or any HTTP response body (success or
 * error) below.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { KeycloakUserPort } from "../keycloak/admin-port.js";
import { ensureReaderRoleAndAssignHuman } from "../core/reader-grant.js";
import { loadAdminContext, resolveActorSlugFromAuth } from "../db/org.js";
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";
import { authorizeOrgWrite, assertOrgObjectAuthority } from "./seed-write.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

const userMgmtAuditWriter = makePgAuditWriter();

// ---------------------------------------------------------------------------
// extractActor — identical seam to rights-intents.ts / seed-write.ts (T-0489 /
// T-0372 pattern). Each write-module keeps its own copy (existing convention
// in this codebase — see seed-write.ts:73/rights-intents.ts:245 comments).
// ---------------------------------------------------------------------------

async function extractActor(
  req: import("node:http").IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// withTenantTx — write-path transaction (mirrors grants.ts / rights-intents.ts
// / seed-write.ts — each keeps its own copy, existing repo convention).
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function isConflict(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "23505";
  }
  return false;
}

/** KC port errors carry .code (EMAIL_TAKEN / EMAIL_INVALID / AUTH_UNAVAILABLE) — see admin-port.ts. */
function kcErrCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Password validation — mirrors register.ts validateRequest (≥8 chars, NF-9).
// Never logged; the raw value only ever flows into kc.createHumanUser below.
//
// EMAIL_RE (T-0625 fix): the spec (N9) is explicit — "login = username = the
// KC email field, as in register.ts: username=email". Before this fix, login
// was passed to kc.createHumanUser UNVALIDATED: a real Keycloak realm 400s on
// a non-email username/email, which the live port then mapped to
// AUTH_UNAVAILABLE (503) — the classic "ordinary login" LIVE_PROOF bug
// (T-0583/T-0625). Validating the SAME shape here, BEFORE any KC call, turns
// that into an honest 400 VALIDATION and never lets a bad value reach KC.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCreateBody(b: Record<string, unknown>): {
  login: string;
  password: string;
  display_name: string;
  position_id: string | null;
  role_id: string | null;
} {
  const login = b["login"];
  if (typeof login !== "string" || login.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "login is required");
  }
  const trimmedLogin = login.trim();
  if (!EMAIL_RE.test(trimmedLogin)) {
    throw new HttpError(400, "VALIDATION", "login must be a valid email address (e.g. name@company.ru)");
  }
  const password = b["password"];
  if (typeof password !== "string" || password.length < 8) {
    throw new HttpError(400, "VALIDATION", "password must be at least 8 characters");
  }
  const display_name = b["display_name"];
  if (typeof display_name !== "string" || display_name.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "display_name is required");
  }
  const position_id = typeof b["position_id"] === "string" ? (b["position_id"] as string) : null;
  if (position_id !== null) assertUuidShape(position_id, "position_id");
  const role_id = typeof b["role_id"] === "string" ? (b["role_id"] as string) : null;
  if (role_id !== null) assertUuidShape(role_id, "role_id");
  return { login: trimmedLogin, password, display_name: display_name.trim(), position_id, role_id };
}

// ---------------------------------------------------------------------------
// registerUserMgmtRoutes — wired in server.ts, reusing the SAME kcUserPort
// instance registerRegisterRoutes uses (live or honest-degrade, N5).
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export function registerUserMgmtRoutes(
  router: Router,
  pool: pg.Pool,
  kc: KeycloakUserPort,
  resolveActorTenant: ActorTenantResolver,
): void {
  const nowMs = () => Date.now();

  // -------------------------------------------------------------------------
  // POST /api/users — create a user account (KC-first, create-then-link).
  // body: { tenant_id, login, password, display_name, position_id?, role_id? }
  // 201: { employee_id, login }  (password never in the response)
  // -------------------------------------------------------------------------
  router.register("POST", "/api/users", withAuth(async (req, res) => {
    const body = await readJsonBody(req);
    const b = body as Record<string, unknown>;

    const tenant_id = b["tenant_id"];
    if (typeof tenant_id !== "string") {
      throw new HttpError(400, "VALIDATION", "tenant_id is required");
    }
    assertUuidShape(tenant_id, "tenant_id");

    // GATE BEFORE any side-effect (T-0388 cross-tenant guard + T-0469 owner-or-
    // covering-grant gate) — identical seam POST /api/employees uses.
    const { actorId, authTenantId } = await authorizeOrgWrite(req, pool, tenant_id, nowMs());
    const admin = await loadAdminContext(pool, authTenantId, actorId, nowMs());
    const oracle = await loadTenantOrgAncestry(pool, authTenantId);
    assertOrgObjectAuthority(
      admin, "mgmt_object:employee", "create", tenant_id, actorId, nowMs(),
      "owner or mgmt_object:employee grant required to create user accounts",
      oracle,
    );

    const { login, password, display_name, position_id, role_id } = validateCreateBody(b);

    // KC-first (N4): create the KC user BEFORE any DB write. The plaintext
    // password is passed here and NOWHERE else — never logged, never audited,
    // never echoed in a response (N1).
    let kcUserId: string;
    try {
      const result = await kc.createHumanUser({
        username: login,
        email: login,
        password,
        actorType: "human",
      });
      kcUserId = result.userId;
    } catch (err) {
      const code = kcErrCode(err);
      if (code === "EMAIL_TAKEN") {
        throw new HttpError(409, "EMAIL_TAKEN", "an account with that login already exists");
      }
      // Defense-in-depth (T-0625): validateCreateBody already rejects a
      // non-email login before this call, so a real KC realm should never
      // 400 here in this product's own flow. If it somehow does (KC-side
      // validation drift, e.g. Keycloak also rejecting a syntactically valid
      // but realm-disallowed address), surface it as an honest 400 — NOT the
      // generic 503 AUTH_UNAVAILABLE that masked this exact bug before.
      if (code === "EMAIL_INVALID") {
        throw new HttpError(400, "VALIDATION", "login must be a valid email address (e.g. name@company.ru)");
      }
      throw new HttpError(503, "AUTH_UNAVAILABLE", "account service unavailable — try again later");
    }

    const employeeId = randomUUID();
    const ts = nowMs();

    try {
      await withTenantTx(pool, tenant_id, async (client) => {
        // slug = KC userId — the T-0342 connective invariant (employee<->KC),
        // NOT human-readable (identity resolution reads it as the JWT sub —
        // see src/db/org.ts resolveActorSlugFromAuth). The human-readable KC
        // username the owner typed goes in the SEPARATE `login` column
        // (migration 126, T-0625 fix) so GET /api/users/accounts can show
        // the real login instead of this UUID.
        await client.query(
          `INSERT INTO choros.employee
             (tenant_id, id, position_id, kind, slug, login, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, 'human', $4, $5, $6, $7, $7)`,
          [tenant_id, employeeId, position_id, kcUserId, login, display_name, ts],
        );

        // Same hire-flow reader-grant helper T-0619 uses (F2) — the new
        // account can read records from the FIRST login, no separate step.
        await ensureReaderRoleAndAssignHuman(client, tenant_id, employeeId, actorId, ts);

        // Optional role_assignment on the given position's role (F3), under
        // the SAME admin gate already proven above (owner or covering grant
        // for this tenant — role_id itself is not independently re-gated here
        // because the org-object authority check already covers "author org
        // structure in this tenant"; this mirrors registerHire's assignment
        // write, minus the preset-atom machinery which is out of scope here).
        if (role_id) {
          await client.query(
            `INSERT INTO choros.role_assignment
               (tenant_id, id, employee_id, role_id, org_scope,
                granted_by, confirmed_by, source, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6, 'user-mgmt:create', $7, $7)`,
            [
              tenant_id, randomUUID(), employeeId, role_id,
              JSON.stringify({ kind: "set", members: [] }),
              actorId, ts,
            ],
          );
        }

        // Audit — creation of the account. NEVER includes the password (N1).
        await userMgmtAuditWriter.appendAuditEvent(client as unknown as PgClientLike, {
          id: randomUUID(),
          type: "user_account.create",
          actor: actorId,
          subject: employeeId,
          scope: null,
          via: null,
          proposed_by: null,
          confirmed_by: actorId,
          payload: { login, display_name },
          occurred_at: ts,
        });
      });
    } catch (err) {
      // DB failed AFTER KC create → best-effort compensation (N4/FF-583-3).
      await kc.deleteUser(kcUserId);
      if (isConflict(err)) {
        throw new HttpError(409, "CONFLICT", `an employee with this account already exists`);
      }
      throw err;
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ employee_id: employeeId, login }));
  }));

  // -------------------------------------------------------------------------
  // GET /api/users/accounts — tenant-scoped list of human accounts.
  // 200: { accounts: [{ employee_id, login, display_name, position, department, active }] }
  // -------------------------------------------------------------------------
  router.register("GET", "/api/users/accounts", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actorId);

    const client = await pool.connect();
    let rows: Array<{
      id: string;
      slug: string;
      login: string | null;
      display_name: string;
      position_title: string | null;
      department_name: string | null;
      deactivated_at: string | null;
    }>;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");
      const result = await client.query<{
        id: string;
        slug: string;
        login: string | null;
        display_name: string;
        position_title: string | null;
        department_name: string | null;
        deactivated_at: string | null;
      }>(
        `SELECT e.id, e.slug, e.login, e.display_name,
                p.title AS position_title,
                d.display_name AS department_name,
                e.deactivated_at
           FROM choros.employee e
           LEFT JOIN choros.position p
                 ON p.tenant_id = e.tenant_id AND p.id = e.position_id
           LEFT JOIN choros.department d
                 ON d.tenant_id = p.tenant_id AND d.id = p.department_id
          WHERE e.tenant_id = $1 AND e.kind = 'human'
          ORDER BY e.display_name`,
        [tenantId],
      );
      rows = result.rows;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // T-0625 fix: `slug` is the KC user UUID (identity-resolution invariant,
    // NOT human-readable — see the INSERT comment above). The list must show
    // the human-readable login the owner typed, which lives in the new
    // `login` column. Rows created before migration 126 (dev-silo seed
    // humans, or any account created before this fix shipped) have
    // login=NULL — for those ONLY, fall back to `slug` (their sole label;
    // the seed's slugs like `e-kravtsova` are already human-readable, not
    // KC UUIDs, since seed humans have no KC login at all).
    const accounts = rows.map((row) => ({
      employee_id: row.id,
      login: row.login ?? row.slug,
      display_name: row.display_name,
      position: row.position_title ?? "",
      department: row.department_name ?? "",
      active: row.deactivated_at === null,
    }));

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ accounts }));
  }));

  // -------------------------------------------------------------------------
  // PATCH /api/users/:employee_id — deactivate/reactivate an account.
  // body: { active: boolean }
  // 200: { employee_id, active }
  // -------------------------------------------------------------------------
  router.register("PATCH", "/api/users/:employee_id", withAuth(async (req, res, params) => {
    const employeeId = params["employee_id"];
    if (typeof employeeId !== "string") {
      throw new HttpError(400, "VALIDATION", "employee_id is required");
    }
    assertUuidShape(employeeId, "employee_id");

    const actorId = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actorId);

    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs());
    const oracle = await loadTenantOrgAncestry(pool, tenantId);
    assertOrgObjectAuthority(
      admin, "mgmt_object:employee", "update", tenantId, actorId, nowMs(),
      "owner or mgmt_object:employee grant required to deactivate/reactivate accounts",
      oracle,
    );

    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const active = body["active"];
    if (typeof active !== "boolean") {
      throw new HttpError(400, "VALIDATION", "active must be a boolean");
    }

    // Resolve the employee under the actor's OWN tenant (RLS) — a different
    // tenant's employee_id resolves to zero rows here → 404 (N3).
    const found = await withTenantTx(pool, tenantId, async (client) => {
      const { rows } = await client.query<{ slug: string; kind: string }>(
        `SELECT slug, kind FROM choros.employee WHERE tenant_id = $1 AND id = $2`,
        [tenantId, employeeId],
      );
      return rows[0] ?? null;
    });
    if (!found || found.kind !== "human") {
      throw new HttpError(404, "NOT_FOUND", "user account not found in your tenant");
    }
    const kcUserId = found.slug;

    // KC-first (N4): flip the KC login BEFORE touching the local marker. If KC
    // is unreachable, the local row stays untouched and the caller sees 503.
    try {
      await kc.setUserEnabled(kcUserId, active);
    } catch {
      throw new HttpError(503, "AUTH_UNAVAILABLE", "account service unavailable — try again later");
    }

    const ts = nowMs();
    await withTenantTx(pool, tenantId, async (client) => {
      await client.query(
        `UPDATE choros.employee
            SET deactivated_at = $3, updated_at = $4
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, employeeId, active ? null : ts, ts],
      );
      await userMgmtAuditWriter.appendAuditEvent(client as unknown as PgClientLike, {
        id: randomUUID(),
        type: active ? "user_account.reactivate" : "user_account.deactivate",
        actor: actorId,
        subject: employeeId,
        scope: null,
        via: null,
        proposed_by: null,
        confirmed_by: actorId,
        payload: {},
        occurred_at: ts,
      });
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ employee_id: employeeId, active }));
  }));
}
