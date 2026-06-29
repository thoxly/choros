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
import { resolveActorSlugFromAuth } from "../db/org.js";
import { validateRecordAgainstSchema } from "../core/record-schema-validator.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { checkWriteMask } from "../runtime/customer-onboarding/field-mask-guard.js";
import { getOnCreateBinding } from "../db/binding-trigger-dao.js";
import { appendProcessStarted } from "./process-projection.js";
import { flowableErrorToHttp, type FlowableClient } from "../core/flowable-client.js";
import { preComputeGatewayVariable } from "../core/dmn-gateway.js";
import {
  parsePaginationParams,
  encodeRecordsCursor,
  applyFieldVisibilityRedaction,
  MAX_PAGE_SIZE,
  type RecordsPage,
} from "../core/data-access-port.js";
import type { Grant } from "../core/grant-lattice.js";
import type { FieldVisibilityPolicy } from "../core/field-visibility.js";

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

/**
 * Resolve the caller's field-visibility context for the records LIST.
 *
 * Returns the actor's covering grants (already resolved via the SAME
 * getGrantsForSubject / makeDbGrantSource path the rest of the PDP uses —
 * single-resolver constraint) and the FieldVisibilityPolicy describing which
 * JSONB keys are role-scoped.
 *
 * HONEST-DEGRADE: OPTIONAL on RecordRoutesDeps. When absent, the list endpoint
 * calls applyFieldVisibilityRedaction with an empty policy (roleScopedFields=∅)
 * — a no-op that is byte-identical to pre-T-0419 behaviour (NF-1). Redaction
 * activates the moment this resolver is injected.
 *
 * NO SECOND AUTHORITY PATH: the grants returned here MUST come from the same
 * GrantSource/getGrantsForSubject DAO that makeDbGrantSource uses (T-0331 /
 * T-0419 single-resolver). The policy is an assembled projection of existing
 * record_schema + data_classification rows, not a new store.
 *
 * @param actorSlug  the caller identity (dev-user slug / OIDC sub)
 * @param tenantId   the caller's resolved tenant
 * @param nowMs      current epoch ms (same instant for effective-window filtering)
 */
export type FieldVisibilityResolver = (
  actorSlug: string,
  tenantId: string,
  nowMs: number,
) => Promise<{ coveringGrants: Grant[]; policy: FieldVisibilityPolicy }>;

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
  /**
   * T-0419 [D7-3-FU] — OPTIONAL field-visibility resolver for the records LIST.
   *
   * When supplied, the LIST handler resolves the actor's covering grants + policy
   * via this resolver, then calls applyFieldVisibilityRedaction on each row's
   * `data` BEFORE serialization. Redacted JSONB keys are PHYSICALLY ABSENT from
   * the response (not null — F-3). This closes PD-19's "agent widget field-leak"
   * for the list surface.
   *
   * When absent (honest-degrade): applyFieldVisibilityRedaction is called with
   * an empty policy (roleScopedFields=∅) — a no-op, byte-identical to
   * pre-T-0419 (NF-1). No second authority path: the resolver MUST source
   * grants from the SAME getGrantsForSubject DAO (single-resolver constraint).
   */
  resolveFieldVisibility?: FieldVisibilityResolver;
  /**
   * T-0351 E16 (on_create trigger): OPTIONAL FlowableClient for process-start
   * co-located with record creation. When supplied, POST /api/records checks for
   * an on_create binding on the application and fires the engine start in the
   * SAME transaction (create = start, S1 seam).
   *
   * When absent (no engine configured), the record is still created normally;
   * the on_create trigger is silently skipped (honest-degrade: the record exists
   * but no process starts — consistent with no flowable configured at all).
   *
   * DOCTRINE (RECORD_IN_PAYLOAD): only scalar values projected from the record's
   * `data` via `field_mapping` are passed to the engine. The record object itself
   * is NEVER sent as a variable (assertVariableValue guard in flowable-client.ts
   * is the runtime sentinel; we also enforce at projection time here).
   */
  flowable?: FlowableClient;
  /**
   * T-0536 [D8-R4 delivery]: OPTIONAL internal-signal emitter. When supplied, a
   * successful record UPDATE (PUT /api/records/:id) broadcasts a generic
   * `record-status-changed` signal WITHIN the record's tenant, correlated by the
   * record id (the business key any process can bind a signal-catch to). This is
   * the «смена статуса записи → внутренний сигнал» seam (spec §3.5 source b): a
   * process parked on a signal-catch advances when the record it watches changes.
   *
   * Best-effort + tenant-bounded: the emitter is called with the ALREADY-RESOLVED
   * record tenant (never a body field) AFTER the update commits; a failed/empty
   * emit is non-fatal to the update (which already succeeded). When absent
   * (memory-mode / no engine), the update behaves exactly as before (honest-degrade).
   *
   * GENERIC — no ТЭЛ hardcode: the signal name + record-id correlation key are
   * registry-agnostic; any record of any application emits the same shape, and any
   * process can author a signal-catch to receive it.
   */
  emitSignal?: RecordStatusSignalEmitter;
}

/**
 * T-0536: emit a generic «record changed» internal signal within the record's
 * tenant. Returns a best-effort result; the caller ignores failures (the originating
 * update already committed). The implementation (wired in server.ts) delegates to
 * emitInternalSignal in message-ingest.ts → the SAME deliverMessageEnvelope path.
 */
export type RecordStatusSignalEmitter = (args: {
  readonly tenantId: string;
  readonly recordId: string;
  readonly registryDefId: string;
  readonly actor: string;
  readonly nowMs: number;
}) => Promise<void>;

/** T-0536: the generic record-status-change signal name (registry-agnostic). */
export const RECORD_STATUS_SIGNAL = "record-status-changed";

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
// extractActor — caller identity, mode-aware (T-0372: resolves KC sub → slug)
// ---------------------------------------------------------------------------

async function extractActor(req: IncomingMessage, pool: pg.Pool): Promise<string> {
  // Keycloak mode: AuthContext is set by withAuth() middleware before the handler.
  // T-0372: resolve sub → employee slug so seeded personas (e-larina, e-orlov, …)
  // and registered users are keyed on the same slug used for grant/tenant lookup.
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
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

// ---------------------------------------------------------------------------
// T-0351 E16: scalar projection for on_create trigger variables
// DOCTRINE (RECORD_IN_PAYLOAD, S1 seam): ONLY primitive scalars (string, number,
// boolean) projected from the record's `data` object via the binding's
// `field_mapping` are passed to the engine. The record object itself is NEVER
// a variable. This function enforces that contract at projection time; the
// assertVariableValue guard in flowable-client.ts is the runtime sentinel.
// ---------------------------------------------------------------------------

/**
 * Project scalar variables from a record's `data` for engine start via a
 * `field_mapping` configuration. field_mapping maps engine variable name →
 * field path (a key into the record `data` object, flat one-level lookup).
 *
 * ONLY primitive scalars (string, number, boolean, null) are projected.
 * If the resolved value at a field path is an object or array it is SKIPPED
 * (RECORD_IN_PAYLOAD discipline: no nested objects or record references passed
 * to the engine). The engine is called only with provably scalar values.
 *
 * Returns an empty object when field_mapping is empty or produces no scalars.
 */
function projectEngineVariables(
  data: unknown,
  fieldMapping: Record<string, string>,
): Record<string, string | number | boolean | null> {
  const vars: Record<string, string | number | boolean | null> = {};
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return vars;
  }
  const record = data as Record<string, unknown>;
  for (const [varName, fieldPath] of Object.entries(fieldMapping)) {
    const rawValue = record[fieldPath];
    // RECORD_IN_PAYLOAD guard: accept only primitives. Skip objects/arrays.
    if (
      rawValue === null ||
      rawValue === undefined ||
      typeof rawValue === "string" ||
      typeof rawValue === "number" ||
      typeof rawValue === "boolean"
    ) {
      vars[varName] = rawValue ?? null;
    }
    // Objects and arrays are intentionally skipped — not projected.
  }
  return vars;
}

async function createRecord(args: {
  pool: pg.Pool;
  tenantId: string;
  applicationId: string;
  registryDefId: string | null;
  data: unknown;
  actor: string;
  grantWriteFacet: string[] | undefined;
  nowMs: number;
  /** T-0351 E16: optional engine client for on_create trigger (create = start). */
  flowable?: FlowableClient;
}): Promise<WriteOutcome> {
  const { pool, tenantId, applicationId, registryDefId, data, actor, grantWriteFacet, nowMs, flowable } = args;
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

    // 5. T-0351 E16 (create = start, S1 seam): look up an on_create binding for
    //    this application and fire the process start in the SAME transaction.
    //    DOCTRINE (RECORD_IN_PAYLOAD / S1 seam):
    //      - Only scalar projections from data via field_mapping are passed to the
    //        engine. The record object itself is NEVER a variable.
    //      - The engine call is INSIDE this tx, so a start failure rolls back the
    //        record insert and audit event (atomicity: create = start or nothing).
    //      - The process.started projection write is best-effort (a projection fail
    //        must NOT roll back the record — mirrors process-start.ts §T-0282).
    //    If flowable is not configured, skip silently (honest-degrade).
    if (flowable !== undefined) {
      const binding = await getOnCreateBinding(client, tenantId, reg.application_id);
      if (binding !== null) {
        // Project SCALAR variables from record data via field_mapping.
        // RECORD_IN_PAYLOAD: only primitives pass through; objects/arrays are dropped.
        let variables = projectEngineVariables(data, binding.field_mapping);

        // T-0439: pre-compute DMN gateway routing variable at launch.
        // Evaluates the published rule table (if any) for this process and injects
        // the routing variable + version pins into the startInstance variables map
        // so the exclusiveGateway in authored processes can route at start time.
        // Degrades gracefully: no published rule table → no injection, no throw.
        //
        // SAVEPOINT isolation: preComputeGatewayVariable writes an audit event
        // (emitGatewayEvaluated → appendAuditEvent) on this same client.  A DB
        // error inside that INSERT would leave the outer tx in an aborted state
        // (25P02) even though the JS catch swallows the JS error, causing every
        // subsequent query to fail.  Wrapping in a SAVEPOINT ensures that on any
        // DB error the tx is rolled back only to the savepoint — the outer tx
        // remains clean and launch proceeds with the original variables.
        // Mirrors the proc_proj SAVEPOINT pattern directly below (~line 791).
        await client.query('SAVEPOINT dmn_precompute');
        try {
          const dmnResult = await preComputeGatewayVariable(client, {
            tenantId,
            instanceId: id,      // record id as proxy instance id for audit (best-effort)
            processKey: binding.process_key,
            procDefId: binding.process_key,
            actor,
            nowMs,
            bindings: variables,
            gatewayId: `gw-${binding.process_key}`, // generic gateway id for audit event
          });
          if (dmnResult.gatewayVar !== null) {
            variables = {
              ...variables,
              [dmnResult.gatewayVar.name]: dmnResult.gatewayVar.value,
              ...dmnResult.versionVars,
            };
          } else if (Object.keys(dmnResult.versionVars).length > 0) {
            variables = { ...variables, ...dmnResult.versionVars };
          }
          await client.query('RELEASE SAVEPOINT dmn_precompute');
        } catch (dmnErr) {
          // Non-fatal: a DMN evaluation failure must NOT block the process launch.
          // Roll back to the savepoint so the tx is clean, then proceed with
          // the original variables (gateway falls through to default flow).
          await client.query('ROLLBACK TO SAVEPOINT dmn_precompute');
          console.warn(
            `[on_create dmn-precompute] non-fatal DMN pre-compute error for process ` +
              `${binding.process_key}:`,
            dmnErr,
          );
        }

        // Start the process inside the SAME tenant tx (create = start atomically).
        // If startInstance fails the whole tx rolls back (no orphan record).
        // Known two-phase window: startInstance is a REST call outside this PG tx — an
        // engine-success + PG-COMMIT-fail leaves an orphan engine instance (best-effort).
        const startResult = await flowable.startInstance(
          binding.process_key,
          Object.keys(variables).length > 0 ? variables : undefined,
        );
        if (!startResult.ok) {
          // Engine failure is propagated: no record without a process start (tx rolls back).
          // T-0483: surface a CLEAR, TYPED error — ENGINE_UNAVAILABLE → 503 with an
          // honest message — instead of an opaque "502 ENGINE_ERROR ...".
          const { status, code, message } = flowableErrorToHttp(startResult.code);
          throw new HttpError(status, code, message);
        }

        // T-0368 (E16): dissolve double-submit.
        //
        // A create=start instance enters the BPMN at startEvent and immediately
        // waits at the «Подача заявки» (task-submit) user task — because the BPMN's
        // intent is that the initiator fills the form there. But for on_create
        // instances the CREATE FORM IS the submit: the record+data already exist
        // (just inserted above). Keeping the process waiting at task-submit means the
        // user must submit a second time — a hollow double step.
        //
        // Fix: immediately after startInstance, find the first active user task for
        // the new instance (will be task-submit). If found, auto-complete it with no
        // variables (field_mapping already injected amount into Flowable variables at
        // startInstance time). The process then advances to the triage serviceTask.
        //
        // This is best-effort: a lookup or complete failure is logged but does NOT
        // roll back the record or the started instance — the instance just waits
        // at task-submit (degraded, not broken). The BPMN is NOT modified; the
        // explicit launcher path (process-start.ts) is unaffected (it never calls
        // getFirstActiveUserTask / completeUserTask).
        try {
          const taskResult = await flowable.getFirstActiveUserTask(startResult.instanceId);
          if (taskResult.ok && taskResult.taskId !== null) {
            // Auto-complete the waiting user task (task-submit for on_create path).
            const completeResult = await flowable.completeUserTask(taskResult.taskId);
            if (!completeResult.ok) {
              // Non-fatal: log and continue — record and instance are live.
              console.warn(
                `[on_create skip-submit] completeUserTask failed for instance ` +
                  `${startResult.instanceId}, task ${taskResult.taskId}: ${completeResult.code}`,
              );
            }
          }
        } catch (skipErr) {
          // Non-fatal: skip-submit errors must NOT invalidate the committed record.
          console.warn(
            `[on_create skip-submit] unexpected error for instance ` +
              `${startResult.instanceId}:`,
            skipErr,
          );
        }

        // Projection write: best-effort, isolated by a SAVEPOINT so a projection
        // failure cannot poison the outer tx and cause the committed record+instance
        // to be lost. Mirrors process-start.ts appendProcessStarted pattern.
        await client.query('SAVEPOINT proc_proj');
        try {
          await appendProcessStarted(client as unknown as PgClientLike, {
            instanceId: startResult.instanceId,
            procKey: binding.process_key,
            actor,
            nowMs,
            tenantId,
            // T-0356 (E16): pass the just-created record id so the resolver can
            // expose it as primaryRecordId and the step-applier can write it as the
            // real cross_app_ref pointer (closes the T-0344 create-path gap).
            recordId: id,
          });
          await client.query('RELEASE SAVEPOINT proc_proj');
        } catch {
          // Projection is additive; roll back only the savepoint — record+instance remain.
          await client.query('ROLLBACK TO SAVEPOINT proc_proj');
        }
      }
    }

    // 6. Read back the joined row for the response.
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

/**
 * T-0401 [D7-3]: Paginated record list with cursor-based keyset pagination.
 *
 * Keyset: ORDER BY r.created_at DESC, r.id ASC
 * Cursor encodes (createdAt, id) of the last row on the previous page.
 * With cursor: WHERE (r.created_at, r.id) < (cursor.createdAt, cursor.id)
 * for DESC order — i.e. older rows (or same created_at with higher id).
 *
 * Tenant isolation: runs inside withTenantTx with RLS FORCE.
 * Actor isolation: caller MUST pass the actor-resolved tenantId (resolved via
 * resolveActorTenant); this function never re-resolves actor identity.
 *
 * Size limits (PD-19 §3.3):
 *   - limit clamped to [1, MAX_PAGE_SIZE] at the call site (parsePaginationParams).
 *   - Query fetches limit+1 rows to detect hasNextPage without a COUNT(*).
 */
async function listRecordsPaginated(
  pool: pg.Pool,
  tenantId: string,
  applicationId: string | null,
  registryDefId: string | null,
  limit: number,
  cursor: { createdAt: number; id: string } | null,
): Promise<RecordsPage<RecordJoinedRow>> {
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

    // Keyset pagination: for DESC created_at + ASC id, "after cursor" means:
    //   rows with created_at < cursor.createdAt
    //   OR (created_at = cursor.createdAt AND id > cursor.id)
    // This implements a stable page boundary that does not re-read previously seen rows.
    if (cursor !== null) {
      params.push(cursor.createdAt);
      const cAtParam = `$${params.length}`;
      params.push(cursor.id);
      const idParam = `$${params.length}`;
      conds.push(
        `(r.created_at < ${cAtParam} OR (r.created_at = ${cAtParam} AND r.id > ${idParam}))`,
      );
    }

    // Fetch limit+1 to detect whether a next page exists (avoid COUNT(*)).
    const clampedLimit = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
    params.push(clampedLimit + 1);
    const limitParam = `$${params.length}`;

    const res = await client.query<RecordJoinedRow>(
      `SELECT ${RECORD_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
        WHERE ${conds.join(" AND ")}
        ORDER BY r.created_at DESC, r.id ASC
        LIMIT ${limitParam}`,
      params,
    );

    const hasMore = res.rows.length > clampedLimit;
    const pageRows = hasMore ? res.rows.slice(0, clampedLimit) : res.rows;

    // Build next cursor from the last row on this page.
    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeRecordsCursor({
        createdAt: Number(last.created_at),
        id: last.id,
      });
    }

    return {
      items: pageRows,
      nextCursor,
      total: null, // COUNT(*) is expensive; omitted per PD-20 (analytics ≠ BI).
      limit: clampedLimit,
    };
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

/** Parse all query params for the records list endpoint. */
function parseRecordsListQuery(req: IncomingMessage): {
  applicationId: string | null;
  registryDefId: string | null;
  limit: number;
  cursor: { createdAt: number; id: string } | null;
} {
  const rawUrl = req.url ?? "";
  const qIdx = rawUrl.indexOf("?");
  const searchParams = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");

  // UUID filter params
  const applicationIdRaw = searchParams.get("application_id");
  if (applicationIdRaw !== null && !UUID_RE.test(applicationIdRaw)) {
    throw new HttpError(400, "VALIDATION", "application_id query param must be a valid UUID");
  }
  const registryDefIdRaw = searchParams.get("registry_def_id");
  if (registryDefIdRaw !== null && !UUID_RE.test(registryDefIdRaw)) {
    throw new HttpError(400, "VALIDATION", "registry_def_id query param must be a valid UUID");
  }

  // Pagination params (T-0401 D7-3)
  const { limit, cursor } = parsePaginationParams(searchParams);

  return {
    applicationId: applicationIdRaw,
    registryDefId: registryDefIdRaw,
    limit,
    cursor,
  };
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
  const { pool, resolveActorTenant, resolveWriteFacet, resolveFieldVisibility, flowable, emitSignal } = deps;

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
    const actor = await extractActor(req, pool);

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
      // T-0351 E16: pass the engine client (may be undefined if not wired).
      flowable,
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
  //
  // T-0401 [D7-3]: PAGINATED via cursor-based keyset (created_at DESC, id ASC).
  //   ?limit=N       — items per page (1..200, default 50)
  //   ?after=<tok>   — opaque cursor from previous page's `nextCursor` field
  //   ?application_id= — filter by application (UUID)
  //   ?registry_def_id= — filter by registry_def (UUID)
  //
  // Response shape changed (additive):
  //   { records: [...], nextCursor: string|null, limit: number }
  //   nextCursor is null on the last page.
  //
  // Tenant isolation: actor resolved → tenantId → RLS inside withTenantTx.
  // Actor narrowing: actor resolves to its own tenant only (resolveActorTenant).
  // Field-visibility (T-0419 [D7-3-FU]): applyFieldVisibilityRedaction is applied
  //   to each row's `data` BEFORE serialization. When resolveFieldVisibility is
  //   injected (production), the actor's covering grants + FieldVisibilityPolicy
  //   are resolved via the SAME GrantSource/getGrantsForSubject path used by the
  //   full PDP (single-resolver constraint — no second authority path). When the
  //   dep is absent (honest-degrade), an empty policy is used and redaction is a
  //   no-op (NF-1, byte-identical to pre-T-0419). Redacted JSONB keys are
  //   PHYSICALLY ABSENT from the response (not null, ADR §6.1 F-3).
  router.register("GET", "/api/records", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);
    const { applicationId, registryDefId, limit, cursor } = parseRecordsListQuery(req);

    const tenantId = await resolveActorTenant(actor);
    const nowMs = Date.now();

    // Resolve field-visibility context once per request (not per row).
    // Honest-degrade: no resolver → empty policy → no-op redaction (NF-1).
    const EMPTY_FV_POLICY: FieldVisibilityPolicy = { roleScopedFields: new Set() };
    let fvGrants: Grant[] = [];
    let fvPolicy: FieldVisibilityPolicy = EMPTY_FV_POLICY;
    if (resolveFieldVisibility !== undefined) {
      const fv = await resolveFieldVisibility(actor, tenantId, nowMs);
      fvGrants = fv.coveringGrants;
      fvPolicy = fv.policy;
    }

    const page = await listRecordsPaginated(pool, tenantId, applicationId, registryDefId, limit, cursor);

    // Apply field-visibility redaction to each row's data before serialization.
    // unionVisible = all keys in the row's data object (pre-T-0081 union floor:
    // the caller has already passed the covering-grant check via the DB query;
    // whole-resource semantics mean all stored keys are in unionVisible unless the
    // most-restrictive role-policy hides them). Redacted keys are physically absent.
    const serialized = page.items.map((row) => {
      const base = serializeRecord(row);
      if (fvPolicy.roleScopedFields.size === 0) {
        // Fast path: empty policy → no-op (NF-1, avoids object churn per row).
        return base;
      }
      const rawData =
        row.data !== null && typeof row.data === "object" && !Array.isArray(row.data)
          ? (row.data as Record<string, unknown>)
          : {};
      const unionVisible = new Set(Object.keys(rawData));
      const { redacted } = applyFieldVisibilityRedaction(rawData, fvGrants, unionVisible, fvPolicy);
      return { ...base, data: redacted };
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      records: serialized,
      nextCursor: page.nextCursor,
      limit: page.limit,
    }));
  }));

  // GET /api/records/:id — get one record enriched for the detail screen
  // (T-0295): includes record_schema + created_by in addition to the base
  // fields. 404 if not in the caller's tenant (RLS-filtered or does not exist).
  //
  // T-0421 [D7-3-FU]: field-visibility redaction is now applied to the detail
  // endpoint BEFORE serialization, matching the LIST behaviour (T-0419).
  // The SAME resolveFieldVisibility dep (already on RecordRoutesDeps) is reused
  // — no second authority path. When the dep is absent, applyFieldVisibilityRedaction
  // is called with an empty policy (roleScopedFields=∅) — a no-op identical to
  // pre-T-0421 behaviour (honest-degrade / NF-1). Redacted JSONB keys are
  // PHYSICALLY ABSENT from the response (not null — F-3).
  router.register(
    "GET",
    "/api/records/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "record id");

      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      const nowMs = Date.now();
      const row = await getRecordDetail(pool, tenantId, id);
      if (row === null) {
        // Not in the caller's tenant (RLS-filtered) OR does not exist → 404.
        throw new HttpError(404, "NOT_FOUND", "record not found");
      }

      // T-0421: resolve field-visibility context and apply redaction to the
      // detail record's data BEFORE serialization. Reuses the same
      // resolveFieldVisibility dep and applyFieldVisibilityRedaction helper as
      // the LIST endpoint (single-resolver constraint — no second authority path).
      const EMPTY_FV_POLICY: FieldVisibilityPolicy = { roleScopedFields: new Set() };
      let fvGrants: Grant[] = [];
      let fvPolicy: FieldVisibilityPolicy = EMPTY_FV_POLICY;
      if (resolveFieldVisibility !== undefined) {
        const fv = await resolveFieldVisibility(actor, tenantId, nowMs);
        fvGrants = fv.coveringGrants;
        fvPolicy = fv.policy;
      }

      const serialized = serializeRecordDetail(row);
      if (fvPolicy.roleScopedFields.size > 0) {
        // Fast-path: skip object churn when no role-scoped fields exist (NF-1).
        const rawData =
          row.data !== null && typeof row.data === "object" && !Array.isArray(row.data)
            ? (row.data as Record<string, unknown>)
            : {};
        const unionVisible = new Set(Object.keys(rawData));
        const { redacted } = applyFieldVisibilityRedaction(rawData, fvGrants, unionVisible, fvPolicy);
        serialized["data"] = redacted;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serialized));
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

      const actor = await extractActor(req, pool);

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

      // T-0536 [D8-R4 delivery]: the update committed → broadcast the generic
      // «record-status-changed» internal signal WITHIN the record's tenant, keyed by
      // the record id (the business key a process binds its signal-catch to). A
      // process parked on a signal-catch for this record now advances. Best-effort:
      // a failed emit never fails the 200 (the update already succeeded). Skipped
      // entirely when no emitter is wired (memory-mode — honest-degrade).
      if (emitSignal) {
        try {
          await emitSignal({
            tenantId,
            recordId: outcome.row.id,
            registryDefId: outcome.row.registry_id,
            actor,
            nowMs: Date.now(),
          });
        } catch (err) {
          console.warn("[records T-0536] record-status signal emit failed (non-fatal):", err);
        }
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeRecord(outcome.row)));
    }),
  );
}
