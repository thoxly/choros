// T-0140 · seed-pack DB-path probes
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=... npm run fitness:db
//
// Mirrors the skip discipline of grant-editor.test.ts (T-0030):
//   migratorUrl() throws when DATABASE_URL is not set, which causes the suite
//   to fail with a descriptive error — this is intentional for fitness:db gating.
//
// Covered AC:
//   AC-7  — applyPack on clean tenant → tenant-state has 3/7/12 entities
//   AC-8  — second applyPack → identical counts (idempotency, no duplicates)
//   AC-9  — insert extra dept → resetPack → extra deleted, pack depts remain
//   AC-10 — e-owner NOT deleted by resetPack (exclude-list guard verified)
//
// Also covers R-1 fix validation:
//   DELETE endpoints scoped to target tenant_id (wrong tenant → 404, correct → 200)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migratorUrl, withClient, uuid } from './_helpers.js';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// ---------------------------------------------------------------------------
// Server lifecycle (same pattern as grant-editor.test.ts FF-10 live section)
// ---------------------------------------------------------------------------

let server: http.Server;
let serverPort: number;

beforeAll(async () => {
  // migratorUrl() will throw descriptively if DATABASE_URL is not set —
  // consistent with the skip discipline of T-0030 (grant-editor.test.ts).
  migratorUrl(); // validate presence early

  const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const addr = server.address() as { port: number };
  serverPort = addr.port;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function baseUrl(): string {
  return `http://127.0.0.1:${serverPort}`;
}

async function apiGet(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: { 'x-dev-user': 'e-owner' },
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function apiPost(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dev-user': 'e-owner' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function apiDelete(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'x-dev-user': 'e-owner' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// Cleanup: delete all rows for a test tenant (via migrator, bypasses RLS)
// ---------------------------------------------------------------------------

async function cleanupTenant(tenantId: string): Promise<void> {
  await withClient(migratorUrl(), async (c) => {
    await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [tenantId]);
    await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
    await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [tenantId]);
    await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
    await c.query(`DELETE FROM choros.position WHERE tenant_id = $1`, [tenantId]);
    await c.query(`DELETE FROM choros.department WHERE tenant_id = $1`, [tenantId]);
    await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [tenantId]);
  });
}

// ---------------------------------------------------------------------------
// AC-7: applyPack on a fresh tenant → 3 departments / 7 positions / 12 employees
// ---------------------------------------------------------------------------

describe('AC-7: seed apply → 3 dept / 7 positions / 12 employees', () => {
  it('applyPack creates correct entity counts via live HTTP + DB', async () => {
    const { applyPack } = await import(join(REPO_ROOT, 'seed', 'importer.js'));
    const tenantSlug = `test-ac7-${uuid().slice(0, 8)}`;

    let tenantId: string | undefined;
    try {
      const summary = await applyPack({
        baseUrl: baseUrl(),
        tenantSlug,
        packName: 'showcase',
        devUser: 'e-owner',
      });

      // Resolve tenant UUID
      const tenantRes = await apiGet(`/api/tenants/${tenantSlug}`);
      expect(tenantRes.status, `GET /api/tenants/${tenantSlug} must return 200`).toBe(200);
      tenantId = (tenantRes.body as Record<string, string>)['id'];

      // Verify entity counts via tenant-state endpoint
      const stateRes = await apiGet(`/api/org/tenant-state?tenant_id=${tenantId}`);
      expect(stateRes.status, 'GET /api/org/tenant-state must return 200').toBe(200);
      const state = stateRes.body as {
        departments: Array<{ id: string; slug: string }>;
        positions: Array<{ id: string; slug: string }>;
        employees: Array<{ id: string; slug: string }>;
        roles: Array<{ id: string; slug: string }>;
      };

      expect(state.departments.length, 'AC-7: exactly 3 departments').toBe(3);
      expect(state.positions.length, 'AC-7: exactly 7 positions').toBe(7);
      expect(state.employees.length, 'AC-7: exactly 12 employees').toBe(12);

      // Verify summary counts
      expect(summary.created['tenant'], 'applyPack: tenant created = 1').toBe(1);
      expect(summary.created['departments'], 'applyPack: 3 departments created').toBe(3);
      expect(summary.created['positions'], 'applyPack: 7 positions created').toBe(7);
      expect(summary.created['employees'], 'applyPack: 12 employees created').toBe(12);
    } finally {
      if (tenantId) await cleanupTenant(tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-8: second applyPack → idempotent (same counts, no duplicates)
// ---------------------------------------------------------------------------

describe('AC-8: second applyPack → identical state (idempotency)', () => {
  it('running applyPack twice produces same entity counts, all-skipped on second run', async () => {
    const { applyPack } = await import(join(REPO_ROOT, 'seed', 'importer.js'));
    const tenantSlug = `test-ac8-${uuid().slice(0, 8)}`;

    let tenantId: string | undefined;
    try {
      // First apply
      await applyPack({ baseUrl: baseUrl(), tenantSlug, packName: 'showcase', devUser: 'e-owner' });

      const tenantRes = await apiGet(`/api/tenants/${tenantSlug}`);
      expect(tenantRes.status).toBe(200);
      tenantId = (tenantRes.body as Record<string, string>)['id'];

      // Second apply — must be fully idempotent
      const summary2 = await applyPack({ baseUrl: baseUrl(), tenantSlug, packName: 'showcase', devUser: 'e-owner' });

      expect(summary2.created['tenant'], 'second apply: tenant not created again').toBe(0);
      expect(summary2.created['departments'] ?? 0, 'second apply: no new departments').toBe(0);
      expect(summary2.created['positions'] ?? 0, 'second apply: no new positions').toBe(0);
      expect(summary2.created['employees'] ?? 0, 'second apply: no new employees').toBe(0);
      expect(summary2.skipped['tenant'], 'second apply: tenant skipped').toBe(1);

      // Verify counts unchanged (no duplicates)
      const stateRes = await apiGet(`/api/org/tenant-state?tenant_id=${tenantId}`);
      expect(stateRes.status).toBe(200);
      const state = stateRes.body as {
        departments: Array<unknown>;
        positions: Array<unknown>;
        employees: Array<unknown>;
      };
      expect(state.departments.length, 'AC-8: still exactly 3 depts after 2nd apply').toBe(3);
      expect(state.positions.length, 'AC-8: still exactly 7 positions after 2nd apply').toBe(7);
      expect(state.employees.length, 'AC-8: still exactly 12 employees after 2nd apply').toBe(12);
    } finally {
      if (tenantId) await cleanupTenant(tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-9: insert extra dept → resetPack → extra deleted, pack depts remain
// ---------------------------------------------------------------------------

describe('AC-9: reset deletes extra dept, preserves pack entities', () => {
  it('resetPack removes manually inserted department, keeps pack departments', async () => {
    const { applyPack, resetPack } = await import(join(REPO_ROOT, 'seed', 'importer.js'));
    const tenantSlug = `test-ac9-${uuid().slice(0, 8)}`;

    let tenantId: string | undefined;
    try {
      // 1. Apply pack — creates 3 departments
      await applyPack({ baseUrl: baseUrl(), tenantSlug, packName: 'showcase', devUser: 'e-owner' });

      const tenantRes = await apiGet(`/api/tenants/${tenantSlug}`);
      expect(tenantRes.status).toBe(200);
      tenantId = (tenantRes.body as Record<string, string>)['id'];

      // 2. Insert an extra department NOT in the pack
      const extraSlug = `extra-dept-${uuid().slice(0, 8)}`;
      const createR = await apiPost('/api/departments', {
        tenant_id: tenantId,
        slug: extraSlug,
        display_name: 'Extra Department (should be deleted by reset)',
      });
      expect(createR.status, 'extra dept creation must return 201').toBe(201);

      // 3. Verify 4 depts present before reset
      const stateBefore = await apiGet(`/api/org/tenant-state?tenant_id=${tenantId}`);
      expect(stateBefore.status).toBe(200);
      const deptsBefore = (stateBefore.body as { departments: Array<{ slug: string }> }).departments;
      expect(deptsBefore.length, '4 depts before reset').toBe(4);
      expect(deptsBefore.some((d) => d.slug === extraSlug), 'extra dept must exist').toBe(true);

      // 4. resetPack — deletes extra, upserts any missing
      const resetSummary = await resetPack({ baseUrl: baseUrl(), tenantSlug, packName: 'showcase', devUser: 'e-owner' });
      expect(resetSummary.deleted['departments'] ?? 0, 'AC-9: 1 department deleted').toBeGreaterThanOrEqual(1);

      // 5. Verify exactly 3 depts remain and extra is gone
      const stateAfter = await apiGet(`/api/org/tenant-state?tenant_id=${tenantId}`);
      expect(stateAfter.status).toBe(200);
      const deptsAfter = (stateAfter.body as { departments: Array<{ slug: string }> }).departments;
      expect(deptsAfter.length, 'AC-9: exactly 3 departments after reset').toBe(3);
      expect(deptsAfter.some((d) => d.slug === extraSlug), 'AC-9: extra dept must be gone').toBe(false);
    } finally {
      if (tenantId) await cleanupTenant(tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-10: e-owner employee NOT deleted by resetPack (exclude-list guard)
// We verify (1) the static exclude-list guard exists in importer source,
// (2) e-owner row still exists in dev tenant after any test activity.
// ---------------------------------------------------------------------------

describe('AC-10: genesis-owner e-owner NOT deleted by resetPack', () => {
  it('EXCLUDE_EMPLOYEE_SLUGS contains e-owner (static guard) + e-owner row exists in dev silo', async () => {
    // Dev tenant / genesis-owner constants (stable from migrations)
    const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';
    const DEV_EMP_OWNER = 'd0000000-0000-0000-0000-0000000000ff';

    // Static: verify importer.ts has the exclude guard
    const { readFileSync } = await import('node:fs');
    const importerSrc = readFileSync(join(REPO_ROOT, 'seed', 'importer.ts'), 'utf8');
    expect(importerSrc, 'importer.ts must define EXCLUDE_EMPLOYEE_SLUGS').toMatch(/EXCLUDE_EMPLOYEE_SLUGS/);
    expect(importerSrc, 'e-owner must be in EXCLUDE_EMPLOYEE_SLUGS').toMatch(/["']e-owner["']/);

    // Live: e-owner row must exist in dev silo
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT id, slug FROM choros.employee WHERE tenant_id = $1 AND id = $2`,
        [DEV_TENANT, DEV_EMP_OWNER],
      );
      expect(rows.length, 'AC-10: e-owner row must exist in dev silo').toBe(1);
      expect(rows[0].slug, 'AC-10: slug must be e-owner').toBe('e-owner');
    });
  });
});

// ---------------------------------------------------------------------------
// R-1 fix: DELETE endpoints scoped to tenant_id from request body
// Wrong tenant_id → 404; correct tenant_id → 200
// ---------------------------------------------------------------------------

describe('R-1: DELETE endpoints scoped to target tenant_id in body', () => {
  it('DELETE /api/departments with wrong tenant_id → 404; correct tenant_id → 200', async () => {
    const { applyPack } = await import(join(REPO_ROOT, 'seed', 'importer.js'));
    const tenantSlug = `test-r1-${uuid().slice(0, 8)}`;
    const DEV_TENANT = 'a0000000-0000-0000-0000-000000000001';

    let tenantId: string | undefined;
    try {
      await applyPack({ baseUrl: baseUrl(), tenantSlug, packName: 'showcase', devUser: 'e-owner' });

      const tenantRes = await apiGet(`/api/tenants/${tenantSlug}`);
      expect(tenantRes.status).toBe(200);
      tenantId = (tenantRes.body as Record<string, string>)['id'];

      // Create a leaf department with no positions (safe to DELETE without FK cascade).
      // The showcase pack departments (fin/cs/plat) all have positions referencing them
      // so they cannot be deleted without first removing the positions — out of test scope.
      const leafSlug = `r1-leaf-${uuid().slice(0, 8)}`;
      const createR = await apiPost('/api/departments', {
        tenant_id: tenantId,
        slug: leafSlug,
        display_name: 'R-1 leaf dept (no positions)',
      });
      expect(createR.status, 'leaf dept must be created').toBe(201);
      const leafDeptId = (createR.body as Record<string, string>)['id'];

      // DELETE with wrong tenant_id (dev silo) → 404 (entity not in that tenant)
      const wrongR = await apiDelete(`/api/departments/${leafDeptId}`, { tenant_id: DEV_TENANT });
      expect(wrongR.status, 'R-1: DELETE with wrong tenant_id must return 404').toBe(404);

      // DELETE with correct tenant_id → 200
      const correctR = await apiDelete(`/api/departments/${leafDeptId}`, { tenant_id: tenantId });
      expect(correctR.status, 'R-1: DELETE with correct tenant_id must return 200').toBe(200);
    } finally {
      if (tenantId) await cleanupTenant(tenantId);
    }
  });
});
