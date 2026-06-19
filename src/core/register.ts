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
 *   4. On DB failure after KC create → best-effort kc.deleteUser (FF-2) then rethrow
 *
 * No new migrations: employee/role/role_assignment/tenant tables exist (ADR §3).
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
 * slugify(orgName) → lower, [a-z0-9-], collapse dashes, truncate.
 * Consistent with deriveKcClientId pattern in agent-hire.ts.
 */
export function slugifyOrgName(orgName: string): string {
  const slug = orgName
    .toLowerCase()
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
 * Registers a new tenant with owner membership.
 *
 * Sequence:
 *   1. Validate request
 *   2. Create KC user (KC-first, as per ADR §2 decision)
 *   3. DB transaction in the new tenant's scope:
 *      - INSERT tenant (self-ref: tenant_id = id)
 *      - INSERT role (slug='tenant-owner')
 *      - INSERT employee (slug=kcSub, kind='human')
 *      - INSERT role_assignment (confirmed, org_scope=set([]))
 *   4. On any DB failure after KC create → kc.deleteUser (best-effort compensation FF-2) + rethrow
 */
export async function registerTenant(
  deps: RegisterDeps,
  req: RegisterRequest,
): Promise<RegisterResponse> {
  // Step 1: Validate
  validateRequest(req);
  const orgName = req.orgName.trim();
  const tenantSlug = slugifyOrgName(orgName);

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
  const tenantId = randomUUID();
  const roleId = randomUUID();
  const employeeId = randomUUID();
  const assignmentId = randomUUID();
  const ts = deps.nowMs();

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
        [tenantId, tenantSlug, orgName, ts],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        await client.query("ROLLBACK");
        // Compensate: delete the KC user we just created
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

    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    // Compensation: KC user was created but DB failed — delete KC user (FF-2)
    // Skip compensation if error is already a RegisterError (e.g. ORG_TAKEN already compensated above)
    if (!(err instanceof RegisterError)) {
      await deps.kc.deleteUser(kcUserId); // best-effort
    }
    throw err;
  } finally {
    client.release();
  }

  return {
    tenantId,
    tenantSlug,
    userId: kcUserId,
    email: req.email,
  };
}
