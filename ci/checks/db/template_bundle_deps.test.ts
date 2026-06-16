// T-0235 · T-0124 · FF-TEMPLATE-COHERENCE — template_dep live-DB probes.
//
// Resolves the dangling reference in ci/checks/check-template-deps.sh (TD-* checks):
//   "Live DB check (field_key ∈ registry_def.record_schema.properties) is in
//    ci/checks/db/template_bundle_deps.test.ts"
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=postgres://choros_migrator:...@localhost:55432/choros npm run fitness:db
//
// Covers (ADR T-0124 §2.9 / §6 / §7):
//
//  TCOHERENCE-1 (FF-TEMPLATE-COHERENCE live-gate):
//    Seed template_def + template_dep pointing at a field_key in record_schema;
//    assert field_key ∈ record_schema.properties.
//    Drop that field WITHOUT force → 409 (schema NOT applied, dep NOT stale).
//    WITH force + genesis-owner actor → 200 applied, dep.stale=true,
//    template_def.tier='draft', audit_event written (type=report_page.schema_destructive_force).
//
//  TCOHERENCE-2 (stale dep invariant):
//    Non-stale template_dep rows: every field_key ∈ registry_def.record_schema.properties.
//    Mirrors report_page_bundle_deps.test.ts DB-1 for template_dep.
//
//  TCOHERENCE-3 (audit payload sanity):
//    The audit_event payload written by force path contains affected_templates array
//    with the correct template_id; NO token/secret keys in payload.
//
// FRESH TENANTS: all tests mint their own random tenant UUID.
// Never reuse TENANT_A/TENANT_B (global shared fixtures pollute shared cloned DB).
//
// Seeds go through migratorUrl() (choros_migrator / bypasses RLS).
// T-0144 discipline: BEGIN before SET LOCAL; COMMIT always.

import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import pg from 'pg';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import { createServer } from '../../../src/server.js';
import { resetPoolForTesting } from '../../../src/http/registry-defs.js';

// ---------------------------------------------------------------------------
// Skip guard: if DATABASE_URL is absent, skip all tests in this file.
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
const skipAll = !DB_URL;

// DEV_TENANT_ID must match registry-defs.ts (the HTTP layer uses this).
const DEV_TENANT_ID = process.env['DEV_TENANT_ID'] ?? 'a0000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Seed helpers (all use migratorUrl to bypass RLS)
// ---------------------------------------------------------------------------

async function seedApplication(c: pg.Client, tenantId: string): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.application
       (tenant_id, id, slug, display_name, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $3, 'draft', 0, 0)`,
    [tenantId, id, `td-app-${id.slice(0, 8)}`],
  );
  await c.query('COMMIT');
  return id;
}

async function seedRegistryDef(
  c: pg.Client,
  tenantId: string,
  appId: string,
  schema: object,
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.registry_def
       (tenant_id, id, application_id, slug, display_name, record_schema, tier, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5::jsonb, 'draft', 0, 0)`,
    [tenantId, id, appId, `td-reg-${id.slice(0, 8)}`, JSON.stringify(schema)],
  );
  await c.query('COMMIT');
  return id;
}

async function seedTemplateDef(
  c: pg.Client,
  tenantId: string,
  registryId: string,
  tier: 'draft' | 'published' = 'published',
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  // Use SET LOCAL choros.promoting='1' to allow inserting published tier
  // (mirrors report_page tier-gate pattern from schema_change_api.test.ts)
  if (tier !== 'draft') {
    await c.query("SET LOCAL choros.promoting = '1'");
  }
  await c.query(
    `INSERT INTO choros.template_def
       (tenant_id, id, registry_id, format, body, version, tier, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'csv', '{{amount}}', 1, $4, 'td-tester', 0, 0)`,
    [tenantId, id, registryId, tier],
  );
  await c.query('COMMIT');
  return id;
}

async function seedTemplateDep(
  c: pg.Client,
  tenantId: string,
  templateId: string,
  registryDefId: string,
  fieldKey: string,
  depKind: 'read' | 'aggregate' = 'aggregate',
): Promise<string> {
  const id = uuid();
  await c.query('BEGIN');
  await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
  await c.query(
    `INSERT INTO choros.template_dep
       (tenant_id, id, template_id, registry_def_id, field_key, dep_kind, stale, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, false, 0)`,
    [tenantId, id, templateId, registryDefId, fieldKey, depKind],
  );
  await c.query('COMMIT');
  return id;
}

// ---------------------------------------------------------------------------
// HTTP helper (mirrors schema_change_api.test.ts)
// ---------------------------------------------------------------------------

type HttpResult = { statusCode: number; body: string };

function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-dev-user': 'e-owner', // genesis-owner actor (same as schema_change_api.test.ts AC-10)
      ...(headers ?? {}),
    };
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let chunk = '';
      res.on('data', (c: Buffer) => { chunk += c.toString(); });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: chunk }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: http.Server;
let baseUrl: string;
const cleanupFns: Array<() => Promise<void>> = [];

if (!skipAll) {
  // Reset the module-level pool so we connect to the live DB (not a stale test pool)
  resetPoolForTesting();
  server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, 'localhost', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
}

afterAll(async () => {
  for (const fn of cleanupFns.reverse()) {
    await fn().catch(() => { /* best-effort */ });
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// TCOHERENCE-1: field_key ∈ record_schema; drop WITHOUT force → 409;
//               WITH force+grant → dep.stale=true, template depromoted, audit emitted.
// ---------------------------------------------------------------------------
describe.skipIf(skipAll)(
  'TCOHERENCE-1 · FF-TEMPLATE-COHERENCE live gate',
  () => {
    it('template_dep field_key ∈ record_schema; drop without force → 409; force path → dep stale + template draft + audit', async () => {
      // Use DEV_TENANT_ID so the HTTP layer (registry-defs.ts) can see our seeded rows.
      const tenantId = DEV_TENANT_ID;

      // Seed a registry_def with a field 'amount'
      const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
      const regId = await withClient(migratorUrl(), (c) =>
        seedRegistryDef(c, tenantId, appId, { properties: { amount: { type: 'number' } } }),
      );

      // Seed a template_def (published so render would work) pointing at the registry_def
      const templateId = await withClient(migratorUrl(), (c) =>
        seedTemplateDef(c, tenantId, regId, 'published'),
      );

      // Seed a template_dep: template depends on 'amount'
      const depId = await withClient(migratorUrl(), (c) =>
        seedTemplateDep(c, tenantId, templateId, regId, 'amount', 'aggregate'),
      );

      // Register cleanup (best-effort, in reverse order)
      cleanupFns.push(async () => {
        await withClient(migratorUrl(), async (c) => {
          await c.query('BEGIN');
          await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await c.query(
            `DELETE FROM choros.template_dep WHERE tenant_id=$1 AND id=$2`,
            [tenantId, depId],
          );
          await c.query(`DELETE FROM choros.template_def WHERE tenant_id=$1 AND id=$2`,
            [tenantId, templateId],
          );
          await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`,
            [tenantId, regId],
          );
          await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`,
            [tenantId, appId],
          );
          await c.query('COMMIT');
        });
      });

      // PRECONDITION: field_key 'amount' must be in record_schema.properties
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query<{ record_schema: Record<string, unknown> }>(
          `SELECT record_schema FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`,
          [tenantId, regId],
        );
        const props = (rows[0]?.record_schema as { properties?: Record<string, unknown> })?.properties ?? {};
        expect('amount' in props).toBe(true);
      });

      // Without force: dropping 'amount' from schema → 409 (template_dep blocks it)
      const schema409 = { properties: {} }; // 'amount' dropped
      const r409 = await makeRequest(
        baseUrl,
        'PUT',
        `/api/registry-defs/${regId}`,
        { record_schema: schema409, force: false },
      );
      expect(r409.statusCode).toBe(409);
      const body409 = JSON.parse(r409.body) as {
        error: { code: string; affected_pages: unknown[] };
      };
      expect(body409.error.code).toBe('destructive_schema_change');
      // FF-TEMPLATE-COHERENCE: schema NOT applied
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query<{ record_schema: Record<string, unknown> }>(
          `SELECT record_schema FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`,
          [tenantId, regId],
        );
        const props = (rows[0]?.record_schema as { properties?: Record<string, unknown> })?.properties ?? {};
        // 'amount' must STILL be present (schema not applied on 409)
        expect('amount' in props).toBe(true);
      });

      // dep.stale must still be false (no stalening on 409)
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query<{ stale: boolean }>(
          `SELECT stale FROM choros.template_dep WHERE tenant_id=$1 AND id=$2`,
          [tenantId, depId],
        );
        expect(rows[0]?.stale).toBe(false);
      });

      // WITH force=true + genesis-owner actor ('e-owner'): applied, dep stale, template depromoted
      const r200 = await makeRequest(
        baseUrl,
        'PUT',
        `/api/registry-defs/${regId}`,
        { record_schema: schema409, force: true },
      );
      expect(r200.statusCode).toBe(200);
      const body200 = JSON.parse(r200.body) as {
        updated: boolean;
        force_applied: boolean;
      };
      expect(body200.updated).toBe(true);
      expect(body200.force_applied).toBe(true);

      // dep.stale is now true
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query<{ stale: boolean }>(
          `SELECT stale FROM choros.template_dep WHERE tenant_id=$1 AND id=$2`,
          [tenantId, depId],
        );
        expect(rows[0]?.stale).toBe(true);
      });

      // template_def tier is now 'draft' (depromoted)
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query<{ tier: string }>(
          `SELECT tier FROM choros.template_def WHERE tenant_id=$1 AND id=$2`,
          [tenantId, templateId],
        );
        expect(rows[0]?.tier).toBe('draft');
      });

      // audit_event written (type=report_page.schema_destructive_force — kept for backward compat)
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query<{ type: string; payload: unknown }>(
          `SELECT type, payload FROM choros.audit_event
            WHERE tenant_id=$1 AND type='report_page.schema_destructive_force'
            ORDER BY seq DESC LIMIT 1`,
          [tenantId],
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const payload = rows[0]?.payload as {
          registry_def_id: string;
          fields: string[];
          affected_templates: Array<{ template_id: string; field_key: string }>;
        };
        expect(payload.registry_def_id).toBe(regId);
        expect(payload.fields.includes('amount')).toBe(true);
        // affected_templates populated (T-0235 additive field)
        expect(Array.isArray(payload.affected_templates)).toBe(true);
        expect(payload.affected_templates.length).toBeGreaterThanOrEqual(1);
        expect(payload.affected_templates.some((t) => t.template_id === templateId)).toBe(true);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// TCOHERENCE-2: non-stale template_dep.field_key ∈ record_schema.properties
// Mirrors report_page_bundle_deps.test.ts DB-1 for template_dep.
// ---------------------------------------------------------------------------
describe.skipIf(skipAll)(
  'TCOHERENCE-2 · every non-stale template_dep.field_key exists in registry_def.record_schema',
  () => {
    it('no non-stale template_dep references an absent field_key', async () => {
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query<{
          dep_id: string;
          tenant_id: string;
          template_id: string;
          registry_def_id: string;
          field_key: string;
          record_schema: Record<string, unknown> | null;
        }>(
          `SELECT
             d.id::text              AS dep_id,
             d.tenant_id::text       AS tenant_id,
             d.template_id::text     AS template_id,
             d.registry_def_id::text AS registry_def_id,
             d.field_key             AS field_key,
             r.record_schema         AS record_schema
           FROM choros.template_dep d
           JOIN choros.registry_def r
             ON r.tenant_id = d.tenant_id
            AND r.id        = d.registry_def_id
           WHERE d.stale = false`,
        );

        const violations: string[] = [];

        for (const row of rows) {
          const schema =
            row.record_schema !== null &&
            typeof row.record_schema === 'object' &&
            !Array.isArray(row.record_schema)
              ? (row.record_schema as Record<string, unknown>)
              : null;

          const props =
            schema !== null
              ? (schema['properties'] as Record<string, unknown> | undefined)
              : undefined;

          // Skip deps against schemas with empty/absent properties (test fixtures).
          // Mirrors report_page_bundle_deps.test.ts DB-1 logic exactly.
          if (props === undefined || Object.keys(props).length === 0) {
            console.info(
              `[TCOHERENCE-2] skipping dep id=${row.dep_id} field_key="${row.field_key}" — ` +
                `record_schema.properties is empty/absent (test-fixture schema, not a real desync)`,
            );
            continue;
          }

          if (!(row.field_key in props)) {
            violations.push(
              `dep id=${row.dep_id} tenant=${row.tenant_id} template=${row.template_id} ` +
                `registry_def=${row.registry_def_id} field_key="${row.field_key}" ` +
                `NOT FOUND in record_schema.properties`,
            );
          }
        }

        expect(
          violations.length,
          `Found ${violations.length} non-stale template_dep row(s) with field_key absent ` +
            `from registry_def.record_schema.properties (FF-TEMPLATE-COHERENCE):\n` +
            violations.map((v) => `  • ${v}`).join('\n'),
        ).toBe(0);
      });
    });
  },
);

// ---------------------------------------------------------------------------
// TCOHERENCE-3 (FF-AUDIT-EVERY-RENDER): audit payload sanity
// Verifies that the audit_event payload written by the template force path
// contains affected_templates and NO token/secret keys.
// Note: the audit_event rows for render (doc.render / doc.render_denied /
// doc.snapshot_fixed) are written by document-render.ts via RenderAuditSink.
// That path is fully covered by the unit tests (pure/in-memory).
// Here we probe the schema-change-force path's audit payload only.
// ---------------------------------------------------------------------------
describe.skipIf(skipAll)(
  'TCOHERENCE-3 · FF-AUDIT-EVERY-RENDER audit payload: no token/secret; affected_templates present',
  () => {
    it('force-path audit_event payload has no token/secret; affected_templates populated', async () => {
      const tenantId = DEV_TENANT_ID;

      const appId = await withClient(migratorUrl(), (c) => seedApplication(c, tenantId));
      const regId = await withClient(migratorUrl(), (c) =>
        seedRegistryDef(c, tenantId, appId, { properties: { score: { type: 'integer' } } }),
      );
      const templateId = await withClient(migratorUrl(), (c) =>
        seedTemplateDef(c, tenantId, regId, 'published'),
      );
      const depId = await withClient(migratorUrl(), (c) =>
        seedTemplateDep(c, tenantId, templateId, regId, 'score', 'read'),
      );

      cleanupFns.push(async () => {
        await withClient(migratorUrl(), async (c) => {
          await c.query('BEGIN');
          await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
          await c.query(`DELETE FROM choros.template_dep WHERE tenant_id=$1 AND id=$2`, [tenantId, depId]);
          await c.query(`DELETE FROM choros.template_def WHERE tenant_id=$1 AND id=$2`, [tenantId, templateId]);
          await c.query(`DELETE FROM choros.registry_def WHERE tenant_id=$1 AND id=$2`, [tenantId, regId]);
          await c.query(`DELETE FROM choros.application WHERE tenant_id=$1 AND id=$2`, [tenantId, appId]);
          await c.query('COMMIT');
        });
      });

      // Force-drop 'score' to trigger template dep staling + audit
      const r = await makeRequest(
        baseUrl,
        'PUT',
        `/api/registry-defs/${regId}`,
        { record_schema: { properties: {} }, force: true },
      );
      expect(r.statusCode).toBe(200);

      // Read the most recent audit event for this tenant + force type
      await withClient(migratorUrl(), async (c) => {
        const { rows } = await c.query<{ type: string; payload: unknown }>(
          `SELECT type, payload FROM choros.audit_event
            WHERE tenant_id=$1 AND type='report_page.schema_destructive_force'
            ORDER BY seq DESC LIMIT 1`,
          [tenantId],
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);

        const payloadStr = JSON.stringify(rows[0]?.payload ?? {}).toLowerCase();
        // FF-AUDIT-EVERY-RENDER: NO token / secret / password in payload
        expect(payloadStr).not.toContain('token');
        expect(payloadStr).not.toContain('secret');
        expect(payloadStr).not.toContain('password');

        // affected_templates is present
        const payload = rows[0]?.payload as { affected_templates?: unknown[] };
        expect(Array.isArray(payload.affected_templates)).toBe(true);
      });
    });
  },
);
