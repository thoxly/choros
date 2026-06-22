/**
 * src/db/sod-dao.ts — T-0386 [D6]: Postgres DAO implementing SodSource (T-0053)
 *
 * Provides:
 *   PgSodSource — implements SodSource (sod.ts) for the grant-resolver step 3.6.
 *   PgSodConstraintDao — CRUD helpers for sod_constraint rows, used by the
 *     write-endpoint (rights-sod-admin.ts). NOT part of the SodSource interface.
 *
 * SodSource contract (from src/core/sod.ts):
 *   constraintsFor(ref)             — active sod_constraint rows for the tenant
 *                                     whose scope MAY cover the object. The scope
 *                                     containment test is applied by the pure sod.ts
 *                                     logic; this DAO returns ALL tenant constraints
 *                                     (the AncestryOracle pruning is sod.ts's job).
 *   effectiveAssignmentsOf(slug)    — confirmed, in-window role_assignment rows for
 *                                     the principal; effectiveness = confirmed_by IS
 *                                     NOT NULL AND validity window contains nowMs.
 *   reader                          — ActorEventReader over actor_event (dynamic SoD).
 *   writer                          — ActorEventWriter (append on a PASS).
 *
 * Tenant isolation: every query runs inside a tenant-scoped transaction
 *   BEGIN; SET LOCAL choros.tenant_id = '<uuid>'; SET LOCAL search_path TO choros;
 * plus RLS (ENABLE + FORCE on both tables). The tenant_id is UUID-validated
 * before interpolation (mirrors org.ts assertUuid — defence-in-depth, T-0116 R-3).
 *
 * PgSodConstraintDao CRUD helpers are standalone (no SodSource coupling). They
 * accept a pg.Pool + tenantId and expose createConstraint / updateConstraint /
 * deleteConstraint — used by the admin write-API.
 *
 * Rule-9: does NOT touch src/http/rights-sod.ts, src/core/sod.ts,
 * src/core/grant-resolver.ts, src/db/grants-dao.ts, or any migration.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  SodSource,
  SodConstraint,
  EffectiveAssignment,
} from "../core/sod.js";
import type {
  ActorEventReader,
  ActorEventWriter,
  ActorEventInput,
  ActorEventObjectRef,
  ActorEventRow,
  ActorEventVerb,
  AppendedActorEvent,
} from "../core/actor-event.js";
import { VOCAB_VERSION } from "../core/actor-event.js";

// ---------------------------------------------------------------------------
// UUID shape guard (mirrors org.ts — defence-in-depth, T-0116 R-3)
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(
      `${label} must be a valid UUID, got: ${JSON.stringify(value)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// withTenantTx — tenant-scoped read/write transaction
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
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

// ---------------------------------------------------------------------------
// PgActorEventReader — ActorEventReader over actor_event (dynamic SoD substrate)
// ---------------------------------------------------------------------------

function makeObjectClause(ref: ActorEventObjectRef): {
  clause: string;
  params: unknown[];
  baseIndex: number;
} {
  // Returns a WHERE fragment matching the object ref. Parameterised from $2.
  switch (ref.objectKind) {
    case "application":
      return {
        clause: "object_kind = 'application' AND application_id = $2",
        params: [ref.applicationId],
        baseIndex: 2,
      };
    case "registry":
      return {
        clause: "object_kind = 'registry' AND registry_id = $2",
        params: [ref.registryId],
        baseIndex: 2,
      };
    case "record":
      return {
        clause: "object_kind = 'record' AND record_id = $2",
        params: [ref.recordId],
        baseIndex: 2,
      };
  }
}

class PgActorEventReader implements ActorEventReader {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
  ) {}

  async trail(ref: ActorEventObjectRef): Promise<ActorEventRow[]> {
    const { clause, params } = makeObjectClause(ref);
    return withTenantTx(this.pool, this.tenantId, async (client) => {
      const { rows } = await client.query<{
        tenant_id: string;
        seq: string;
        id: string;
        object_kind: string;
        application_id: string | null;
        registry_id: string | null;
        record_id: string | null;
        actor: string;
        on_behalf_of: string | null;
        role_at_event: string;
        event: string;
        approve_level: number | null;
        detail: Record<string, unknown> | null;
        ts: string;
        vocab_version: number;
      }>(
        `SELECT tenant_id, seq, id, object_kind,
                application_id, registry_id, record_id,
                actor, on_behalf_of, role_at_event, event,
                approve_level, detail, ts, vocab_version
           FROM choros.actor_event
          WHERE tenant_id = $1 AND ${clause}
          ORDER BY seq ASC`,
        [this.tenantId, ...params],
      );
      return rows.map((r) => ({
        tenantId: r.tenant_id,
        seq: parseInt(r.seq, 10),
        id: r.id,
        objectKind: r.object_kind as ActorEventRow["objectKind"],
        applicationId: r.application_id,
        registryId: r.registry_id,
        recordId: r.record_id,
        actor: r.actor,
        onBehalfOf: r.on_behalf_of,
        roleAtEvent: r.role_at_event,
        event: r.event as ActorEventVerb,
        approveLevel: r.approve_level,
        detail: r.detail,
        ts: parseInt(r.ts, 10),
        vocabVersion: r.vocab_version,
      }));
    });
  }

  async didPrincipalPerform(
    ref: ActorEventObjectRef,
    event: ActorEventVerb,
    principal: string,
  ): Promise<boolean> {
    const { clause, params } = makeObjectClause(ref);
    return withTenantTx(this.pool, this.tenantId, async (client) => {
      const nextIdx = 2 + params.length;
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM choros.actor_event
            WHERE tenant_id = $1
              AND ${clause}
              AND event = $${nextIdx}
              AND COALESCE(on_behalf_of, actor)::text = $${nextIdx + 1}
         ) AS exists`,
        [this.tenantId, ...params, event, principal],
      );
      return rows[0]?.exists ?? false;
    });
  }

  async rolesThatActed(
    ref: ActorEventObjectRef,
    events?: ActorEventVerb[],
  ): Promise<string[]> {
    const { clause, params } = makeObjectClause(ref);
    return withTenantTx(this.pool, this.tenantId, async (client) => {
      let query: string;
      let queryParams: unknown[];
      if (events && events.length > 0) {
        const placeholders = events
          .map((_, i) => `$${2 + params.length + i}`)
          .join(", ");
        query = `SELECT DISTINCT role_at_event
                   FROM choros.actor_event
                  WHERE tenant_id = $1
                    AND ${clause}
                    AND event IN (${placeholders})`;
        queryParams = [this.tenantId, ...params, ...events];
      } else {
        query = `SELECT DISTINCT role_at_event
                   FROM choros.actor_event
                  WHERE tenant_id = $1 AND ${clause}`;
        queryParams = [this.tenantId, ...params];
      }
      const { rows } = await client.query<{ role_at_event: string }>(
        query,
        queryParams,
      );
      return rows.map((r) => r.role_at_event);
    });
  }
}

// ---------------------------------------------------------------------------
// PgActorEventWriter — ActorEventWriter (append-only, per-tenant seq counter)
// ---------------------------------------------------------------------------

class PgActorEventWriter implements ActorEventWriter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
  ) {}

  async appendActorEvent(
    input: ActorEventInput,
  ): Promise<AppendedActorEvent> {
    const id = randomUUID();
    const ts = Date.now();

    return withTenantTx(this.pool, this.tenantId, async (client) => {
      // Advance per-tenant seq counter (lock FOR UPDATE, INSERT genesis row if absent).
      await client.query(
        `INSERT INTO choros.actor_event_seq (tenant_id, next_seq)
         VALUES ($1, 1)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [this.tenantId],
      );
      const { rows: seqRows } = await client.query<{ next_seq: string }>(
        `SELECT next_seq FROM choros.actor_event_seq
          WHERE tenant_id = $1
          FOR UPDATE`,
        [this.tenantId],
      );
      const seq = parseInt(seqRows[0]!.next_seq, 10);
      await client.query(
        `UPDATE choros.actor_event_seq SET next_seq = next_seq + 1
          WHERE tenant_id = $1`,
        [this.tenantId],
      );

      // Resolve object ref columns.
      const applicationId =
        input.objectKind === "application" ? input.applicationId : null;
      const registryId =
        input.objectKind === "registry" ? input.registryId : null;
      const recordId =
        input.objectKind === "record" ? input.recordId : null;

      await client.query(
        `INSERT INTO choros.actor_event
           (tenant_id, seq, id, object_kind,
            application_id, registry_id, record_id,
            actor, on_behalf_of, role_at_event, event,
            approve_level, detail, ts, vocab_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          this.tenantId,
          seq,
          id,
          input.objectKind,
          applicationId,
          registryId,
          recordId,
          input.actor,
          input.onBehalfOf ?? null,
          input.roleAtEvent,
          input.event,
          input.approveLevel ?? null,
          input.detail ?? null,
          ts,
          VOCAB_VERSION,
        ],
      );

      return { seq, id };
    });
  }
}

// ---------------------------------------------------------------------------
// PgSodSource — implements SodSource (injected into grant-resolver step 3.6)
// ---------------------------------------------------------------------------

/**
 * PgSodSource — the T-0053 Postgres DAO implementing SodSource.
 *
 * Tenant context is bound at construction time (tenantId + nowMs supplier).
 * All queries are RLS-scoped via SET LOCAL choros.tenant_id.
 *
 * constraintsFor: returns ALL active sod_constraint rows for the tenant; the
 *   scope-containment test (does the constraint scope cover the object?) is the
 *   pure sod.ts evaluateSod / detectStaticConflict logic's responsibility.
 * effectiveAssignmentsOf: confirmed (confirmed_by IS NOT NULL) + in-window
 *   (valid_from <= nowMs, valid_until > nowMs or NULL) role_assignment rows.
 * reader: PgActorEventReader over actor_event (dynamic SoD trail).
 * writer: PgActorEventWriter (the guarded append).
 */
export class PgSodSource implements SodSource {
  public readonly reader: ActorEventReader;
  public readonly writer: ActorEventWriter;

  constructor(
    private readonly pool: pg.Pool,
    private readonly tenantId: string,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.reader = new PgActorEventReader(pool, tenantId);
    this.writer = new PgActorEventWriter(pool, tenantId);
  }

  async constraintsFor(
    _ref: ActorEventObjectRef,
  ): Promise<SodConstraint[]> {
    // Returns all active sod_constraint rows for the tenant. The AncestryOracle-based
    // scope-containment test (does the constraint scope cover _ref's object?) is
    // handled by sod.ts's pure detectStaticConflict / evaluateDynamicSod logic.
    // We return all constraints and let sod.ts prune by scope intersection.
    return withTenantTx(this.pool, this.tenantId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        kind: string;
        role_a: string | null;
        role_b: string | null;
        self_record: boolean;
        scope: unknown;
        detail: Record<string, unknown> | null;
      }>(
        `SELECT id, kind, role_a, role_b, self_record, scope, detail
           FROM choros.sod_constraint
          WHERE tenant_id = $1
          ORDER BY created_at ASC`,
        [this.tenantId],
      );
      return rows.map((r) => ({
        tenantId: this.tenantId,
        id: r.id,
        kind: r.kind as SodConstraint["kind"],
        roleA: r.role_a,
        roleB: r.role_b,
        selfRecord: r.self_record,
        scope: r.scope,
        detail: r.detail,
      }));
    });
  }

  async effectiveAssignmentsOf(
    principal: string,
  ): Promise<EffectiveAssignment[]> {
    const nowMs = this.nowMs();
    return withTenantTx(this.pool, this.tenantId, async (client) => {
      // Resolve employee id: principal is an employee slug.
      const { rows: empRows } = await client.query<{ id: string }>(
        `SELECT id FROM choros.employee
          WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
        [this.tenantId, principal],
      );
      if (empRows.length === 0) return [];
      const employeeId = empRows[0]!.id;

      const { rows } = await client.query<{
        employee_id: string;
        role_id: string;
        org_scope: unknown;
      }>(
        `SELECT employee_id, role_id, org_scope
           FROM choros.role_assignment
          WHERE tenant_id = $1
            AND employee_id = $2
            AND confirmed_by IS NOT NULL
            AND (valid_from  IS NULL OR valid_from  <= $3)
            AND (valid_until IS NULL OR valid_until  > $3)`,
        [this.tenantId, employeeId, nowMs],
      );
      return rows.map((r) => ({
        employeeId: r.employee_id,
        roleId: r.role_id,
        orgScope: r.org_scope,
      }));
    });
  }
}

// ---------------------------------------------------------------------------
// PgSodConstraintDao — CRUD helpers for the write-API
// ---------------------------------------------------------------------------

/** Input for creating a new sod_constraint row. */
export interface CreateSodConstraintInput {
  kind: "static" | "dynamic";
  roleA?: string | null;
  roleB?: string | null;
  selfRecord?: boolean;
  scope: unknown;
  detail?: Record<string, unknown> | null;
}

/** Input for updating an existing sod_constraint row (partial). */
export interface UpdateSodConstraintInput {
  roleA?: string | null;
  roleB?: string | null;
  selfRecord?: boolean;
  scope?: unknown;
  detail?: Record<string, unknown> | null;
}

/** A sod_constraint row as returned by the DAO. */
export interface SodConstraintRow {
  id: string;
  kind: "static" | "dynamic";
  roleA: string | null;
  roleB: string | null;
  selfRecord: boolean;
  scope: unknown;
  detail: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * List all sod_constraint rows for a tenant, with optional role name resolution.
 */
export async function listSodConstraints(
  pool: pg.Pool,
  tenantId: string,
): Promise<SodConstraintRow[]> {
  assertUuid(tenantId, "tenantId");
  return withTenantTx(pool, tenantId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      kind: string;
      role_a: string | null;
      role_b: string | null;
      self_record: boolean;
      scope: unknown;
      detail: Record<string, unknown> | null;
      created_at: string;
    }>(
      `SELECT id, kind, role_a, role_b, self_record, scope, detail, created_at
         FROM choros.sod_constraint
        WHERE tenant_id = $1
        ORDER BY created_at ASC`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as "static" | "dynamic",
      roleA: r.role_a,
      roleB: r.role_b,
      selfRecord: r.self_record,
      scope: r.scope,
      detail: r.detail ?? null,
      createdAt:
        typeof r.created_at === "string"
          ? parseInt(r.created_at, 10)
          : (r.created_at as unknown as number),
    }));
  });
}

/**
 * Insert a new sod_constraint row. Returns the generated UUID.
 *
 * Validates static-shape invariant before INSERT: a static constraint MUST name
 * both role_a and role_b (mirrors the DB CHECK sod_constraint_static_shape).
 * Throws a typed ValidationError on violation so the HTTP handler can return 400.
 */
export async function createSodConstraint(
  pool: pg.Pool,
  tenantId: string,
  input: CreateSodConstraintInput,
): Promise<string> {
  assertUuid(tenantId, "tenantId");

  // Mirror the DB CHECK: static requires role_a AND role_b non-null.
  if (
    input.kind === "static" &&
    (input.roleA == null || input.roleB == null)
  ) {
    throw new SodValidationError(
      "static SoD constraint requires both roleA and roleB (incompatible role pair)",
    );
  }
  // Validate role UUIDs if provided.
  if (input.roleA != null) assertUuid(input.roleA, "roleA");
  if (input.roleB != null) assertUuid(input.roleB, "roleB");

  const id = randomUUID();
  const createdAt = Date.now();

  await withTenantTx(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO choros.sod_constraint
         (tenant_id, id, kind, role_a, role_b, self_record, scope, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tenantId,
        id,
        input.kind,
        input.roleA ?? null,
        input.roleB ?? null,
        input.selfRecord ?? false,
        JSON.stringify(input.scope),
        input.detail ? JSON.stringify(input.detail) : null,
        createdAt,
      ],
    );
  });

  return id;
}

/**
 * Update a sod_constraint row (partial update — only provided fields change).
 *
 * Re-validates static-shape after merge: if the resulting row would be static
 * with a null role pair, throws SodValidationError.
 * Returns false if the row was not found (caller can 404).
 */
export async function updateSodConstraint(
  pool: pg.Pool,
  tenantId: string,
  constraintId: string,
  input: UpdateSodConstraintInput,
): Promise<boolean> {
  assertUuid(tenantId, "tenantId");
  assertUuid(constraintId, "constraintId");
  if (input.roleA != null) assertUuid(input.roleA, "roleA");
  if (input.roleB != null) assertUuid(input.roleB, "roleB");

  return withTenantTx(pool, tenantId, async (client) => {
    // Load the current row for merge + shape check.
    const { rows } = await client.query<{
      kind: string;
      role_a: string | null;
      role_b: string | null;
    }>(
      `SELECT kind, role_a, role_b
         FROM choros.sod_constraint
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tenantId, constraintId],
    );
    if (rows.length === 0) return false;

    const current = rows[0]!;
    const mergedRoleA = "roleA" in input ? (input.roleA ?? null) : current.role_a;
    const mergedRoleB = "roleB" in input ? (input.roleB ?? null) : current.role_b;

    if (
      current.kind === "static" &&
      (mergedRoleA == null || mergedRoleB == null)
    ) {
      throw new SodValidationError(
        "static SoD constraint requires both roleA and roleB",
      );
    }

    // Build SET clause for provided fields only.
    const setClauses: string[] = [];
    const params: unknown[] = [tenantId, constraintId];

    function addField(col: string, val: unknown): void {
      params.push(val);
      setClauses.push(`${col} = $${params.length}`);
    }

    if ("roleA" in input) addField("role_a", input.roleA ?? null);
    if ("roleB" in input) addField("role_b", input.roleB ?? null);
    if ("selfRecord" in input) addField("self_record", input.selfRecord);
    if ("scope" in input && input.scope !== undefined)
      addField("scope", JSON.stringify(input.scope));
    if ("detail" in input)
      addField(
        "detail",
        input.detail != null ? JSON.stringify(input.detail) : null,
      );

    if (setClauses.length === 0) return true; // no-op

    await client.query(
      `UPDATE choros.sod_constraint
          SET ${setClauses.join(", ")}
        WHERE tenant_id = $1 AND id = $2`,
      params,
    );
    return true;
  });
}

/**
 * Hard-delete a sod_constraint row.
 * Returns false if the row was not found (caller can 404).
 */
export async function deleteSodConstraint(
  pool: pg.Pool,
  tenantId: string,
  constraintId: string,
): Promise<boolean> {
  assertUuid(tenantId, "tenantId");
  assertUuid(constraintId, "constraintId");

  return withTenantTx(pool, tenantId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM choros.sod_constraint
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, constraintId],
    );
    return (rowCount ?? 0) > 0;
  });
}

/** Thrown by DAO when the input violates the SoD constraint shape rules. */
export class SodValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SodValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
