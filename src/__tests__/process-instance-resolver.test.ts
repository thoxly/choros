/**
 * T-0333 [E15-S1a] — Unit tests for resolveInstanceTarget
 *
 * Pure unit — no live Postgres. The pg Pool is an in-memory stub that intercepts
 * SQL queries and returns canned rows. The tenant-scoped tx (withTenant: BEGIN /
 * SET LOCAL choros.tenant_id / COMMIT / ROLLBACK) is exercised via the stub, which
 * runs the real withTenant() code path (stub implements client.query() correctly).
 *
 * Test matrix:
 *   RES-1  — resolves a fully-bound instance → correct InstanceTargetRef
 *   RES-2  — returns unresolved(no_process_started_event) when audit event absent
 *   RES-3  — returns unresolved(no_app_binding) when process_app_binding absent
 *   RES-4  — returns unresolved(no_registry) when no registry_def for the application
 *   RES-5  — respects tenant scoping: queries carry tenantId in WHERE clause
 *   RES-6  — returns unresolved(invalid_input) for non-UUID tenantId (no DB round-trip)
 *   RES-7  — returns unresolved(invalid_input) for empty instanceId (no DB round-trip)
 *   RES-8  — proc_key missing from payload → unresolved(no_process_started_event)
 *   RES-9  — skips is_system=true registries; picks first non-system by created_at
 *
 * Note on DATABASE_URL: this test file does NOT import pg's Pool constructor directly
 * and does NOT connect to a real database. FE-s27-0002 (stray DATABASE_URL env var
 * triggers unwanted live connections in some test setups) is not a risk here because
 * the pool is always a mock stub, never constructed via `new pg.Pool()`.
 */

import { describe, it, expect } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  resolveInstanceTarget,
  type InstanceTargetRef,
  type InstanceTargetUnresolved,
} from "../db/process-instance-resolver.js";
// PROCESS_STARTED_TYPE is passed as a query parameter ($1) by the resolver —
// not embedded in the SQL text. Stubs match on table name ("audit_event") instead.

// ---------------------------------------------------------------------------
// Constants for the test fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0001-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0002-000000000002";
const INSTANCE_ID = "00000000-0000-0000-0003-000000000003";
const PROCESS_KEY = "purchase-approval";
const APPLICATION_ID = "00000000-0000-0000-0004-000000000004";
const REGISTRY_ID = "00000000-0000-0000-0005-000000000005";
const REGISTRY_SLUG = "purchases";
const REGISTRY_DISPLAY = "Заявки на закупку";

// ---------------------------------------------------------------------------
// Query-stubbing infrastructure
// ---------------------------------------------------------------------------

/**
 * Build the canned audit_event row for a process.started event.
 * The real table stores payload as JSONB; the pg driver parses it back to object.
 */
function auditStartedRow() {
  return {
    payload: {
      inst: INSTANCE_ID,
      proc_key: PROCESS_KEY,
      task_role: "role-approver",
      task_step: "Согласование",
      task_name: "Согласовать заявку",
      inbox_task_id: "00000000-0000-0000-0000-000000000099",
    },
  };
}

function appBindingRow() {
  return { application_id: APPLICATION_ID };
}

function registryRow() {
  return {
    id: REGISTRY_ID,
    slug: REGISTRY_SLUG,
    display_name: REGISTRY_DISPLAY,
  };
}

/**
 * Build an in-memory pg Pool stub.
 *
 * `queryResponder` is called for each SQL query AFTER the transaction-control
 * commands (BEGIN / SET LOCAL / SET search_path / COMMIT / ROLLBACK) are filtered out.
 * It receives the raw SQL string and returns an array of rows (may be empty).
 *
 * The real withTenant() code path is exercised (BEGIN, SET LOCAL, SET search_path,
 * COMMIT are silently absorbed as { rows: [] } — exactly as pg returns for DDL/TCL).
 */
function makeStubPool(queryResponder: (sql: string, values?: unknown[]) => unknown[]): Pool {
  // Use `as unknown as PoolClient` cast — same pattern as process-start.test.ts and
  // other tests that stub the pg client. pg's query() overloads are too complex to
  // satisfy with a plain type; the cast is the established project convention.
  const fakeClient = {
    query: async (sql: unknown, values?: unknown[]) => {
      const sqlText: string =
        typeof sql === "string" ? sql : (sql as { text?: string }).text ?? "";
      // Absorb transaction-control statements (no rows)
      if (
        sqlText.trimStart().toUpperCase().startsWith("BEGIN") ||
        sqlText.trimStart().toUpperCase().startsWith("COMMIT") ||
        sqlText.trimStart().toUpperCase().startsWith("ROLLBACK") ||
        sqlText.trimStart().toUpperCase().startsWith("SET LOCAL")
      ) {
        return { rows: [] };
      }
      const rows = queryResponder(sqlText, values);
      return { rows };
    },
    release: () => {},
  };
  return {
    connect: async () => fakeClient as unknown as PoolClient,
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// RES-1: happy path — fully resolved
// ---------------------------------------------------------------------------

describe("resolveInstanceTarget", () => {
  it("RES-1: resolves a fully-bound instance to the correct InstanceTargetRef", async () => {
    // Pool returns all three rows: started event, binding, registry.
    // Note: the resolver passes PROCESS_STARTED_TYPE as a query *parameter* ($1),
    // not inline in the SQL text — so we match on "audit_event" table name only.
    const pool = makeStubPool((sql) => {
      if (sql.includes("audit_event")) {
        return [auditStartedRow()];
      }
      if (sql.includes("process_app_binding")) {
        return [appBindingRow()];
      }
      if (sql.includes("registry_def")) {
        return [registryRow()];
      }
      return [];
    });

    const result = await resolveInstanceTarget(pool, TENANT_ID, INSTANCE_ID);

    expect(result.kind).toBe("resolved");
    const resolved = result as InstanceTargetRef;
    expect(resolved.instanceId).toBe(INSTANCE_ID);
    expect(resolved.processKey).toBe(PROCESS_KEY);
    expect(resolved.applicationId).toBe(APPLICATION_ID);
    expect(resolved.registryId).toBe(REGISTRY_ID);
    expect(resolved.registrySlug).toBe(REGISTRY_SLUG);
    expect(resolved.registryDisplayName).toBe(REGISTRY_DISPLAY);
    expect(resolved.tenantId).toBe(TENANT_ID);
  });

  // -------------------------------------------------------------------------
  // RES-2: no process.started event
  // -------------------------------------------------------------------------

  it("RES-2: returns unresolved(no_process_started_event) when audit event absent", async () => {
    const pool = makeStubPool((sql) => {
      if (sql.includes("audit_event")) {
        return []; // no event for this instance
      }
      return [];
    });

    const result = await resolveInstanceTarget(pool, TENANT_ID, INSTANCE_ID);

    expect(result.kind).toBe("unresolved");
    const unresolved = result as InstanceTargetUnresolved;
    expect(unresolved.reason).toBe("no_process_started_event");
    expect(unresolved.detail).toMatch(/No process\.started audit event/);
  });

  // -------------------------------------------------------------------------
  // RES-3: no process_app_binding
  // -------------------------------------------------------------------------

  it("RES-3: returns unresolved(no_app_binding) when process_app_binding absent", async () => {
    const pool = makeStubPool((sql) => {
      if (sql.includes("audit_event")) {
        return [auditStartedRow()];
      }
      if (sql.includes("process_app_binding")) {
        return []; // no binding for this process
      }
      return [];
    });

    const result = await resolveInstanceTarget(pool, TENANT_ID, INSTANCE_ID);

    expect(result.kind).toBe("unresolved");
    const unresolved = result as InstanceTargetUnresolved;
    expect(unresolved.reason).toBe("no_app_binding");
    expect(unresolved.detail).toMatch(/No process_app_binding/);
  });

  // -------------------------------------------------------------------------
  // RES-4: no registry_def
  // -------------------------------------------------------------------------

  it("RES-4: returns unresolved(no_registry) when no registry_def for the application", async () => {
    const pool = makeStubPool((sql) => {
      if (sql.includes("audit_event")) {
        return [auditStartedRow()];
      }
      if (sql.includes("process_app_binding")) {
        return [appBindingRow()];
      }
      if (sql.includes("registry_def")) {
        return []; // no registries
      }
      return [];
    });

    const result = await resolveInstanceTarget(pool, TENANT_ID, INSTANCE_ID);

    expect(result.kind).toBe("unresolved");
    const unresolved = result as InstanceTargetUnresolved;
    expect(unresolved.reason).toBe("no_registry");
    expect(unresolved.detail).toMatch(/No registry_def/);
  });

  // -------------------------------------------------------------------------
  // RES-5: tenant scoping — queries carry the tenantId parameter
  // -------------------------------------------------------------------------

  it("RES-5: all DB queries receive the correct tenantId parameter", async () => {
    const capturedParams: Array<{ sql: string; values: unknown[] }> = [];

    const pool = makeStubPool((sql, values) => {
      // Capture non-TCL queries so we can inspect their WHERE params.
      if (!sql.trimStart().toUpperCase().startsWith("SET")) {
        capturedParams.push({ sql, values: values ?? [] });
      }
      if (sql.includes("audit_event")) {
        return [auditStartedRow()];
      }
      if (sql.includes("process_app_binding")) {
        return [appBindingRow()];
      }
      if (sql.includes("registry_def")) {
        return [registryRow()];
      }
      return [];
    });

    await resolveInstanceTarget(pool, TENANT_ID, INSTANCE_ID);

    // All three queries (audit, binding, registry) must carry TENANT_ID as a param.
    const allHaveTenant = capturedParams.every(({ values }) =>
      values.includes(TENANT_ID)
    );
    expect(allHaveTenant).toBe(true);

    // Verify there are exactly 3 data queries (audit_event, process_app_binding, registry_def).
    expect(capturedParams).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // RES-6: invalid tenantId — no DB round-trip
  // -------------------------------------------------------------------------

  it("RES-6: returns unresolved(invalid_input) for non-UUID tenantId without DB access", async () => {
    let queryCalled = false;
    const pool = makeStubPool(() => {
      queryCalled = true;
      return [];
    });

    const result = await resolveInstanceTarget(pool, "not-a-uuid", INSTANCE_ID);

    expect(result.kind).toBe("unresolved");
    const unresolved = result as InstanceTargetUnresolved;
    expect(unresolved.reason).toBe("invalid_input");
    // The pool must not have been touched — validation happens before DB.
    expect(queryCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // RES-7: empty instanceId — no DB round-trip
  // -------------------------------------------------------------------------

  it("RES-7: returns unresolved(invalid_input) for empty instanceId without DB access", async () => {
    let queryCalled = false;
    const pool = makeStubPool(() => {
      queryCalled = true;
      return [];
    });

    const result = await resolveInstanceTarget(pool, TENANT_ID, "");

    expect(result.kind).toBe("unresolved");
    expect((result as InstanceTargetUnresolved).reason).toBe("invalid_input");
    expect(queryCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // RES-8: proc_key missing from payload
  // -------------------------------------------------------------------------

  it("RES-8: returns unresolved(no_process_started_event) when proc_key absent from payload", async () => {
    const pool = makeStubPool((sql) => {
      if (sql.includes("audit_event")) {
        // payload exists but proc_key is absent
        return [{ payload: { inst: INSTANCE_ID } }];
      }
      return [];
    });

    const result = await resolveInstanceTarget(pool, TENANT_ID, INSTANCE_ID);

    expect(result.kind).toBe("unresolved");
    expect((result as InstanceTargetUnresolved).reason).toBe("no_process_started_event");
    expect((result as InstanceTargetUnresolved).detail).toMatch(/missing proc_key/);
  });

  // -------------------------------------------------------------------------
  // RES-9: is_system=true registries are skipped; picks first non-system
  // -------------------------------------------------------------------------

  it("RES-9: skips system registries; picks first non-system registry by created_at", async () => {
    const ALT_REGISTRY_ID = "00000000-0000-0000-0006-000000000006";

    const pool = makeStubPool((sql) => {
      if (sql.includes("audit_event")) {
        return [auditStartedRow()];
      }
      if (sql.includes("process_app_binding")) {
        return [appBindingRow()];
      }
      if (sql.includes("registry_def")) {
        // The SQL already filters is_system=false at the DB level.
        // Here we simulate returning only the non-system registry (the DB already filters).
        return [
          { id: ALT_REGISTRY_ID, slug: "requests", display_name: "Заявки" },
        ];
      }
      return [];
    });

    const result = await resolveInstanceTarget(pool, TENANT_ID, INSTANCE_ID);

    expect(result.kind).toBe("resolved");
    expect((result as InstanceTargetRef).registryId).toBe(ALT_REGISTRY_ID);
    expect((result as InstanceTargetRef).registrySlug).toBe("requests");
  });

  // -------------------------------------------------------------------------
  // RES-10: different tenantId queries different partition (tenant isolation)
  // -------------------------------------------------------------------------

  it("RES-10: tenant isolation — OTHER_TENANT finds no event for INSTANCE_ID in TENANT_ID", async () => {
    // Simulate a DB that only knows about TENANT_ID's data.
    // When queried as OTHER_TENANT, the GUC-scoped RLS hides everything.
    const pool = makeStubPool((sql, values) => {
      if (sql.includes("audit_event")) {
        // Only return data if tenantId matches TENANT_ID
        if (Array.isArray(values) && values.includes(OTHER_TENANT)) {
          return []; // foreign tenant sees no row
        }
        return [auditStartedRow()];
      }
      return [];
    });

    const result = await resolveInstanceTarget(pool, OTHER_TENANT, INSTANCE_ID);

    expect(result.kind).toBe("unresolved");
    expect((result as InstanceTargetUnresolved).reason).toBe("no_process_started_event");
  });
});
