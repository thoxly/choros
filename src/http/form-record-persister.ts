/**
 * src/http/form-record-persister.ts — T-0337 [E15-S4]
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
 * WRITE PATTERN (mirrors records.ts createRecord §3–§4):
 *   1. Resolve tenant from actor slug.
 *   2. Resolve application by slug ("tel-approval") under the tenant.
 *   3. Resolve governing registry_def by form-slug under the application.
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
import type { FormPersistPort } from "./forms.js";
import type { ActorTenantResolver } from "./records.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Minimal registry_def shape needed for the form record insert. */
interface RegistryDefRow {
  id: string;
  application_id: string;
  record_schema_version: number | string;
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
 * look up the governing registry under the "tel-approval" application.
 *
 * This mapping is the SINGLE canonical anchor that collapses the triple:
 *   form_binding.fields (process routing) → demoted to routing hint
 *   form-schema.ts PURCHASE/APPROVAL      → pinned bootstrap, read-only
 *   registry_def.record_schema            → authoritative schema (AJV)
 *
 * Extending to new forms: add an entry here and seed the registry_def via the
 * registry-def API or a migration. No separate schema maintenance needed.
 */
const FORM_TO_REGISTRY_SLUG: Readonly<Record<string, string>> = Object.freeze({
  purchase: "purchases",
  approval: "soglasovanie",
});

/** Slug of the application that hosts the ТЭЛ forms (migration 076). */
const TEL_APPLICATION_SLUG = "tel-approval" as const;

// ---------------------------------------------------------------------------
// withTenantTx (mirrors records.ts — same RLS pattern, no cross-import)
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
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
    // 1. Resolve the registry slug for this form.
    const registrySlug = FORM_TO_REGISTRY_SLUG[formId];
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

    await withTenantTx(pool, tenantId, async (client) => {
      // 3a. Resolve the application by slug ("tel-approval").
      const appRes = await client.query<ApplicationRow>(
        `SELECT id FROM choros.application
          WHERE tenant_id = $1 AND slug = $2
          LIMIT 1`,
        [tenantId, TEL_APPLICATION_SLUG],
      );
      const app = appRes.rows[0];
      if (!app) {
        throw new Error(
          `form-record-persister: application '${TEL_APPLICATION_SLUG}' not found ` +
          `for tenant ${tenantId} — is migration 076 applied?`,
        );
      }

      // 3b. Resolve the governing registry_def by slug under the application.
      const regRes = await client.query<RegistryDefRow>(
        `SELECT id, application_id, record_schema_version
           FROM choros.registry_def
          WHERE tenant_id = $1
            AND application_id = $2
            AND slug = $3
          LIMIT 1`,
        [tenantId, app.id, registrySlug],
      );
      const reg = regRes.rows[0];
      if (!reg) {
        throw new Error(
          `form-record-persister: registry_def slug='${registrySlug}' not found ` +
          `under application '${TEL_APPLICATION_SLUG}' for tenant ${tenantId}`,
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
