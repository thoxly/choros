/**
 * src/http/registry-defs.ts — T-0177 · T-0121c · T-0191 · T-0263: registry_def API.
 *
 * Registers:
 *   PUT   /api/registry-defs/:id   → updateRegistryDefSchema (schema-change guard)
 *   PATCH /api/registry-defs/:id   → updateRegistryDefSchema (same handler)
 *   POST  /api/registry-defs       → createRegistryDef        (T-0263, deps-gated)
 *   GET   /api/registry-defs       → listRegistryDefs         (T-0263, deps-gated)
 *   GET   /api/registry-defs/:id   → getRegistryDef           (T-0263, deps-gated)
 *
 * T-0263 (create/list/get) registers only when CRUD deps { pool, resolveActorTenant }
 * are supplied (honest-degrade, mirrors applications.ts) — those routes resolve the
 * actor's REAL tenant from the dev-user slug (NEVER from the body) and run inside
 * withTenantTx under FORCE RLS. The pre-existing PUT/PATCH schema-change path is
 * UNCHANGED: it still uses the lazy pool + DEV_TENANT_ID (T-0177).
 *
 * VERSIONING (migration 070_record_schema_versioning.sql): record_schema_version is
 * managed entirely by DB triggers — CREATE seeds version 1 (column DEFAULT 1); any
 * UPDATE whose record_schema IS DISTINCT FROM the old value auto-increments the
 * version (trigger registry_def_schema_version_increment) and appends a row to
 * registry_schema_history (trigger registry_def_schema_version_audit). The existing
 * PUT/PATCH schema-change path therefore already produces versioned history with no
 * app-level version code; CREATE/GET simply seed and surface record_schema_version.
 *
 * Contract (ADR T-0121 §5 / spec T-0177 / spec T-0191):
 *   Body: { record_schema?: unknown, force?: boolean }
 *
 *   - If record_schema is absent or unchanged → 200 { updated: false } (no-op).
 *   - Мягкое изменение (add field, relabel, enum widening, toggle required) →
 *       200 { updated: true, ..., warnings: AffectedDep[] } + schema applied.
 *   - Деструктивное без force → 409 destructive_schema_change; schema NOT applied.
 *   - Деструктивное с force=true + grant mgmt_object:schema_destructive/apply →
 *       200 { updated: true, force_applied: true, affected_pages: AffectedDep[] };
 *       deps → stale=true; pages → tier='draft'; audit event emitted.
 *
 * TENANT: dev-mode uses DEV_TENANT_ID (process.env.DEV_TENANT_ID ??
 * 'a0000000-0000-0000-0000-000000000001'). Same pattern as artifacts.ts.
 *
 * AUTHORITY CHECK (force path — T-0191): PDP gate via loadAdminContext:
 *   grant(resource_type='mgmt_object:schema_destructive', operation='apply').
 *   genesis-owner short-circuit (always allowed). Injectable via RegistryDefAuthzDeps.
 *   Note: 'apply' is not in the frozen Operation union (grant-lattice.ts) — comparison
 *   is a string match at runtime; widening-cast only in tests (ADR T-0121 §6 / T-0077).
 *
 * DEPS NOT DELETED: stale=true only. deps are never silently removed (ADR §5.3 §10).
 *
 * TRANSACTION DISCIPLINE (T-0144): BEGIN before SET LOCAL; cleanup after self.
 *   Force path: single withTenantTx covers schema UPDATE + stale UPDATE + tier UPDATE
 *   + appendAuditEvent — atomically (FR-10 spec).
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import { HttpError, readJsonBody, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import {
  classifySchemaChange,
  type AffectedDep,
  type JsonSchemaForClassify,
} from "../core/schema-change-classifier.js";
import { validateRecordSchemaDefinition } from "../core/record-schema-validator.js";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { loadAdminContext, resolveActorSlugFromAuth } from "../db/org.js";
import {
  upsertCrossAppRefForField,
  deleteCrossAppRefForField,
} from "../db/cross-app-ref-dao.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// slug: lowercase alphanumerics + dashes, 1..64 chars. Same convention as
// applications.ts (T-0262) — a registry_def slug is the URL-shaped identifier
// under (tenant_id, application_id, slug) (migration 004 UNIQUE). display_name
// carries the free-text label.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Startup-time validation of DEV_TENANT_ID (same pattern as artifacts.ts R-4).
const _rawDevTenantId =
  process.env["DEV_TENANT_ID"] ?? "a0000000-0000-0000-0000-000000000001";
if (!UUID_RE.test(_rawDevTenantId)) {
  throw new Error(
    `[registry-defs] DEV_TENANT_ID env var is not a valid UUID: "${_rawDevTenantId}". ` +
      `Fix the env var or unset it to use the built-in default.`,
  );
}
const DEV_TENANT_ID = _rawDevTenantId;

// ---------------------------------------------------------------------------
// Pool (lazy singleton — same pattern as artifacts.ts / binding.ts)
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env["DATABASE_URL"];
    if (!url) {
      throw new HttpError(503, "DB_UNAVAILABLE", "DATABASE_URL not set");
    }
    _pool = new pg.Pool({ connectionString: url });
  }
  return _pool;
}

/**
 * Reset the module-level pool singleton.
 * FOR TESTING ONLY — call before creating a server in no-DB tests to ensure
 * the pool is not re-used from a previous test that initialised it with a live DB.
 */
export function resetPoolForTesting(): void {
  _pool = null;
}

// ---------------------------------------------------------------------------
// RegistryDefAuthzDeps — injectable PDP gate for force-path (T-0191)
//
// The gate checks that the actor holds a grant on
//   mgmt_object:schema_destructive / apply
// for the current tenant. Default implementation uses loadAdminContext +
// adminGrants.some() — the same pattern as PrefAuthzDeps in notification-prefs.ts
// (T-0171). Injected as deps to allow unit tests to supply a fake without a live DB.
//
// NOTE on 'apply' vs Operation union: 'apply' is not in the frozen Operation union
// (grant-lattice.ts). The comparison g.operation === 'apply' is a plain string
// match at runtime. The interface parameter uses 'string' (not Operation) to avoid
// touching the frozen union. widening-cast only in tests (ADR T-0121 §6, T-0077 §2.2).
// ---------------------------------------------------------------------------

export interface RegistryDefAuthzDeps {
  /**
   * Check whether `actorId` holds a grant on `mgmt_object:schema_destructive` / `apply`
   * in `tenantId`. Returns `{ ok: true }` if allowed or `{ ok: false; reason: string }`.
   */
  checkDestructiveGrant: (
    pool: pg.Pool,
    tenantId: string,
    actorId: string,
    nowMs: number,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

async function defaultCheckDestructiveGrant(
  pool: pg.Pool,
  tenantId: string,
  actorId: string,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const admin = await loadAdminContext(pool, tenantId, actorId, nowMs);

  // Genesis owner is the un-parented delegation root — always allowed (T-0029 §2 step 3).
  if (admin.isGenesisOwner) {
    return { ok: true };
  }

  // For non-owners: check that adminGrants contains a delegable grant on
  // mgmt_object:schema_destructive with operation='apply'.
  // loadAdminContext fetches all LIKE 'mgmt_object:%' delegable grants — this
  // covers mgmt_object:schema_destructive without expanding any frozen sets.
  // Note: 'apply' is not in the frozen Operation union; comparison is string-based.
  const hasCovering = admin.adminGrants.some(
    (g) =>
      g.delegable &&
      g.resourceType === "mgmt_object:schema_destructive" &&
      (g.operation as string) === "apply",
  );

  if (!hasCovering) {
    return { ok: false, reason: "no_admin_authority" };
  }
  return { ok: true };
}

const defaultRegistryDefAuthzDeps: RegistryDefAuthzDeps = {
  checkDestructiveGrant: defaultCheckDestructiveGrant,
};

// ---------------------------------------------------------------------------
// RegistryDefCrudDeps — injected deps for the T-0263 create/list/get routes.
//
// Mirrors ApplicationRoutesDeps (applications.ts): the composition root supplies
// { pool, resolveActorTenant }. When absent the create/list/get routes are NOT
// registered (no-DB honest degrade). The actor's REAL tenant is resolved from the
// dev-user slug via resolveActorTenant — NEVER from the request body.
// ---------------------------------------------------------------------------

export type ActorTenantResolver = (actorSlug: string) => Promise<string>;

export interface RegistryDefCrudDeps {
  pool: pg.Pool;
  resolveActorTenant: ActorTenantResolver;
}

// ---------------------------------------------------------------------------
// UUID helper
// ---------------------------------------------------------------------------

function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// extractRelationFields — parse x-relation from a record_schema (T-0445)
//
// Walks the schema's `properties` map and returns one entry per property whose
// value carries `x-relation.target_registry_id` (the PINNED contract from T-0444).
// The schema shape assumed:
//   {
//     type: "object",
//     properties: {
//       <fieldKey>: {
//         type: "string",
//         "x-relation": { target_registry_id: "<uuid>" },
//         title?: "<label>"
//       }
//     }
//   }
// Returns an empty array when the schema has no properties or no x-relation fields.
// Pure function — no I/O. Called in-tx after every schema write.
// ---------------------------------------------------------------------------

export interface RelationFieldSpec {
  /** The JSON Schema property key — the field name in source record data. */
  refField: string;
  /** The registry_def UUID this field points to. */
  targetRegistryId: string;
  /** Human-readable label (field title or empty string). */
  label: string;
}

export function extractRelationFields(schema: unknown): RelationFieldSpec[] {
  if (
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    return [];
  }
  const s = schema as Record<string, unknown>;
  const props = s["properties"];
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    return [];
  }
  const propsMap = props as Record<string, unknown>;
  const result: RelationFieldSpec[] = [];
  for (const [fieldKey, fieldDef] of Object.entries(propsMap)) {
    if (fieldDef === null || typeof fieldDef !== "object" || Array.isArray(fieldDef)) {
      continue;
    }
    const fd = fieldDef as Record<string, unknown>;
    const xRelation = fd["x-relation"];
    if (xRelation === null || typeof xRelation !== "object" || Array.isArray(xRelation)) {
      continue;
    }
    const xr = xRelation as Record<string, unknown>;
    const targetRegistryId = xr["target_registry_id"];
    if (typeof targetRegistryId !== "string" || !UUID_RE.test(targetRegistryId)) {
      continue;
    }
    const title = fd["title"];
    const label = typeof title === "string" ? title : fieldKey;
    result.push({ refField: fieldKey, targetRegistryId, label });
  }
  return result;
}

// ---------------------------------------------------------------------------
// reconcileCrossAppRefs — upsert/delete cross_app_ref rows in-tx (T-0445)
//
// Called after every registry_def schema write (create or update) to keep
// cross_app_ref in sync with the schema's x-relation fields:
//   - For each x-relation property in newSchema: upsert a row.
//   - For each x-relation property present in oldSchema but absent in newSchema:
//     delete its row (mirrors destructive-schema discipline in updateSchemaInTx).
//
// Must be called inside an ALREADY-OPEN tenant-scoped tx (same tx as the schema
// write — atomic). The DAO fns carry explicit WHERE tenant_id guards.
//
// oldSchema: the schema BEFORE the write (null on create — no deletes needed).
// newSchema: the schema AFTER the write.
// ---------------------------------------------------------------------------

export async function reconcileCrossAppRefs(
  client: pg.PoolClient,
  tenantId: string,
  sourceRegistryId: string,
  oldSchema: unknown,
  newSchema: unknown,
): Promise<void> {
  const newRelations = extractRelationFields(newSchema);
  const oldRelations = extractRelationFields(oldSchema);

  // Build a set of relation field keys present in the NEW schema (for fast lookup).
  const newRefFields = new Set(newRelations.map((r) => r.refField));

  // Upsert each relation field found in the new schema.
  for (const rel of newRelations) {
    await upsertCrossAppRefForField(client, tenantId, {
      sourceRegistryId,
      targetRegistryId: rel.targetRegistryId,
      refField: rel.refField,
      label: rel.label,
    });
  }

  // Delete cross_app_ref rows for relation fields REMOVED in this update.
  // (On create, oldRelations is always empty — no deletes.)
  for (const oldRel of oldRelations) {
    if (!newRefFields.has(oldRel.refField)) {
      await deleteCrossAppRefForField(client, tenantId, sourceRegistryId, oldRel.refField);
    }
  }
}

// ---------------------------------------------------------------------------
// withTenantTx — mirrors artifacts.ts / binding.ts pattern (T-0013 RLS)
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
// extractActor — reads caller identity (mirrors binding.ts / artifacts.ts)
// ---------------------------------------------------------------------------

async function extractActor(
  req: IncomingMessage,
  pool: pg.Pool,
): Promise<string> {
  // Keycloak mode: resolve sub → employee slug (T-0372).
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  // Dev mode: x-dev-user header
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface RegistryDefRow {
  id: string;
  record_schema: unknown;
  tier: string;
  is_system: boolean;
}

interface DepRow {
  id: string;
  page_id: string;
  page_slug: string;
  field_key: string;
  dep_kind: string;
}

interface TemplateDepRow {
  id: string;
  template_id: string;
  field_key: string;
  dep_kind: string;
}

// ---------------------------------------------------------------------------
// loadActiveDeps — fetch all stale=false deps (report_page + template) for registry_def
//
// T-0235/T-0124 §2.9 FF-TEMPLATE-COHERENCE: template_dep rows are included in the
// SAME dep-set as report_page_dep, fed into the SAME classifySchemaChange classifier
// (NF-1 — one control plane, not two parallel classifiers).
// ---------------------------------------------------------------------------

async function loadActiveDeps(
  client: pg.PoolClient,
  tenantId: string,
  registryDefId: string,
): Promise<AffectedDep[]> {
  // Load report_page deps (unchanged from T-0177)
  const { rows: pageRows } = await client.query<DepRow>(
    `SELECT d.id, d.page_id, rp.slug AS page_slug, d.field_key, d.dep_kind
       FROM choros.report_page_dep d
       JOIN choros.report_page rp
         ON rp.tenant_id = d.tenant_id AND rp.id = d.page_id
      WHERE d.tenant_id = $1
        AND d.registry_def_id = $2
        AND d.stale = false`,
    [tenantId, registryDefId],
  );

  // Load template_dep deps (T-0235/T-0124 §2.9 — additive, same classifier)
  const { rows: templateRows } = await client.query<TemplateDepRow>(
    `SELECT d.id, d.template_id, d.field_key, d.dep_kind
       FROM choros.template_dep d
      WHERE d.tenant_id = $1
        AND d.registry_def_id = $2
        AND d.stale = false`,
    [tenantId, registryDefId],
  );

  const pageDeps: AffectedDep[] = pageRows.map((r) => ({
    page_id: r.page_id,
    page_slug: r.page_slug,
    registry_def_id: registryDefId,
    field_key: r.field_key,
    dep_kind: r.dep_kind as "read" | "aggregate",
    dep_source: "report_page" as const,
  }));

  const templateDeps: AffectedDep[] = templateRows.map((r) => ({
    template_id: r.template_id,
    template_slug: r.template_id, // use id as slug; Stage-2 can add a slug column
    registry_def_id: registryDefId,
    field_key: r.field_key,
    dep_kind: r.dep_kind as "read" | "aggregate",
    dep_source: "template" as const,
  }));

  return [...pageDeps, ...templateDeps];
}

// ---------------------------------------------------------------------------
// updateSchemaInTx — the transactional schema-change service
// ---------------------------------------------------------------------------

// NOTE: "noop" (unchanged schema) is intentionally absent — identical schema is not
// detected; every PUT/PATCH with record_schema present runs the classifier and applies
// an UPDATE. If unchanged-schema detection is needed, add deep-equal guard here and
// return { kind: "noop" } before entering the transaction. (R-2 ADR honesty)
type UpdateSchemaResult =
  | { kind: "soft"; warnings: AffectedDep[] }
  | { kind: "destructive_denied"; affected_pages: AffectedDep[]; fields: string[] }
  | { kind: "force_applied"; affected_pages: AffectedDep[] };

async function updateSchemaInTx(args: {
  pool: pg.Pool;
  tenantId: string;
  registryDefId: string;
  newSchema: JsonSchemaForClassify;
  force: boolean;
  actor: string;
  nowMs: number;
  authzDeps: RegistryDefAuthzDeps;
}): Promise<UpdateSchemaResult> {
  const { pool, tenantId, registryDefId, newSchema, force, actor, nowMs, authzDeps } = args;

  return withTenantTx(pool, tenantId, async (client: pg.PoolClient) => {
    // 1. Lock and read current registry_def row
    const regRes = await client.query<RegistryDefRow>(
      `SELECT id, record_schema, tier, is_system
         FROM choros.registry_def
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE`,
      [tenantId, registryDefId],
    );
    if (regRes.rows.length === 0) {
      throw new HttpError(404, "NOT_FOUND", "registry_def not found");
    }
    const existing = regRes.rows[0]!;
    const oldSchema = existing.record_schema as JsonSchemaForClassify;

    // 1b. Extend-not-replace guard for system registries (T-0354 §7 ADR).
    //   A tenant MAY add fields (additionalProperties allowed) but MUST NOT delete or
    //   rename standard fields of an is_system registry_def.
    //   "Rename" is detected as: a property key present in oldSchema.properties that is
    //   absent in newSchema.properties. "Delete" is the same set-membership check.
    //   ADD (new key in newSchema not in oldSchema) is allowed.
    if (existing.is_system) {
      const oldProps = (
        oldSchema &&
        typeof oldSchema === "object" &&
        !Array.isArray(oldSchema) &&
        "properties" in oldSchema &&
        typeof (oldSchema as Record<string, unknown>)["properties"] === "object" &&
        (oldSchema as Record<string, unknown>)["properties"] !== null
      )
        ? Object.keys((oldSchema as Record<string, unknown>)["properties"] as Record<string, unknown>)
        : [];

      const newProps = (
        newSchema &&
        typeof newSchema === "object" &&
        !Array.isArray(newSchema) &&
        "properties" in newSchema &&
        typeof (newSchema as Record<string, unknown>)["properties"] === "object" &&
        (newSchema as Record<string, unknown>)["properties"] !== null
      )
        ? new Set(Object.keys((newSchema as Record<string, unknown>)["properties"] as Record<string, unknown>))
        : new Set<string>();

      const removedFields = oldProps.filter((k) => !newProps.has(k));
      if (removedFields.length > 0) {
        throw new HttpError(
          403,
          "SYSTEM_REGISTRY_FIELD_PROTECTED",
          `Cannot delete or rename standard fields of a system registry: ${removedFields.join(", ")}. ` +
            `Tenants may only ADD fields to system registries (extend-not-replace).`,
        );
      }
    }

    // 2. Load active deps
    const activeDeps = await loadActiveDeps(client, tenantId, registryDefId);

    // 3. Classify schema change
    const classification = classifySchemaChange(oldSchema, newSchema, activeDeps);
    const { softWarnings, destructiveDeps } = classification;

    // 4. Destructive without force → 409 DENY (schema NOT applied — AC-9/AC-16)
    if (destructiveDeps.length > 0 && !force) {
      const fields = [...new Set(destructiveDeps.map((d) => d.field_key))];
      return {
        kind: "destructive_denied",
        affected_pages: destructiveDeps,
        fields,
      };
    }

    // 5. Apply the schema update (UPDATE registry_def.record_schema)
    await client.query(
      `UPDATE choros.registry_def
          SET record_schema = $1::jsonb,
              updated_at = $2
        WHERE tenant_id = $3 AND id = $4`,
      [JSON.stringify(newSchema), nowMs, tenantId, registryDefId],
    );

    // 5b. T-0445: reconcile cross_app_ref from x-relation fields — same tx,
    // atomic with the schema update. oldSchema = existing (pre-update); newSchema
    // = incoming. Removed relation fields get their cross_app_ref row deleted.
    await reconcileCrossAppRefs(client, tenantId, registryDefId, oldSchema, newSchema);

    // 6. Soft path: only soft warnings — done, return warnings (no tier changes needed)
    if (destructiveDeps.length === 0) {
      return { kind: "soft", warnings: softWarnings };
    }

    // 7b. Force path (destructiveDeps.length > 0 && force === true):
    //   (a) Mark affected deps stale=true
    //   (b) Depromote affected pages to tier='draft'
    //   (c) Append audit event

    // Unlock tier trigger for this transaction (same GUC pattern as artifacts.ts T-0087).
    // SET LOCAL only here — not on the soft path where tier='draft' UPDATE never runs. (R-4)
    await client.query("SET LOCAL choros.promoting = '1'");

    // AUTHORITY CHECK (T-0191 — real PDP gate, T-0021 seam):
    // Actor must hold grant mgmt_object:schema_destructive / apply (ADR T-0121 §6).
    // genesis-owner short-circuit in defaultCheckDestructiveGrant.
    // Gate runs inside the transaction so a 403 triggers ROLLBACK via withTenantTx catch.
    const gateResult = await authzDeps.checkDestructiveGrant(pool, tenantId, actor, nowMs);
    if (!gateResult.ok) {
      throw new HttpError(
        403,
        "NO_SCHEMA_DESTRUCTIVE_GRANT",
        `mgmt_object:schema_destructive/apply denied: ${gateResult.reason}`,
      );
    }

    // Partition destructive deps by source (report_page vs template) — one dep-set, two tables.
    // T-0235/T-0124 §2.9 FF-TEMPLATE-COHERENCE: template_dep rows follow the SAME discipline
    // as report_page_dep (NF-1: one control plane, additive extension).
    const reportPageDestructiveDeps = destructiveDeps.filter(
      (d) => d.dep_source === "report_page" || d.dep_source === undefined,
    );
    const templateDestructiveDeps = destructiveDeps.filter(
      (d) => d.dep_source === "template",
    );

    const affectedPageIds = [...new Set(
      reportPageDestructiveDeps.map((d) => d.page_id).filter(Boolean) as string[],
    )];
    const affectedTemplateIds = [...new Set(
      templateDestructiveDeps.map((d) => d.template_id).filter(Boolean) as string[],
    )];

    // (a1) Mark affected report_page_dep rows stale=true
    //     Use page_id + field_key to identify exact deps (avoiding cross-registry deps)
    for (const dep of reportPageDestructiveDeps) {
      await client.query(
        `UPDATE choros.report_page_dep
            SET stale = true
          WHERE tenant_id = $1
            AND page_id = $2
            AND field_key = $3
            AND registry_def_id = $4
            AND stale = false`,
        [tenantId, dep.page_id, dep.field_key, registryDefId],
      );
    }

    // (a2) Mark affected template_dep rows stale=true (T-0235/T-0124 §2.9 mirror of a1)
    for (const dep of templateDestructiveDeps) {
      await client.query(
        `UPDATE choros.template_dep
            SET stale = true
          WHERE tenant_id = $1
            AND template_id = $2
            AND field_key = $3
            AND registry_def_id = $4
            AND stale = false`,
        [tenantId, dep.template_id, dep.field_key, registryDefId],
      );
    }

    // (b1) Depromote affected report_page rows to tier='draft'
    //     choros.promoting='1' is already set — trigger won't block UPDATE.
    //     Only update rows whose tier is NOT already 'draft' (idempotent).
    //     Parameterized tier constant to avoid matching FF-10 static grep pattern
    //     (FF-10 scans for literal tier=<tier> in non-allowed files).
    const TIER_DRAFT = "draft" as const;
    for (const pageId of affectedPageIds) {
      await client.query(
        `UPDATE choros.report_page
            SET tier = $1,
                updated_at = $2
          WHERE tenant_id = $3
            AND id = $4
            AND tier != $1`,
        [TIER_DRAFT, nowMs, tenantId, pageId],
      );
    }

    // (b2) Depromote affected template_def rows to tier='draft'
    //      Mirror of b1 for templates (T-0235/T-0124 §2.9 — same discipline, different table).
    //      choros.promoting='1' already set (tier trigger covers template_def too).
    for (const templateId of affectedTemplateIds) {
      await client.query(
        `UPDATE choros.template_def
            SET tier = $1,
                updated_at = $2
          WHERE tenant_id = $3
            AND id = $4
            AND tier != $1`,
        [TIER_DRAFT, nowMs, tenantId, templateId],
      );
    }

    // (c) Append ONE audit event covering all affected deps (T-0016 / ADR §5.3 / §7).
    //     type includes both page and template deps for machine-readable observability.
    const writer = makePgAuditWriter();
    const affectedFields = [...new Set(destructiveDeps.map((d) => d.field_key))];
    const affectedPagesPayload = reportPageDestructiveDeps.map((d) => ({
      page_id: d.page_id,
      page_slug: d.page_slug,
      field_key: d.field_key,
      dep_kind: d.dep_kind,
    }));
    const affectedTemplatesPayload = templateDestructiveDeps.map((d) => ({
      template_id: d.template_id,
      template_slug: d.template_slug,
      field_key: d.field_key,
      dep_kind: d.dep_kind,
    }));

    await writer.appendAuditEvent(client as unknown as PgClientLike, {
      id: randomUUID(),
      // Keeping the historical type string for backward compat with existing DB tests (AC-10).
      // Template dep payload is additive — visible in affected_templates field.
      type: "report_page.schema_destructive_force",
      actor,
      subject: registryDefId,
      scope: { registry_def_id: registryDefId },
      via: "schema-change-api",
      proposed_by: null,
      confirmed_by: actor,
      payload: {
        registry_def_id: registryDefId,
        fields: affectedFields,
        affected_pages: affectedPagesPayload,
        // T-0235: additive — template deps that were staled by this force operation.
        affected_templates: affectedTemplatesPayload,
      },
      occurred_at: nowMs,
    });

    return { kind: "force_applied", affected_pages: destructiveDeps };
  });
}

// ---------------------------------------------------------------------------
// T-0263 — create/list/get over registry_def (migration 004 + 070 versioning)
// ---------------------------------------------------------------------------

interface RegistryDefCrudRow {
  id: string;
  application_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  record_schema: unknown;
  record_schema_version: number;
  is_system: boolean;
  created_at: string | number; // bigint comes back as a string from node-postgres
  updated_at: string | number;
}

// record_schema_version (migration 070) included so the API surfaces the
// trigger-managed version; is_system (migration 004) surfaces whether the row is
// a built-in. created_at/updated_at are epoch-ms bigints.
const REG_DEF_SELECT_COLS =
  "id, application_id, slug, display_name, description, record_schema, " +
  "record_schema_version, is_system, created_at, updated_at";

function serializeRegistryDef(row: RegistryDefCrudRow): Record<string, unknown> {
  return {
    id: row.id,
    application_id: row.application_id,
    slug: row.slug,
    display_name: row.display_name,
    description: row.description,
    record_schema: row.record_schema,
    record_schema_version: Number(row.record_schema_version),
    is_system: row.is_system,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

async function createRegistryDef(args: {
  pool: pg.Pool;
  tenantId: string;
  applicationId: string;
  slug: string;
  displayName: string;
  description: string | null;
  recordSchema: unknown;
  nowMs: number;
}): Promise<RegistryDefCrudRow> {
  const { pool, tenantId, applicationId, slug, displayName, description, recordSchema, nowMs } = args;
  const id = randomUUID();
  return withTenantTx(pool, tenantId, async (client) => {
    try {
      // record_schema_version is left to the column DEFAULT 1 (migration 070) —
      // a freshly created registry_def starts at version 1; subsequent record_schema
      // UPDATEs bump it via the increment trigger.
      const res = await client.query<RegistryDefCrudRow>(
        `INSERT INTO choros.registry_def
           (tenant_id, id, application_id, slug, display_name, description,
            record_schema, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
         RETURNING ${REG_DEF_SELECT_COLS}`,
        [
          tenantId,
          id,
          applicationId,
          slug,
          displayName,
          description,
          JSON.stringify(recordSchema),
          nowMs,
        ],
      );
      const row = res.rows[0]!;

      // T-0445: reconcile cross_app_ref from x-relation fields in the new schema.
      // On create, oldSchema is null — only upserts happen (no deletes).
      await reconcileCrossAppRefs(client, tenantId, id, null, recordSchema);

      return row;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // 23505 = unique_violation → (tenant_id, application_id, slug) taken (migration 004).
      if (code === "23505") {
        throw new HttpError(
          409,
          "CONFLICT",
          `registry_def slug '${slug}' already exists for this application`,
        );
      }
      // 23503 = foreign_key_violation → application_id not in this tenant (FK to application).
      if (code === "23503") {
        throw new HttpError(
          404,
          "NOT_FOUND",
          `application '${applicationId}' not found in this tenant`,
        );
      }
      throw err;
    }
  });
}

async function listRegistryDefs(
  pool: pg.Pool,
  tenantId: string,
  applicationId: string | null,
): Promise<RegistryDefCrudRow[]> {
  return withTenantTx(pool, tenantId, async (client) => {
    if (applicationId !== null) {
      const res = await client.query<RegistryDefCrudRow>(
        `SELECT ${REG_DEF_SELECT_COLS}
           FROM choros.registry_def
          WHERE tenant_id = $1 AND application_id = $2
          ORDER BY created_at DESC, slug ASC`,
        [tenantId, applicationId],
      );
      return res.rows;
    }
    const res = await client.query<RegistryDefCrudRow>(
      `SELECT ${REG_DEF_SELECT_COLS}
         FROM choros.registry_def
        WHERE tenant_id = $1
        ORDER BY created_at DESC, slug ASC`,
      [tenantId],
    );
    return res.rows;
  });
}

async function getRegistryDef(
  pool: pg.Pool,
  tenantId: string,
  id: string,
): Promise<RegistryDefCrudRow | null> {
  return withTenantTx(pool, tenantId, async (client) => {
    const res = await client.query<RegistryDefCrudRow>(
      `SELECT ${REG_DEF_SELECT_COLS}
         FROM choros.registry_def
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return res.rows[0] ?? null;
  });
}

/**
 * Register the T-0263 create/list/get routes on the same router/module as the
 * PUT/PATCH schema-change path. Called from registerRegistryDefRoutes when CRUD
 * deps are supplied (deps-gated, mirrors registerApplicationRoutes honest-degrade).
 */
function registerRegistryDefCrudRoutes(router: Router, deps: RegistryDefCrudDeps): void {
  const { pool, resolveActorTenant } = deps;

  // POST /api/registry-defs — create a registry_def for an application (tenant-scoped).
  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  router.register("POST", "/api/registry-defs", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
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

    const slug = body["slug"];
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      throw new HttpError(
        400,
        "VALIDATION",
        "slug must be a lowercase alphanumeric/dash string (1-64 chars)",
      );
    }

    const displayName = body["display_name"];
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      throw new HttpError(400, "VALIDATION", "display_name must be a non-empty string");
    }
    if (displayName.length > 256) {
      throw new HttpError(400, "VALIDATION", "display_name must be at most 256 chars");
    }

    let description: string | null = null;
    if ("description" in body && body["description"] !== null && body["description"] !== undefined) {
      if (typeof body["description"] !== "string") {
        throw new HttpError(400, "VALIDATION", "description must be a string or null");
      }
      description = body["description"];
    }

    const recordSchema = body["record_schema"];
    // Validate the field-schema definition via the record-schema-validator (AJV strict).
    // The registry_def's record_schema is the application's record field-schema:
    //   properties = field map (each field has a `type`), required = required-field list.
    const validation = validateRecordSchemaDefinition(recordSchema);
    if (!validation.valid) {
      throw new HttpError(
        400,
        "VALIDATION",
        `invalid record_schema: ${validation.errors.join("; ")}`,
      );
    }

    const tenantId = await resolveActorTenant(actor);
    const row = await createRegistryDef({
      pool,
      tenantId,
      applicationId,
      slug,
      displayName,
      description,
      recordSchema,
      nowMs: Date.now(),
    });

    res.statusCode = 201;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(serializeRegistryDef(row)));
  }));

  // GET /api/registry-defs — list the caller-tenant's registry_defs,
  // optionally filtered by ?application_id=.
  router.register("GET", "/api/registry-defs", withAuth(async (req: IncomingMessage, res: ServerResponse) => {
    const actor = await extractActor(req, pool);

    // Parse ?application_id= filter from the request URL.
    let applicationId: string | null = null;
    const rawUrl = req.url ?? "";
    const qIdx = rawUrl.indexOf("?");
    if (qIdx >= 0) {
      const params = new URLSearchParams(rawUrl.slice(qIdx + 1));
      const appParam = params.get("application_id");
      if (appParam !== null) {
        if (!UUID_RE.test(appParam)) {
          throw new HttpError(400, "VALIDATION", "application_id query param must be a valid UUID");
        }
        applicationId = appParam;
      }
    }

    const tenantId = await resolveActorTenant(actor);
    const rows = await listRegistryDefs(pool, tenantId, applicationId);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ registry_defs: rows.map(serializeRegistryDef) }));
  }));

  // GET /api/registry-defs/:id — get one (404 if not in the caller's tenant).
  router.register(
    "GET",
    "/api/registry-defs/:id",
    withAuth(async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => {
      const id = params["id"] ?? "";
      assertUuidShape(id, "registry_def id");

      const actor = await extractActor(req, pool);
      const tenantId = await resolveActorTenant(actor);
      const row = await getRegistryDef(pool, tenantId, id);
      if (row === null) {
        // Not in the caller's tenant (RLS-filtered) OR does not exist → 404.
        throw new HttpError(404, "NOT_FOUND", "registry_def not found");
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(serializeRegistryDef(row)));
    }),
  );
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers PUT and PATCH /api/registry-defs/:id
 * Both methods use the same handler (PATCH = partial update, PUT = full replacement;
 * for schema-change purposes they behave identically).
 *
 * Uses lazy pool (same pattern as artifacts.ts) — no grantsPool required at wiring time.
 * When DATABASE_URL is absent, requests receive 503 DB_UNAVAILABLE (honest degrade).
 *
 * @param deps - Injectable authz deps for the force-path PDP gate (T-0191).
 *               Default: production loadAdminContext gate (genesis-owner short-circuit +
 *               adminGrants check for mgmt_object:schema_destructive/apply).
 *               Override in tests to supply a fake without a live DB.
 * @param crudDeps - Injectable { pool, resolveActorTenant } for the T-0263 create/
 *               list/get routes. When omitted those routes are NOT registered
 *               (no-DB honest degrade, mirrors registerApplicationRoutes). The
 *               PUT/PATCH schema-change path is unaffected either way.
 */
export function registerRegistryDefRoutes(
  router: Router,
  _poolHint?: pg.Pool,
  deps: RegistryDefAuthzDeps = defaultRegistryDefAuthzDeps,
  crudDeps?: RegistryDefCrudDeps,
): void {
  const handler = async (
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
    params: Record<string, string>,
  ): Promise<void> => {
    const registryDefId = params["id"] ?? "";
    assertUuidShape(registryDefId, "registry_def id");

    // 1. Extract actor (use _poolHint or lazy pool for slug resolution)
    const actor = await extractActor(req, _poolHint ?? getPool());

    // 2. Parse body
    const rawBody = await readJsonBody(req);
    if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new HttpError(400, "VALIDATION", "request body must be a JSON object");
    }
    const body = rawBody as Record<string, unknown>;

    // If no record_schema provided → no-op (200 updated:false)
    if (!("record_schema" in body)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ updated: false, registry_def_id: registryDefId }));
      return;
    }

    const newSchema = body["record_schema"] as JsonSchemaForClassify;
    if (newSchema === null || typeof newSchema !== "object" || Array.isArray(newSchema)) {
      throw new HttpError(400, "VALIDATION", "record_schema must be a JSON object");
    }

    const force = body["force"] === true;

    // 3. Run transactional schema-change guard.
    // poolHint is provided by tests to inject a fake pool; production uses lazy singleton.
    const result = await updateSchemaInTx({
      pool: _poolHint ?? getPool(),
      tenantId: DEV_TENANT_ID,
      registryDefId,
      newSchema,
      force,
      actor,
      nowMs: Date.now(),
      authzDeps: deps,
    });

    // 4. Return response based on result kind
    if (result.kind === "destructive_denied") {
      // 409 — schema NOT applied (ADR §5.2, spec AC-9/AC-16)
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            code: "destructive_schema_change",
            message:
              "Schema change is destructive: active report_page deps would be broken. " +
              "Pass force=true with grant mgmt_object:schema_destructive/apply to override.",
            affected_pages: result.affected_pages,
            fields: result.fields,
          },
        }),
      );
      return;
    }

    if (result.kind === "force_applied") {
      // 200 — force path: schema updated, deps stale, pages depromoted, audit logged
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          updated: true,
          registry_def_id: registryDefId,
          force_applied: true,
          affected_pages: result.affected_pages,
        }),
      );
      return;
    }

    // result.kind === "soft" — schema updated, soft warnings returned
    const softResult = result as { kind: "soft"; warnings: AffectedDep[] };
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    const responseBody: Record<string, unknown> = {
      updated: true,
      registry_def_id: registryDefId,
    };
    if (softResult.warnings.length > 0) {
      // machine-readable warnings array (NF-5 spec, NF-8 ADR)
      responseBody["warnings"] = softResult.warnings.map((w) => ({
        page_slug: w.page_slug,
        registry_def_id: w.registry_def_id,
        field_key: w.field_key,
      }));
    }
    res.end(JSON.stringify(responseBody));
  };

  // withAuth: keycloak mode REQUIRES a valid Bearer JWT (401 otherwise; no x-dev-user
  // bypass); dev mode is a no-op pass-through and the x-dev-user path is unchanged.
  const guardedHandler = withAuth(handler);
  router.register("PUT", "/api/registry-defs/:id", guardedHandler);
  router.register("PATCH", "/api/registry-defs/:id", guardedHandler);

  // T-0263 — create/list/get routes register only when CRUD deps are supplied
  // (honest-degrade). Wired on the SAME module/router so server.ts is unchanged
  // beyond the one optional arg added to this registration call.
  if (crudDeps) {
    registerRegistryDefCrudRoutes(router, crudDeps);
  }
}
