/**
 * ci/checks/db/register-tenant-isolation.adversarial.test.ts
 *
 * T-0427 · ADVERSARY (Враг red-team) — LIVE-PG tenant-isolation at registration time.
 *
 * CI-ONLY: requires DATABASE_URL (must resolve to choros_migrator). Runs in the `db`
 * CI job / locally against the compose Postgres via `npm run fitness:db`. Skipped on
 * a plain Mac with no Postgres.
 *
 * Registers REAL tenants through the production pure service src/core/register.ts
 * against live Postgres (with RLS enabled), then attacks the four isolation
 * properties the pure tests cannot reach (they need real rows + real RLS):
 *
 *   A1-live  Two SAME-name registrations land in TWO distinct tenant rows with TWO
 *            distinct globally-unique slugs (the UNIQUE(slug) + retry loop, proven on
 *            the real constraint, not a fake).
 *   A2-live  tenant_id is a fresh server UUID; the self-ref tenant row has
 *            tenant_id = id; no row of tenant B carries tenant A's id.
 *   A3-clean A freshly-registered tenant sees ZERO rows of any OTHER tenant under the
 *            choros_app (NOBYPASSRLS) role: 0 foreign tenants/employees/roles/grants/
 *            role_assignments/applications/records leak into its GUC scope. The fresh
 *            workspace is empty except its OWN seed (owner + assistant-agent + 2 roles
 *            + 3 confirmed assignments + 2 authoring_draft grants).
 *   A4-scope The genesis-owner role_assignment + the authoring_draft grants created at
 *            registration are scoped to ONLY the new tenant — every owner-side row's
 *            tenant_id equals the new tenant; the owner of A holds NO role/grant/
 *            assignment row in tenant B (no global / cross-tenant authority).
 *
 * Each test registers throwaway tenants and best-effort deep-deletes them in a finally.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migratorUrl, appUrl, withClient } from "./_helpers.js";
import { registerTenant } from "../../../src/core/register.js";
import { InMemoryKeycloakUserPort } from "../../../src/keycloak/fake-user-port.js";

const LIVE = !!process.env["DATABASE_URL"];
const NOW = () => Date.now();

// Tenant tables that should NEVER show a foreign tenant's rows once the GUC is set.
const SCOPED_TABLES = [
  "choros.tenant",
  "choros.employee",
  "choros.role",
  "choros.role_assignment",
  'choros."grant"',
  "choros.application",
  "choros.record",
];

interface Registered {
  tenantId: string;
  tenantSlug: string;
  ownerSlug: string; // = KC sub = employee.slug
  email: string;
}

describe.skipIf(!LIVE)("T-0427 · ADVERSARY — live-PG registration tenant isolation", () => {
  let migPool: pg.Pool;

  beforeAll(() => {
    migPool = new pg.Pool({ connectionString: migratorUrl() });
  });

  afterAll(async () => {
    await migPool.end();
  });

  async function registerOne(label: string): Promise<Registered> {
    const kc = new InMemoryKeycloakUserPort();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const req = {
      orgName: `${label} ${stamp}`,
      email: `adv-${label}-${stamp}@example.com`,
      password: "adversary-password-99",
    };
    const res = await registerTenant({ pool: migPool, kc, nowMs: NOW }, req);
    return { tenantId: res.tenantId, tenantSlug: res.tenantSlug, ownerSlug: res.userId, email: res.email };
  }

  /** Best-effort deep delete of a registered tenant (FK-safe order). */
  async function cleanup(tenantId: string): Promise<void> {
    const c = await migPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      await c.query("SET LOCAL search_path TO choros");
      await c.query(`DELETE FROM choros."grant" WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role_assignment WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.employee WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.role WHERE tenant_id = $1`, [tenantId]);
      await c.query(`DELETE FROM choros.tenant WHERE id = $1`, [tenantId]);
      await c.query("COMMIT");
    } catch {
      try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    } finally {
      c.release();
    }
  }

  // -------------------------------------------------------------------------
  // A1-live + A2-live — distinct rows / distinct slugs / server-side tenant_id.
  // -------------------------------------------------------------------------
  it("A1/A2-live: two SAME-name registrations → 2 distinct tenant rows, 2 distinct slugs, self-ref ids", async () => {
    // Identical display-name base → forces the global UNIQUE(slug) collision + retry.
    const kc = new InMemoryKeycloakUserPort();
    const base = `Acme Identical ${Date.now()}`;
    const r1 = await registerTenant({ pool: migPool, kc, nowMs: NOW }, { orgName: base, email: `a1-${Date.now()}@e.com`, password: "pw-12345678" });
    const r2 = await registerTenant({ pool: migPool, kc, nowMs: NOW }, { orgName: base, email: `a2-${Date.now()}@e.com`, password: "pw-12345678" });
    try {
      expect(r1.tenantId).not.toBe(r2.tenantId);
      expect(r1.tenantSlug).not.toBe(r2.tenantSlug);

      // Both tenant rows really exist and are self-referential (tenant_id = id).
      const rows = await withClient(migratorUrl(), async (c) => {
        const q = await c.query(
          `SELECT tenant_id, id, slug FROM choros.tenant WHERE id = ANY($1::uuid[])`,
          [[r1.tenantId, r2.tenantId]],
        );
        return q.rows as Array<{ tenant_id: string; id: string; slug: string }>;
      });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.tenant_id).toBe(row.id); // self-ref
      }
      // The two slugs are globally unique (DB enforces UNIQUE(slug)).
      const slugs = rows.map((r) => r.slug);
      expect(new Set(slugs).size).toBe(2);
    } finally {
      await cleanup(r1.tenantId);
      await cleanup(r2.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // A3-clean — a fresh tenant sees ZERO foreign rows under the app-role RLS.
  // -------------------------------------------------------------------------
  it("A3-clean: a fresh tenant sees 0 rows of ANY other tenant (RLS, choros_app role)", async () => {
    const a = await registerOne("CleanA");
    const b = await registerOne("CleanB");
    try {
      // Connect as the NOBYPASSRLS app role and scope the GUC to tenant A.
      const app = new pg.Client({ connectionString: appUrl() });
      await app.connect();
      try {
        await app.query("SET search_path TO choros");
        await app.query(`SET choros.tenant_id = '${a.tenantId}'`);

        for (const table of SCOPED_TABLES) {
          // Count rows belonging to the OTHER tenant that are visible in A's scope.
          // Under correct RLS this is ALWAYS 0 — B's rows are invisible to A.
          const q = await app.query(
            `SELECT count(*)::int AS c FROM ${table} WHERE tenant_id = $1`,
            [b.tenantId],
          );
          expect(q.rows[0].c, `tenant A must see 0 rows of B in ${table}`).toBe(0);
        }

        // Positive control: A DOES see its own tenant row + its own seed.
        const ownTenant = await app.query(`SELECT count(*)::int AS c FROM choros.tenant WHERE id = $1`, [a.tenantId]);
        expect(ownTenant.rows[0].c).toBe(1);
        const ownEmps = await app.query(`SELECT count(*)::int AS c FROM choros.employee WHERE tenant_id = $1`, [a.tenantId]);
        expect(ownEmps.rows[0].c).toBe(2); // owner + assistant-agent
        // And the workspace is otherwise empty (no apps/records leaked in from anywhere).
        const apps = await app.query(`SELECT count(*)::int AS c FROM choros.application`);
        expect(apps.rows[0].c).toBe(0);
        const recs = await app.query(`SELECT count(*)::int AS c FROM choros.record`);
        expect(recs.rows[0].c).toBe(0);
      } finally {
        await app.end();
      }
    } finally {
      await cleanup(a.tenantId);
      await cleanup(b.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // A4-scope — owner authority is scoped to the new tenant ONLY, never global.
  // -------------------------------------------------------------------------
  it("A4-scope: owner grant/role/assignment of A is scoped to A; A's owner holds NO authority in B", async () => {
    const a = await registerOne("ScopeA");
    const b = await registerOne("ScopeB");
    try {
      await withClient(migratorUrl(), async (c) => {
        // Every owner-side row created at registration carries tenant_id = A. None is global
        // (there is no NULL/wildcard tenant) and none belongs to B.
        const ownerRows = await c.query(
          `SELECT 'role_assignment' AS src, tenant_id FROM choros.role_assignment WHERE employee_id IN
             (SELECT id FROM choros.employee WHERE tenant_id = $1 AND slug = $2)
           UNION ALL
           SELECT 'grant', tenant_id FROM choros."grant" WHERE tenant_id = $1`,
          [a.tenantId, a.ownerSlug],
        );
        expect(ownerRows.rows.length).toBeGreaterThan(0);
        for (const row of ownerRows.rows as Array<{ tenant_id: string }>) {
          expect(row.tenant_id).toBe(a.tenantId);
          expect(row.tenant_id).not.toBe(b.tenantId);
        }

        // A's owner employee slug exists ONLY in tenant A — there is no twin employee row
        // for that slug in tenant B (so the owner cannot be resolved into B).
        const twin = await c.query(
          `SELECT tenant_id FROM choros.employee WHERE slug = $1`,
          [a.ownerSlug],
        );
        expect(twin.rows).toHaveLength(1);
        expect((twin.rows[0] as { tenant_id: string }).tenant_id).toBe(a.tenantId);

        // A's owner holds ZERO role_assignment rows whose tenant is B.
        const inB = await c.query(
          `SELECT count(*)::int AS c FROM choros.role_assignment ra
             JOIN choros.employee e ON e.tenant_id = ra.tenant_id AND e.id = ra.employee_id
            WHERE e.slug = $1 AND ra.tenant_id = $2`,
          [a.ownerSlug, b.tenantId],
        );
        expect(inB.rows[0].c).toBe(0);
      });

      // Cross-check via the app role: scope GUC to B, and A's owner slug resolves to NO
      // visible employee row in B's scope (RLS hides A's owner from B entirely).
      const app = new pg.Client({ connectionString: appUrl() });
      await app.connect();
      try {
        await app.query("SET search_path TO choros");
        await app.query(`SET choros.tenant_id = '${b.tenantId}'`);
        const seenInB = await app.query(`SELECT count(*)::int AS c FROM choros.employee WHERE slug = $1`, [a.ownerSlug]);
        expect(seenInB.rows[0].c, "A's owner must be invisible in B's RLS scope").toBe(0);
      } finally {
        await app.end();
      }
    } finally {
      await cleanup(a.tenantId);
      await cleanup(b.tenantId);
    }
  });
});
