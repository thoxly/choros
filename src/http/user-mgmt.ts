/**
 * src/http/user-mgmt.ts — T-0583 (E5): manage user ACCOUNTS from the product.
 *
 * "A human is not harder to hire than an AI agent": agent = POST
 * /api/agents/hire (KC client); human = POST /api/users (KC user) — both
 * through the SAME KeycloakUserPort (src/keycloak/admin-port.ts, T-0342/T-0470).
 * This module does NOT introduce a second KC-integration path (N5): it
 * imports KeycloakUserPort and calls createHumanUser / setUserEnabled /
 * deleteUser / revokeUserSessions (T-0702) — no direct Keycloak admin-REST
 * HTTP call lives here (FF-583-8).
 *
 * T-0702 (ADR-T0702): PATCH .../:employee_id {active:false} also calls
 * kc.revokeUserSessions(kcUserId) right after setUserEnabled(false) — a
 * best-effort WINDOW-SHRINK (ADR §8): it kills the KC SSO session and
 * refresh tokens, so no NEW access token can be minted from the live
 * session. An ALREADY-ISSUED access-JWT is NOT invalidated by this — choros
 * validates access tokens offline against JWKS (src/http/auth.ts), so it
 * stays accepted until its own exp (~300s realm TTL). The actual
 * authorization guarantee is the PDP resolver gate (T-0658/T-0662
 * ACTOR_ACTIVE_SQL), independent of this call's outcome. Best-effort by
 * design (never throws) — the outcome is recorded as
 * payload.kc_sessions_revoked on the same user_account.deactivate audit
 * event, not treated as a hard gate.
 *
 * T-0727 (ADR-T0727, R-4/R-5 from the T-0702 review) — two hygiene fixes on
 * top of the T-0702 flow, both in the PATCH .../:employee_id handler:
 *   (R-4) a failed revokeUserSessions now ALSO console.warn's (was ONLY the
 *         audit payload before — an operator watching logs had no signal).
 *   (R-5) a repeated PATCH whose `active` already matches the current state
 *         is an idempotent no-op (no duplicate deactivate/reactivate audit
 *         event, no timestamp churn, no redundant KC call) — see ADR-T0727
 *         §3 for why the no-op check runs BEFORE the LAST-OWNER guard and
 *         BEFORE any KC call, and §3.2 for the KC-disabled+choros-active
 *         recovery path (repeat the same PATCH — it is NOT short-circuited
 *         because the DB still honestly reads "active").
 *
 * Routes (all under the existing org-write gate, T-0469):
 *   POST   /api/users               — create a KC-backed login + employee(kind='human')
 *   GET    /api/users/accounts      — list human accounts of the actor's tenant
 *   PATCH  /api/users/:employee_id  — deactivate/reactivate an account
 *
 * T-0630 [security] fix: GET /api/users/accounts previously carried NO
 * authority check (only auth — any authenticated tenant member, owner or
 * not, got 200 with the full account list). It now runs the SAME
 * loadAdminContext + assertOrgObjectAuthority(mgmt_object:employee, "read")
 * seam POST/PATCH already use — owner or a covering, delegable
 * mgmt_object:employee grant, no new authority path (D-064/T-0658
 * discipline: this file must not grow a 6th parallel authority resolver).
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
 *
 * T-0628 fix (follow-up on T-0625): `login` and `email` are two DISTINCT
 * required fields — `login` is free-form (a non-email username like
 * `ivan.petrov` is legitimate), `email` is validated as an email address
 * BEFORE any Keycloak call. Before this fix, `email: login` duplicated the
 * same string into both KC fields (T-0583 original), then T-0625 closed the
 * resulting 503 by forcing `login` itself to be email-shaped — narrower than
 * this task's own spec. `employee.email` (migration 127) stores the value
 * distinct from `employee.login` (migration 126, unaffected by this change —
 * the account list still shows `login`, not `email`).
 *
 * T-0741 fix (follow-up on T-0734 §5 out-of-scope finding): `display_name`
 * (already a required field on this form) is now ALSO passed to
 * kc.createHumanUser as `displayName`, which admin-port.ts splits into KC's
 * firstName/lastName. Without this, KC 25's declarative user profile (which
 * keeps firstName/lastName `required.roles:["user"]`, unmodified by T-0734)
 * leaves a UI-created account unable to obtain ANY login token — proven live:
 * a direct grant on such a user 400s `invalid_grant "Account is not fully set
 * up"` — until an interactive profile-update step is completed by hand. See
 * docs/design/T-0741-firstname-lastname.adr.md.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { KeycloakUserPort } from "../keycloak/admin-port.js";
import { ensureReaderRoleAndAssignHuman } from "../core/reader-grant.js";
import {
  loadAdminContext,
  resolveActorSlugFromAuth,
  humanEmployeeSlugExists,
} from "../db/org.js";
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

// ---------------------------------------------------------------------------
// T-0652 (§6.4 «backfill login»): map an employee DB row to the account list
// shape, choosing an HONEST `login` that never leaks a raw KC-UUID.
//
// Pre-migration-126 accounts have login=NULL. For a KC-backed human `slug` is
// the KC user UUID (identity-resolution invariant) — the old `login ?? slug`
// fallback surfaced that UUID as the account's "login" (the /users leak §6
// flagged). We fix it at the READ boundary (a pure-SQL migration can't reach
// Keycloak; a live-KC backfill would break CI):
//   • login present                 → use it (owner typed it, post-126).
//   • login NULL, slug NOT UUID      → use slug (dev-silo seed humans like
//                                      `e-kravtsova` have no KC login at all —
//                                      slug IS their only real label).
//   • login NULL, slug IS a KC UUID  → login=null + login_missing=true. The UI
//                                      shows «логин не задан», NEVER the UUID.
// Exported so the mapping is unit-testable without a live DB.
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  slug: string | null;
  login: string | null;
  display_name: string;
  position_title: string | null;
  department_name: string | null;
  deactivated_at: string | null;
}

export interface AccountView {
  employee_id: string;
  login: string | null;
  login_missing: boolean;
  display_name: string;
  position: string;
  department: string;
  active: boolean;
}

export function mapAccountRow(row: AccountRow): AccountView {
  const slugIsUuid = row.slug !== null && UUID_RE.test(row.slug);
  const login = row.login ?? (slugIsUuid ? null : row.slug);
  return {
    employee_id: row.id,
    login,
    login_missing: login === null,
    display_name: row.display_name,
    position: row.position_title ?? "",
    department: row.department_name ?? "",
    active: row.deactivated_at === null,
  };
}

/** KC port errors carry .code (LOGIN_TAKEN / EMAIL_TAKEN / EMAIL_INVALID / AUTH_UNAVAILABLE) — see admin-port.ts. */
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
// EMAIL_RE (T-0628 fix, follow-up on T-0625): T-0625 closed the 503-on-create
// bug by making `login` itself mandatory-email-shaped. T-0628's own LIVE_PROOF
// spec asks for a narrower fix: `login` stays FREE-FORM (an ordinary,
// non-email login like `ivan.petrov` is legitimate) and `email` becomes its
// OWN required field, validated on our side BEFORE any KC call — same "never
// let a bad value reach KC" property T-0625 established, just anchored on the
// right field. Passing a real KC realm a non-email `username` does not 400
// (config/keycloak/realm-choros.json sets no registrationEmailAsUsername/
// email-only constraint) — that requirement was this codebase's own choice,
// not a Keycloak constraint.
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCreateBody(b: Record<string, unknown>): {
  login: string;
  email: string;
  password: string;
  display_name: string;
  position_id: string | null;
  role_id: string | null;
} {
  const login = b["login"];
  if (typeof login !== "string" || login.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "login is required");
  }
  // SECURITY — case-fold normalization (T-0633 round-3 fix). Keycloak 25.0.6
  // LOWERCASES a username at creation (proven live against KC 25.0.6). If we
  // let a mixed-case `login` through unchanged, two forms diverge and the
  // anti-collision guard below is bypassable: `login='E-Configurator'` misses
  // the byte-exact guard query (no employee.slug == 'E-Configurator') so the
  // guard PASSES, but KC then stores username='e-configurator' → the token's
  // preferred_username='e-configurator' → the cross-tenant preferred_username→
  // slug fallback (resolveActorSlugFromAuth) resolves it to the SEED persona
  // 'e-configurator' (role-configurator authoring) — a vertical privilege
  // escalation for ANY seed kind='human' slug lacking a KC user at install.
  // We normalize ONCE here, at the single point where `login` is produced, so
  // the guard side (humanEmployeeSlugExists), the KC `username`, the stored
  // `employee.login` column, the response, and the audit ALL see the identical
  // lowercase form Keycloak will store — guard-side and token-side can no
  // longer diverge. Seed persona slugs (e-owner/e-configurator/e-orlov …) are
  // already lowercase, so the normalized login collides with them exactly.
  const trimmedLogin = login.trim().toLowerCase();
  const email = b["email"];
  if (typeof email !== "string" || email.trim().length === 0) {
    throw new HttpError(400, "VALIDATION", "email is required");
  }
  const trimmedEmail = email.trim();
  if (!EMAIL_RE.test(trimmedEmail)) {
    throw new HttpError(400, "VALIDATION", "email must be a valid email address (e.g. name@company.ru)");
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
  return {
    login: trimmedLogin,
    email: trimmedEmail,
    password,
    display_name: display_name.trim(),
    position_id,
    role_id,
  };
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
  // body: { tenant_id, login, email, password, display_name, position_id?, role_id? }
  // 201: { employee_id, login }  (password never in the response)
  // T-0628: login is free-form (need not be an email); email is a separate
  // required field, validated before any Keycloak call.
  // T-0633: 409 LOGIN_RESERVED if login collides with an existing HUMAN
  // employee slug in ANY tenant (anti-collision — blocks minting a KC user
  // whose preferred_username would resolve to a seeded persona like e-owner).
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

    const { login, email, password, display_name, position_id, role_id } = validateCreateBody(b);

    // SECURITY — anti-collision (T-0633, privilege-escalation fix). The chosen
    // `login` becomes the Keycloak username, which surfaces as the token's
    // `preferred_username`. Identity resolution (resolveActorSlugFromAuth)
    // resolves a token to an employee via a CROSS-TENANT preferred_username →
    // employee.slug fallback for seeded personas whose KC sub ≠ slug. Several
    // kind='human' seed personas exist as employees WITHOUT a Keycloak user at
    // install time — notably genesis 'e-owner' (16 delegable mgmt-grants +
    // tenant-owner, migrations/026) and 'e-configurator' (migrations/088) —
    // so Keycloak does NOT reject creating a user named 'e-owner'. Without this
    // guard, a holder of mgmt_object:employee:create (NOT the owner) could mint
    // a KC user login='e-owner', log in, miss sub-first, and be resolved to the
    // forest-owner via that fallback — a vertical privilege escalation.
    // Reject, cross-tenant, any login that collides with an existing HUMAN
    // employee slug BEFORE any Keycloak call (no side-effect, no orphan). The
    // check is cross-tenant precisely because the fallback it protects is
    // cross-tenant. 409 with a human reason — never the generic 503.
    //
    // `login` is already LOWERCASED here (validateCreateBody, T-0633 round-3):
    // that is what closes the case-collision bypass — the guard now checks the
    // SAME form Keycloak will store, so 'E-Configurator' can no longer slip
    // past a byte-exact query while KC lowercases it into a seed-persona slug.
    if (await humanEmployeeSlugExists(pool, login)) {
      throw new HttpError(
        409,
        "LOGIN_RESERVED",
        "this login is already in use — choose a different login",
      );
    }

    // KC-first (N4): create the KC user BEFORE any DB write. The plaintext
    // password is passed here and NOWHERE else — never logged, never audited,
    // never echoed in a response (N1).
    //
    // T-0628 fix: `login` (free-form, may be a non-email username) and
    // `email` (validated above, ALWAYS email-shaped) are now two DISTINCT
    // values passed to KC — before this fix, `email: login` duplicated the
    // same string into both fields, forcing login itself to be email-shaped
    // (T-0625's narrower fix) to avoid a KC 400/our 503.
    let kcUserId: string;
    try {
      const result = await kc.createHumanUser({
        username: login,
        email,
        password,
        actorType: "human",
        // T-0741 (follow-up on T-0734 §5): reuse the ALREADY-collected
        // display_name to derive KC firstName/lastName (admin-port.ts
        // splitDisplayName) — no second name field in the form, no second
        // typing pass. Closes the gap where a UI-created account without
        // firstName/lastName could not obtain ANY login token ("Account is
        // not fully set up") until the user manually filled an interactive
        // profile-update step.
        displayName: display_name,
      });
      kcUserId = result.userId;
    } catch (err) {
      const code = kcErrCode(err);
      if (code === "LOGIN_TAKEN") {
        // T-0633 round-3 (minor): a KC USERNAME conflict — the login, not the
        // email, is taken. Distinct human reason so the owner fixes the right
        // field. (The anti-collision guard above already rejects a login that
        // collides with a SEED slug; this covers a collision with a
        // previously-minted ordinary login, whose KC username uniqueness is the
        // relevant guard — see FF-633-4's note.)
        throw new HttpError(409, "LOGIN_TAKEN", "this login is already taken — choose a different login");
      }
      if (code === "EMAIL_TAKEN") {
        // T-0630: softened from "an account with that email already exists".
        // admin-port.ts's own comment admits EMAIL_TAKEN is the DEFAULT
        // mapping "when the body is absent/unparseable/ambiguous" — a login
        // clash can surface as this same code when Keycloak's 409 body does
        // not disambiguate. Naming only "email" here misdirects the owner
        // into fixing the wrong field when the real collision is the login.
        throw new HttpError(409, "EMAIL_TAKEN", "логин или email уже заняты — выберите другие значения");
      }
      // Defense-in-depth: validateCreateBody already rejects a non-email
      // `email` before this call, so a real KC realm should never 400 here in
      // this product's own flow. If it somehow does (KC-side validation
      // drift, e.g. Keycloak also rejecting a syntactically valid but
      // realm-disallowed address), surface it as an honest 400 — NOT the
      // generic 503 AUTH_UNAVAILABLE that masked the original T-0583 bug.
      if (code === "EMAIL_INVALID") {
        throw new HttpError(400, "VALIDATION", "email must be a valid email address (e.g. name@company.ru)");
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
        // the real login instead of this UUID. `email` (migration 127,
        // T-0628 fix) is its own column, distinct from login — the pair sent
        // to Keycloak above (username=login, email=email) is preserved here.
        await client.query(
          `INSERT INTO choros.employee
             (tenant_id, id, position_id, kind, slug, login, email, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, 'human', $4, $5, $6, $7, $8, $8)`,
          [tenant_id, employeeId, position_id, kcUserId, login, email, display_name, ts],
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
          payload: { login, email, display_name },
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
  //
  // T-0630 [security] fix — this route was missing the authority gate that
  // POST/PATCH below already carry: an authenticated-but-unauthorized tenant
  // member (no mgmt_object:employee grant, not owner) could list every
  // account in the tenant (login/name/position/department/active) with a
  // plain fetch (adversarial finding on T-0628). Gate: owner OR a covering,
  // delegable mgmt_object:employee grant — the SAME loadAdminContext +
  // assertOrgObjectAuthority seam PATCH uses just below (no new authority
  // path; loadAdminContext carries the T-0658 deactivated_at IS NULL
  // fail-closed predicate already).
  // -------------------------------------------------------------------------
  router.register("GET", "/api/users/accounts", withAuth(async (req, res) => {
    const actorId = await extractActor(req, pool);
    const tenantId = await resolveActorTenant(actorId);

    const admin = await loadAdminContext(pool, tenantId, actorId, nowMs());
    const oracle = await loadTenantOrgAncestry(pool, tenantId);
    assertOrgObjectAuthority(
      admin, "mgmt_object:employee", "read", tenantId, actorId, nowMs(),
      "owner or mgmt_object:employee grant required to read user accounts",
      oracle,
    );

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

    // T-0652 (§6.4 «backfill login»): map each row to the account view via the
    // pure, unit-tested mapAccountRow — it chooses an HONEST login that never
    // leaks a raw KC-UUID (login present → login; login NULL + human-readable
    // slug → slug; login NULL + UUID slug → null + login_missing=true, so the
    // UI shows «логин не задан», never the UUID). See mapAccountRow above.
    const accounts = rows.map(mapAccountRow);

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
    // tenant's employee_id resolves to zero rows here → 404 (N3). T-0727
    // (R-5, review of T-0702): also read `deactivated_at` here so the
    // IDEMPOTENT NO-OP short-circuit below can compare requested vs current
    // state without a second round-trip.
    const found = await withTenantTx(pool, tenantId, async (client) => {
      const { rows } = await client.query<{ slug: string; kind: string; deactivated_at: string | null }>(
        `SELECT slug, kind, deactivated_at FROM choros.employee WHERE tenant_id = $1 AND id = $2`,
        [tenantId, employeeId],
      );
      return rows[0] ?? null;
    });
    if (!found || found.kind !== "human") {
      throw new HttpError(404, "NOT_FOUND", "user account not found in your tenant");
    }
    const kcUserId = found.slug;

    // T-0727 (R-5, review of T-0702) — IDEMPOTENT NO-OP short-circuit. A
    // repeat PATCH whose `active` already matches the CURRENT state (a
    // client retry after a lost response, a double-click, or an automation
    // re-applying a desired state) must be a safe no-op: it must NOT
    // (a) re-run the LAST-OWNER guard against unrelated later role changes
    //     that could turn an already-completed deactivation into a spurious
    //     409 on retry,
    // (b) call Keycloak a second time for no reason, or
    // (c) write a SECOND user_account.deactivate/reactivate audit event —
    //     that would silently overwrite the ORIGINAL deactivated_at
    //     timestamp and pollute the audit trail with N events for one real
    //     transition (docs/design/ADR-T0727-deactivation-hygiene.md §3).
    // This does NOT short-circuit the recovery path named in that ADR
    // (setUserEnabled succeeded, the DB tx that follows it then failed,
    // leaving KC-disabled + choros-active/deactivated_at IS NULL): that
    // state reads as a REAL transition here (current !== requested) and
    // falls through to the full flow below, which completes it.
    const alreadyInTargetState = (found.deactivated_at === null) === active;
    if (alreadyInTargetState) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ employee_id: employeeId, active }));
      return;
    }

    // T-0658 (round 3) — LAST-OWNER GUARD. The T-0658 deactivation gate in
    // org.ts (isGenesisOwnerForTenant / loadAdminContext) makes a deactivated
    // owner resolve to isGenesisOwner=false. That correctly closes the security
    // hole, but introduces a SELF-LOCKOUT: reactivation goes through THIS route,
    // whose own authority gate is loadAdminContext (assertOrgObjectAuthority
    // above). If the LAST active tenant-owner is deactivated, no one is left who
    // can reactivate them (the owner themself is now isGenesisOwner=false, and
    // there is no other owner) — the tenant is bricked. Fail-CLOSED against the
    // IRREVERSIBLE action: refuse to deactivate the last active tenant-owner.
    // Only checked on deactivation (active === false); reactivation is always
    // allowed. Counts OTHER active owners (confirmed, in-window role_assignment
    // to role.slug='tenant-owner', employee.deactivated_at IS NULL) EXCLUDING
    // the target — if zero, the target is the last owner → 409.
    if (active === false) {
      const isLastOwner = await withTenantTx(pool, tenantId, async (client) => {
        // Is the TARGET currently an active tenant-owner?
        const { rows: targetOwnerRows } = await client.query<{ one: number }>(
          `SELECT 1 AS one
             FROM choros.role_assignment ra
             JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
            WHERE ra.tenant_id = $1
              AND ra.employee_id = $2
              AND r.slug = 'tenant-owner'
              AND ra.confirmed_by IS NOT NULL
              AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
              AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
            LIMIT 1`,
          [tenantId, employeeId, nowMs()],
        );
        if (targetOwnerRows.length === 0) return false; // target is not an owner — no guard needed

        // Are there any OTHER active (non-deactivated) tenant-owners?
        const { rows: otherOwnerRows } = await client.query<{ one: number }>(
          `SELECT 1 AS one
             FROM choros.role_assignment ra
             JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
             JOIN choros.employee e ON e.tenant_id = ra.tenant_id AND e.id = ra.employee_id
            WHERE ra.tenant_id = $1
              AND ra.employee_id <> $2
              AND r.slug = 'tenant-owner'
              AND ra.confirmed_by IS NOT NULL
              AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
              AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
              AND e.deactivated_at IS NULL
            LIMIT 1`,
          [tenantId, employeeId, nowMs()],
        );
        return otherOwnerRows.length === 0; // target IS an owner AND no other active owner → last owner
      });
      if (isLastOwner) {
        throw new HttpError(
          409,
          "LAST_OWNER",
          "нельзя деактивировать единственного владельца тенанта — сначала назначьте другого владельца",
        );
      }
    }

    // KC-first (N4): flip the KC login BEFORE touching the local marker. If KC
    // is unreachable, the local row stays untouched and the caller sees 503.
    try {
      await kc.setUserEnabled(kcUserId, active);
    } catch {
      throw new HttpError(503, "AUTH_UNAVAILABLE", "account service unavailable — try again later");
    }

    // T-0702 (ADR-T0702) — on DEACTIVATION only: best-effort WINDOW-SHRINK
    // (ADR §8). Kills the KC SSO session + refresh tokens, so the live
    // session cannot mint another access token (setUserEnabled(false) above
    // already blocks fresh logins). An ALREADY-ISSUED access-JWT is NOT
    // invalidated by this call — choros validates access tokens offline
    // against JWKS (src/http/auth.ts), so it stays accepted until its own
    // exp (~300s realm TTL, T-0658 §9's acknowledged remaining gap). The
    // guarantee is the PDP gate (T-0658/T-0662 ACTOR_ACTIVE_SQL), which
    // denies the deactivated actor regardless of this outcome. BEST-EFFORT:
    // revokeUserSessions never throws (ADR §2.2) — a transient KC hiccup on
    // THIS call must not fail the whole deactivation. The boolean outcome is
    // recorded in the audit event below so a failed revoke is observable,
    // not silently swallowed. Reactivation does NOT call this (ADR §2.3) —
    // a fresh login creates its own new session; there is nothing live to
    // revoke.
    let kcSessionsRevoked: boolean | null = null;
    if (active === false) {
      const { revoked } = await kc.revokeUserSessions(kcUserId);
      kcSessionsRevoked = revoked;
      // T-0727 (R-4, review of T-0702): a failed revoke used to be visible
      // ONLY as payload.kc_sessions_revoked:false on the audit event — an
      // operator watching logs (not diffing the audit trail) had NO signal
      // that KC was unreachable/degraded at the moment of deactivation.
      // console.warn is this repo's existing convention for a non-fatal,
      // best-effort degradation (no logger abstraction — see e.g.
      // src/http/inbox.ts "[inbox T-0458] ... reconcile failed (non-fatal)",
      // src/server/timer-firing-loop.ts "[timer-firing] ... (non-fatal)").
      // This stays a WARN, not a hard failure: the deactivation itself must
      // still succeed (best-effort per ADR-T0702 §2.2) — only visibility
      // changes here, not behavior.
      if (!revoked) {
        console.warn(
          `[user-mgmt T-0727] KC revokeUserSessions failed for employee ${employeeId} ` +
            `(kcUserId=${kcUserId}) — session window-shrink degraded for this ` +
            `deactivation (best-effort, ADR-T0702 §2.2); the PDP gate ` +
            `(T-0658/T-0662 ACTOR_ACTIVE_SQL) remains the actual authorization ` +
            `guarantee regardless of this outcome. Recorded as ` +
            `payload.kc_sessions_revoked:false on the audit event too.`,
        );
      }
    }

    const ts = nowMs();
    const writeResult = await withTenantTx(pool, tenantId, async (client) => {
      // T-0664 — ATOMIC LAST-OWNER GUARD. The early guard above (before the KC
      // flip) is a fast-fail, but it runs in its OWN, separate READ COMMITTED
      // transaction with no row lock. Two concurrent PATCH{active:false} on TWO
      // DIFFERENT active owners each ran that early guard, each saw "the OTHER
      // owner is still active" (neither write had landed yet), so BOTH passed —
      // then both reached this write and, before this fix, both UPDATEd,
      // leaving the tenant with ZERO active owners (the exact self-lockout the
      // guard exists to prevent — found in T-0658 round-3 verification).
      //
      // FIX: on the deactivation path, re-assert the last-owner invariant HERE,
      // in the SAME transaction as the deactivating write, UNDER a row lock.
      // `SELECT ... FOR UPDATE OF e` locks EVERY active tenant-owner employee
      // row for this tenant (ordered by e.id so concurrent deactivations lock
      // in the same order — no deadlock). Two concurrent owner-deactivations
      // therefore contend on the shared owner set and SERIALIZE: the second one
      // blocks until the first commits, then re-reads — the just-deactivated
      // owner drops out of the `e.deactivated_at IS NULL` set (READ COMMITTED
      // EPQ re-check), so the remaining target is correctly seen as the LAST
      // owner and refused. Result: at most one of any concurrent batch
      // succeeds; the tenant ALWAYS keeps ≥1 active owner.
      if (active === false) {
        // Lock the active-owner set for this tenant (serialize concurrent
        // owner deactivations on a shared, deterministically-ordered row set).
        await client.query(
          `SELECT e.id
             FROM choros.employee e
             JOIN choros.role_assignment ra ON ra.tenant_id = e.tenant_id AND ra.employee_id = e.id
             JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
            WHERE e.tenant_id = $1
              AND r.slug = 'tenant-owner'
              AND ra.confirmed_by IS NOT NULL
              AND (ra.valid_from  IS NULL OR ra.valid_from  <= $2)
              AND (ra.valid_until IS NULL OR ra.valid_until  > $2)
              AND e.deactivated_at IS NULL
            ORDER BY e.id
            FOR UPDATE OF e`,
          [tenantId, ts],
        );

        // Under the lock: is the TARGET still an active tenant-owner?
        const { rows: targetOwnerRows } = await client.query<{ one: number }>(
          `SELECT 1 AS one
             FROM choros.role_assignment ra
             JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
            WHERE ra.tenant_id = $1
              AND ra.employee_id = $2
              AND r.slug = 'tenant-owner'
              AND ra.confirmed_by IS NOT NULL
              AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
              AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
            LIMIT 1`,
          [tenantId, employeeId, ts],
        );
        if (targetOwnerRows.length > 0) {
          // Under the lock: is there any OTHER active (non-deactivated) owner?
          const { rows: otherOwnerRows } = await client.query<{ one: number }>(
            `SELECT 1 AS one
               FROM choros.role_assignment ra
               JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
               JOIN choros.employee e ON e.tenant_id = ra.tenant_id AND e.id = ra.employee_id
              WHERE ra.tenant_id = $1
                AND ra.employee_id <> $2
                AND r.slug = 'tenant-owner'
                AND ra.confirmed_by IS NOT NULL
                AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
                AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
                AND e.deactivated_at IS NULL
              LIMIT 1`,
            [tenantId, employeeId, ts],
          );
          if (otherOwnerRows.length === 0) {
            // Race lost: a concurrent deactivation removed the last OTHER owner
            // between our early guard and this locked re-check. Refuse WITHOUT
            // writing — leave deactivated_at untouched so the invariant holds.
            return { raceLostLastOwner: true as const };
          }
        }
      }

      // T-0727 (R-5) — the WHERE clause is guarded on the CURRENT state
      // (mirrors the pre-check above, but re-asserted at write time so a
      // narrow race — a concurrent PATCH landing between the read above and
      // this transaction — is caught here too, not only by the early
      // short-circuit). `RETURNING id` reports whether a real transition
      // happened; zero rows means someone else already applied the SAME
      // transition since the read above — the audit append below is then
      // skipped rather than writing a second event for one real change.
      const { rows: transitioned } = await client.query<{ id: string }>(
        active
          ? `UPDATE choros.employee
                SET deactivated_at = NULL, updated_at = $3
              WHERE tenant_id = $1 AND id = $2 AND deactivated_at IS NOT NULL
              RETURNING id`
          : `UPDATE choros.employee
                SET deactivated_at = $3, updated_at = $3
              WHERE tenant_id = $1 AND id = $2 AND deactivated_at IS NULL
              RETURNING id`,
        [tenantId, employeeId, ts],
      );
      if (transitioned.length === 0) {
        // Lost a narrow race against a concurrent identical PATCH — the
        // state is already correct; do not write a second audit event.
        return { raceLostLastOwner: false as const };
      }
      await userMgmtAuditWriter.appendAuditEvent(client as unknown as PgClientLike, {
        id: randomUUID(),
        type: active ? "user_account.reactivate" : "user_account.deactivate",
        actor: actorId,
        subject: employeeId,
        scope: null,
        via: null,
        proposed_by: null,
        confirmed_by: actorId,
        // T-0702: kc_sessions_revoked is present only on the deactivate path
        // (kcSessionsRevoked stays null on reactivate — ADR §2.3, no call made).
        payload: kcSessionsRevoked === null ? {} : { kc_sessions_revoked: kcSessionsRevoked },
        occurred_at: ts,
      });
      return { raceLostLastOwner: false as const };
    });

    if (writeResult.raceLostLastOwner) {
      // T-0664 — the atomic guard refused the deactivation (target became the
      // last owner while we were mid-flight). We had already optimistically
      // flipped the KC login to disabled (KC-first, N4) and revoked its
      // sessions BEFORE the lock could reveal this. COMPENSATE: re-enable the
      // KC login so a REFUSED deactivation leaves NO KC-disabled last owner —
      // otherwise the very lockout this guard prevents would happen at the KC
      // layer. The DB never marked them deactivated, so choros/PDP already
      // treats them as active; this only restores the KC login side. If
      // re-enable itself fails, the account stays PDP-active (DB authoritative)
      // and the KC login can be recovered by repeating a reactivate PATCH
      // (ADR-T0727 §3.2 recovery path) — so swallow rather than mask the 409.
      try {
        await kc.setUserEnabled(kcUserId, true);
      } catch {
        console.warn(
          `[user-mgmt T-0664] compensating KC re-enable failed for last-owner ` +
            `employee ${employeeId} (kcUserId=${kcUserId}) after a refused ` +
            `concurrent deactivation; account remains PDP-active (DB authoritative), ` +
            `KC login recoverable via a reactivate PATCH (ADR-T0727 §3.2).`,
        );
      }
      throw new HttpError(
        409,
        "LAST_OWNER",
        "нельзя деактивировать единственного владельца тенанта — сначала назначьте другого владельца",
      );
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ employee_id: employeeId, active }));
  }));
}
