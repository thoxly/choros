/**
 * src/core/register.ts — T-0342 (E14): Pure registration service.
 *
 * PURE: no http import. All IO behind injected interfaces (FF-5 / FF-HIRE-6).
 *
 * Exports:
 *   RegisterRequest   — validated input shape
 *   RegisterResponse  — success response shape
 *   registerTenant    — pure service: validate → KC-first → DB-tx → compensation
 *
 * Flow:
 *   1. Validate orgName/email/password (throw VALIDATION on failure)
 *   2. kc.createHumanUser (throw EMAIL_TAKEN / AUTH_UNAVAILABLE on failure)
 *   3. DB transaction: tenant(self-ref) + role(tenant-owner) + employee(slug=sub) + confirmed role_assignment
 *      + T-0373 (PD-7): assistant-agent employee + role-configurator + their role_assignments + authoring_draft grants
 *   4. On DB failure after KC create → best-effort kc.deleteUser (FF-2) then rethrow
 *
 * No new migrations: employee/role/role_assignment/tenant/grant tables exist (ADR §3).
 * resolveActorTenant/extractActor signatures UNCHANGED (FF-7).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { KeycloakUserPort } from "../keycloak/admin-port.js";

// ---------------------------------------------------------------------------
// Request / Response shapes (ADR §4 wire contract)
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  orgName: string;   // 1..120 chars, trimmed
  email: string;     // RFC-lite email
  password: string;  // ≥ 8 chars
}

export interface RegisterResponse {
  tenantId: string;    // UUID of the new tenant
  tenantSlug: string;  // URL-safe slug derived from orgName
  userId: string;      // KC user UUID (= employee.slug = future JWT sub)
  email: string;
}

// ---------------------------------------------------------------------------
// Deps shape (injected; no env reads in core)
// ---------------------------------------------------------------------------

export interface RegisterDeps {
  pool: pg.Pool;
  kc: KeycloakUserPort;
  nowMs(): number;
}

// ---------------------------------------------------------------------------
// Slug derivation — pure (ADR §4)
// ---------------------------------------------------------------------------

const SLUG_MAX = 80;

/**
 * Russian Cyrillic → latin transliteration map.
 * Applied before the [^a-z0-9-] filter so Cyrillic names produce readable slugs.
 * e.g. "Браузер Приёмка" → "brauzer-priyomka"
 */
const CYRILLIC_MAP: Record<string, string> = {
  а: "a",  б: "b",  в: "v",  г: "g",  д: "d",
  е: "e",  ё: "e",  ж: "zh", з: "z",  и: "i",
  й: "y",  к: "k",  л: "l",  м: "m",  н: "n",
  о: "o",  п: "p",  р: "r",  с: "s",  т: "t",
  у: "u",  ф: "f",  х: "h",  ц: "ts", ч: "ch",
  ш: "sh", щ: "sch", ъ: "",  ы: "y",  ь: "",
  э: "e",  ю: "yu", я: "ya",
};

/** Replace each Cyrillic character with its latin equivalent (lower-case input expected). */
function transliterateCyrillic(s: string): string {
  return s.replace(/[а-яё]/g, (ch) => CYRILLIC_MAP[ch] ?? ch);
}

/**
 * slugify(orgName) → transliterate Cyrillic → lower, [a-z0-9-], collapse dashes, truncate.
 * Consistent with deriveKcClientId pattern in agent-hire.ts.
 * "Браузер Приёмка" → "brauzer-priyomka"
 */
export function slugifyOrgName(orgName: string): string {
  const slug = transliterateCyrillic(orgName.toLowerCase())
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "org").slice(0, SLUG_MAX);
}

// ---------------------------------------------------------------------------
// Validation — pure, throws VALIDATION
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class RegisterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RegisterError";
  }
}

/**
 * ValidationError extends RegisterError so the HTTP route's `instanceof RegisterError`
 * guard catches it and emits 400 VALIDATION (ADR §4 / AC-9 / R-1 fix).
 */
class ValidationError extends RegisterError {
  constructor(message: string) {
    super("VALIDATION", message);
    this.name = "ValidationError";
  }
}

function validateRequest(req: RegisterRequest): void {
  const name = req.orgName?.trim();
  if (!name || name.length < 1 || name.length > 120) {
    throw new ValidationError("orgName must be 1–120 characters");
  }
  if (!req.email || !EMAIL_RE.test(req.email)) {
    throw new ValidationError("email must be a valid email address");
  }
  if (!req.password || req.password.length < 8) {
    throw new ValidationError("password must be at least 8 characters");
  }
}

// ---------------------------------------------------------------------------
// DB conflict helpers
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  return !!(err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505");
}

// ---------------------------------------------------------------------------
// registerTenant — the pure core service (ADR §2 / §4)
// ---------------------------------------------------------------------------

/**
 * Derive a slug candidate from a base slug + optional attempt index.
 * Attempt 0  → base slug (no suffix)
 * Attempt 1+ → base-<6-char base36 derived from a fresh randomUUID>
 * This keeps slugs pretty for the common case (first registrant of a name)
 * while guaranteeing uniqueness under concurrent same-name registrations.
 */
function slugCandidate(base: string, attempt: number): string {
  if (attempt === 0) return base;
  // Take the first 6 hex chars of a fresh UUID, convert to base36 for brevity
  const hex = randomUUID().replace(/-/g, "").slice(0, 8);
  const suffix = parseInt(hex, 16).toString(36).slice(0, 6);
  // Ensure total length stays within SLUG_MAX
  const trimmedBase = base.slice(0, SLUG_MAX - 7); // 7 = "-" + 6 chars
  return `${trimmedBase}-${suffix}`;
}

/** Maximum number of slug insert attempts before giving up with ORG_TAKEN. */
const SLUG_MAX_ATTEMPTS = 5;

/**
 * Registers a new tenant with owner membership.
 *
 * Sequence:
 *   1. Validate request
 *   2. Create KC user (KC-first, as per ADR §2 decision)
 *   3. DB transaction in the new tenant's scope:
 *      - INSERT tenant (self-ref: tenant_id = id) — retried on slug unique-violation
 *      - INSERT role (slug='tenant-owner')
 *      - INSERT employee (slug=kcSub, kind='human')
 *      - INSERT role_assignment (confirmed, org_scope=set([]))
 *   4. On any DB failure after KC create → kc.deleteUser (best-effort compensation FF-2) + rethrow
 *
 * Slug uniqueness: slug collisions (23505) are retried up to SLUG_MAX_ATTEMPTS times
 * with a random suffix (attempt 1+). Two orgs with the same display name BOTH succeed.
 */
export async function registerTenant(
  deps: RegisterDeps,
  req: RegisterRequest,
): Promise<RegisterResponse> {
  // Step 1: Validate
  validateRequest(req);
  const orgName = req.orgName.trim();
  const baseSlug = slugifyOrgName(orgName);

  // Step 2: KC-first — create human user
  let kcUserId: string;
  try {
    const result = await deps.kc.createHumanUser({
      username: req.email,
      email: req.email,
      password: req.password,
      actorType: "human",
    });
    kcUserId = result.userId;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as { code?: string }).code;
    if (code === "EMAIL_TAKEN") {
      throw new RegisterError("EMAIL_TAKEN", "An account with that email already exists");
    }
    throw new RegisterError("AUTH_UNAVAILABLE", "Registration service unavailable — try again later");
  }

  // Step 3: DB transaction in the new tenant's scope
  // Retry the entire transaction on slug unique-violation (23505) so that two
  // different companies sharing a display name can both register successfully.
  const tenantId = randomUUID();
  const roleId = randomUUID();
  const employeeId = randomUUID();
  const assignmentId = randomUUID();
  // T-0373 (PD-7): IDs for per-tenant assistant-agent + configurator role + grants
  const configuratorRoleId = randomUUID();
  const agentEmployeeId = randomUUID();
  const ownerRaConfiguratorId = randomUUID();
  const agentRaConfiguratorId = randomUUID();
  const grantCreateId = randomUUID();
  const grantUpdateId = randomUUID();
  // T-0475 [E-AGENTS L4]: capability grants on role-configurator — llm_connection:
  // configure + system_agent:operate (spec §6). Granting them to role-configurator
  // (which the owner holds via 3g) keeps the configurator the platform-admin role.
  const grantLlmConnConfigureId = randomUUID();
  const grantSystemAgentOperateId = randomUUID();
  // T-0469 [auth]: IDs for the role-constructor-admin role + its delegable
  // org-object grants. The role is SEEDED but NOT auto-assigned — the owner
  // grants it to whoever should be a constructor-admin (owner-rights MINUS
  // owner-deletion). See the seeding block below for the boundary rationale.
  const constructorAdminRoleId = randomUUID();
  const caGrantIds = {
    deptCreate: randomUUID(),
    deptUpdate: randomUUID(),
    deptDelete: randomUUID(),
    posCreate: randomUUID(),
    posUpdate: randomUUID(),
    posDelete: randomUUID(),
    empCreate: randomUUID(),
    empUpdate: randomUUID(),
    roleCreate: randomUUID(),
    roleUpdate: randomUUID(),
    roleDelete: randomUUID(),
  };
  const ts = deps.nowMs();

  let tenantSlug: string | undefined;

  for (let attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt++) {
    const candidateSlug = slugCandidate(baseSlug, attempt);

    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      // SET LOCAL sets the tenant GUC so RLS WITH CHECK passes for self-ref tenant row
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");

      // 3a. Insert tenant (self-referential: tenant_id = id, migration 013 pattern)
      try {
        await client.query(
          `INSERT INTO choros.tenant (tenant_id, id, slug, display_name, created_at)
           VALUES ($1, $1, $2, $3, $4)`,
          [tenantId, candidateSlug, orgName, ts],
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          await client.query("ROLLBACK");
          // slug collision — try next candidate (don't compensate yet: still have retries)
          if (attempt < SLUG_MAX_ATTEMPTS - 1) {
            continue;
          }
          // Exhausted retries — compensate and surface ORG_TAKEN
          await deps.kc.deleteUser(kcUserId);
          throw new RegisterError("ORG_TAKEN", `An organization with a similar name already exists`);
        }
        throw err;
      }

      // 3b. Insert role (slug='tenant-owner', per-tenant)
      await client.query(
        `INSERT INTO choros.role (tenant_id, id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, 'tenant-owner', 'Tenant Owner', $3, $3)`,
        [tenantId, roleId, ts],
      );

      // 3c. Insert employee (slug=kcSub, kind='human', position_id=NULL)
      await client.query(
        `INSERT INTO choros.employee (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'human', $4, NULL, $5, $5)`,
        [tenantId, employeeId, kcUserId, req.email, ts],
      );

      // 3d. Insert confirmed role_assignment (org_scope=set([]), confirmed_by=employeeId for self-bootstrap)
      await client.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope, granted_by, confirmed_by, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6, 'registration', $7, $7)`,
        [
          tenantId,
          assignmentId,
          employeeId,
          roleId,
          JSON.stringify({ kind: "set", members: [] }),
          employeeId,  // self-bootstrap: both granted_by and confirmed_by are the genesis owner employee
          ts,
        ],
      );

      // -----------------------------------------------------------------------
      // T-0373 (PD-7): Tenant-zero seeding — every new tenant gets:
      //   3e. role-configurator: the role that holds authoring_draft grants.
      //   3f. assistant-agent employee (kind='agent', slug='assistant-agent'): the
      //       agent side of the intersection check in assistant.ts. Without this row,
      //       getGrantsForSubject returns [] for the agent → intersection always empty.
      //   3g. role_assignment: owner (employeeId) → role-configurator (CONFIRMED).
      //   3h. role_assignment: assistant-agent → role-configurator (CONFIRMED).
      //   3i. grant: authoring_draft / create for role-configurator (CONFIRMED).
      //   3j. grant: authoring_draft / update for role-configurator (CONFIRMED).
      //
      // Idempotency: ON CONFLICT DO NOTHING on each INSERT (PK = (tenant_id, id)).
      // For a fresh tenant these IDs are newly generated → no conflict possible.
      // For existing seeded tenants (migration 088) with fixed UUIDs, this code
      // path is never reached (registerTenant only runs for new self-registrations).
      //
      // Scope: {"kind":"set","members":[]} = ⊥ (bottom). Per grant-lattice.ts:
      //   isNarrowerOrEqual(⊥, ⊥) → true (⊥ ⊑ anything).
      // hasAuthoringDraftGrant (assistant-configurator.ts:300) only checks
      // resourceType + operation on the intersection output — scope matching in
      // makeIntersectionGrantSource uses isNarrowerOrEqual(agentScope, userScope)
      // which returns true when agentScope = userScope = ⊥. So ⊥ scoped grants
      // correctly unlock the configurator for the intersection check while remaining
      // the least-authority scope possible.
      // -----------------------------------------------------------------------

      // 3e. Insert role-configurator (grants authoring_draft on this tenant)
      await client.query(
        `INSERT INTO choros.role
           (tenant_id, id, slug, display_name, created_at, updated_at)
         VALUES ($1, $2, 'role-configurator', 'Конфигуратор системы', $3, $3)
         ON CONFLICT DO NOTHING`,
        [tenantId, configuratorRoleId, ts],
      );

      // 3f. Insert assistant-agent employee (kind='agent', slug='assistant-agent')
      await client.query(
        `INSERT INTO choros.employee
           (tenant_id, id, slug, kind, display_name, position_id, created_at, updated_at)
         VALUES ($1, $2, 'assistant-agent', 'agent', 'Ассистент (AI-агент)', NULL, $3, $3)
         ON CONFLICT DO NOTHING`,
        [tenantId, agentEmployeeId, ts],
      );

      // 3g. role_assignment: owner → role-configurator (CONFIRMED, self-bootstrap)
      await client.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            granted_by, confirmed_by, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6, 'registration', $7, $7)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          ownerRaConfiguratorId,
          employeeId,
          configuratorRoleId,
          JSON.stringify({ kind: "set", members: [] }),
          employeeId,
          ts,
        ],
      );

      // 3h. role_assignment: assistant-agent → role-configurator (CONFIRMED)
      await client.query(
        `INSERT INTO choros.role_assignment
           (tenant_id, id, employee_id, role_id, org_scope,
            granted_by, confirmed_by, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6, 'registration', $7, $7)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          agentRaConfiguratorId,
          agentEmployeeId,
          configuratorRoleId,
          JSON.stringify({ kind: "set", members: [] }),
          employeeId,
          ts,
        ],
      );

      // 3i. grant: authoring_draft / create for role-configurator (CONFIRMED)
      await client.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
            "constraint", delegable, granted_by, proposed_by, confirmed_by,
            valid_from, valid_until, created_at)
         VALUES ($1, $2, $3, 'authoring_draft', NULL, 'create', $4::jsonb,
                 NULL, false, 'registration', NULL, 'registration',
                 NULL, NULL, $5)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          grantCreateId,
          configuratorRoleId,
          JSON.stringify({ kind: "set", members: [] }),
          ts,
        ],
      );

      // 3j. grant: authoring_draft / update for role-configurator (CONFIRMED)
      await client.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
            "constraint", delegable, granted_by, proposed_by, confirmed_by,
            valid_from, valid_until, created_at)
         VALUES ($1, $2, $3, 'authoring_draft', NULL, 'update', $4::jsonb,
                 NULL, false, 'registration', NULL, 'registration',
                 NULL, NULL, $5)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          grantUpdateId,
          configuratorRoleId,
          JSON.stringify({ kind: "set", members: [] }),
          ts,
        ],
      );

      // 3j-bis. T-0475 [E-AGENTS L4]: capability grants on role-configurator.
      //   llm_connection:configure → configure LLM connections + keys (spec §6).
      //   system_agent:operate     → configure/run a SYSTEM agent (spec §6, tied to
      //                              authoring_draft — seeded explicitly so the
      //                              capability exists in the lattice on its own).
      // CAPABILITY (not mgmt_object): delegable=false, ⊥-scope, resource_type carries
      // the capability token verbatim (free-text grant column). The owner holds these
      // via the 3g owner→role-configurator assignment (belt-and-suspenders with the
      // code owner-short-circuit); any human assigned role-configurator inherits them.
      await client.query(
        `INSERT INTO choros."grant"
           (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
            "constraint", delegable, granted_by, proposed_by, confirmed_by,
            valid_from, valid_until, created_at)
         VALUES
           ($1, $2, $4, 'llm_connection:configure', NULL, 'configure', $5::jsonb,
            NULL, false, 'registration', NULL, 'registration', NULL, NULL, $6),
           ($1, $3, $4, 'system_agent:operate', NULL, 'operate', $5::jsonb,
            NULL, false, 'registration', NULL, 'registration', NULL, NULL, $6)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          grantLlmConnConfigureId,
          grantSystemAgentOperateId,
          configuratorRoleId,
          JSON.stringify({ kind: "set", members: [] }),
          ts,
        ],
      );

      // -----------------------------------------------------------------------
      // T-0469 [auth]: Tenant-zero seeding of role-constructor-admin.
      //
      // role-constructor-admin = OWNER RIGHTS *MINUS* OWNER-DELETION. It carries
      // DELEGABLE mgmt_object grants that the seed-write.ts org routes honour
      // (assertOrgObjectAuthority), so a holder gets owner-like AUTHORING power
      // over departments / positions / employees / roles without being the
      // genesis owner.
      //
      // THE SECURITY BOUNDARY — what is DELIBERATELY ABSENT from this grant set:
      //   - NO mgmt_object:employee/delete grant. Employee DELETION is owner-only
      //     (DELETE /api/employees keeps a strict isGenesisOwner gate AND the grant
      //     set here cannot cover it even if a future refactor routed it through
      //     the delegation helper). A constructor-admin can hire/edit people but
      //     never remove one.
      //   - NO mgmt_object:grant grant. The role/assignment-minting authority is
      //     NOT delegated, so a constructor-admin can never mint a role_assignment
      //     (and seed-write never touches role_assignment at all), and therefore
      //     can never grant/replace/remove the tenant-owner. The owner stays the
      //     un-parented delegation root.
      //   - NO freeform scope. All grants are ⊥-scoped lattice elements.
      //
      // Scope ⊥ = {"kind":"set","members":[]}. isNarrowerOrEqual(⊥, ⊥) = true and
      // ⊥ ⊑ anything = true (grant-lattice.ts), so an assignment of this role
      // (org_scope ⊥, like the owner/configurator assignments) makes the synthetic
      // child (scope = adminOrgScope = ⊥) pass both the org-axis and resource-axis
      // gates of validateAdminDelegation. delegable=true is required for the
      // resource-axis covering check.
      //
      // The role is SEEDED-BUT-UNASSIGNED: registerTenant assigns it to nobody.
      // The owner confirms a role_assignment to make a real person a constructor-
      // admin (via the existing rights machinery), so no person silently gains
      // these rights on registration.
      //
      // Idempotency: ON CONFLICT DO NOTHING (fresh IDs → never conflicts on a new
      // tenant; safe no-op if the same path is re-run).
      // -----------------------------------------------------------------------

      // 3k. role-constructor-admin role row.
      await client.query(
        `INSERT INTO choros.role
           (tenant_id, id, slug, display_name, description, created_at, updated_at)
         VALUES ($1, $2, 'role-constructor-admin', 'Конструктор-администратор',
                 $3, $4, $4)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          constructorAdminRoleId,
          "Owner-like org authoring (departments/positions/employees/roles) MINUS " +
            "owner-deletion: no employee delete, no role_assignment/owner mutation.",
          ts,
        ],
      );

      // 3l. Delegable mgmt_object grants for role-constructor-admin.
      //     resource_type ∈ {department, position, employee, role}; operations
      //     create/update (+delete for dept/position/role). employee:delete and
      //     mgmt_object:grant are intentionally OMITTED (owner-only boundary).
      const caGrants: Array<{ id: string; rt: string; op: string }> = [
        { id: caGrantIds.deptCreate, rt: "mgmt_object:department", op: "create" },
        { id: caGrantIds.deptUpdate, rt: "mgmt_object:department", op: "update" },
        { id: caGrantIds.deptDelete, rt: "mgmt_object:department", op: "delete" },
        { id: caGrantIds.posCreate, rt: "mgmt_object:position", op: "create" },
        { id: caGrantIds.posUpdate, rt: "mgmt_object:position", op: "update" },
        { id: caGrantIds.posDelete, rt: "mgmt_object:position", op: "delete" },
        { id: caGrantIds.empCreate, rt: "mgmt_object:employee", op: "create" },
        { id: caGrantIds.empUpdate, rt: "mgmt_object:employee", op: "update" },
        { id: caGrantIds.roleCreate, rt: "mgmt_object:role", op: "create" },
        { id: caGrantIds.roleUpdate, rt: "mgmt_object:role", op: "update" },
        { id: caGrantIds.roleDelete, rt: "mgmt_object:role", op: "delete" },
      ];
      for (const g of caGrants) {
        await client.query(
          `INSERT INTO choros."grant"
             (tenant_id, id, role_id, resource_type, resource_facet, operation, scope,
              "constraint", delegable, granted_by, proposed_by, confirmed_by,
              valid_from, valid_until, created_at)
           VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb,
                   NULL, true, 'registration', NULL, 'registration',
                   NULL, NULL, $7)
           ON CONFLICT DO NOTHING`,
          [
            tenantId,
            g.id,
            constructorAdminRoleId,
            g.rt,
            g.op,
            JSON.stringify({ kind: "set", members: [] }),
            ts,
          ],
        );
      }

      await client.query("COMMIT");
      tenantSlug = candidateSlug;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      // Compensation: KC user was created but DB failed — delete KC user (FF-2)
      // Skip compensation if error is already a RegisterError (ORG_TAKEN already compensated above)
      if (!(err instanceof RegisterError)) {
        await deps.kc.deleteUser(kcUserId); // best-effort
      }
      throw err;
    } finally {
      client.release();
    }

    // Transaction committed — exit the retry loop
    break;
  }

  return {
    tenantId,
    tenantSlug: tenantSlug!,
    userId: kcUserId,
    email: req.email,
  };
}
