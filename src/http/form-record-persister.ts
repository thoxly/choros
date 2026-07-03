/**
 * src/http/form-record-persister.ts — T-0337 [E15-S4], T-0345 [E15-S4 followup]
 *
 * REAL DB PERSIST PORT for form submissions.
 *
 * Wires the FormPersistPort (forms.ts) to the real entity store (records.ts
 * createRecord path / S1 applier pattern) in a tenant-scoped tx.
 *
 * Design: the composition root (server.ts) calls makeFormRecordPersister() when
 * a pool + resolveActorTenant are available (DATABASE_URL set) and passes the
 * result to registerFormsRoutes() as FormStoreDeps.persist. When DATABASE_URL is
 * absent (memory mode, tests), registerFormsRoutes() is called without deps and
 * uses the in-memory RECORDS Map fallback instead.
 *
 * FORM → REGISTRY MAPPING (T-0337 anchor):
 *   The form submit knows its formId ("purchase" | "approval") but NOT the
 *   registry_def UUID directly. This module resolves the governing registry_def
 *   by slug:
 *     formId "purchase"  → registry_def slug "purchases"  (Заявки)
 *     formId "approval"  → registry_def slug "soglasovanie" (Согласование)
 *   under the "tel-approval" application (slug, seeded by migration 076). The
 *   slug-based lookup is tenant-scoped (FORCE RLS in the tx).
 *
 * TENANT RESOLUTION:
 *   The actor's tenant is resolved from the actorSlug via resolveActorTenant
 *   (same pattern as applications.ts / registry-defs.ts / records.ts routes).
 *
 * SINGLE SOURCE OF TRUTH (T-0345 doctrine §3):
 *   After resolving the registry_def, this module derives the authoritative
 *   FormDef from registry_def.record_schema via deriveFormDefFromSchema and
 *   validates the submitted data against it using the unified form-validator.
 *   This is the single source of truth enforcement: the registry schema governs
 *   what fields are accepted and what values are valid — not form-schema.ts.
 *   A submit that passes the pre-validation in forms.ts (hardcoded schema) but
 *   fails against the registry record_schema is rejected here with 400.
 *
 * WRITE PATTERN (mirrors records.ts createRecord §3–§4):
 *   1. Resolve tenant from actor slug.
 *   2. Resolve application by slug ("tel-approval") under the tenant.
 *   3. Resolve governing registry_def by form-slug under the application.
 *   3b. Derive FormDef from registry_def.record_schema; validate data against it.
 *   4. INSERT record into choros.record (tenant-scoped RLS tx).
 *   5. Append record.create audit event in the same tx.
 *   Returns the server-minted record UUID.
 *
 * Field-mask write guard (FF-10): forms submit always uses the whole-resource
 * facet (undefined) — form data fields are all user-facing, none are system-only
 * (circuit_id etc. are not part of the purchase / approval form schemas).
 *
 * Note on fitness:db: this module is NOT directly tested here (the DB live tests
 * are in ci/checks/db/); the pure derivation layer (form-schema-derive.ts) and
 * the type dictionary (field-type-dictionary.ts) are unit-tested in
 * src/__tests__/forms-from-schema.test.ts. The DB persist path is exercised by
 * the acceptance tests that run against the dev server.
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { makePgAuditWriter, type PgClientLike } from "../db/audit-writer.js";
import { HttpError } from "./router.js";
import type { FormPersistPort } from "./forms.js";
import type { ActorTenantResolver } from "./records.js";
import { deriveFormDefFromSchema } from "../core/form-schema-derive.js";
import { validateFormSubmissionAgainst } from "../core/form-validator.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Minimal registry_def shape needed for the form record insert + schema validation. */
interface RegistryDefRow {
  id: string;
  application_id: string;
  /** The authoritative JSON Schema governing this registry's records. */
  record_schema: unknown;
  record_schema_version: number | string;
  /**
   * T-0606 [approval-registry-guard] review F-1 (migration 122): true for an
   * engine-managed / write-protected registry (e.g. the «Согласование»
   * step-result projection step-applier.ts writes decision records into).
   * A form submit targeting such a registry is a generic user-facing CRUD
   * write and MUST be rejected — this path (POST /api/forms/:formId/submit)
   * was the live bypass the T-0606 review proved against records.ts's guard.
   */
  engine_managed: boolean;
}

/** Minimal application shape needed to look up the application by slug. */
interface ApplicationRow {
  id: string;
}

// ---------------------------------------------------------------------------
// Form ID → registry slug mapping (T-0337 canonical anchor)
// ---------------------------------------------------------------------------

/**
 * Maps a form id ("purchase" | "approval") to the registry_def slug used to
 * look up the governing registry under the resolved application (see
 * resolveTelApplicationSlug below).
 *
 * This mapping is the SINGLE canonical anchor that collapses the triple:
 *   form_binding.fields (process routing) → demoted to routing hint
 *   form-schema.ts PURCHASE/APPROVAL      → pinned bootstrap, read-only
 *   registry_def.record_schema            → authoritative schema (AJV)
 *
 * Extending to new forms: add an entry here and seed the registry_def via the
 * registry-def API or a migration. No separate schema maintenance needed.
 *
 * T-0575 [W1/деТЭЛ] BUG-017 §2.5: "purchase" keeps its pre-existing literal
 * ("purchases" — never a ТЭЛ-osадок in the spec's own list, only "approval"/
 * "soglasovanie" and the application slug were named). "approval" now resolves
 * through resolveDefaultApprovalRegistrySlug() (config-primitive, below) rather
 * than a bare literal in this map — the ТЭЛ value "soglasovanie" survives ONLY
 * as that function's configurable default, not as an unconditional map entry.
 */
const FORM_TO_REGISTRY_SLUG: Readonly<Record<string, string>> = Object.freeze({
  purchase: "purchases",
});

/**
 * T-0575 config-primitive (BUG-017 §2.5 dedup): the fallback "Согласование"
 * registry slug used by the "approval" form. Configurable via env
 * `CHOROS_DEFAULT_STEP_RESULT_SLUG` — the SAME config-primitive step-applier.ts's
 * resolveDefaultStepResultSlug() reads, so the ТЭЛ value "soglasovanie" lives in
 * exactly ONE configuration point across both call sites (approve step-result AND
 * form-submit persistence), not two independently-hardcoded copies.
 */
function resolveApprovalFormRegistrySlug(): string {
  const v = process.env["CHOROS_DEFAULT_STEP_RESULT_SLUG"];
  return v !== undefined && v.trim() !== "" ? v : "soglasovanie";
}

/**
 * T-0575 config-primitive (BUG-017 §2.5): the slug of the application that
 * hosts the ТЭЛ forms (migration 076), now READ from env
 * `CHOROS_TEL_APPLICATION_SLUG` with a backward-compatible default — this
 * module's application-slug resolution is NO LONGER the sole, unconditional
 * code path for the value; an operator can override which application a form
 * persists under without a code change.
 */
function resolveTelApplicationSlug(): string {
  const v = process.env["CHOROS_TEL_APPLICATION_SLUG"];
  return v !== undefined && v.trim() !== "" ? v : "tel-approval";
}

// ---------------------------------------------------------------------------
// UUID shape guard (R-2 parity with records.ts — prevents SQL injection via
// SET LOCAL choros.tenant_id = '<tenantId>' when tenantId is not a UUID)
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Assert that `value` is a well-formed UUID (lowercase hex + 4 dashes).
 * Throws 400 VALIDATION if the shape is wrong — the same guard records.ts uses
 * in its withTenantTx (parity: both guard the SET LOCAL injection surface).
 */
function assertUuidShape(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new HttpError(400, "VALIDATION", `${label} must be a valid UUID`);
  }
}

// ---------------------------------------------------------------------------
// withTenantTx (mirrors records.ts — same RLS pattern, no cross-import)
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  // R-2 parity guard: tenantId is interpolated directly into SET LOCAL — must be
  // a well-formed UUID to prevent SQL injection on this surface.
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
// makeFormRecordPersister — factory for the real DB persist port
// ---------------------------------------------------------------------------

/**
 * Create a real-DB FormPersistPort that writes form submissions to the entity
 * store (choros.record) in a tenant-scoped tx with a record.create audit event.
 *
 * Call this in server.ts when grantsPool is available and pass the result as
 * FormStoreDeps.persist to registerFormsRoutes(). When grantsPool is absent
 * (memory mode / tests), do NOT call this — forms.ts uses the in-memory fallback.
 *
 * @param pool                - pg.Pool with DATABASE_URL
 * @param resolveActorTenant  - maps actor slug → tenant UUID
 * @returns FormPersistPort   - async (actorSlug, formId, data) → recordId
 */
export function makeFormRecordPersister(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
): FormPersistPort {
  return async (
    actorSlug: string,
    formId: string,
    data: Record<string, unknown>,
  ): Promise<string> => {
    // 1. Resolve the registry slug for this form. T-0575: "approval" resolves
    //    via the shared config-primitive (resolveApprovalFormRegistrySlug), not
    //    a hardcoded map entry.
    const registrySlug =
      formId === "approval" ? resolveApprovalFormRegistrySlug() : FORM_TO_REGISTRY_SLUG[formId];
    if (!registrySlug) {
      // Unknown form — the route handler already rejects UNKNOWN_FORM via
      // getFormDef() before calling persist. This path is defensive only.
      throw new Error(`form-record-persister: no registry slug for formId '${formId}'`);
    }

    // 2. Resolve the actor's tenant.
    const tenantId = await resolveActorTenant(actorSlug);

    // 3–5. Open a tenant-scoped tx and write the record + audit event.
    const recordId = randomUUID();
    const nowMs = Date.now();
    const applicationSlug = resolveTelApplicationSlug();

    await withTenantTx(pool, tenantId, async (client) => {
      // 3a. Resolve the application by slug (config-primitive default, T-0575).
      const appRes = await client.query<ApplicationRow>(
        `SELECT id FROM choros.application
          WHERE tenant_id = $1 AND slug = $2
          LIMIT 1`,
        [tenantId, applicationSlug],
      );
      const app = appRes.rows[0];
      if (!app) {
        throw new Error(
          `form-record-persister: application '${applicationSlug}' not found ` +
          `for tenant ${tenantId} — is migration 076 applied?`,
        );
      }

      // 3b. Resolve the governing registry_def by slug under the application.
      //     record_schema is fetched here (T-0345) to derive the authoritative
      //     FormDef for schema validation before persisting. engine_managed
      //     (migration 122) is fetched for the write-protection guard below.
      const regRes = await client.query<RegistryDefRow>(
        `SELECT id, application_id, record_schema, record_schema_version, engine_managed
           FROM choros.registry_def
          WHERE tenant_id = $1
            AND application_id = $2
            AND slug = $3
          LIMIT 1`,
        [tenantId, app.id, registrySlug],
      );
      const reg = regRes.rows[0];
      if (!reg) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          `form-record-persister: registry_def slug='${registrySlug}' not found ` +
          `under application '${applicationSlug}' for tenant ${tenantId}`,
        );
      }

      // 3b-bis. T-0606 [approval-registry-guard] review F-1: reject a form
      // submit whose TARGET registry is engine-managed / write-protected —
      // BEFORE any validation or write. This is the SAME invariant records.ts
      // enforces via assertNotEngineManaged (same code, same honest message):
      // a form submit is a generic user-facing CRUD create, and an
      // engine-managed registry (e.g. the «Согласование» decision projection)
      // accepts writes ONLY from the engine's own step-applier DAO path.
      // The check is registry-property-driven (engine_managed boolean), NOT
      // form-id-driven — a form whose target registry is NOT engine-managed
      // (e.g. "purchase" → a primary business registry) is entirely
      // unaffected; and if an operator ever re-points the "approval" form at
      // a non-protected registry (CHOROS_DEFAULT_STEP_RESULT_SLUG), the
      // submit works again without a code change. The route (forms.ts) lets
      // this HttpError propagate to the router's {error:{code,message}}
      // envelope — the same 403 shape /api/records returns.
      if (reg.engine_managed) {
        throw new HttpError(
          403,
          "REGISTRY_ENGINE_MANAGED",
          "Записи этого раздела создаёт процесс — согласуйте через задачу в Моих задачах",
        );
      }

      // 3c. Derive the authoritative FormDef from the registry's record_schema
      //     (T-0345 — single source of truth: entity schema governs form fields).
      //
      //     This is the live enforcement point: registry_def.record_schema is the
      //     sole authority for which fields are accepted and what values are valid.
      //     form-schema.ts PURCHASE/APPROVAL are bootstrap definitions that may
      //     diverge from the registry if the schema was updated via the API.
      //
      //     We use deriveFormDefFromSchema (form-schema-derive.ts) to derive a
      //     FormDef in the same FieldDef shape as form-validator.ts expects, then
      //     validate the submitted data against it. A submit that passed the
      //     pre-validation in forms.ts (hardcoded schema) but fails here (registry
      //     schema) is rejected with 400 — consistent with §3 doctrine:
      //     "entity = single source of truth; forms derive FROM it, never reverse."
      const derivedFormDef = deriveFormDefFromSchema(registrySlug, reg.record_schema);
      const schemaValidation = validateFormSubmissionAgainst(derivedFormDef, data);
      if (!schemaValidation.ok) {
        const fieldSummary = schemaValidation.errors
          .map((e) => `${e.field || "_"}: ${e.code}`)
          .join("; ");
        throw new HttpError(
          400,
          "VALIDATION",
          `form data does not conform to registry_def '${registrySlug}' schema: ${fieldSummary}`,
        );
      }

      // 4. INSERT the record (tenant-scoped under RLS, system actor = submitter).
      await client.query(
        `INSERT INTO choros.record
           (tenant_id, id, registry_id, data, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $5, $6)`,
        [tenantId, recordId, reg.id, JSON.stringify(data), nowMs, actorSlug],
      );

      // 5. Append ONE record.create audit event in the same tx (T-0016 / T-0068).
      const writer = makePgAuditWriter();
      await writer.appendAuditEvent(client as unknown as PgClientLike, {
        id: randomUUID(),
        type: "record.create",
        actor: actorSlug,
        subject: recordId,
        scope: {
          registry_def_id: reg.id,
          application_id: reg.application_id,
          via: "form-submit",
        },
        via: "form-submit",
        proposed_by: null,
        confirmed_by: actorSlug,
        payload: {
          form_id: formId,
          record_id: recordId,
          registry_def_id: reg.id,
          application_id: reg.application_id,
          record_schema_version: Number(reg.record_schema_version),
        },
        occurred_at: nowMs,
      });
    });

    return recordId;
  };
}

// ---------------------------------------------------------------------------
// makeFormDefResolver — factory for the T-0345 FormDefResolver port
// ---------------------------------------------------------------------------

/** Shape of the registry_def row needed for FormDef derivation only. */
interface RegistryDefSchemaRow {
  record_schema: unknown;
}

/**
 * Create a real-DB FormDefResolver that derives the authoritative FormDef from
 * the registry's record_schema for a given formId.
 *
 * T-0345 (E15-S4 followup): makes the live submit path use the registry's
 * record_schema as the single source of truth for form validation, replacing
 * the hardcoded form-schema.ts lookup with a DB-derived FormDef.
 *
 * Flow:
 *   1. Resolve the registry slug for this formId (FORM_TO_REGISTRY_SLUG).
 *      Returns null if formId is unknown (route handler converts to 404).
 *   2. Resolve the actor's tenant.
 *   3. Look up the registry_def by slug under the "tel-approval" application.
 *      Returns null if not found (route handler converts to 404).
 *   4. Derive FormDef via deriveFormDefFromSchema(registrySlug, record_schema).
 *      Returns the derived FormDef.
 *
 * @param pool               - pg.Pool with DATABASE_URL
 * @param resolveActorTenant - maps actor slug → tenant UUID
 * @returns FormDefResolver  - async (formId, actorSlug) → FormDef | null
 */
export function makeFormDefResolver(
  pool: pg.Pool,
  resolveActorTenant: ActorTenantResolver,
): import("./forms.js").FormDefResolver {
  return async (
    formId: string,
    actorSlug: string,
  ): Promise<import("../core/form-schema.js").FormDef | null> => {
    // 1. Map formId → registry slug (T-0575: "approval" via config-primitive).
    const registrySlug =
      formId === "approval" ? resolveApprovalFormRegistrySlug() : FORM_TO_REGISTRY_SLUG[formId];
    if (!registrySlug) {
      // Unknown form id — caller converts to 404.
      return null;
    }

    // 2. Resolve the actor's tenant.
    const tenantId = await resolveActorTenant(actorSlug);
    // R-2 parity guard: tenantId is interpolated directly into SET LOCAL — must be
    // a well-formed UUID to prevent SQL injection on this surface (same as withTenantTx).
    assertUuidShape(tenantId, "tenantId");

    // 3. Fetch the registry_def's record_schema (read-only, no tx needed for
    //    the lookup — we use a pool client directly outside a tx since this is
    //    a read and we force search_path via SET LOCAL to ensure RLS applies).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await client.query("SET LOCAL search_path TO choros");

      // Resolve application (config-primitive default, T-0575).
      const appRes = await client.query<ApplicationRow>(
        `SELECT id FROM choros.application
          WHERE tenant_id = $1 AND slug = $2
          LIMIT 1`,
        [tenantId, resolveTelApplicationSlug()],
      );
      const app = appRes.rows[0];
      if (!app) {
        await client.query("ROLLBACK");
        return null; // Application not found → form not resolvable.
      }

      // Resolve registry_def.
      const regRes = await client.query<RegistryDefSchemaRow>(
        `SELECT record_schema
           FROM choros.registry_def
          WHERE tenant_id = $1
            AND application_id = $2
            AND slug = $3
          LIMIT 1`,
        [tenantId, app.id, registrySlug],
      );
      const reg = regRes.rows[0];
      if (!reg) {
        await client.query("ROLLBACK");
        return null; // Registry not found → form not resolvable (404).
      }

      await client.query("ROLLBACK"); // Read-only — no changes to commit.

      // 4. Derive the FormDef from the authoritative record_schema.
      return deriveFormDefFromSchema(registrySlug, reg.record_schema);
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore secondary error */ }
      throw err;
    } finally {
      client.release();
    }
  };
}
