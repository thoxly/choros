/**
 * src/http/records.ts — T-0264 E13: record create/list/get/update API.
 *
 * Records are the actual DATA ROWS of an application (migration 005_record.sql),
 * each conforming to the field-schema (`record_schema`) of the registry_def that
 * governs it. This is the third write-surface over a config/data primitive after
 * applications (T-0262) and registry_def (T-0263) — same module shape, same router
 * seam, same honest-degrade contract.
 *
 * Registers (deps-gated on { pool, resolveActorTenant }):
 *   POST /api/records      → create one record (validated against its registry_def)
 *   GET  /api/records      → list the caller-tenant's records (?application_id=,
 *                            ?registry_def_id= filters)
 *   GET  /api/records/:id  → get one record (404 if not in tenant)
 *   PUT  /api/records/:id  → update record data (re-validated; audited; 404 if not in tenant)
 *
 * THE RECORD ↔ registry_def LINK (migration 005): the `record` table carries only
 * `registry_id` (composite FK (tenant_id, registry_id) → registry_def(tenant_id, id)).
 * There is NO application_id column on `record` — the governing application is reached
 * THROUGH the registry_def (registry_def.application_id). The API therefore:
 *   - accepts `application_id` (+ optional `registry_def_id`) on POST and resolves the
 *     governing registry_def under that application (exactly-one rule, see below);
 *   - surfaces `application_id` + `registry_def_id` on every response by reading them
 *     from the joined registry_def row.
 *
 * GOVERNING registry_def RESOLUTION (POST):
 *   - If `registry_def_id` is supplied, it must be a registry_def of `application_id`
 *     in the caller's tenant; otherwise 404 NOT_FOUND.
 *   - If `registry_def_id` is absent, the application must have EXACTLY ONE
 *     registry_def — that one governs. Zero → 404 NOT_FOUND ("no registry_def");
 *     more than one → 409 CONFLICT ("ambiguous; pass registry_def_id"). This keeps the
 *     no-arg path honest: we never silently pick one of several schemas.
 *
 * DATA VALIDATION (the heart of T-0264): `data` is validated against the governing
 * registry_def's `record_schema` via validateRecordAgainstSchema (record-schema-
 * validator.ts — AJV). A mismatch is 400 VALIDATION with the AJV errors. We build a
 * one-entry SchemaHistoryMap { record_schema_version → record_schema } and validate
 * { data, schema_version: record_schema_version } against it — i.e. the record is
 * validated against the CURRENT schema version of its registry_def at write time.
 *
 * MULTI-TENANT (mandatory, AC): every operation runs inside withTenantTx under
 * SET LOCAL choros.tenant_id = '<actor-tenant>' + FORCE RLS (policy
 * record_tenant_isolation, migration 005). The actor's REAL tenant is resolved from
 * the dev-user slug via the injected resolveActorTenant — NEVER from the body or an
 * attacker-controlled header. A caller in tenant A therefore cannot read or update
 * tenant B's record (RLS-enforced, the Враг target).
 *
 * AUDIT (mandatory, like every mutating endpoint): create and update each append ONE
 * audit event (type record.create / record.update) via makePgAuditWriter().appendAuditEvent
 * INSIDE the same withTenantTx — so a caller ROLLBACK undoes the row AND the audit
 * entry atomically (T-0016 / T-0068 hash-chain).
 *
 * FIELD-MASK WRITE GUARD (T-0246 §2.3 / AC-10 / FF-10 / B-11 hook-point): before any
 * record-data field is written, the create/update services call checkWriteMask(
 * grantWriteFacet, requestedFields) — the pure predicate in field-mask-guard.ts —
 * where requestedFields = the keys of the incoming `data`. A system-only field
 * (circuit_id, activation_key_issued_at) requested by a caller whose write facet does
 * NOT confer it is BLOCKED: a card_action.denied audit event is appended in-tx and the
 * route returns HTTP 403 (FIELD_WRITE_FORBIDDEN); the data row is not written. The
 * caller's write facet is resolved via the OPTIONAL resolveWriteFacet dep — see
 * WriteFacetResolver for the honest-degrade (whole-resource `undefined`) default.
 *
 * DEPS INJECTION (mirrors applications.ts / registry-defs.ts): the composition root
 * supplies { pool, resolveActorTenant }. When absent (no DATABASE_URL) the routes are
 * NOT registered — same honest-degrade contract as the other DB-backed write APIs.
 *
 * COLUMNS (migration 005_record.sql):
 *   tenant_id   uuid    (scope; resolved from actor, not body)
 *   id          uuid    (server-generated)
 *   registry_id uuid    (FK to the governing registry_def)
 *   data        jsonb   (the record payload; validated against record_schema)
 *   created_at  bigint  (epoch ms, server clock)
 *   updated_at  bigint  (epoch ms, server clock)
 *   created_by  text    (actor slug)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { validateRecordAgainstSchema } from "../core/record-schema-validator.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { checkWriteMask } from "../runtime/customer-onboarding/field-mask-guard.js";

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

// ---------------------------------------------------------------------------
// Injected deps (mirrors ApplicationRoutesDeps / RegistryDefCrudDeps)
// ---------------------------------------------------------------------------

/**
 * Resolve the tenant the actor (dev-user slug) actually belongs to.
 * Production binding = resolveActorTenant(getOrgPool(), slug); injected so the test
 * suite can stub the membership check (actor A → tenant A, actor B → tenant B).
 */
export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

/**
 * Resolve the caller's FIELD WRITE-MASK for a given record — the field-name
 * allow-list its covering write-grant confers (T-0246 §2.3 / AC-10 / B-11).
 *
 * Return contract (mirrors grant-resolver.grantFacetFields / checkWriteMask's
 * `writeFacet` parameter):
 *   - `undefined` ⇒ WHOLE-RESOURCE write (system-actor / unrestricted grant):
 *     every field is writable → checkWriteMask never denies.
 *   - `string[]`  ⇒ a RESTRICTED facet: the named fields are the only ones the
 *     caller may write; a requested system-only field absent from this set is
 *     blocked (HTTP 403 + card_action.denied).
 *
 * HONEST-DEGRADE (ADR §4.3 optional-PDP-port discipline): this resolver is
 * OPTIONAL on RecordRoutesDeps. When the composition root has not yet wired the
 * grant→write-facet lookup (the current bootstrap state — field-grant
 * provisioning for record-data is a later increment), it is absent and the
 * write path degrades to the whole-resource (`undefined`) facet: the field-mask
 * guard is STILL on the write path and STILL runs checkWriteMask on every write,
 * but is permissive until a restricting facet is supplied. The guard bites the
 * moment a vendor-admin facet is injected — exactly the B-11 hook-point the
 * field-mask-guard.ts / FF-10 contract mandates.
 *
 * @param actorSlug the caller identity (dev-user slug / OIDC sub)
 * @param tenantId  the caller's resolved tenant
 * @param recordId  the record being written (the grant scope subject)
 */
export type WriteFacetResolver = (
  actorSlug: string,
  tenantId: string,
  recordId: string,
) => Promise<string[] | undefined>;

export interface RecordRoutesDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
  /**
   * OPTIONAL field write-mask resolver (T-0246 §2.3 / AC-10 / B-11 hook-point).
   * When omitted, every write degrades to a whole-resource facet (`undefined`)
   * — see {@link WriteFacetResolver}. When supplied, the returned allow-list is
   * fed to checkWriteMask before any record-data field write, denying writes of
   * system-only fields (circuit_id, activation_key_issued_at) the caller's grant
   * does not confer.
   */
  resolveWriteFacet?: WriteFacetResolver;
}

// ---------------------------------------------------------------------------
// withTenantTx — canonical RLS pattern (mirrors applications.ts / registry-defs.ts)
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

// ---------------------------------------------------------------------------
// extractActor — caller identity (mirrors applications.ts / registry-defs.ts)
// ---------------------------------------------------------------------------

function extractActor(req: IncomingMessage): string {
  // Keycloak mode: AuthContext is set by withAuth() middleware before the handler.
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    return ctx.sub;
  }
  // Dev mode: x-dev-user header.
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// Row types + serializer
// ---------------------------------------------------------------------------

// A record joined to its governing registry_def, so the API surface can present
// application_id + registry_def_id + record_schema_version (none of which live on
// the record row itself — they come from the registry_def, migration 004 + 070).
interface RecordJoinedRow {
  id: string;
  registry_id: string;
  application_id: string;
  record_schema_version: number;
  data: unknown;
  created_at: string | number; // bigint comes back as a string from node-postgres
  updated_at: string | number;
}

function serializeRecord(row: RecordJoinedRow): Record<string, unknown> {
  return {
    id: row.id,
    application_id: row.application_id,
    registry_def_id: row.registry_id,
    record_schema_version: Number(row.record_schema_version),
    data: row.data,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

// SELECT a record + its governing registry_def's application_id / version, all
// tenant-scoped (the join also enforces tenant_id-leading FK alignment).
const RECORD_SELECT_JOIN =
  `r.id, r.registry_id, rd.application_id, rd.record_schema_version, ` +
  `r.data, r.created_at, r.updated_at`;

// ---------------------------------------------------------------------------
// T-0295: enriched detail shape — extends the base row with record_schema +
// created_by so the detail screen can render field labels + actor context.
// Only used by GET /api/records/:id (not the list / create / update paths).
// ---------------------------------------------------------------------------

interface RecordDetailRow extends RecordJoinedRow {
  record_schema: unknown;
  created_by: string | null;
}

function serializeRecordDetail(row: RecordDetailRow): Record<string, unknown> {
  return {
    ...serializeRecord(row),
    record_schema: row.record_schema,
    created_by: row.created_by ?? null,
  };
}

const RECORD_DETAIL_SELECT_JOIN =
  `r.id, r.registry_id, rd.application_id, rd.record_schema_version, ` +
  `rd.record_schema, r.data, r.created_at, r.updated_at, r.created_by`;

// ---------------------------------------------------------------------------
// Governing registry_def — the schema a record is validated against.
// ---------------------------------------------------------------------------

interface GoverningRegistryDef {
  id: string;
  application_id: string;
  record_schema: unknown;
  record_schema_version: number;
}

/**
 * Resolve the registry_def that governs records under `applicationId`.
 *
 * - registryDefId supplied → that registry_def, but only if it belongs to the
 *   application in this tenant (else 404).
 * - registryDefId absent → the application must have EXACTLY ONE registry_def
 *   (0 → 404, >1 → 409 ambiguous). Never silently picks among several schemas.
 *
 * Runs against an already-tenant-scoped client (inside withTenantTx + RLS).
 */
async function resolveGoverningRegistryDef(
  client: pg.PoolClient,
  tenantId: string,
  applicationId: string,
  registryDefId: string | null,
): Promise<GoverningRegistryDef> {
  if (registryDefId !== null) {
    const res = await client.query<GoverningRegistryDef>(
      `SELECT id, application_id, record_schema, record_schema_version
         FROM choros.registry_def
        WHERE tenant_id = $1 AND id = $2 AND application_id = $3`,
      [tenantId, registryDefId, applicationId],
    );
    if (res.rows.length === 0) {
      throw new HttpError(
        404,
        "NOT_FOUND",
        `registry_def '${registryDefId}' not found for application '${applicationId}' in this tenant`,
      );
    }
    return res.rows[0]!;
  }

  // No registry_def_id given: the application must have exactly one registry_def.
  const res = await client.query<GoverningRegistryDef>(
    `SELECT id, application_id, record_schema, record_schema_version
       FROM choros.registry_def
      WHERE tenant_id = $1 AND application_id = $2
      ORDER BY created_at ASC, slug ASC`,
    [tenantId, applicationId],
  );
  if (res.rows.length === 0) {
    throw new HttpError(
      404,
      "NOT_FOUND",
      `application '${applicationId}' has no registry_def to govern records`,
    );
  }
  if (res.rows.length > 1) {
    throw new HttpError(
      409,
      "CONFLICT",
      `application '${applicationId}' has multiple registry_defs; pass registry_def_id to disambiguate`,
    );
  }
  return res.rows[0]!;
}

/**
 * Load the governing registry_def for an EXISTING record (by its registry_id).
 * Used by PUT to re-validate the updated data against the same schema that governs
 * the row. Tenant-scoped via RLS on the open client.
 */
async function loadRegistryDefById(
  client: pg.PoolClient,
  tenantId: string,
  registryDefId: string,
): Promise<GoverningRegistryDef> {
  const res = await client.query<GoverningRegistryDef>(
    `SELECT id, application_id, record_schema, record_schema_version
       FROM choros.registry_def
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, registryDefId],
  );
  if (res.rows.length === 0) {
    // The record's FK guarantees a registry_def exists in the tenant; defensive 404.
    throw new HttpError(404, "NOT_FOUND", "governing registry_def not found");
  }
  return res.rows[0]!;
}

/**
 * Validate `data` against a registry_def's record_schema (the current version).
 * Builds a one-entry SchemaHistoryMap so we reuse the canonical record-schema-
 * validator (one validator, not two). Throws 400 VALIDATION on mismatch.
 */
function assertDataValid(data: unknown, reg: GoverningRegistryDef): void {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "VALIDATION", "data must be a JSON object");
  }
  const schemaHistory = new Map<number, object>([
    [Number(reg.record_schema_version), reg.record_schema as object],
  ]);
  const result = validateRecordAgainstSchema(
    { data: data as object, schema_version: Number(reg.record_schema_version) },
    schemaHistory,
  );
  if (!result.valid) {
    throw new HttpError(
      400,
      "VALIDATION",
      `data does not conform to registry_def schema: ${result.errors.join("; ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Field-mask write guard (T-0246 §2.3 / AC-10 / FF-10 / B-11 hook-point)
// ---------------------------------------------------------------------------

/**
 * Sentinel result of the field-mask write guard. `denied=true` carries the
 * blocked wire field names so the route can shape a 403 body and so the audit
 * trail (already appended inside the tx) records exactly what the caller sent.
 */
type WriteMaskGuardResult =
  | { denied: false }
  | { denied: true; blockedFields: string[] };

/**
 * Enforce the field write-mask on a record-data write (PUT, and POST for
 * consistency) BEFORE the row is written — the B-11 hook-point FF-10 mandates.
 *
 * Flow (ADR T-0246 §2.3 / field-mask-guard.ts "Integration with B-11"):
 *   1. The requested field set = the keys of the incoming `data` object.
 *   2. checkWriteMask(grantWriteFacet, requestedFields) — the pure predicate
 *      (field-mask-guard.ts): a requested system-only field (circuit_id,
 *      activation_key_issued_at) absent from the caller's write facet is blocked.
 *   3. On denial → append ONE card_action.denied audit event INSIDE the same tx
 *      (so the denial is on the hash-chain and commits even though the data row
 *      is not written) and return the sentinel. The route maps it to HTTP 403.
 *
 * `grantWriteFacet === undefined` (no restricting facet resolved — system-actor
 * / honest-degrade path) ⇒ checkWriteMask never denies ⇒ this is a no-op.
 *
 * Runs against an already-tenant-scoped client (inside withTenantTx + RLS).
 */
async function enforceWriteMask(
  client: pg.PoolClient,
  args: {
    grantWriteFacet: string[] | undefined;
    data: unknown;
    recordId: string;
    reg: GoverningRegistryDef;
    actor: string;
    op: "create" | "update";
    nowMs: number;
  },
): Promise<WriteMaskGuardResult> {
  const { grantWriteFacet, data, recordId, reg, actor, op, nowMs } = args;

  // The requested field set = the keys of the incoming data object. `assertDataValid`
  // has already guaranteed `data` is a non-null, non-array object at the call sites.
  const requestedFields =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? Object.keys(data as Record<string, unknown>)
      : [];

  const verdict = checkWriteMask(grantWriteFacet, requestedFields);
  if (!verdict.denied) {
    return { denied: false };
  }

  // Append ONE card_action.denied audit event in-tx (the canonical denial event;
  // mirrors issue-key.ts). The tx still COMMITs this denial event even though the
  // record row is NOT written — the route throws 403 after the service returns.
  const writer = makePgAuditWriter();
  await writer.appendAuditEvent(client as unknown as PgClientLike, {
    id: randomUUID(),
    type: "card_action.denied",
    actor,
    subject: recordId,
    scope: {
      resource: "record",
      op,
      registry_def_id: reg.id,
      application_id: reg.application_id,
    },
    via: "records-api",
    proposed_by: null,
    confirmed_by: null,
    payload: {
      reason: verdict.reason,
      record_id: recordId,
      blocked_fields: verdict.blockedFields,
      registry_def_id: reg.id,
      application_id: reg.application_id,
    },
    occurred_at: nowMs,
  });

  return { denied: true, blockedFields: verdict.blockedFields };
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Outcome of a write service. A `{ denied: true }` outcome means the field-mask
 * guard blocked the write (system-only field absent from the caller's facet);
 * the denial audit event has already been committed in-tx and the route maps
 * this to HTTP 403. `{ row }` is the success path.
 */
type WriteOutcome =
  | { denied: true; blockedFields: string[] }
  | { denied: false; row: RecordJoinedRow };

async function createRecord(args: {
  pool: pg.Pool;
  tenantId: string;
  applicationId: string;
  registryDefId: string | null;
  data: unknown;
  actor: string;
  grantWriteFacet: string[] | undefined;
  nowMs: number;
}): Promise<WriteOutcome> {
  const { pool, tenantId, applicationId, registryDefId, data, actor, grantWriteFacet, nowMs } = args;
  const id = randomUUID();
  return withTenantTx(pool, tenantId, async (client) => {
    // 1. Resolve the governing registry_def (404/409 paths inside).
    const reg = await resolveGoverningRegistryDef(
      client,
      tenantId,
      applicationId,
      registryDefId,
    );

    // 2. Validate data against the governing schema (400 on mismatch).
    assertDataValid(data, reg);

    // 2b. FIELD-MASK WRITE GUARD (FF-10 / AC-10): before writing any field, check
    // the requested field set against the caller's write facet. A system-only
    // field absent from the facet → denial audited in-tx + 403 (no row written).
    const guard = await enforceWriteMask(client, {
      grantWriteFacet,
      data,
      recordId: id,
      reg,
      actor,
      op: "create",
      nowMs,
    });
    if (guard.denied) {
      return { denied: true, blockedFields: guard.blockedFields };
    }

    // 3. Insert the record (tenant-scoped under RLS).
    await client.query(
      `INSERT INTO choros.record
         (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6)`,
      [tenantId, id, reg.id, JSON.stringify(data), nowMs, actor],
    );

    // 4. Append ONE audit event (record.create) inside the same tx (T-0016 / T-0068).
    const writer = makePgAuditWriter();
    await writer.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "record.create",
      actor,
      subject: id,
      scope: { registry_def_id: reg.id, application_id: reg.application_id },
      via: "records-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: {
        record_id: id,
        registry_def_id: reg.id,
        application_id: reg.application_id,
        record_schema_version: Number(reg.record_schema_version),
      },
      occurred_at: nowMs,
    });

    // 5. Read back the joined row for the response.
    const res = await client.query<RecordJoinedRow>(
      `SELECT ${RECORD_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, id],
    );
    return { denied: false, row: res.rows[0]! };
  });
}

async function listRecords(
  pool: pg.Pool,
  tenantId: string,
  applicationId: string | null,
  registryDefId: string | null,
): Promise<RecordJoinedRow[]> {
  return withTenantTx(pool, tenantId, async (client) => {
    const conds: string[] = ["r.tenant_id = $1"];
    const params: unknown[] = [tenantId];
    if (applicationId !== null) {
      params.push(applicationId);
      conds.push(`rd.application_id = $${params.length}`);
    }
    if (registryDefId !== null) {
      params.push(registryDefId);
      conds.push(`r.registry_id = $${params.length}`);
    }
    const res = await client.query<RecordJoinedRow>(
      `SELECT ${RECORD_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE ${conds.join(" AND ")}
        ORDER BY r.created_at DESC, r.id ASC`,
      params,
    );
    return res.rows;
  });
}

/**
 * T-0295: enriched detail fetch — adds record_schema (for label rendering) +
 * created_by (actor context) to the base record shape. Only called by the
 * GET /api/records/:id route so the list/create/update paths are unaffected.
 * Replaces the former bare `getRecord` function which only returned base fields.
 */
async function getRecordDetail(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<RecordDetailRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<RecordDetailRow>(
      `SELECT ${RECORD_DETAIL_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, id],
    );
    return res.rows[0] ?? null;
  });
}

/** updateRecord outcome: not-found (404), field-mask denied (403), or success. */
type UpdateOutcome = { notFound: true } | WriteOutcome;

async function updateRecord(args: {
  pool: pg.Pool;
  tenantId: string;
  id: string;
  data: unknown;
  actor: string;
  grantWriteFacet: string[] | undefined;
  nowMs: number;
}): Promise<UpdateOutcome> {
  const { pool, tenantId, id, data, actor, grantWriteFacet, nowMs } = args;
  return withTenantTx(pool, tenantId, async (client) => {
    // 1. Lock and read the existing record (tenant-scoped; FOR UPDATE).
    const cur = await client.query<{ registry_id: string }>(
      `SELECT registry_id
         FROM choros.record
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tenantId, id],
    );
    if (cur.rows.length === 0) {
      // Not in the caller's tenant (RLS-filtered) OR does not exist → caller maps to 404.
      return { notFound: true };
    }
    const registryId = cur.rows[0]!.registry_id;

    // 2. Re-validate the new data against the governing registry_def schema.
    const reg = await loadRegistryDefById(client, tenantId, registryId);
    assertDataValid(data, reg);

    // 2b. FIELD-MASK WRITE GUARD (FF-10 / AC-10 / B-11): before any field write,
    // check the requested field set (keys of incoming data) against the caller's
    // write facet. A system-only field (circuit_id, activation_key_issued_at)
    // absent from the facet → denial audited in-tx + 403; the row is NOT updated.
    const guard = await enforceWriteMask(client, {
      grantWriteFacet,
      data,
      recordId: id,
      reg,
      actor,
      op: "update",
      nowMs,
    });
    if (guard.denied) {
      return { denied: true, blockedFields: guard.blockedFields };
    }

    // 3. Apply the update.
    await client.query(
      `UPDATE choros.record
          SET data = $1::jsonb,
              updated_at = $2
        WHERE tenant_id = $3 AND id = $4`,
      [JSON.stringify(data), nowMs, tenantId, id],
    );

    // 4. Append ONE audit event (record.update) inside the same tx.
    const writer = makePgAuditWriter();
    await writer.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      type: "record.update",
      actor,
      subject: id,
      scope: { registry_def_id: reg.id, application_id: reg.application_id },
      via: "records-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: {
        record_id: id,
        registry_def_id: reg.id,
        application_id: reg.application_id,
        record_schema_version: Number(reg.record_schema_version),
      },
      occurred_at: nowMs,
    });

    // 5. Read back the joined row for the response.
    const res = await client.query<RecordJoinedRow>(
      `SELECT ${RECORD_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, id],
    );
    return { denied: false, row: res.rows[0]! };
  });
}

// ---------------------------------------------------------------------------
// Query-param parsing
// ---------------------------------------------------------------------------

function parseUuidQueryParam(
  req: IncomingMessage,
  name: string,
): string | null {
  const rawUrl = req.url ?? "";
  const qIdx = rawUrl.indexOf("?");
  if (qIdx < 0) return null;
  const params = new URLSearchParams(rawUrl.slice(qIdx + 1));
  const val = params.get(name);
  if (val === null) return null;
  if (!UUID_RE.test(val)) {
    throw new HttpError(400, "VALIDATION", `${name} query param must be a valid UUID`);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register the records create/list/get/update routes.
 *
 * @param router HTTP router.
 * @param deps   Injected { pool, resolveActorTenant }. When omitted the routes are
 *               NOT registered (no-DB honest degrade — same as the other write APIs).
 */
export function registerRecordRoutes(
  router: Router,
  deps?: RecordRoutesDeps,
): void {
  if (!deps) return;
  const { pool, resolveActorTenant, resolveWriteFacet } = deps;

  // Resolve the caller's field write-mask for a record (FF-10 / AC-10 hook-point).
  // Honest-degrade: when no resolveWriteFacet is wired (current bootstrap), every
  // write uses the whole-resource facet (`undefined`) — checkWriteMask never denies,
  // but the guard is STILL on the write path and bites once a facet is injected.
  async function writeFacetFor(
    actorSlug: string,
    tenantId: string,
    recordId: string,
  ): Promise<string[] | undefined> {
    if (!resolveWriteFacet) return undefined;
    return resolveWriteFacet(actorSlug, tenantId, recordId);
  }

  // Shape an HTTP 403 from a field-mask denial (the denial is already audited in-tx).
  function denialError(blockedFields: string[]): HttpError {
    return new HttpError(
      403,
      "FIELD_WRITE_FORBIDDEN",
      `write of system-only field(s) not permitted by your grant: ${blockedFields.join(", ")}`,
    );
  }

  // POST /api/records — create one record in the caller's tenant, validated against
  // the governing registry_def's record_schema.
  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/records", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = extractActor(req);

    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    const applicationId = body["application_id"];
    if (typeof applicationId !== "string" || !UUID_RE.test(applicationId)) {
      throw new HttpError(400, "VALIDATION", "application_id must be a valid UUID");
    }

    let registryDefId: string | null = null;
    if (
      "registry_def_id" in body &&
      body["registry_def_id"] !== null &&
      body["registry_def_id"] !== undefined
    ) {
      if (typeof body["registry_def_id"] !== "string" || !UUID_RE.test(body["registry_def_id"])) {
        throw new HttpError(400, "VALIDATION", "registry_def_id must be a valid UUID");
      }
      registryDefId = body["registry_def_id"];
    }

    if (!("data" in body)) {
      throw new HttpError(400, "VALIDATION", "data is required");
    }
    const data = body["data"];

    const tenantId = await resolveActorTenant(actor);
    // Field write-mask for the create (the record id does not exist yet, so the
    // facet is resolved at the application/registry scope — empty recordId).
    const grantWriteFacet = await writeFacetFor(actor, tenantId, "");
    const outcome = await createRecord({
      pool,
      tenantId,
      applicationId,
      registryDefId,
      data,
      actor,
      grantWriteFacet,
      nowMs: Date.now(),
    });
    if (outcome.denied) {
      throw denialError(outcome.blockedFields);
    }

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(serializeRecord(outcome.row)));
  }));

  // GET /api/records — list the caller-tenant's records, optionally filtered by
  // ?application_id= and/or ?registry_def_id=.
  router.register("GET", "/api/records", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = extractActor(req);
    const applicationId = parseUuidQueryParam(req, "application_id");
    const registryDefId = parseUuidQueryParam(req, "registry_def_id");

    const tenantId = await resolveActorTenant(actor);
    const rows = await listRecords(pool, tenantId, applicationId, registryDefId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ records: rows.map(serializeRecord) }));
  }));

  // GET /api/records/:id — get one record enriched for the detail screen
  // (T-0295): includes record_schema + created_by in addition to the base
  // fields. 404 if not in the caller's tenant (RLS-filtered or does not exist).
  router.register(
    "GET",
    "/api/records/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "record id");

      const actor = extractActor(req);
      const tenantId = await resolveActorTenant(actor);
      const row = await getRecordDetail(pool, tenantId, id);
      if (row === null) {
        // Not in the caller's tenant (RLS-filtered) OR does not exist → 404.
        throw new HttpError(404, "NOT_FOUND", "record not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeRecordDetail(row)));
    }),
  );

  // PUT /api/records/:id — update a record's data (re-validated; audited; 404 if not
  // in the caller's tenant).
  router.register(
    "PUT",
    "/api/records/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "record id");

      const actor = extractActor(req);

      const rawBody = await readJsonBody(req);
      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
      }
      const body = rawBody as Record<string, unknown>;

      if (!("data" in body)) {
        throw new HttpError(400, "VALIDATION", "data is required");
      }
      const data = body["data"];

      const tenantId = await resolveActorTenant(actor);
      // Resolve the caller's field write-mask for THIS record (FF-10 / AC-10).
      const grantWriteFacet = await writeFacetFor(actor, tenantId, id);
      const outcome = await updateRecord({
        pool,
        tenantId,
        id,
        data,
        actor,
        grantWriteFacet,
        nowMs: Date.now(),
      });
      if ("notFound" in outcome) {
        throw new HttpError(404, "NOT_FOUND", "record not found");
      }
      if (outcome.denied) {
        // Field-mask guard blocked a system-only field write (already audited in-tx).
        throw denialError(outcome.blockedFields);
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeRecord(outcome.row)));
    }),
  );
}
