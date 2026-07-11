/**
 * ci/checks/db/first-run-empty-workspace.test.ts
 *
 * T-0306 [E14-S2, столп 7 «изолированное внедрение»] — LIVE-PG regression:
 * СВЕЖИЙ ТЕНАНТ СТАРТУЕТ ЧИСТЫМ (0 мок/демо-данных).
 *
 * CI-ONLY: требует DATABASE_URL (→ choros_migrator). Запускается в `db` CI-job /
 * локально через `npm run fitness:db`. На Mac без Postgres — skip.
 *
 * Регистрирует настоящий тенант через продовый чистый сервис src/core/register.ts
 * (registerTenant) против живого Postgres с RLS и утверждает МАШИННО:
 *
 *   AC-1  Контент-плоскость конструктора/демо ПУСТА для нового тенанта:
 *         0 строк в application / registry_def / record / process_definition /
 *         process_app_binding / dmn_rule_table / form_binding / cross_app_ref /
 *         matrix_lookup_table (WHERE tenant_id = новый). Демо-сид ТЭЛ и
 *         core-registries Dev-Silo (migrations 076..090, литеральный a0000000-…-0001)
 *         НЕ протекает в свежий рандомный tenant_id.
 *
 *   AC-2  Под RLS-ролью choros_app (NOBYPASSRLS, GUC scoped на новый тенант) видно
 *         РОВНО свой каркас: 2 employee (owner + assistant-agent), свой tenant row,
 *         но 0 application / 0 record — ничего чужого/демо не видно.
 *
 * Регистрационный каркас (owner, роли, гранты) — это НЕ мок-данные, а управляющая
 * плоскость нового тенанта; он проверяется в register-tenant-isolation.adversarial.
 * Здесь фокус — именно ПУСТОТА контент-плоскости (что видит пользователь-строитель).
 *
 * Anti-regression: если кто-то позже начнёт сеять демо-приложение/записи на
 * регистрации — этот тест станет красным. Гейт «0 мок-данных» из спеки T-0306.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migratorUrl, appUrl } from "./_helpers.js";
import { registerTenant } from "../../../src/core/register.js";
import { InMemoryKeycloakUserPort } from "../../../src/keycloak/fake-user-port.js";

const LIVE = !!process.env["DATABASE_URL"];
const NOW = () => Date.now();

// Контент-плоскость конструктора + все демо-несущие таблицы. Свежий тенант ДОЛЖЕН
// иметь 0 строк в каждой. Все они tenant-scoped (known_tenant_tables.txt, RLS).
const CONTENT_TABLES = [
  "choros.application",
  "choros.registry_def",
  "choros.record",
  "choros.process_definition",
  "choros.process_app_binding",
  "choros.dmn_rule_table",
  "choros.form_binding",
  "choros.cross_app_ref",
  "choros.matrix_lookup_table",
];

interface Registered {
  tenantId: string;
  tenantSlug: string;
  ownerSlug: string;
  email: string;
}

describe.skipIf(!LIVE)("T-0306 — свежий тенант стартует чистым (0 мок-данных)", () => {
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
      email: `firstrun-${label}-${stamp}@example.com`,
      password: "first-run-password-99",
    };
    const res = await registerTenant({ pool: migPool, kc, nowMs: NOW }, req);
    return { tenantId: res.tenantId, tenantSlug: res.tenantSlug, ownerSlug: res.userId, email: res.email };
  }

  /** Best-effort deep delete регистрационного каркаса (FK-safe order). */
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
  // AC-1 — контент-плоскость нового тенанта пуста (migrator view, точный tenant_id).
  // -------------------------------------------------------------------------
  it("AC-1: свежий тенант имеет 0 строк в каждой контент/демо-таблице", async () => {
    const t = await registerOne("Fresh");
    try {
      const c = await migPool.connect();
      try {
        await c.query("SET search_path TO choros");
        for (const table of CONTENT_TABLES) {
          const q = await c.query(
            `SELECT count(*)::int AS c FROM ${table} WHERE tenant_id = $1`,
            [t.tenantId],
          );
          expect(
            q.rows[0].c,
            `свежий тенант должен иметь 0 строк в ${table} (утечка мок/демо-данных?)`,
          ).toBe(0);
        }
      } finally {
        c.release();
      }
    } finally {
      await cleanup(t.tenantId);
    }
  });

  // -------------------------------------------------------------------------
  // AC-2 — под RLS-ролью choros_app видно ровно свой каркас, 0 контента.
  // -------------------------------------------------------------------------
  it("AC-2: под choros_app (RLS, GUC) — свой каркас есть, контент-плоскость пуста", async () => {
    const t = await registerOne("FreshApp");
    try {
      const app = new pg.Client({ connectionString: appUrl() });
      await app.connect();
      try {
        await app.query("SET search_path TO choros");
        await app.query(`SET choros.tenant_id = '${t.tenantId}'`);

        // Каркас нового тенанта виден: свой tenant row + 2 employee (owner + assistant-agent).
        const ownTenant = await app.query(
          `SELECT count(*)::int AS c FROM choros.tenant WHERE id = $1`, [t.tenantId],
        );
        expect(ownTenant.rows[0].c, "свой tenant row виден").toBe(1);
        const emps = await app.query(
          `SELECT count(*)::int AS c FROM choros.employee WHERE tenant_id = $1`, [t.tenantId],
        );
        expect(emps.rows[0].c, "owner + assistant-agent").toBe(2);

        // Контент-плоскость под RLS пуста (в scope тенанта вообще, не только по tenant_id).
        for (const table of CONTENT_TABLES) {
          const q = await app.query(`SELECT count(*)::int AS c FROM ${table}`);
          expect(
            q.rows[0].c,
            `в RLS-scope нового тенанта ${table} должна быть пуста (демо Dev-Silo не протекает)`,
          ).toBe(0);
        }
      } finally {
        await app.end();
      }
    } finally {
      await cleanup(t.tenantId);
    }
  });
});
