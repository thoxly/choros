/**
 * ci/checks/db/engine-process-name.db.test.ts — T-0732 live-DB fitness (E16 T-0349,
 * O-1 из ревью T-0717).
 *
 * Proves the engine_process_name overlay (migration 131) end-to-end against real
 * Postgres via the choros_app (NOBYPASSRLS) pool — the exact production path:
 *
 *   FF-2 (cross-tenant, T-0616 §F-1 class): with the SAME key overlaid in TWO
 *     tenants under DIFFERENT names, tenant A resolves ONLY its own name, never
 *     tenant B's — neither via the selectEngineProcessNames helper nor via
 *     listInstanceProjections' definitionName. The isolation is enforced by RLS
 *     (FORCE) on the tenant-scoped choros_app (NOBYPASSRLS) client; the helper's
 *     explicit `WHERE tenant_id = $1` is defense-in-depth on top (mirrors the
 *     T-0616 §F-1 pin: RLS masks the foreign row, the WHERE is belt-and-suspenders).
 *   FF-3 (human name reaches the read plane): an engine-source instance
 *     (appendProcessStarted, no process_definition row) whose key has an overlay
 *     row reads its human name as definitionName; WITHOUT an overlay row it reads
 *     the raw KEY (the honest keyDemoted fallback — never empty).
 *   precedence: a modeler process_definition row wins over the engine overlay.
 *   round-trip: registerEngineProcessName upserts; selectEngineProcessNames reads
 *     back tenant-scoped; a repeat register overwrites (last deploy wins).
 *
 * Run: DATABASE_URL=postgres://choros_migrator:choros_dev_pw@localhost:55432/choros npm run fitness:db
 */

import { describe, it, expect } from "vitest";
import pg from "pg";
import { appUrl, uuid } from "./_helpers.js";
import {
  appendProcessStarted,
  listInstanceProjections,
} from "../../../src/http/process-projection.js";
import {
  registerEngineProcessName,
  selectEngineProcessNames,
} from "../../../src/db/engine-process-name.js";

const { Client } = pg;

function freshTenant(): string {
  return crypto.randomUUID();
}

/** Open the app pool, BEGIN a tenant-scoped tx (SET LOCAL choros.tenant_id), run fn, COMMIT. */
async function withTenantTx<T>(
  tenantId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await c.query("SET LOCAL search_path TO choros");
    const result = await fn(c as unknown as pg.PoolClient);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

/** Seed a modeler process_definition row directly under RLS (mirrors process-projection.test.ts). */
async function seedProcessDefDirect(tenantId: string, processKey: string, name: string): Promise<void> {
  await withTenantTx(tenantId, (c) =>
    c.query(
      `INSERT INTO choros.process_definition
         (tenant_id, id, process_key, name, bpmn_xml, version, status, deployment_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '<definitions/>', 1, 'published', NULL, 0, 0)
       ON CONFLICT DO NOTHING`,
      [tenantId, uuid(), processKey, name],
    ),
  );
}

/** definitionName the read plane resolves for the given engine key. */
async function definitionNameFor(tenantId: string, instanceId: string): Promise<string | undefined> {
  const pool = new pg.Pool({ connectionString: appUrl(), max: 2 });
  try {
    const projections = await listInstanceProjections(pool, tenantId);
    return projections.find((p) => p.inst === instanceId)?.definitionName;
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Helper round-trip + upsert
// ---------------------------------------------------------------------------

describe("T-0732 — engine_process_name helper (write + read)", () => {
  it("registerEngineProcessName upserts and selectEngineProcessNames reads it back (tenant-scoped)", async () => {
    const tenantId = freshTenant();
    const key = `eng-${crypto.randomUUID().slice(0, 8)}`;

    await withTenantTx(tenantId, (c) => registerEngineProcessName(c, tenantId, key, "Заявка на отпуск", Date.now()));

    const got = await withTenantTx(tenantId, (c) => selectEngineProcessNames(c, tenantId, [key, "absent-key"]));
    expect(got.get(key)).toBe("Заявка на отпуск");
    expect(got.has("absent-key")).toBe(false);
  });

  it("a repeat register overwrites the name (last deploy wins)", async () => {
    const tenantId = freshTenant();
    const key = `eng-${crypto.randomUUID().slice(0, 8)}`;

    await withTenantTx(tenantId, (c) => registerEngineProcessName(c, tenantId, key, "Старое имя", Date.now()));
    await withTenantTx(tenantId, (c) => registerEngineProcessName(c, tenantId, key, "Новое имя", Date.now()));

    const got = await withTenantTx(tenantId, (c) => selectEngineProcessNames(c, tenantId, [key]));
    expect(got.get(key)).toBe("Новое имя");
  });

  it("selectEngineProcessNames with no keys returns an empty map (no query)", async () => {
    const tenantId = freshTenant();
    const got = await withTenantTx(tenantId, (c) => selectEngineProcessNames(c, tenantId, []));
    expect(got.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FF-2 — cross-tenant isolation (T-0616 §F-1 class)
// ---------------------------------------------------------------------------

describe("T-0732 [FF-2] — cross-tenant name isolation (RLS-enforced, T-0616 §F-1 class)", () => {
  it("SAME key overlaid in both tenants with different names → tenant A resolves ONLY its own (helper)", async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const key = "telLinear"; // SAME key in both tenants — the F-1 leak scenario

    // Both tenants overlay the SAME key with DIFFERENT names.
    await withTenantTx(tenantA, (c) => registerEngineProcessName(c, tenantA, key, "Имя тенанта A", Date.now()));
    await withTenantTx(tenantB, (c) => registerEngineProcessName(c, tenantB, key, "Имя тенанта B", Date.now()));

    // Resolve K in tenant A — must be A's name, NEVER tenant B's. RLS (FORCE) on the
    // tenant-scoped choros_app client masks B's row; the explicit WHERE is defense-in-depth.
    const inA = await withTenantTx(tenantA, (c) => selectEngineProcessNames(c, tenantA, [key]));
    expect(inA.get(key)).toBe("Имя тенанта A");
    expect(inA.get(key)).not.toBe("Имя тенанта B");

    // Symmetric: tenant B sees only its own.
    const inB = await withTenantTx(tenantB, (c) => selectEngineProcessNames(c, tenantB, [key]));
    expect(inB.get(key)).toBe("Имя тенанта B");
  });

  it("listInstanceProjections in tenant A resolves its OWN overlay name, never tenant B's, for the same key", async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const key = "telLinear";
    const instA = `flw-${crypto.randomUUID().slice(0, 8)}`;

    // Same key overlaid in BOTH tenants, different names; only A starts an instance.
    await withTenantTx(tenantA, (c) => registerEngineProcessName(c, tenantA, key, "Имя A", Date.now()));
    await withTenantTx(tenantB, (c) => registerEngineProcessName(c, tenantB, key, "Секрет тенанта B", Date.now()));
    await withTenantTx(tenantA, (c) =>
      appendProcessStarted(c, { instanceId: instA, procKey: key, actor: "e-orlov", nowMs: Date.now() }),
    );

    // Tenant A's read plane resolves A's name, never B's.
    const nameA = await definitionNameFor(tenantA, instA);
    expect(nameA).toBe("Имя A");
    expect(nameA).not.toBe("Секрет тенанта B");
  });
});

// ---------------------------------------------------------------------------
// FF-3 — the human name reaches the read plane (definitionName)
// ---------------------------------------------------------------------------

describe("T-0732 [FF-3] — engine instance shows the human name in the read plane", () => {
  it("an engine-source instance with an overlay row reads its HUMAN name as definitionName", async () => {
    const tenantId = freshTenant();
    const key = `eng-${crypto.randomUUID().slice(0, 8)}`;
    const inst = `flw-${crypto.randomUUID().slice(0, 8)}`;

    await withTenantTx(tenantId, (c) =>
      appendProcessStarted(c, { instanceId: inst, procKey: key, actor: "e-orlov", nowMs: Date.now() }),
    );
    // Before the overlay: definitionName is the raw KEY (honest keyDemoted fallback).
    expect(await definitionNameFor(tenantId, inst)).toBe(key);

    // Register the human name (the deploy-time write) and re-read.
    await withTenantTx(tenantId, (c) => registerEngineProcessName(c, tenantId, key, "Канонический процесс", Date.now()));
    expect(await definitionNameFor(tenantId, inst)).toBe("Канонический процесс");
  });

  it("WITHOUT an overlay row, definitionName is the raw key (never empty — keyDemoted fallback)", async () => {
    const tenantId = freshTenant();
    const key = `eng-${crypto.randomUUID().slice(0, 8)}`;
    const inst = `flw-${crypto.randomUUID().slice(0, 8)}`;

    await withTenantTx(tenantId, (c) =>
      appendProcessStarted(c, { instanceId: inst, procKey: key, actor: "e-orlov", nowMs: Date.now() }),
    );
    expect(await definitionNameFor(tenantId, inst)).toBe(key);
  });

  it("a modeler process_definition row wins over the engine overlay (precedence)", async () => {
    const tenantId = freshTenant();
    const key = `eng-${crypto.randomUUID().slice(0, 8)}`;
    const inst = `flw-${crypto.randomUUID().slice(0, 8)}`;

    await withTenantTx(tenantId, (c) =>
      appendProcessStarted(c, { instanceId: inst, procKey: key, actor: "e-orlov", nowMs: Date.now() }),
    );
    // Both a modeler row AND an engine overlay exist for the same key — modeler wins.
    await seedProcessDefDirect(tenantId, key, "Имя из модельера");
    await withTenantTx(tenantId, (c) => registerEngineProcessName(c, tenantId, key, "Имя из оверлея", Date.now()));

    expect(await definitionNameFor(tenantId, inst)).toBe("Имя из модельера");
  });
});
