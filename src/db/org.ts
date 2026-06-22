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

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Types (mirrors ORG_SEED shape for backwards-compat with HTTP layer)
// ---------------------------------------------------------------------------

export type OrgPerson = {
  id: string;
  name: string;
  type: "human" | "agent";
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
        const empRows = await client.query<{
          id: string;
          slug: string;
          display_name: string;
          kind: string;
        }>(
          `SELECT id, slug, display_name, kind FROM choros.employee
           WHERE tenant_id = $1 AND position_id = $2
           ORDER BY slug`,
          [tenantId, pos.id],
        );

        const people: OrgPerson[] = empRows.rows.map((e) => ({
          id: e.slug,
          name: e.display_name,
          type: e.kind as "human" | "agent",
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
): Promise<(OrgPerson & { position: string; department: string }) | null> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      slug: string;
      display_name: string;
      kind: string;
      position_title: string;
      department_name: string;
    }>(
      // T-0141: explicit WHERE tenant_id for BYPASSRLS pool connections.
      `SELECT e.slug, e.display_name, e.kind,
              p.title AS position_title,
              d.display_name AS department_name
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
// is known. Falls back to DEV_TENANT_ID if slug not found or DB unavailable.
// ---------------------------------------------------------------------------

export async function resolveActorTenant(
  pool: pg.Pool,
  actorSlug: string,
): Promise<string> {
  const demoSlug = process.env["DEMO_TENANT_SLUG"] ?? "showcase";
  const client = await pool.connect();
  try {
    // Prefer the employee row belonging to the DEMO_TENANT_SLUG tenant (showcase).
    // ORDER BY: demo tenant first (CASE), then DEV_TENANT_ID second, then any other.
    // This handles dev DB pollution (multiple tenants with the same employee slug
    // from test suites) without changing the BYPASSRLS query pattern.
    const { rows } = await client.query<{ tenant_id: string }>(
      `SELECT e.tenant_id
         FROM choros.employee e
         JOIN choros.tenant t ON t.id = e.tenant_id
        WHERE e.slug = $1
        ORDER BY
          CASE WHEN t.slug = $2 THEN 0 ELSE 1 END,
          e.created_at DESC
        LIMIT 1`,
      [actorSlug, demoSlug],
    );
    if (rows.length > 0 && rows[0].tenant_id) {
      return rows[0].tenant_id;
    }
    return DEV_TENANT_ID;
  } catch {
    // DB error (e.g. connection refused) → safe fallback
    return DEV_TENANT_ID;
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
// SECURITY — impersonation vector (preferred_username fallback):
//   Could a self-registered user set preferred_username = 'e-orlov' and, because
//   no employee has slug == their-own-sub-UUID, fall through to the e-orlov
//   employee and impersonate a seeded persona?  NO:
//     - The `sub` lookup is ALWAYS performed first and short-circuits. A
//       registered user satisfies slug == sub (T-0342), so the fallback is never
//       reached for them — they can only ever resolve to THEIR OWN employee.
//     - The fallback only activates when slug == sub matches NO employee. For a
//       legitimately registered user that never happens (their employee row has
//       slug == sub). So the fallback path is reachable only for a token whose
//       sub matches no employee at all.
//     - `preferred_username` defaults to the Keycloak username, and Keycloak
//       enforces USERNAME UNIQUENESS PER REALM. The seeded personas (e-orlov,
//       e-larina, …, e-configurator) ARE provisioned as KC users with those exact
//       usernames, so a second user CANNOT register/claim username 'e-orlov'.
//       Therefore an attacker cannot mint a token whose preferred_username is a
//       seeded persona's slug — KC would reject the duplicate username at
//       registration. The only principal that can present preferred_username
//       'e-orlov' is the genuine e-orlov KC user.
//   Net: the resolved slug always maps to the real employee owned by the
//   authenticated principal. On ambiguity (neither lookup matches) we fail closed
//   (null) rather than widen authority.
// ---------------------------------------------------------------------------

export async function resolveActorSlugFromAuth(
  pool: pg.Pool,
  sub: string,
  preferredUsername: string | undefined,
): Promise<string | null> {
  // Existence check helper: does ANY tenant have a HUMAN employee with this slug?
  // Cross-tenant BYPASSRLS — mirrors resolveActorTenant (no tenant GUC; the
  // tenant is scoped later by resolveActorTenant on the returned slug).
  //
  // SECURITY — kind='human' restriction (T-0372):
  //   Agents authenticate via their Keycloak client_id (service-account JWT), never
  //   via preferred_username. Restricting to kind='human' ensures that a forged or
  //   stolen preferred_username can never resolve to a no-KC-user agent or seed slug
  //   (e.g. 'config-agent-seed', which holds authoring_draft grants). All registered
  //   users (T-0342 invariant: slug == sub) and seeded human personas (e-orlov,
  //   e-larina, e-configurator…) are kind='human', so this restriction is non-breaking
  //   for the existing population while closing the agent-impersonation vector.
  async function employeeSlugExists(
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

  const client = await pool.connect();
  try {
    // 1. sub-first: registered-user invariant (slug == sub). Short-circuits so a
    //    registered user NEVER reaches the preferred_username fallback.
    if (sub && (await employeeSlugExists(client, sub))) {
      return sub;
    }
    // 2. preferred_username fallback: seeded persona whose KC sub ≠ slug.
    //    Skipped when it equals sub (same lookup → same miss) or is empty.
    if (
      preferredUsername &&
      preferredUsername !== sub &&
      (await employeeSlugExists(client, preferredUsername))
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
                 WHERE tenant_id = $1 AND slug = $2 LIMIT 1
              )
          AND r.slug = 'tenant-owner'
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
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
//   1. isGenesisOwner (via isGenesisOwnerForTenant helper, re-using the
//      already-acquired client to stay in the same transaction scope).
//   2. All confirmed, in-window role_assignment rows for the actor.
//   3. For each assignment, all confirmed, in-window, delegable=true grants
//      on the assigned role where resource_type starts with mgmt_object:.
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
                 WHERE tenant_id = $1 AND slug = $2 LIMIT 1
              )
          AND r.slug = 'tenant-owner'
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)
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
                 WHERE tenant_id = $1 AND slug = $2 LIMIT 1
              )
          AND ra.confirmed_by IS NOT NULL
          AND (ra.valid_from  IS NULL OR ra.valid_from  <= $3)
          AND (ra.valid_until IS NULL OR ra.valid_until  > $3)`,
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
            AND (g.valid_until IS NULL OR g.valid_until  > $3)`,
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
