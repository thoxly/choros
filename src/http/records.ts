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
import { flowableErrorToHttp, type FlowableClient, type ActiveUserTask } from "../core/flowable-client.js";
import { preComputeGatewayVariable } from "../core/dmn-gateway.js";
import {
  parsePaginationParams,
  encodeRecordsCursor,
  applyFieldVisibilityRedaction,
  MAX_PAGE_SIZE,
  type RecordsPage,
} from "../core/data-access-port.js";
import type { Grant, AncestryOracle } from "../core/grant-lattice.js";
import { extractDerivedFields } from "../core/rollup-contract.js";
import { computeAllDerivedFields } from "../db/derived-fields-dao.js";
import type { FieldVisibilityPolicy } from "../core/field-visibility.js";
import { sandboxReadPredicate } from "../core/sandbox-gate.js";
import { resolveActorPrivilege, type ActorPrivilege } from "../db/sandbox-gate-dao.js";
import { isRecordReadable, type RowAncestry } from "../core/read-visibility.js";
import { roleFieldVisibility } from "../core/field-visibility.js";
import { buildFieldKeyWhitelist, translateFilters, translateSort } from "../core/view-query.js";
import type { ViewFilter, ViewSort } from "../core/view-config.js";

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

/**
 * T-0558 (sandbox gate): resolve the caller's sandbox-gate privilege — whether the
 * actor may see DRAFT (sandbox) artifacts. Mirrors the resolved-facts shape consumed
 * by core/sandbox-gate.ts (DraftVisibilityInput["actor"]).
 *
 * Production binding = resolveActorPrivilege(pool, tenantId, actorSlug) from
 * src/db/sandbox-gate-dao.ts (loadAdminContext + getGrantsForSubject, both
 * tenant-scoped + fail-closed). Injected so the unit suite can exercise the gate
 * (privileged-sees-draft / unprivileged-hidden) without a live Postgres.
 *
 * HONEST-DEGRADE: OPTIONAL on RecordRoutesDeps. When absent, the LIST/GET handlers
 * fall back to the REAL resolveActorPrivilege against the injected pool — the gate
 * is ALWAYS on the read path (it is never silently disabled). The dep exists only so
 * tests can stub the privilege resolution; production wiring may omit it.
 *
 * @param actorSlug  the caller identity (dev-user slug / OIDC sub — never a header value)
 * @param tenantId   the caller's resolved tenant
 * @param nowMs      current epoch ms (grant validity-window instant)
 */
export type ActorPrivilegeResolver = (
  actorSlug: string,
  tenantId: string,
  nowMs: number,
) => Promise<ActorPrivilege>;

/**
 * T-0570 (D3, READ-PDP): resolve the caller's READ-visibility context for the
 * records LIST/DETAIL endpoints — the actor's covering READ grants (via the
 * SAME `getGrantsForSubject`/`makeDbGrantSource` DAO the rest of the PDP uses —
 * single-resolver, FR-7) plus a per-request composite `AncestryOracle`
 * (org-hierarchy delegate + resource-hierarchy root-sentinel/inline-chain,
 * `src/db/resource-ancestry.ts`).
 *
 * Resolved ONCE per HTTP request (NOT per row, NF-1/AC-7): the LIST/DETAIL
 * handlers call this a single time, then filter the already-loaded page/row
 * in-memory via `isRecordReadable` (src/core/read-visibility.ts) — O(1) grant/
 * ancestry resolution calls per request, O(N) pure containment checks over the
 * page already in memory.
 *
 * HONEST-DEGRADE (ADR §2.3, mirrors resolveWriteFacet?/resolveFieldVisibility?/
 * resolveSandboxPrivilege?): OPTIONAL on RecordRoutesDeps. When absent, the
 * READ-PDP gate is NOT applied — the LIST/DETAIL handlers behave EXACTLY as
 * pre-T-0570 (tenant-RLS + sandbox-gate only). The gate activates the moment
 * composition root injects this resolver — which it does in the SAME commit
 * that applies migrations/117 (the default-open backfill), so the gate never
 * activates before every existing tenant has a covering grant (NF-2).
 *
 * @param actorSlug  the caller identity (dev-user slug / OIDC sub)
 * @param tenantId   the caller's resolved tenant
 * @param nowMs      current epoch ms (grant validity-window instant)
 */
export type ReadVisibilityResolver = (
  actorSlug: string,
  tenantId: string,
  nowMs: number,
) => Promise<{ grants: Grant[]; ancestry: AncestryOracle }>;

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
   * T-0558 (sandbox gate): OPTIONAL actor-privilege resolver for the runtime
   * sandbox read gate. When supplied, the LIST/GET handlers use it to decide
   * whether the caller may see DRAFT (sandbox) records; when absent they fall
   * back to the REAL resolveActorPrivilege against `pool`. Either way the
   * sandboxReadPredicate is appended to the record SELECTs (gated on the OWNING
   * APPLICATION's tier — records inherit the app's sandbox state), so a
   * non-privileged caller never sees records of a draft application. The
   * predicate is an ADDITIONAL `AND` inside withTenantTx + RLS — never a
   * replacement for the tenant scope (T-0013 isolation is sacred).
   */
  resolveSandboxPrivilege?: ActorPrivilegeResolver;
  /**
   * T-0570 (D3, READ-PDP): OPTIONAL read-visibility resolver. When supplied, the
   * LIST/GET handlers additionally filter the already-loaded page/row through
   * the SAME grant-resolver PDP that already gates actions (card-action.ts →
   * resolveFor) — a record without ANY covering READ grant (default-open or a
   * narrower one) is EXCLUDED from the list response / turns the detail 404
   * (indistinguishable from cross-tenant/not-found, FR-5/AC-1/AC-2).
   *
   * When absent (honest-degrade, NF-2): the READ-PDP filter is skipped entirely
   * — LIST/DETAIL behave byte-identically to pre-T-0570 (tenant-RLS + sandbox-
   * gate only). Production wiring injects this resolver in the SAME commit that
   * applies the migrations/117 default-open backfill, so the gate never turns on
   * before every tenant has a covering grant.
   */
  resolveReadVisibility?: ReadVisibilityResolver;
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
  /**
   * T-0606 [approval-registry-guard] (migration 122): true for a registry
   * that is engine-managed / write-protected (e.g. the "Согласование"
   * step-result projection registry step-applier.ts writes decision
   * records into). Generic CRUD create/update/delete via THIS HTTP route
   * must reject a request against such a registry — see
   * assertNotEngineManaged below. step-applier.ts's own direct DAO insert
   * does NOT go through this route at all, so it is unaffected by this
   * guard (see ADR-T0606-approval-registry-guard.md §5).
   */
  engine_managed: boolean;
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
      `SELECT id, application_id, record_schema, record_schema_version, engine_managed
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
    `SELECT id, application_id, record_schema, record_schema_version, engine_managed
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
    `SELECT id, application_id, record_schema, record_schema_version, engine_managed
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

// ---------------------------------------------------------------------------
// T-0606 [approval-registry-guard]: engine-managed write-protection guard
// ---------------------------------------------------------------------------

/**
 * Reject a generic CRUD create/update/delete against an engine-managed
 * (write-protected) registry_def with an honest 403. Called from
 * createRecord/updateRecord/deleteRecord in THIS file. The SAME check
 * (same 403 code, same message) is enforced on the OTHER live HTTP write
 * path — form submits — inside src/http/form-record-persister.ts's
 * makeFormRecordPersister (review T-0606 F-1: that path bypassed this
 * guard until it got its own check). The complete write-surface map with a
 * per-INSERT verdict lives in ADR-T0606-approval-registry-guard.md §4-bis.
 *
 * step-applier.ts's applyStepResult writes decision records via its OWN
 * direct `INSERT INTO choros.record` inside binding-trigger-dao.ts's sibling
 * module — it never calls this function or any function in this file, so it
 * is structurally unaffected by this guard (see
 * ADR-T0606-approval-registry-guard.md §5 for the isolation argument, and
 * src/__tests__/step-applier.test.ts / the write-protection DB test for a
 * live proof that applyStepResult still writes into an engine_managed
 * registry after this guard lands).
 */
function assertNotEngineManaged(reg: { engine_managed: boolean }): void {
  if (reg.engine_managed) {
    throw new HttpError(
      403,
      "REGISTRY_ENGINE_MANAGED",
      "Записи этого раздела создаёт процесс — согласуйте через задачу в Моих задачах",
    );
  }
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

    // 1b. T-0606 [approval-registry-guard]: reject generic create against an
    // engine-managed registry (e.g. "Согласование") BEFORE any validation or
    // write — this HTTP route is not a legitimate writer for such a registry
    // at all (step-applier.ts writes it via a separate, unaffected DAO path).
    assertNotEngineManaged(reg);

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
      // T-0606: scope the lookup to THIS registry (reg.id) — not just the
      // application — so an on_create binding fires only for its declared
      // trigger registry (NULL = the application's primary registry), never
      // for every registry_def sharing the same application_id.
      const binding = await getOnCreateBinding(client, tenantId, reg.application_id, reg.id);
      if (binding !== null) {
        // T-0575 [W1/деТЭЛ] BUG-016: compute derived (rollup / matrix-lookup)
        // fields of THIS registry BEFORE projecting engine variables, and overlay
        // them onto the raw `data` object so field_mapping entries that reference
        // a computed/rollup field key actually resolve to a value at start time.
        //
        // WHY: projectEngineVariables (below) reads ONLY record.data — and by PD-20
        // doctrine (derived-fields-dao.ts), derived values are NEVER stored in
        // record.data (they are computed on READ). Before this fix, an on_create
        // start's field_mapping referencing a rollup field always got `undefined`
        // (LIVE_PROOF T-0571: a 600000 rollup-sum silently vanished, sending the
        // instance down the gateway's DEFAULT branch instead of the condition
        // branch). This does NOT change storage (record.data is unaffected) — it
        // is a TRANSIENT overlay computed only for this engine-variable projection.
        //
        // SAVEPOINT isolation (mirrors dmn_precompute below): a derived-field
        // compute failure must NOT poison the outer tx or block the record+start
        // that already succeeded — degrade honestly (no derived values injected;
        // any gateway condition referencing them sees them as absent, same as
        // pre-fix behavior) rather than aborting the whole create=start.
        let projectionSource: Record<string, unknown> =
          data !== null && typeof data === "object" && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : {};
        const derivedSpecs = extractDerivedFields(reg.record_schema);
        if (derivedSpecs.length > 0) {
          await client.query('SAVEPOINT derived_precompute');
          try {
            const derived = await computeAllDerivedFields(
              client,
              tenantId,
              id,
              projectionSource,
              derivedSpecs,
            );
            // Derived values OVERLAY the raw scalar data (rollup key now has a
            // computed value instead of being absent). null-semantics ARE HONEST:
            // "no child records" → null (never coerced to 0) — a gateway condition
            // like ${amount>500000} on null evaluates false, deterministically, not
            // a silent throw (ADR-T0575 §2.4).
            projectionSource = { ...projectionSource, ...derived };
            await client.query('RELEASE SAVEPOINT derived_precompute');
          } catch (derivedErr) {
            await client.query('ROLLBACK TO SAVEPOINT derived_precompute');
            console.warn(
              `[on_create derived-precompute] non-fatal derived-field compute error for ` +
                `registry ${reg.id} record ${id}:`,
              derivedErr,
            );
          }
        }

        // Project SCALAR variables from record data (+ overlaid derived values)
        // via field_mapping. RECORD_IN_PAYLOAD: only primitives pass through;
        // objects/arrays are dropped.
        let variables = projectEngineVariables(projectionSource, binding.field_mapping);

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

        // T-0368 (E16): dissolve double-submit — T-0604 [P0/целостность
        // согласований] GATED REWRITE.
        //
        // A create=start instance enters the BPMN at startEvent and immediately
        // waits at its FIRST user task. T-0368's original assumption — "the first
        // active user task is always «Подача заявки» (task-submit)" — held only
        // for the ТЭЛ linear fixture. It is FALSE in general: a tenant-authored
        // process (data, not code) may wait at any first step (e.g. «Проверка
        // руководителем», defKey task-review). Once T-0571 fixed completeUserTask's
        // HTTP verb (it was a silent no-op before — PUT vs POST, BUG-014), this
        // unconditional assumption started SILENTLY COMPLETING REAL APPROVAL STEPS
        // with no human involved (live acceptance 2026-07-03: instances 5cf10788 /
        // 1aecce4e closed task-review in ~35ms, assignee empty).
        //
        // FIX (ADR-T0604-skip-submit-defkey.md): the on_create binding now DECLARES
        // (as DATA, migration 121 process_app_binding.submit_task_key) which BPMN
        // taskDefinitionKey is legitimately auto-completable for THIS binding.
        //   - binding.submit_task_key === null → auto-complete is NOT engaged (the
        //     safe default — every binding that never sets this explicitly, e.g.
        //     purchaseApproval, leaves its first step for a human).
        //   - non-null → auto-complete fires ONLY when the live engine's first
        //     active user-task's taskDefinitionKey EXACTLY matches the declared
        //     key (a comparison of two VALUES — the engine's live defKey and the
        //     binding's configured key — never a literal string in this code; see
        //     ci/checks/engine-drive-no-literal-defkey.sh).
        //
        // CONSOLIDATION (N4): a single flowable.getActiveUserTasks call (the same
        // engine endpoint T-0443/T-0575 BUG-015 already needed below for the
        // process.started projection's candidateGroups/name) now serves BOTH the
        // defKey gate above AND the projection read — getFirstActiveUserTask (which
        // only ever returned a bare taskId, never a defKey) is no longer called from
        // this block. This is best-effort exactly as before: an engine read failure
        // degrades to the named config-primitive fallback (resolveDefaultApproverRole/
        // Step/TaskName in appendProcessStarted) and never blocks the already-
        // committed record — the instance simply waits at whatever task the engine
        // reports (degraded, not broken). The BPMN is NOT modified; the explicit
        // launcher path (process-start.ts) is unaffected (it never calls
        // getActiveUserTasks / completeUserTask on this path).
        let firstActiveTask: ActiveUserTask | undefined;
        try {
          const tasksResult = await flowable.getActiveUserTasks(startResult.instanceId);
          if (tasksResult.ok && tasksResult.tasks.length > 0) {
            firstActiveTask = tasksResult.tasks[0];
          }
        } catch {
          // Best-effort: engine read failure → fall back to config-primitive defaults.
        }

        if (
          binding.submit_task_key !== null &&
          firstActiveTask !== undefined &&
          firstActiveTask.taskDefinitionKey === binding.submit_task_key
        ) {
          try {
            const completeResult = await flowable.completeUserTask(firstActiveTask.id);
            if (!completeResult.ok) {
              // Non-fatal: log and continue — record and instance are live.
              console.warn(
                `[on_create skip-submit] completeUserTask failed for instance ` +
                  `${startResult.instanceId}, task ${firstActiveTask.id}: ${completeResult.code}`,
              );
            }
          } catch (skipErr) {
            // Non-fatal: skip-submit errors must NOT invalidate the committed record.
            console.warn(
              `[on_create skip-submit] unexpected error for instance ` +
                `${startResult.instanceId}:`,
              skipErr,
            );
          }
        }
        // else: no declared submit_task_key, or the first active task does not
        // match it — this is NOT an error, it means "leave this task for a human"
        // (either by explicit binding config, or because the first step legitimately
        // isn't the declared submit step for this instance).

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
            // T-0575 BUG-015: real candidateGroups[0]/name when the engine yielded
            // an active user-task with non-empty values; appendProcessStarted's own
            // ?? fallback applies when these are undefined/empty.
            ...(firstActiveTask !== undefined && firstActiveTask.candidateGroups.length > 0
              ? { approverRole: firstActiveTask.candidateGroups[0] }
              : {}),
            ...(firstActiveTask !== undefined && firstActiveTask.name !== ""
              ? { step: firstActiveTask.name, taskName: firstActiveTask.name }
              : {}),
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
/**
 * T-0581 (view registry): the view-application inputs listRecordsPaginated
 * accepts, ALL optional (undefined/empty ⇒ byte-identical to pre-T-0581,
 * NF-2/AC-9/FF-VR-6). `whitelist` + `visibleFieldKeys` come from the SAME
 * record_schema/field-visibility resolution the route handler already does —
 * no second authority path (FR-7/FR-8).
 */
interface ViewApplication {
  readonly filters: readonly ViewFilter[];
  readonly sort: readonly ViewSort[];
  readonly whitelist: ReturnType<typeof buildFieldKeyWhitelist>;
  readonly visibleFieldKeys: ReadonlySet<string> | undefined;
}

/**
 * T-0581 (R-2 decision, ADR §5): keyset cursor OFFSET fallback for a CUSTOM
 * sort. The frozen `RecordsCursor` shape (data-access-port.ts) encodes
 * (createdAt, id) — the DEFAULT ordering's keyset. A custom `sort` (by an
 * arbitrary JSONB scalar) cannot reuse that keyset without teaching the
 * cursor about every possible sort key's value type, so v1 uses the ADR's
 * documented alternative: OFFSET-based "показать ещё" for the view-sort path,
 * encoded in its OWN opaque cursor shape (`{ offset: number }`) — distinct
 * from and never confused with the default RecordsCursor (different JSON
 * shape; decodeRecordsCursor's shape-guard would reject an offset-cursor,
 * and this decoder rejects a createdAt-cursor, so the two cannot cross-parse).
 * Trade-off (documented, non-blocking per ADR): an OFFSET page can duplicate/
 * skip a row if rows are inserted/deleted between page fetches — acceptable at
 * PD-20 scale (hundreds of rows per list) and explicitly the ADR's "minimum"
 * option; the DEFAULT (no custom sort) path is completely unaffected and keeps
 * the exact keyset semantics it has today.
 */
export interface OffsetCursor {
  readonly offset: number;
}

export function encodeOffsetCursor(cursor: OffsetCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeOffsetCursor(raw: string): OffsetCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")) as unknown;
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      typeof (decoded as Record<string, unknown>)["offset"] !== "number"
    ) {
      return null;
    }
    return { offset: (decoded as Record<string, unknown>)["offset"] as number };
  } catch {
    return null;
  }
}

async function listRecordsPaginated(
  pool: pg.Pool,
  tenantId: string,
  applicationId: string | null,
  registryDefId: string | null,
  limit: number,
  cursor: { createdAt: number; id: string } | null,
  actorIsPrivileged: boolean,
  viewApplication?: ViewApplication,
  offsetCursor?: OffsetCursor | null,
): Promise<RecordsPage<RecordJoinedRow>> {
  return withTenantTx(pool, tenantId, async (client) => {
    const conds: string[] = ["r.tenant_id = $1"];
    const params: unknown[] = [tenantId];

    // T-0558 (sandbox gate): hide records of a DRAFT (sandbox) application from a
    // non-privileged caller. The gate is on the OWNING APPLICATION's tier (records
    // inherit the app's sandbox state — see the `JOIN choros.application a` below).
    // sandboxReadPredicate emits a $-placeholder-FREE fragment (TRUE for privileged,
    // `a.tier = 'published'` otherwise) so it is an ADDITIONAL `AND` that never shifts
    // the caller's parameter indices and never relaxes the tenant scope (RLS + the
    // r.tenant_id guard remain). `a.tier` is a trusted code-level column constant.
    conds.push(sandboxReadPredicate({ tierColumn: "a.tier", actorIsPrivileged }).sql);

    if (applicationId !== null) {
      params.push(applicationId);
      conds.push(`rd.application_id = $${params.length}`);
    }
    if (registryDefId !== null) {
      params.push(registryDefId);
      conds.push(`r.registry_id = $${params.length}`);
    }

    // T-0581 (view registry, FR-7/NF-3/NF-6): the view-WHERE is ADDED to the
    // tenant+sandbox conds ABOVE — never replaces them (NF-3). translateFilters
    // is a pure, parameterized-SQL-fragment builder (view-query.ts); field_key
    // is whitelist-checked there, values are ALWAYS bind params (NF-6/AC-13).
    const hasCustomSort = viewApplication !== undefined && viewApplication.sort.length > 0;
    if (viewApplication !== undefined && viewApplication.filters.length > 0) {
      const viewWhere = translateFilters(
        viewApplication.filters,
        viewApplication.whitelist,
        params.length,
        viewApplication.visibleFieldKeys,
      );
      if (viewWhere.conds.length > 0) {
        conds.push(...viewWhere.conds);
        params.push(...viewWhere.params);
      }
    }

    // Keyset pagination (DEFAULT ordering only — unaffected by a custom sort,
    // R-2/NF-2): for DESC created_at + ASC id, "after cursor" means:
    //   rows with created_at < cursor.createdAt
    //   OR (created_at = cursor.createdAt AND id > cursor.id)
    // This implements a stable page boundary that does not re-read previously seen rows.
    if (!hasCustomSort && cursor !== null) {
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
    // R-2: a custom sort uses OFFSET pagination — fetch limit+1 rows starting
    // at the requested offset (still avoids COUNT(*)).
    const offsetValue = hasCustomSort && offsetCursor !== null && offsetCursor !== undefined
      ? Math.max(0, offsetCursor.offset)
      : 0;
    params.push(clampedLimit + 1);
    const limitParam = `$${params.length}`;
    let offsetParam = "";
    if (hasCustomSort) {
      params.push(offsetValue);
      offsetParam = ` OFFSET $${params.length}`;
    }

    // T-0581 (view registry, FR-6/R-3): view-ORDER BY replaces the default
    // `created_at DESC, id ASC` ONLY when a custom sort is present; the
    // secondary `r.id ASC` key is always appended by translateSort itself for
    // determinism (matches the default path's own secondary key).
    const orderBy = hasCustomSort
      ? translateSort(viewApplication!.sort, viewApplication!.whitelist).orderBy
      : "r.created_at DESC, r.id ASC";

    const res = await client.query<RecordJoinedRow>(
      `SELECT ${RECORD_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
         JOIN choros.application a
           ON a.tenant_id = rd.tenant_id AND a.id = rd.application_id
        WHERE ${conds.join(" AND ")}
        ORDER BY ${orderBy}
        LIMIT ${limitParam}${offsetParam}`,
      params,
    );

    const hasMore = res.rows.length > clampedLimit;
    const pageRows = hasMore ? res.rows.slice(0, clampedLimit) : res.rows;

    // Build next cursor from the last row on this page.
    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      if (hasCustomSort) {
        // R-2: OFFSET-cursor continuation (distinct shape from RecordsCursor).
        nextCursor = encodeOffsetCursor({ offset: offsetValue + pageRows.length });
      } else {
        const last = pageRows[pageRows.length - 1]!;
        nextCursor = encodeRecordsCursor({
          createdAt: Number(last.created_at),
          id: last.id,
        });
      }
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
  actorIsPrivileged: boolean,
): Promise<RecordDetailRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    // T-0558 (sandbox gate): a non-privileged caller cannot OPEN a record whose
    // owning application is still DRAFT (sandbox) — the row is filtered out and the
    // route returns the same honest 404 as a cross-tenant / missing record. Appended
    // as an EXTRA `AND` (gated on the owning application's tier via `JOIN
    // choros.application a`), never relaxing the tenant scope (RLS + r.tenant_id).
    const sandboxPred = sandboxReadPredicate({ tierColumn: "a.tier", actorIsPrivileged });
    const res = await client.query<RecordDetailRow>(
      `SELECT ${RECORD_DETAIL_SELECT_JOIN}
         FROM choros.record r
         JOIN choros.registry_def rd
           ON rd.tenant_id = r.tenant_id AND rd.id = r.registry_id
         JOIN choros.application a
           ON a.tenant_id = rd.tenant_id AND a.id = rd.application_id
        WHERE r.tenant_id = $1 AND r.id = $2 AND ${sandboxPred.sql}`,
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

    // 2a. T-0606 [approval-registry-guard]: reject generic update against an
    // engine-managed registry (e.g. "Согласование") before any further work.
    assertNotEngineManaged(reg);

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
// DELETE (T-0566): hard-delete one record (+ its files), audited.
// ---------------------------------------------------------------------------

/** deleteRecord outcome: not-found (404), FK-conflict (409), or deleted (204). */
type DeleteRecordOutcome =
  | { kind: "not_found" }
  | { kind: "conflict"; message: string }
  | { kind: "deleted"; registryDefId: string };

/**
 * Hard-delete a single record in ONE tenant-scoped tx (T-0566).
 *
 * Removes the record and its owned files (file_version → file → record; neither FK
 * is ON DELETE CASCADE), then appends ONE `record.deleted` audit event in-tx
 * (T-0016 hash-chain). 404 if the record is not in the caller's tenant (RLS). A
 * residual FK conflict (the record is referenced by another record's relation)
 * surfaces as { kind: "conflict" } → HTTP 409 with an honest message, never a 500.
 */
async function deleteRecord(args: {
  pool: pg.Pool;
  tenantId: string;
  id: string;
  actor: string;
  nowMs: number;
}): Promise<DeleteRecordOutcome> {
  const { pool, tenantId, id, actor, nowMs } = args;
  try {
    return await withTenantTx(pool, tenantId, async (client) => {
      // 1. Lock + read the record (tenant-scoped). Absent → 404.
      const cur = await client.query<{ registry_id: string }>(
        `SELECT registry_id FROM choros.record
          WHERE tenant_id = $1 AND id = $2
          FOR UPDATE`,
        [tenantId, id],
      );
      if (cur.rows.length === 0) {
        return { kind: "not_found" as const };
      }
      const registryId = cur.rows[0]!.registry_id;

      // 1b. T-0606 [approval-registry-guard]: reject delete of a record that
      // belongs to an engine-managed registry (e.g. a "Согласование" decision
      // record) before touching any owned files or the record row itself.
      const engineManagedRes = await client.query<{ engine_managed: boolean }>(
        `SELECT engine_managed FROM choros.registry_def
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, registryId],
      );
      assertNotEngineManaged({ engine_managed: engineManagedRes.rows[0]?.engine_managed === true });

      // 2. Delete owned files + file_versions (FK: file → record; file_version →
      //    file; neither ON DELETE CASCADE) so the record delete is not FK-blocked.
      await client.query(
        `DELETE FROM choros.file_version fv
           USING choros.file f
          WHERE fv.tenant_id = $1 AND fv.file_id = f.id AND f.tenant_id = $1
            AND f.record_id = $2`,
        [tenantId, id],
      );
      await client.query(
        `DELETE FROM choros.file WHERE tenant_id = $1 AND record_id = $2`,
        [tenantId, id],
      );

      // 3. Delete the record.
      await client.query(
        `DELETE FROM choros.record WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );

      // 4. Append ONE audit event (record.deleted) inside the same tx.
      const writer = makePgAuditWriter();
      await writer.appendAuditEvent(client as unknown as PgClientLike, {
        id: randomUUID(),
        type: "record.deleted",
        actor,
        subject: id,
        scope: { registry_def_id: registryId },
        via: "records-api",
        proposed_by: null,
        confirmed_by: actor,
        payload: { record_id: id, registry_def_id: registryId },
        occurred_at: nowMs,
      });

      return { kind: "deleted" as const, registryDefId: registryId };
    });
  } catch (err) {
    // 23503 = foreign_key_violation → the record is referenced by a relation from
    // another record. Honest 409, not a 500.
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23503") {
      return {
        kind: "conflict",
        message:
          "record cannot be deleted: it is still referenced by a relation from another record; remove the reference first",
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Query-param parsing
// ---------------------------------------------------------------------------

/**
 * T-0581 (view registry): decode a base64url-JSON `?filter=`/`?sort=` query
 * param into its raw array. Returns `null` when the param is absent; throws
 * 400 VALIDATION when present but malformed (not base64url-JSON, or not an
 * array) — a malformed inline view-param is a caller error, not a silent
 * no-op (distinct from the internal `translateFilters`/`translateSort`
 * per-item drop, which only applies to items that pass this outer shape
 * check but fail field/op/type validation deeper in the pipeline).
 */
function decodeBase64UrlJsonArray(raw: string | null, label: string): unknown[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    throw new HttpError(400, "VALIDATION", `${label} query param must be base64url-encoded JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new HttpError(400, "VALIDATION", `${label} query param must decode to a JSON array`);
  }
  return parsed;
}

/** Parse all query params for the records list endpoint. */
function parseRecordsListQuery(req: IncomingMessage): {
  applicationId: string | null;
  registryDefId: string | null;
  limit: number;
  cursor: { createdAt: number; id: string } | null;
  viewId: string | null;
  inlineFilters: ViewFilter[] | null;
  inlineSort: ViewSort[] | null;
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

  // T-0581 (view registry): ?view_id= XOR (?filter=/?sort=) — ADR §4.
  const viewIdRaw = searchParams.get("view_id");
  if (viewIdRaw !== null && !UUID_RE.test(viewIdRaw)) {
    throw new HttpError(400, "VALIDATION", "view_id query param must be a valid UUID");
  }
  const inlineFilters = decodeBase64UrlJsonArray(searchParams.get("filter"), "filter") as ViewFilter[] | null;
  const inlineSort = decodeBase64UrlJsonArray(searchParams.get("sort"), "sort") as ViewSort[] | null;
  if (viewIdRaw !== null && (inlineFilters !== null || inlineSort !== null)) {
    throw new HttpError(400, "VALIDATION", "view_id is mutually exclusive with inline filter/sort");
  }

  return {
    applicationId: applicationIdRaw,
    registryDefId: registryDefIdRaw,
    limit,
    cursor,
    viewId: viewIdRaw,
    inlineFilters,
    inlineSort,
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
  const { pool, resolveActorTenant, resolveWriteFacet, resolveFieldVisibility, resolveSandboxPrivilege, resolveReadVisibility, flowable, emitSignal } = deps;

  // T-0558 (sandbox gate): resolve whether the caller may see DRAFT (sandbox) records.
  // Honest-degrade: when no resolveSandboxPrivilege is injected, fall back to the REAL
  // tenant-scoped, fail-closed resolveActorPrivilege against `pool` — the gate is NEVER
  // silently disabled. actorIsPrivileged = owner/admin OR holds the authoring_draft grant.
  async function sandboxPrivilegedFor(
    actorSlug: string,
    tenantId: string,
    nowMs: number,
  ): Promise<boolean> {
    const priv = resolveSandboxPrivilege
      ? await resolveSandboxPrivilege(actorSlug, tenantId, nowMs)
      : await resolveActorPrivilege(pool, tenantId, actorSlug, nowMs);
    return priv.isOwnerOrAdmin || priv.hasAuthoringDraftGrant;
  }

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

  /**
   * T-0581 (view registry): resolve the ViewApplication (filters + sort +
   * field whitelist) for a GET /api/records call carrying `?view_id=` or
   * inline `?filter=`/`?sort=`. Returns `undefined` when NONE of these params
   * are present (NF-2: the caller falls back to the exact pre-T-0581 query
   * path). `fvPolicy`/`fvGrants` are the SAME per-request field-visibility
   * resolution the route already performs — reused here to build
   * `visibleFieldKeys` (FR-8/AC-7), never a second authority path.
   *
   * Requires a registry_def_id: either passed explicitly (`?registry_def_id=`)
   * or implied by the saved view's own `registry_def_id`. Without one, view
   * application is impossible (a view's config is only meaningful against ONE
   * record_schema) — this throws 400 rather than silently ignoring the param.
   */
  async function resolveViewApplication(args: {
    tenantId: string;
    registryDefIdParam: string | null;
    viewId: string | null;
    inlineFilters: ViewFilter[] | null;
    inlineSort: ViewSort[] | null;
    fvGrants: Grant[];
    fvPolicy: FieldVisibilityPolicy;
  }): Promise<ViewApplication | undefined> {
    const { tenantId, registryDefIdParam, viewId, inlineFilters, inlineSort, fvGrants, fvPolicy } = args;
    if (viewId === null && inlineFilters === null && inlineSort === null) {
      return undefined;
    }

    let effectiveRegistryDefId = registryDefIdParam;
    let filters: ViewFilter[] = inlineFilters ?? [];
    let sort: ViewSort[] = inlineSort ?? [];

    if (viewId !== null) {
      const viewRow = await withTenantTx(pool, tenantId, async (client) => {
        const res = await client.query<{ registry_def_id: string; type: string; config: unknown }>(
          `SELECT registry_def_id, type, config FROM choros.list_view WHERE tenant_id = $1 AND id = $2`,
          [tenantId, viewId],
        );
        return res.rows[0] ?? null;
      });
      if (viewRow === null) {
        throw new HttpError(404, "NOT_FOUND", "view not found");
      }
      effectiveRegistryDefId = viewRow.registry_def_id;
      const cfg = viewRow.config as { filters?: ViewFilter[]; sort?: ViewSort[] } | null;
      filters = Array.isArray(cfg?.filters) ? cfg!.filters! : [];
      sort = Array.isArray(cfg?.sort) ? cfg!.sort! : [];
    }

    if (effectiveRegistryDefId === null) {
      throw new HttpError(
        400,
        "VALIDATION",
        "registry_def_id is required to apply a filter/sort (pass ?registry_def_id= or ?view_id=)",
      );
    }

    const recordSchema = await withTenantTx(pool, tenantId, async (client) => {
      const res = await client.query<{ record_schema: unknown }>(
        `SELECT record_schema FROM choros.registry_def WHERE tenant_id = $1 AND id = $2`,
        [tenantId, effectiveRegistryDefId],
      );
      if (res.rows.length === 0) {
        throw new HttpError(404, "NOT_FOUND", `registry_def '${effectiveRegistryDefId}' not found in this tenant`);
      }
      return res.rows[0]!.record_schema;
    });

    const whitelist = buildFieldKeyWhitelist(recordSchema);

    // FR-8/AC-7: visibleFieldKeys = the record_schema's OWN field keys, run
    // through the SAME roleFieldVisibility most-restrictive filter the LIST
    // path already applies to row data — independent of any single row's
    // actual keys (a schema-level visibility set, not a per-row one), so a
    // filter over a role-hidden field is excluded from the query universally,
    // not merely when the row happens to omit that key.
    let visibleFieldKeys: ReadonlySet<string> | undefined;
    if (fvPolicy.roleScopedFields.size > 0) {
      const allSchemaKeys = new Set(whitelist.typeByKey.keys());
      const { effectiveVisible } = roleFieldVisibility(fvGrants, allSchemaKeys, fvPolicy);
      visibleFieldKeys = effectiveVisible;
    }

    return { filters, sort, whitelist, visibleFieldKeys };
  }

  // GET /api/records — list the caller-tenant's records, optionally filtered by
  // ?application_id= and/or ?registry_def_id=.
  //
  // T-0401 [D7-3]: PAGINATED via cursor-based keyset (created_at DESC, id ASC).
  //   ?limit=N       — items per page (1..200, default 50)
  //   ?after=<tok>   — opaque cursor from previous page's `nextCursor` field
  //   ?application_id= — filter by application (UUID)
  //   ?registry_def_id= — filter by registry_def (UUID)
  //
  // T-0581 (view registry): OPTIONAL ?view_id=<uuid> (apply a saved view) XOR
  //   inline ?filter=<base64url-json>&?sort=<base64url-json> — additive, never
  //   changes behaviour when absent (NF-2/AC-9). See resolveViewApplication.
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
    const { applicationId, registryDefId, limit, cursor, viewId, inlineFilters, inlineSort } = parseRecordsListQuery(req);

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

    // T-0558: resolve sandbox privilege once per request; drives the read gate below.
    const actorIsPrivileged = await sandboxPrivilegedFor(actor, tenantId, nowMs);

    // T-0581 (view registry): resolve the view application (saved view OR
    // inline filter/sort), if any of those params were passed. undefined when
    // none were — the query below then behaves EXACTLY as pre-T-0581 (NF-2).
    const viewApplication = await resolveViewApplication({
      tenantId,
      registryDefIdParam: registryDefId,
      viewId,
      inlineFilters,
      inlineSort,
      fvGrants,
      fvPolicy,
    });
    // R-2: a custom sort switches pagination to the OFFSET-cursor scheme; the
    // DEFAULT keyset cursor (`cursor`, parsed above) is reused unchanged when
    // no custom sort is present.
    const hasCustomSort = viewApplication !== undefined && viewApplication.sort.length > 0;
    const rawAfter = new URLSearchParams(
      (req.url ?? "").includes("?") ? (req.url as string).slice((req.url as string).indexOf("?") + 1) : "",
    ).get("after");
    const offsetCursor = hasCustomSort && rawAfter !== null ? decodeOffsetCursor(rawAfter) : null;

    const page = await listRecordsPaginated(
      pool,
      tenantId,
      applicationId,
      registryDefId,
      limit,
      cursor,
      actorIsPrivileged,
      viewApplication,
      offsetCursor,
    );

    // T-0570 (D3, READ-PDP): filter the already-loaded page to rows the actor
    // holds a covering READ grant for. Grants + ancestry are resolved ONCE per
    // request (NOT per row, NF-1/AC-7); containment is a pure in-memory check
    // (isRecordReadable) over the page already in hand — no per-row DB call.
    // Honest-degrade (NF-2): no resolveReadVisibility dep → filter is skipped
    // entirely, byte-identical to pre-T-0570 behaviour.
    const visibleItems = resolveReadVisibility !== undefined
      ? await (async () => {
          const { grants: readGrants, ancestry } = await resolveReadVisibility(actor, tenantId, nowMs);
          return page.items.filter((row) => {
            const rowAncestry: RowAncestry = {
              recordId: row.id,
              registryId: row.registry_id,
              applicationId: row.application_id,
            };
            return isRecordReadable(rowAncestry, readGrants, ancestry, nowMs);
          });
        })()
      : page.items;

    // Apply field-visibility redaction to each row's data before serialization.
    // unionVisible = all keys in the row's data object (pre-T-0081 union floor:
    // the caller has already passed the covering-grant check via the DB query;
    // whole-resource semantics mean all stored keys are in unionVisible unless the
    // most-restrictive role-policy hides them). Redacted keys are physically absent.
    const serialized = visibleItems.map((row) => {
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
      // T-0558: resolve sandbox privilege; a non-privileged caller cannot open a
      // record whose owning application is still DRAFT (returns the same honest 404).
      const actorIsPrivileged = await sandboxPrivilegedFor(actor, tenantId, nowMs);
      const row = await getRecordDetail(pool, tenantId, id, actorIsPrivileged);
      if (row === null) {
        // Not in the caller's tenant (RLS-filtered), draft-hidden (sandbox gate),
        // OR does not exist → 404.
        throw new HttpError(404, "NOT_FOUND", "record not found");
      }

      // T-0570 (D3, READ-PDP): a record without ANY covering READ grant (default-
      // open or narrower) gets the SAME honest 404 as not-found/cross-tenant/draft-
      // hidden (FR-5/AC-2) — indistinguishable by code or response shape, so the
      // caller cannot infer the record's existence from the denial reason. Honest-
      // degrade (NF-2): no resolveReadVisibility dep → this check is skipped
      // entirely, byte-identical to pre-T-0570 behaviour.
      if (resolveReadVisibility !== undefined) {
        const { grants: readGrants, ancestry } = await resolveReadVisibility(actor, tenantId, nowMs);
        const rowAncestry: RowAncestry = {
          recordId: row.id,
          registryId: row.registry_id,
          applicationId: row.application_id,
        };
        if (!isRecordReadable(rowAncestry, readGrants, ancestry, nowMs)) {
          throw new HttpError(404, "NOT_FOUND", "record not found");
        }
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

      // T-0407 [D7-8]: compute derived fields (rollup / matrix-lookup) on-read.
      // PD-20: aggregates are computed by the DB (GROUP BY / PK scan); the browser
      // receives the small result map. Derived values are NEVER stored in record.data
      // (schemaSlot = "derived"); they are appended here as a separate `derived` key.
      // ADR §6 / no-rollup-of-rollup: the DB query accesses raw record.data fields only.
      const derivedSpecs = extractDerivedFields(row.record_schema);
      if (derivedSpecs.length > 0) {
        const recordData =
          row.data !== null && typeof row.data === "object" && !Array.isArray(row.data)
            ? (row.data as Record<string, unknown>)
            : {};
        // Run inside a tenant-scoped transaction so RLS + explicit WHERE guard applies.
        const derivedMap = await (async () => {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(
              `SET LOCAL choros.tenant_id = '${tenantId}'`,
            );
            const result = await computeAllDerivedFields(
              client,
              tenantId,
              id,
              recordData,
              derivedSpecs,
            );
            await client.query("COMMIT");
            return result;
          } catch {
            await client.query("ROLLBACK");
            return {};
          } finally {
            client.release();
          }
        })();
        serialized["derived"] = derivedMap;
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

  // DELETE /api/records/:id — T-0566: hard-delete one record (+ its files), audited.
  //   204 on success (+ record.deleted audit);
  //   404 if the record is not in the caller's tenant (RLS-filtered or absent);
  //   403 if the caller lacks the config-edit privilege (owner/admin | authoring_draft);
  //   409 if the record is referenced by another record's relation (honest, not 500).
  router.register(
    "DELETE",
    "/api/records/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "record id");

      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      const nowMs = Date.now();

      // Authz: same privilege level as editing — owner/admin OR authoring_draft.
      // Reuses the SAME resolveActorPrivilege path the sandbox gate uses.
      const priv = resolveSandboxPrivilege
        ? await resolveSandboxPrivilege(actor, tenantId, nowMs)
        : await resolveActorPrivilege(pool, tenantId, actor, nowMs);
      if (!priv.isOwnerOrAdmin && !priv.hasAuthoringDraftGrant) {
        throw new HttpError(403, "FORBIDDEN", "not permitted to delete this record");
      }

      const outcome = await deleteRecord({ pool, tenantId, id, actor, nowMs });
      if (outcome.kind === "not_found") {
        throw new HttpError(404, "NOT_FOUND", "record not found");
      }
      if (outcome.kind === "conflict") {
        throw new HttpError(409, "CONFLICT", outcome.message);
      }

      res.statusCode = 204;
      res.end();
    }),
  );
}
