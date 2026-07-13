/**
 * src/db/org.ts
 *
 * DB access layer for org structure queries (T-0017 ADR §3.6) plus
 * the admin-context helpers introduced by T-0030 (write-path only).
 *
 * Exports:
 *   listOrgTree, findEmployeeById, listHumanEmployees   (T-0017)
 *   isGenesisOwnerForTenant, loadAdminContext           (T-0030)
 */
import pg from "pg";
import type { Grant, ScopeElement } from "../core/grant-lattice.js";
import type { AdminContext } from "../core/scoped-admin.js";
import { HttpError } from "../http/router.js";
// T-0662: single NAMED deactivation predicate. isGenesisOwnerForTenant and
// loadAdminContext (below) are authority resolvers B1/B2 — they carry
// ACTOR_ACTIVE_SQL in their inner actor slug→employee subqueries.
import { ACTOR_ACTIVE_SQL } from "./actor-authority-gate.js";
// T-0767: single NAMED assignment-active dual-control predicate (T-0605 ADR
// §2, canonical home src/db/grants-dao.ts). isGenesisOwnerForTenant and
// loadAdminContext resolve role_assignment activity the SAME way
// getRoleSlugsForActor/getGrantsForSubject do — see the T-0767 comment on
// each query below for why this was previously missing here.
// T-0768: single NAMED critical-grant classifier (T-0397 canonical, grants-
// dao.ts). loadAdminContext step 3 (below) resolves grant-row dual-control the
// SAME way getGrantsForSubject step 3 does — see the T-0768 comment there for
// why this predicate was previously missing entirely.
import { assignmentActiveDualControlPredicate, criticalGrantPredicate } from "./grants-dao.js";

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Types (mirrors ORG_SEED shape for backwards-compat with HTTP layer)
// ---------------------------------------------------------------------------

export type OrgPerson = {
  id: string;
  name: string;
  type: "human" | "agent";
  // T-0698 (P2 from T-0673's judge, D-064/anti-UUID, столп 4): true when the
  // employee row is soft-deactivated (migration 125, employee.deactivated_at).
  // A BOOLEAN, never the raw epoch-ms timestamp — mirrors the ONE existing
  // precedent for surfacing this signal to the browser, T-0648's
  // batchResolveActors/ResolvedActor.deactivated (src/db/actor-resolver.ts),
  // which already exposes exactly this boolean to any authenticated tenant
  // member via ActorChip on the audit/inbox/grant-trail screens. GET /api/org
  // is itself already broadly readable by any authenticated tenant member (no
  // mgmt_object:* gate — it powers PersonPicker/PersonCell for every record
  // screen), so this is not a new privacy tier, just the same boolean already
  // granted elsewhere reaching one more reader. Optional so ORG_SEED's
  // in-memory dev-no-db fallback (src/http/org.ts) — which has no deactivation
  // concept — remains a valid OrgPerson without carrying the field.
  deactivated?: boolean;
};

export type OrgPosition = {
  id: string;
  title: string;
  people: OrgPerson[];
};

export type OrgDepartment = {
  id: string;
  name: string;
  positions: OrgPosition[];
};

// ---------------------------------------------------------------------------
// Dev tenant UUID (matches migration 013 seed)
// ---------------------------------------------------------------------------

export const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Pool factory (lazy singleton keyed on DATABASE_URL)
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

export function getOrgPool(): pg.Pool {
  if (!_pool) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new Error("DATABASE_URL not set — cannot build org pool");
    }
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// UUID shape guard (defense-in-depth per T-0013 / T-0116 R-3 pattern)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Helper: run a query inside a tenant-scoped transaction (SET LOCAL)
// ---------------------------------------------------------------------------

async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL choros.tenant_id = '${tenantId}'`,
    );
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

// ---------------------------------------------------------------------------
// listOrgTree — returns the full org tree: department → position → people
// Response shape matches the ORG_SEED structure consumed by the web frontend.
// ---------------------------------------------------------------------------

export async function listOrgTree(
  pool: pg.Pool,
  tenantId: string,
): Promise<OrgDepartment[]> {
  return withTenant(pool, tenantId, async (client) => {
    // Fetch all departments (root only for now; no parent_id traversal needed
    // since the dev silo has flat root departments — tree traversal is an
    // autonomous improvement for T-0022 org-scope resolution).
    // T-0141: explicit WHERE tenant_id filter for BYPASSRLS pool connections.
    // The GUC-based RLS policy (department_tenant_isolation) only applies to
    // non-BYPASSRLS connections. choros_migrator is BYPASSRLS, so the explicit
    // WHERE clause is required to scope the result to the correct tenant.
    // This is additive — for non-BYPASSRLS connections it is redundant with RLS.
    const deptRows = await client.query<{
      id: string;
      slug: string;
      display_name: string;
    }>(
      `SELECT id, slug, display_name FROM choros.department WHERE tenant_id = $1 ORDER BY slug`,
      [tenantId],
    );

    const departments: OrgDepartment[] = [];

    for (const dept of deptRows.rows) {
      // Fetch positions for this department (tenant_id scoping for BYPASSRLS safety).
      const posRows = await client.query<{
        id: string;
        slug: string;
        title: string;
      }>(
        `SELECT id, slug, title FROM choros.position
         WHERE tenant_id = $1 AND department_id = $2
         ORDER BY slug`,
        [tenantId, dept.id],
      );

      const positions: OrgPosition[] = [];

      for (const pos of posRows.rows) {
        // Fetch employees for this position (tenant_id scoping for BYPASSRLS safety).
        // T-0698: additive `e.deactivated_at` column select — mirrors the T-0588
        // (BLOCK-3) precedent on findEmployeeById just below in this same file:
        // existing callers destructure only {id,slug,display_name,kind}, so this
        // widened row shape is backward-compat.
        const empRows = await client.query<{
          id: string;
          slug: string;
          display_name: string;
          kind: string;
          deactivated_at: string | null;
        }>(
          `SELECT id, slug, display_name, kind, deactivated_at FROM choros.employee
           WHERE tenant_id = $1 AND position_id = $2
           ORDER BY slug`,
          [tenantId, pos.id],
        );

        const people: OrgPerson[] = empRows.rows.map((e) => ({
          id: e.slug,
          name: e.display_name,
          type: e.kind as "human" | "agent",
          // T-0698: boolean only (never the raw deactivated_at timestamp) — see
          // the OrgPerson.deactivated doc comment above for why boolean.
          deactivated: e.deactivated_at != null,
        }));

        positions.push({
          id: pos.slug,
          title: pos.title,
          people,
        });
      }

      departments.push({
        id: dept.slug,
        name: dept.display_name,
        positions,
      });
    }

    return departments;
  });
}

// ---------------------------------------------------------------------------
// findEmployeeById — resolve employee by slug; returns position + department name
// Returns null if not found.
// ---------------------------------------------------------------------------

export async function findEmployeeById(
  pool: pg.Pool,
  tenantId: string,
  slug: string,
): Promise<(OrgPerson & { position: string; department: string; deactivatedAt: number | null }) | null> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      slug: string;
      display_name: string;
      kind: string;
      position_title: string;
      department_name: string;
      deactivated_at: string | null;
    }>(
      // T-0141: explicit WHERE tenant_id for BYPASSRLS pool connections.
      // T-0588 (BLOCK-3): additive `e.deactivated_at` column — existing callers
      // (process-projection.ts actorKind resolution, org.ts route) destructure
      // only the fields they use, so this widened return shape is backward-compat.
      `SELECT e.slug, e.display_name, e.kind,
              p.title AS position_title,
              d.display_name AS department_name,
              e.deactivated_at
         FROM choros.employee e
         LEFT JOIN choros.position p
               ON p.tenant_id = e.tenant_id AND p.id = e.position_id
         LEFT JOIN choros.department d
               ON d.tenant_id = p.tenant_id AND d.id = p.department_id
        WHERE e.tenant_id = $1 AND e.slug = $2`,
      [tenantId, slug],
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.slug,
      name: row.display_name,
      type: row.kind as "human" | "agent",
      position: row.position_title ?? "",
      department: row.department_name ?? "",
      // T-0588 (BLOCK-3): epoch-ms of deactivation, NULL = active (migration 125).
      deactivatedAt: row.deactivated_at != null ? Number(row.deactivated_at) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// listHumanEmployees — returns only kind='human' employees with position + department
// Used by GET /api/users (listSelectableUsers).
// ---------------------------------------------------------------------------

export async function listHumanEmployees(
  pool: pg.Pool,
  tenantId: string,
): Promise<Array<{ id: string; name: string; position: string; department: string }>> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      slug: string;
      display_name: string;
      position_title: string;
      department_name: string;
    }>(
      // T-0141: explicit WHERE tenant_id for BYPASSRLS pool connections.
      `SELECT e.slug, e.display_name,
              p.title AS position_title,
              d.display_name AS department_name
         FROM choros.employee e
         LEFT JOIN choros.position p
               ON p.tenant_id = e.tenant_id AND p.id = e.position_id
         LEFT JOIN choros.department d
               ON d.tenant_id = p.tenant_id AND d.id = p.department_id
        WHERE e.tenant_id = $1 AND e.kind = 'human'
        ORDER BY e.slug`,
      [tenantId],
    );

    return rows.map((row) => ({
      id: row.slug,
      name: row.display_name,
      position: row.position_title ?? "",
      department: row.department_name ?? "",
    }));
  });
}

// ---------------------------------------------------------------------------
// resolveActorTenant — T-0141: resolve tenant UUID from employee slug.
//
// Runs a BYPASSRLS query (same pattern as seed-write.ts:181-195 slug lookup)
// without setting the tenant GUC, so it can find the tenant before the GUC
// is known.
//
// T-0486 [SECURITY] — FAIL-CLOSED. This helper drives the per-request tenant
// scoping for ~25 routes. It used to fall back to DEV_TENANT_ID when the actor
// could not be resolved (unknown slug, or a DB error). That was a fail-OPEN
// default: a request whose identity does NOT map to any employee silently
// landed in the Dev Silo instead of being rejected — a cross-tenant correctness
// AND authz gap. Both unresolvable paths now THROW HttpError(403), which the
// router (src/http/router.ts) turns into an honest 403 envelope for every
// caller that awaits this (sync + async catch paths both covered) — no caller
// signature change required (FF-7), the Promise<string> contract is preserved.
//
// LEGITIMATE DEV-MODE IS UNCHANGED: in dev auth-mode a valid x-dev-user
// whose slug IS a known employee still resolves to that employee's real tenant
// exactly as before (the SELECT returns a row → first return below). Only the
// ERROR / UNKNOWN-actor path changed. There is no "dev bootstrap with no
// employees yet" case routed through this helper: dev-mode invoke pins
// DEV_TENANT_ID directly (invoke.ts::resolveInvokeTenant, not via this fn), and
// the pre-login tenant picker uses resolveTenantBySlug (a separate helper, left
// fail-open-to-dev on purpose). So nothing legitimate relied on the fallback.
// ---------------------------------------------------------------------------

export async function resolveActorTenant(
  pool: pg.Pool,
  actorSlug: string,
): Promise<string> {
  const demoSlug = process.env["DEMO_TENANT_SLUG"] ?? "showcase";
  let rows: Array<{ tenant_id: string }>;
  const client = await pool.connect();
  try {
    // Prefer the employee row belonging to the DEMO_TENANT_SLUG tenant (showcase).
    // ORDER BY: demo tenant first (CASE), then any other by recency.
    // This handles dev DB pollution (multiple tenants with the same employee slug
    // from test suites) without changing the BYPASSRLS query pattern.
    ({ rows } = await client.query<{ tenant_id: string }>(
      `SELECT e.tenant_id
         FROM choros.employee e
         JOIN choros.tenant t ON t.id = e.tenant_id
        WHERE e.slug = $1
        ORDER BY
          CASE WHEN t.slug = $2 THEN 0 ELSE 1 END,
          e.created_at DESC
        LIMIT 1`,
      [actorSlug, demoSlug],
    ));
  } catch (err) {
    // DB error (e.g. connection refused). FAIL-CLOSED: do NOT silently route the
    // caller into the Dev Silo. We cannot prove this identity belongs to any
    // tenant, so reject. (A genuine infra outage surfaces as a 403 here rather
    // than a cross-tenant leak — the honest, safe failure mode.)
    void err;
    throw new HttpError(
      403,
      "ACTOR_TENANT_UNRESOLVED",
      "could not resolve the caller's tenant",
    );
  } finally {
    client.release();
  }

  if (rows.length > 0 && rows[0].tenant_id) {
    return rows[0].tenant_id;
  }

  // Unknown actor: the slug matches no employee row in any tenant. FAIL-CLOSED —
  // previously this returned DEV_TENANT_ID, silently landing an unresolvable
  // identity in the Dev Silo. Reject instead.
  throw new HttpError(
    403,
    "ACTOR_TENANT_UNRESOLVED",
    "the caller's identity does not resolve to any tenant",
  );
}

// ---------------------------------------------------------------------------
// getTenantInfo — resolve a tenant id → its public descriptor (slug, display
// name, live member count). Used by GET /api/my-tenant so the SPA can (a) send
// the caller's REAL tenant as x-tenant-id instead of a hardcoded constant, and
// (b) label the sidebar with the actual company instead of a baked-in string.
//
// BYPASSRLS query (same pattern as resolveActorTenant): the caller id is only
// ever the caller's OWN resolved tenant, so cross-tenant reach is not exposed.
// ---------------------------------------------------------------------------

export interface TenantInfo {
  id: string;
  slug: string;
  displayName: string;
  memberCount: number;
}

export async function getTenantInfo(
  pool: pg.Pool,
  tenantId: string,
): Promise<TenantInfo | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      slug: string;
      display_name: string;
      member_count: string;
    }>(
      `SELECT t.id,
              t.slug,
              t.display_name,
              (SELECT count(*) FROM choros.employee e WHERE e.tenant_id = t.id) AS member_count
         FROM choros.tenant t
        WHERE t.id = $1
        LIMIT 1`,
      [tenantId],
    );
    if (rows.length === 0 || !rows[0]) return null;
    return {
      id: rows[0].id,
      slug: rows[0].slug,
      displayName: rows[0].display_name,
      memberCount: Number(rows[0].member_count),
    };
  } catch {
    return null;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// resolveActorSlugFromAuth — T-0371: resolve an authenticated request → the
// correct employee SLUG before that slug is used for tenant/grant resolution.
//
// THE BUG THIS FIXES (proven live, s39): in keycloak mode the JWT `sub` is the
// KC user UUID, NOT the employee slug. Self-registered users satisfy the T-0342
// invariant employee.slug == jwt.sub, but SEEDED personas (e-orlov, e-larina,
// e-configurator…) have human-readable slugs while their KC sub is a random
// UUID. Callers that key tenant/grant resolution on the raw sub therefore miss
// the employee row for seeded personas and fail-close (empty grants), even when
// the persona holds a perfectly valid CONFIRMED grant for its real slug.
//
// RESOLUTION (the T-0366 identity pattern: sub-first, preferred_username-fallback):
//   1. If an employee exists with slug == `sub` → return `sub` (registered-user
//      invariant; ALWAYS tried first and short-circuits).
//   2. Else if an employee exists with slug == `preferredUsername` → return
//      `preferredUsername` (seeded persona whose KC sub ≠ slug).
//   3. Else → return null (fail-closed; the caller must NOT silently fall through
//      to a UUID that resolveActorTenant would map to DEV_TENANT_ID).
//
// This is a BYPASSRLS cross-tenant EXISTENCE check on choros.employee.slug — it
// mirrors resolveActorTenant's query pattern exactly (no tenant GUC needed: the
// tenant is scoped afterwards by resolveActorTenant on the resolved slug). The
// slug existence test is cross-tenant by necessity (we don't yet know the tenant),
// but it only ever RETURNS A SLUG STRING — it confers no authority on its own.
//
// SECURITY — impersonation vector (preferred_username fallback) [T-0633]:
//   Could a principal present preferred_username = 'e-owner' and, because no
//   employee has slug == their-own-sub-UUID, fall through to the genesis
//   forest-owner employee and escalate to super-admin?  The fallback is
//   INTENTIONALLY minimal — a bare slug-existence lookup — and DOES NOT and
//   CANNOT distinguish a genuine seeded persona from a forged token bearing the
//   same preferred_username (both carry a random sub and the same username).
//   The resolver is therefore NOT the place that closes this vector; the
//   invariant that makes the fallback safe is enforced UPSTREAM, at the two
//   points where a Keycloak username can be minted:
//     - Self-registration (src/core/register.ts) and admin account creation
//       (POST /api/users, src/http/user-mgmt.ts) both REJECT any login/username
//       that collides with an existing HUMAN employee slug in ANY tenant
//       (assertLoginNotSeededSlug, keyed on humanEmployeeSlugExists below). No
//       app path can mint a KC user named 'e-owner'/'e-orlov'/'e-configurator'
//       — so no forged token with that preferred_username can be produced
//       through the product.
//     - The ONE principal that may legitimately present preferred_username
//       'e-owner' is the genuine genesis-owner KC user, which is provisioned
//       DELIBERATELY and OUT-OF-BAND by an operator during install (it is NOT
//       seeded by migrations and NOT mintable through any product route — see
//       T-0633.spec.md "kc_provision_note"). That is the sole intended holder
//       of a seeded-persona username, and the fallback resolves it correctly.
//   HISTORY / why this comment changed: the previous version asserted that
//   "Keycloak username uniqueness per realm" made a seeded-persona slug
//   un-mintable. That is FALSE for the seeded personas that lack a KC user at
//   install time — genesis 'e-owner' (migrations/026, 16 delegable mgmt-grants
//   + tenant-owner) and 'e-configurator' (migrations/088) are kind='human'
//   employees with NO row in config/keycloak/realm-choros.json. KC would NOT
//   409 on creating username='e-owner', so before T-0633 a holder of
//   mgmt_object:employee:create (NOT the owner) could mint that KC user, log
//   in, miss sub-first, and be resolved to the forest-owner via this fallback —
//   a vertical privilege escalation. The mint-time anti-collision guard closes
//   it at the source; this fallback is left un-narrowed BECAUSE narrowing it
//   (tenant-scope / allow-list / UUID-shape) would break the legitimate
//   genesis-owner login, which depends on exactly this preferred_username→slug
//   path (its sub is a random UUID ≠ its human-readable slug 'e-owner').
//   Net: the resolved slug maps to the real employee of the authenticated
//   principal precisely because no OTHER principal can obtain that username.
//   On ambiguity (neither lookup matches) we fail closed (null), never widen.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// humanEmployeeSlugExists [T-0633] — does ANY tenant have a kind='human'
// employee with this exact slug? Cross-tenant BYPASSRLS EXISTENCE check on
// choros.employee.slug (no tenant GUC needed — mirrors resolveActorTenant's
// query pattern; the tenant is scoped later on the resolved slug). Returns a
// boolean only; confers no authority on its own.
//
// This is THE single canonical query for "is this string already a human
// employee slug?", shared by two callers so the security property has ONE
// implementation, not two that can drift:
//   (1) resolveActorSlugFromAuth (identity resolution — the sub-first /
//       preferred_username fallback).
//   (2) the mint-time anti-collision guard (src/core/register.ts,
//       src/http/user-mgmt.ts) that rejects a login/username colliding with a
//       seeded persona's slug (e.g. 'e-owner') BEFORE creating the Keycloak
//       user — the upstream invariant that keeps the fallback in (1) safe.
//
// SECURITY — kind='human' restriction (T-0372): agents authenticate via their
// Keycloak client_id (service-account JWT), never via preferred_username.
// Restricting to kind='human' ensures a forged/stolen preferred_username can
// never resolve to a no-KC-user agent or seed slug (e.g. 'config-agent-seed').
// The anti-collision caller intentionally uses the SAME kind='human' filter:
// human logins collide with human slugs; agent slugs are a disjoint namespace
// gated separately (agent_card.kc_client_id).
//
// SECURITY — BYPASSRLS-POOL INVARIANT [T-0633 round-3, P1]: this query runs
// CROSS-TENANT with NO tenant GUC set (the tenant is unknown at identity time).
// It therefore REQUIRES a pool whose role can see choros.employee rows without
// a tenant GUC — i.e. a BYPASSRLS role (choros_migrator). Under the NOBYPASSRLS
// runtime role (choros_app) with no GUC, the employee-isolation RLS policy
// filters ALL rows out, so EXISTS returns false for EVERY slug — which SILENTLY
// turns BOTH callers into a no-op: (1) the anti-collision guard would stop
// rejecting a colliding 'e-owner' login (the T-0633 escalation re-opens), and
// (2) the identity resolver's preferred_username fallback returns null for
// legitimate seed personas (the genesis owner can no longer log in). The
// identity-resolution pool wired in server.ts MUST stay BYPASSRLS-class; do NOT
// point it at choros_app. .env.prod.example carries the operator warning and
// ci/checks/anti-collision-guard-rls-invariant.db.test.ts pins the behavior
// (guard SEES a seed slug under migrator, is BLIND under app).
// ---------------------------------------------------------------------------
export async function humanEmployeeSlugExists(
  pool: pg.Pool,
  slug: string,
): Promise<boolean> {
  if (!slug) return false;
  const client = await pool.connect();
  try {
    return await humanEmployeeSlugExistsOnClient(client, slug);
  } finally {
    client.release();
  }
}

async function humanEmployeeSlugExistsOnClient(
  client: pg.PoolClient,
  slug: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM choros.employee WHERE slug = $1 AND kind = 'human'
     ) AS exists`,
    [slug],
  );
  return rows.length > 0 && rows[0]!.exists === true;
}

export async function resolveActorSlugFromAuth(
  pool: pg.Pool,
  sub: string,
  preferredUsername: string | undefined,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    // 1. sub-first: registered-user invariant (slug == sub). Short-circuits so a
    //    registered user NEVER reaches the preferred_username fallback.
    if (sub && (await humanEmployeeSlugExistsOnClient(client, sub))) {
      return sub;
    }
    // 2. preferred_username fallback: seeded persona whose KC sub ≠ slug.
    //    Skipped when it equals sub (same lookup → same miss) or is empty.
    //    SAFE ONLY because the mint-time anti-collision guard (see
    //    humanEmployeeSlugExists doc) prevents any product path from creating a
    //    KC user whose username == a seeded persona slug — so no forged token
    //    with such a preferred_username can be produced. [T-0633]
    if (
      preferredUsername &&
      preferredUsername !== sub &&
      (await humanEmployeeSlugExistsOnClient(client, preferredUsername))
    ) {
      return preferredUsername;
    }
    // 3. fail-closed: do NOT fall through to a UUID that resolveActorTenant
    //    would silently map to DEV_TENANT_ID.
    return null;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// resolveAgentSlugFromAuth — T-0424 [SECURITY]: resolve an authenticated AGENT
// (Keycloak service-account) request → the correct agent employee SLUG, before
// that slug is used for tenant/grant resolution. The SEPARATE, disjoint sibling
// of resolveActorSlugFromAuth (the human bridge) — selected by the validated
// `actor_type` claim, NEVER called for human tokens (and a no-op if it were).
//
// T-0423 ADR §2.2. THE THREAT (T-0372) THAT KEEPS THIS A SECOND FUNCTION:
//   Agents authenticate via their Keycloak client_id (service-account JWT). The
//   human resolver is kind='human'-only precisely so a forged/stolen
//   preferred_username can never resolve to an agent slug (e.g. config-agent-seed,
//   which holds authoring_draft grants). Folding agents into it would reverse that
//   guard. Instead this path resolves ONLY kind='agent' employees, via the
//   authoritative hire-time binding agent_card.kc_client_id.
//
// MECHANISM (the convention is already wired end-to-end — no new credential,
// token system, or table; see ADR §1.4):
//   1. actorType must be 'agent' — a hard kind gate / defense-in-depth: this
//      resolver is a no-op (null) for anything but an agent claim.
//   2. Keycloak's default preferred_username for a service-account user is
//      "service-account-<clientId>". Strip the "service-account-" prefix to
//      recover the clientId (fail-closed if not so prefixed, or empty after).
//   3. <clientId> == agent_card.kc_client_id (text NOT NULL, populated by
//      agent-hire's deriveKcClientId and by the seed migrations). JOIN employee
//      ON kind='agent' → employee.slug.
//   4. Else → null (fail-closed; the caller MUST NOT fall through to a UUID that
//      resolveActorTenant would silently map to DEV_TENANT_ID).
//
// DISJOINTNESS (ADR §3): the JOIN's e.kind = 'agent' filter PLUS the agent_card
// FK — which can only reference a kind='agent' employee (032_agent_card.sql:57-63
// CHECK(employee_kind='agent') + composite FK into employee(tenant_id,id,kind))
// — make it STRUCTURALLY IMPOSSIBLE for this resolver to return a human slug.
// The human resolver stays kind='human'-only. The crossover set is empty.
//
// TENANT SCOPING (ADR §3.4): this is a BYPASSRLS cross-tenant lookup (no tenant
// GUC) because the tenant is unknown until the slug resolves — it mirrors
// resolveActorSlugFromAuth/resolveActorTenant. A Keycloak clientId is
// realm-global-unique (one realm cannot host two clients with the same clientId),
// so a given kc_client_id maps to exactly one agent across the platform; the
// returned slug then drives resolveActorTenant, binding the caller to that agent's
// OWN tenant, after which all invoke logic runs under that tenant's RLS GUC. The
// resolver only ever RETURNS A SLUG STRING — it confers no authority on its own
// (identity ⊥ rights; authorization remains the fail-closed invoke-grant check).
// ---------------------------------------------------------------------------

export async function resolveAgentSlugFromAuth(
  pool: pg.Pool,
  ctx: { sub: string; preferredUsername: string; actorType: "human" | "agent" },
): Promise<string | null> {
  // 1. Hard kind gate (defense-in-depth): never resolve a non-agent claim here.
  if (ctx.actorType !== "agent") return null;

  // 2. KC default: a service-account user's preferred_username is
  //    "service-account-<clientId>". Strip the prefix to recover the clientId.
  const PREFIX = "service-account-";
  if (
    typeof ctx.preferredUsername !== "string" ||
    !ctx.preferredUsername.startsWith(PREFIX)
  ) {
    return null; // fail-closed: not a service-account preferred_username
  }
  const kcClientId = ctx.preferredUsername.slice(PREFIX.length);
  if (!kcClientId) return null; // fail-closed: empty clientId

  // 3. Map kc_client_id → agent employee.slug. Cross-tenant BYPASSRLS (no tenant
  //    GUC; tenant is scoped afterwards by resolveActorTenant on the slug). The
  //    JOIN + e.kind='agent' + the agent_card FK guarantee an AGENT slug only.
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ slug: string }>(
      // T-0426 [SECURITY]: a global UNIQUE INDEX on agent_card(kc_client_id)
      // (migration 092) schema-backs the realm-global clientId invariant, so this
      // query matches AT MOST one row. The deterministic ORDER BY is belt-and-braces:
      // were a colliding row to exist (e.g. a future scheme regression that drops
      // the global UNIQUE), resolution stays STABLE/repeatable rather than random,
      // so the failure is detectable instead of an intermittent cross-tenant leak.
      `SELECT e.slug
         FROM choros.agent_card ac
         JOIN choros.employee e
           ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
        WHERE ac.kc_client_id = $1
          AND e.kind = 'agent'
        ORDER BY ac.tenant_id, ac.employee_id
        LIMIT 1`,
      [kcClientId],
    );
    // 4. null ⇒ caller throws 401 fail-closed (unknown / unprovisioned client).
    return rows.length > 0 ? rows[0]!.slug : null;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// resolveTenantBySlug — T-0141: resolve tenant UUID from tenant slug.
//
// Used for DEMO_TENANT_SLUG resolution in /api/users (pre-login picker).
// Falls back to DEV_TENANT_ID if slug not found or DB unavailable.
// ---------------------------------------------------------------------------

export async function resolveTenantBySlug(
  pool: pg.Pool,
  tenantSlug: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM choros.tenant WHERE slug = $1 LIMIT 1`,
      [tenantSlug],
    );
    if (rows.length > 0 && rows[0].id) {
      return rows[0].id;
    }
    return DEV_TENANT_ID;
  } catch {
    // DB error → safe fallback
    return DEV_TENANT_ID;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// isGenesisOwnerForTenant — T-0030 AC-15 / NF-3
//
// Returns true iff the actor holds the tenant-owner role via a confirmed,
// in-window role_assignment. isGenesisOwner is ALWAYS resolved from the DB
// — never assumed or derived from a JWT claim (NF-3).
//
// T-0658 [security/системный, столп 4] — the inner slug→employee subquery
// carries `AND deactivated_at IS NULL` (fail-closed). This is the OWNER/ADMIN
// authority path, a SECOND resolver PARALLEL to getGrantsForSubject
// (grants-dao.ts). Owner authority SHORT-CIRCUITS the grant PDP:
// capability-grants-dao.ts (canConfigureLlmConnection / canActorOperateSystemAgents)
// and validateAdminDelegation call THIS before ever consulting
// getGrantsForSubject. Deactivation (PATCH /api/users, T-0583) only sets
// employee.deactivated_at — it does NOT revoke the tenant-owner
// role_assignment — so without this predicate a DEACTIVATED owner with a
// still-live KC token (KC enabled:false blocks only NEW token issuance, not an
// already-issued one before its TTL) kept returning true here and retained
// full owner authority (seed-write employee/org mutation, LLM-key config,
// system-agent operation, mgmt_object delegation, SoD-admin). The grant-side
// gate (T-0658 getGrantsForSubject step 1) does NOT cover this path because
// the short-circuit runs first. Mirrors the same predicate already applied in
// grants-dao.ts findTenantOwnerSlug / findTenantOwnerEmployeeId.
//
// T-0767 [security/dual-control, столп 4] — the role_assignment activation
// check below carried ONLY `confirmed_by IS NOT NULL`, omitting the T-0605
// canonical disjunct `(confirmed2_by IS NOT NULL OR proposed_by IS NULL)` that
// getRoleSlugsForActor/getGrantsForSubject (grants-dao.ts) already enforce.
// Real but DORMANT (T-0764 audit: no live INSERT sets role_assignment.
// proposed_by non-null today) — a future assignment-level proposal/escalation
// feature would otherwise silently inherit an owner-authority hole (a
// proposed-but-not-second-confirmed tenant-owner grant would short-circuit
// full owner authority on ONE approver). Now sourced from the single named
// fragment (assignmentActiveDualControlPredicate, grants-dao.ts) — no bespoke
// re-derivation. NO-OP for every CURRENT production row: proposed_by is NULL
// on all live assignments, so the added disjunct is vacuously true for them
// (proven live in ci/checks/db/T-0767-owner-admin-assignment-dual-control.db.test.ts).
// ---------------------------------------------------------------------------

export async function isGenesisOwnerForTenant(
  pool: pg.Pool,
  tenantId: string,
  actorEmployeeId: string,
  nowMs: number,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT ra.id
         FROM choros.role_assignment ra
         JOIN choros.role r
              ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = $1
          AND ra.employee_id = (
                SELECT id FROM choros.employee
                 WHERE tenant_id = $1 AND slug = $2
                   AND ${ACTOR_ACTIVE_SQL} LIMIT 1
              )
          AND r.slug = 'tenant-owner'
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
          AND ${assignmentActiveDualControlPredicate("ra")}
        LIMIT 1`,
      [tenantId, actorEmployeeId, nowMs],
    );
    return rows.length > 0;
  });
}

// ---------------------------------------------------------------------------
// loadAdminContext — T-0030 FR-2
//
// Builds the AdminContext needed by validateAdminDelegation.
// Three-query sequence inside one withTenant call:
//   1. isGenesisOwner (inlined here — same tenant tx — NOT via
//      isGenesisOwnerForTenant, but the SAME predicate).
//   2. All confirmed, in-window role_assignment rows for the actor.
//   3. For each assignment, all confirmed, in-window, delegable=true grants
//      on the assigned role where resource_type starts with mgmt_object:.
//
// T-0658 [security/системный, столп 4] — the slug→employee subqueries in BOTH
// step 1 (owner-check) and step 2 (assignment-load) carry
// `AND deactivated_at IS NULL` (fail-closed). loadAdminContext is the admin
// authority resolver behind ~11 seed-write mgmt paths (assertOrgObjectAuthority
// in seed-write.ts / user-mgmt.ts / rights-intents.ts) and validateAdminDelegation
// — a SECOND authority path parallel to getGrantsForSubject. Without the gate a
// DEACTIVATED admin/owner with a live token kept both isGenesisOwner=true and
// their delegable mgmt_object:* grants. Same rationale as isGenesisOwnerForTenant
// above; kept in sync so no third path resolves a deactivated subject to
// authority.
//
// T-0767 [security/dual-control, столп 4] — BOTH step 1 (owner-check) and
// step 2 (assignment-load) below carried ONLY `confirmed_by IS NOT NULL` on
// role_assignment, omitting the T-0605 canonical disjunct
// `(confirmed2_by IS NOT NULL OR proposed_by IS NULL)`. Same dormant hole as
// isGenesisOwnerForTenant above (see its T-0767 comment) — now closed via the
// same named fragment (assignmentActiveDualControlPredicate, grants-dao.ts),
// keeping all three role_assignment-activity resolvers (this file's two +
// grants-dao.ts's two) on one source of truth. NO-OP for every current row
// (proposed_by always NULL in production today).
//
// T-0768 [security/dual-control P1, LIVE — from T-0767's review] — step 3
// (below) carried NO `confirmed_by`/`confirmed2_by` predicate AT ALL on the
// `grant` row (unlike step 1/2's role_assignment predicate, which at least had
// `confirmed_by IS NOT NULL` before T-0767). This is the T-0397 grant-ROW dual-
// control axis (distinct from T-0605's assignment-ROW axis above): a CRITICAL
// mgmt_object:* grant (criticalGrantPredicate — e.g. `mgmt_object:tier_promote`
// / `transition`, axis a) proposed via POST /api/grants lands SEMI-CONFIRMED
// (confirmed_by = first approver, confirmed2_by = NULL — grants.ts's
// escalating-path INSERT) — by the T-0397 contract this grant is NOT yet PDP-
// active. getGrantsForSubject step 3 (grants-dao.ts) already enforces this
// correctly:
//   confirmed_by IS NOT NULL
//   AND (NOT <criticalGrantPredicate> OR confirmed2_by IS NOT NULL)
// but loadAdminContext step 3 skipped it entirely, so a semi-confirmed critical
// mgmt_object grant reached adminGrants and every consumer that trusts it
// (artifacts.ts tier-promote gate, secret-handle.ts, llm-config.ts, seed-
// write.ts, agents.ts, user-mgmt.ts, rights-intents.ts — the ~11 mgmt paths
// behind assertOrgObjectAuthority/validateAdminDelegation) authorized on ONE
// confirmation instead of the required two — a LIVE single-confirmation
// dual-control bypass, reachable end-to-end via /api/grants propose. REAL (not
// dormant): the write path (grants.ts escalating branch) sets exactly this
// shape today for any critical mgmt_object grant.
//
// Fix mirrors the T-0675 precedent (report-page-render.ts's application/read
// gate) EXACTLY: reuse `criticalGrantPredicate("g")` — the SAME exported
// classifier grants-dao.ts interpolates into its own canonical grant read — not
// a bespoke re-derivation of the four escalation axes. Non-critical delegable
// mgmt_object grants (confirmed_by set, confirmed2_by irrelevant) are
// unaffected: `NOT criticalGrantPredicate` is TRUE for them, so the OR
// short-circuits and confirmed2_by is never required — matches every existing
// non-critical admin grant (e.g. T-0658/T-0767's `mgmt_object:employee`/
// `update` fixture) unchanged.
// ---------------------------------------------------------------------------

export async function loadAdminContext(
  pool: pg.Pool,
  tenantId: string,
  actorEmployeeId: string,
  nowMs: number,
): Promise<AdminContext> {
  return withTenant(pool, tenantId, async (client) => {
    // Step 1: resolve isGenesisOwner from DB (AC-15 / NF-3).
    const { rows: ownerRows } = await client.query<{ id: string }>(
      `SELECT ra.id
         FROM choros.role_assignment ra
         JOIN choros.role r
              ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = $1
          AND ra.employee_id = (
                SELECT id FROM choros.employee
                 WHERE tenant_id = $1 AND slug = $2
                   AND ${ACTOR_ACTIVE_SQL} LIMIT 1
              )
          AND r.slug = 'tenant-owner'
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
          AND ${assignmentActiveDualControlPredicate("ra")}
        LIMIT 1`,
      [tenantId, actorEmployeeId, nowMs],
    );
    const isGenesisOwner = ownerRows.length > 0;

    // Step 2: load confirmed, in-window assignments for the actor.
    const { rows: raRows } = await client.query<{
      id: string;
      role_id: string;
      org_scope: unknown;
    }>(
      `SELECT ra.id, ra.role_id, ra.org_scope
         FROM choros.role_assignment ra
        WHERE ra.tenant_id = $1
          AND ra.employee_id = (
                SELECT id FROM choros.employee
                 WHERE tenant_id = $1 AND slug = $2
                   AND ${ACTOR_ACTIVE_SQL} LIMIT 1
              )
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
          AND ${assignmentActiveDualControlPredicate("ra")}`,
      [tenantId, actorEmployeeId, nowMs],
    );

    // Step 3: for each assignment, load delegable mgmt_object:* grants on its role.
    const adminGrantsList: Grant[] = [];
    for (const ra of raRows) {
      const { rows: grantRows } = await client.query<{
        id: string;
        role_id: string;
        resource_type: string;
        resource_facet: unknown;
        operation: string;
        scope: unknown;
        constraint: unknown;
        delegable: boolean;
        granted_by: string;
        valid_from: string | null;
        valid_until: string | null;
        created_at: string;
      }>(
        `SELECT g.id, g.role_id, g.resource_type, g.resource_facet,
                g.operation, g.scope, g."constraint", g.delegable,
                g.granted_by, g.valid_from, g.valid_until, g.created_at
           FROM choros."grant" g
          WHERE g.tenant_id = $1
            AND g.role_id = $2
            AND g.resource_type LIKE 'mgmt_object:%'
            AND g.delegable = true
            AND (g.valid_from  IS NULL OR g.valid_from  <= $3)
            AND (g.valid_until IS NULL OR g.valid_until  > $3)
            AND g.confirmed_by IS NOT NULL
            AND (
                  NOT ${criticalGrantPredicate("g")}
                  OR g.confirmed2_by IS NOT NULL
                )`,
        [tenantId, ra.role_id, nowMs],
      );

      for (const g of grantRows) {
        adminGrantsList.push({
          tenantId,
          id: g.id,
          roleId: g.role_id,
          resourceType: g.resource_type as Grant["resourceType"],
          resourceFacet: g.resource_facet ?? undefined,
          operation: g.operation as Grant["operation"],
          scope: g.scope as Grant["scope"],
          constraint: g.constraint ?? undefined,
          delegable: g.delegable,
          grantedBy: g.granted_by,
          validFrom: g.valid_from != null ? Number(g.valid_from) : undefined,
          validUntil: g.valid_until != null ? Number(g.valid_until) : undefined,
          createdAt: Number(g.created_at),
        });
      }
    }

    // Construct adminOrgScope: union of assignment org_scope values.
    // Single assignment → use its org_scope directly.
    // Multiple assignments → wrap in a set (the lattice supports sets of atoms).
    let adminOrgScope: ScopeElement;
    if (raRows.length === 0) {
      // No assignments → bottom (empty set = no org authority).
      adminOrgScope = { kind: "set", members: [] };
    } else if (raRows.length === 1) {
      adminOrgScope = raRows[0].org_scope as ScopeElement;
    } else {
      // Collect all unique members; if any member is already a set, flatten it.
      const members: Array<Exclude<ScopeElement, { kind: "set" }>> = [];
      for (const ra of raRows) {
        const s = ra.org_scope as ScopeElement;
        if (s.kind === "set") {
          for (const m of s.members) {
            members.push(m);
          }
        } else {
          members.push(s as Exclude<ScopeElement, { kind: "set" }>);
        }
      }
      adminOrgScope = { kind: "set", members };
    }

    return { isGenesisOwner, adminGrants: adminGrantsList, adminOrgScope };
  });
}
