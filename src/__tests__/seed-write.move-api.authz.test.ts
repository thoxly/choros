/**
 * src/__tests__/seed-write.move-api.authz.test.ts — T-0655 [W5-UX / ux-study §6.4]
 *
 * Proves the MOVE-API (PATCH /api/{departments,positions,employees}/:id — reparent
 * + rename) on the org-write surface (seed-write.ts):
 *
 *   (1) an OWNER can move/rename each entity                         → 200
 *   (2) the move appends ONE `<kind>.moved` audit event in-tx        → captured
 *   (3) a cross-tenant caller (not the forest owner) is rejected     → 403
 *   (4) an empty patch (no fields) is rejected                       → 400
 *   (5) a department reparent that would form a cycle is rejected    → 400 CYCLE
 *   (6) a non-existent id in the tenant                              → 404
 *   (7) a non-owner with NO covering mgmt_object update grant        → 403
 *
 * No real DB: a scripted in-memory stub pg.Pool replays the queries each route
 * runs — resolveActorTenant, loadAdminContext (owner lookup), the SELECT … FOR
 * UPDATE before-image, the department parent-map (for the cycle guard), the
 * canonical audit-writer head/insert/advance, and the entity UPDATE. Mirrors
 * seed-write.constructor-admin.authz.test.ts's scripted-pool approach.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import type pg from "pg";
import { Router } from "../http/router.js";
import { registerSeedWriteRoutes } from "../http/seed-write.js";

const TENANT_A = "aaaaaaaa-0000-0000-0000-000000000001"; // caller's own tenant
const DEPT_ID = "cccccccc-0000-0000-0000-000000000003";
const POS_ID = "ffffffff-0000-0000-0000-000000000006";
const EMP_ID = "dddddddd-0000-0000-0000-000000000004";
const OTHER_DEPT = "cccccccc-0000-0000-0000-000000000099";

const GENESIS_PREV_HASH = Buffer.alloc(32); // any 32-byte buffer for the stub head

/** Captured audit events (type + payload) appended during a request. */
type Captured = { auditEvents: Array<{ type: string; payload: unknown }> };

/**
 * A scripted stub pool for the move-API routes.
 *
 * @param opts.isOwner        loadAdminContext owner lookup → owner? (short-circuits
 *                            assertOrgObjectAuthority).
 * @param opts.callerTenant   resolveActorTenant → this tenant (for cross-tenant test).
 * @param opts.parentOf       department id → parent id map (for the cycle guard).
 * @param opts.rowExists      SELECT … FOR UPDATE before-image → present? (else 404).
 */
function makeStubPool(
  captured: Captured,
  opts: {
    isOwner: boolean;
    callerTenant?: string;
    parentOf?: Record<string, string | null>;
    rowExists?: boolean;
  },
): pg.Pool {
  const callerTenant = opts.callerTenant ?? TENANT_A;
  const parentOf = opts.parentOf ?? {};
  const rowExists = opts.rowExists ?? true;
  let seq = 0;

  const client = {
    query: async (text: string, params?: unknown[]) => {
      if (typeof text !== "string") return { rows: [], rowCount: 0 };

      // resolveActorTenant: slug → caller's tenant.
      if (text.includes("JOIN choros.tenant") && text.includes("CASE WHEN t.slug")) {
        return { rows: [{ tenant_id: callerTenant }], rowCount: 1 };
      }
      // isGenesisOwnerForTenant (forest-owner check in authorizeOrgWrite): owner?
      // (only matters on the cross-tenant path; return based on isOwner).
      // loadAdminContext owner lookup: tenant-owner role_assignment.
      if (text.includes("tenant-owner") && text.includes("role_assignment")) {
        return opts.isOwner ? { rows: [{ id: "ra-owner" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // loadAdminContext assignment list (non-owner → empty → no admin grants).
      if (text.includes("ra.id") && text.includes("ra.org_scope")) {
        return { rows: [], rowCount: 0 };
      }
      // loadAdminContext per-assignment mgmt_object grant lookup → none.
      if (text.includes('choros."grant"') && text.includes("mgmt_object:%")) {
        return { rows: [], rowCount: 0 };
      }
      // loadTenantOrgAncestry: SELECT id, parent_id FROM choros.department (oracle).
      // Also the move route's own parent-map load uses the SAME shape.
      if (text.includes("SELECT id, parent_id FROM choros.department")) {
        const rows = Object.entries(parentOf).map(([id, pid]) => ({ id, parent_id: pid }));
        return { rows, rowCount: rows.length };
      }
      // SELECT … FOR UPDATE before-image (department/position/employee).
      if (text.includes("FOR UPDATE") && text.includes("choros.department") && text.includes("parent_id")) {
        return rowExists
          ? { rows: [{ parent_id: parentOf[DEPT_ID] ?? null, display_name: "Отдел" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("FOR UPDATE") && text.includes("choros.position")) {
        return rowExists
          ? { rows: [{ department_id: DEPT_ID, title: "Должность" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (text.includes("FOR UPDATE") && text.includes("choros.employee")) {
        return rowExists
          ? { rows: [{ position_id: POS_ID, display_name: "Сотрудник" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      // Audit-writer: current tenant GUC read.
      if (text.includes("current_setting('choros.tenant_id', false)") && text.includes("AS tenant_id")) {
        return { rows: [{ tenant_id: callerTenant }], rowCount: 1 };
      }
      // Audit head seed (INSERT … ON CONFLICT).
      if (text.includes("INSERT INTO choros.audit_head")) {
        return { rows: [], rowCount: 1 };
      }
      // Audit head lock (SELECT seq … FOR UPDATE).
      if (text.includes("FROM choros.audit_head") && text.includes("FOR UPDATE")) {
        return { rows: [{ seq, row_hash: GENESIS_PREV_HASH, vocab_version: 1 }], rowCount: 1 };
      }
      // Audit event INSERT — capture type + payload from the bound params.
      if (text.includes("INSERT INTO choros.audit_event")) {
        seq += 1;
        // params: [seq, id, type, actor, subject, scopeJson, via, proposed, confirmed, payloadJson, ...]
        const type = params?.[2] as string;
        const payload = params?.[9] as string;
        captured.auditEvents.push({ type, payload: JSON.parse(payload) });
        return { rows: [], rowCount: 1 };
      }
      // Audit head advance UPDATE.
      if (text.includes("UPDATE choros.audit_head")) {
        return { rows: [], rowCount: 1 };
      }
      // Entity UPDATE (the move itself) + BEGIN/SET LOCAL/COMMIT/ROLLBACK.
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as pg.Pool;
}

async function startServer(pool: pg.Pool): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router();
  registerSeedWriteRoutes(router, pool);
  const server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function request(
  port: number,
  method: string,
  path: string,
  body: unknown,
  devUser = "e-owner",
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(devUser ? { "x-dev-user": devUser } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function errCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

// ---------------------------------------------------------------------------
// (1)+(2) OWNER can move/rename each entity + audit event appended
// ---------------------------------------------------------------------------

describe("T-0655 move-API — owner can move/rename + audit", () => {
  it("PATCH /api/employees/:id { position_id } → 200 + employee.moved audit", async () => {
    const captured: Captured = { auditEvents: [] };
    const { port, close } = await startServer(makeStubPool(captured, { isOwner: true }));
    try {
      const r = await request(port, "PATCH", `/api/employees/${EMP_ID}`, {
        tenant_id: TENANT_A, position_id: "ffffffff-0000-0000-0000-000000000010",
      });
      expect(r.status).toBe(200);
      expect(captured.auditEvents).toHaveLength(1);
      expect(captured.auditEvents[0].type).toBe("employee.moved");
      expect(captured.auditEvents[0].payload).toMatchObject({
        from_position_id: POS_ID, to_position_id: "ffffffff-0000-0000-0000-000000000010",
      });
    } finally { await close(); }
  });

  it("PATCH /api/employees/:id { position_id: null } detaches (снять должность) → 200", async () => {
    const captured: Captured = { auditEvents: [] };
    const { port, close } = await startServer(makeStubPool(captured, { isOwner: true }));
    try {
      const r = await request(port, "PATCH", `/api/employees/${EMP_ID}`, {
        tenant_id: TENANT_A, position_id: null,
      });
      expect(r.status).toBe(200);
      expect(captured.auditEvents[0].payload).toMatchObject({ to_position_id: null });
    } finally { await close(); }
  });

  it("PATCH /api/positions/:id { department_id, title } → 200 + position.moved audit", async () => {
    const captured: Captured = { auditEvents: [] };
    const { port, close } = await startServer(makeStubPool(captured, { isOwner: true }));
    try {
      const r = await request(port, "PATCH", `/api/positions/${POS_ID}`, {
        tenant_id: TENANT_A, department_id: OTHER_DEPT, title: "Новое название",
      });
      expect(r.status).toBe(200);
      expect(captured.auditEvents[0].type).toBe("position.moved");
      expect(captured.auditEvents[0].payload).toMatchObject({ renamed: true, to_department_id: OTHER_DEPT });
    } finally { await close(); }
  });

  it("PATCH /api/departments/:id { display_name } rename → 200 + department.moved audit", async () => {
    const captured: Captured = { auditEvents: [] };
    const { port, close } = await startServer(
      makeStubPool(captured, { isOwner: true, parentOf: { [DEPT_ID]: null } }),
    );
    try {
      const r = await request(port, "PATCH", `/api/departments/${DEPT_ID}`, {
        tenant_id: TENANT_A, display_name: "Переименовано",
      });
      expect(r.status).toBe(200);
      expect(captured.auditEvents[0].type).toBe("department.moved");
      expect(captured.auditEvents[0].payload).toMatchObject({ renamed: true, to_name: "Переименовано" });
    } finally { await close(); }
  });
});

// ---------------------------------------------------------------------------
// (3) cross-tenant deny
// ---------------------------------------------------------------------------

describe("T-0655 move-API — cross-tenant caller rejected", () => {
  it("PATCH /api/employees/:id into a tenant the caller does not own → 403", async () => {
    const captured: Captured = { auditEvents: [] };
    // caller's own tenant differs from the target tenant_id, and caller is not the
    // forest-owner → authorizeOrgWrite throws 403 NOT_OWNER before any UPDATE.
    const { port, close } = await startServer(
      makeStubPool(captured, { isOwner: false, callerTenant: "bbbbbbbb-0000-0000-0000-000000000002" }),
    );
    try {
      const r = await request(port, "PATCH", `/api/employees/${EMP_ID}`, {
        tenant_id: TENANT_A, position_id: POS_ID,
      });
      expect(r.status).toBe(403);
      expect(captured.auditEvents).toHaveLength(0);
    } finally { await close(); }
  });
});

// ---------------------------------------------------------------------------
// (4) empty patch
// ---------------------------------------------------------------------------

describe("T-0655 move-API — empty patch rejected", () => {
  it("PATCH /api/departments/:id with no touched fields → 400", async () => {
    const captured: Captured = { auditEvents: [] };
    const { port, close } = await startServer(makeStubPool(captured, { isOwner: true }));
    try {
      const r = await request(port, "PATCH", `/api/departments/${DEPT_ID}`, { tenant_id: TENANT_A });
      expect(r.status).toBe(400);
    } finally { await close(); }
  });
});

// ---------------------------------------------------------------------------
// (5) cycle guard
// ---------------------------------------------------------------------------

describe("T-0655 move-API — department cycle rejected", () => {
  it("reparenting a department under its own descendant → 400 CYCLE", async () => {
    const captured: Captured = { auditEvents: [] };
    // Tree: DEPT_ID (root) → child. Making DEPT_ID a child of `child` is a cycle.
    const child = "cccccccc-0000-0000-0000-000000000050";
    const { port, close } = await startServer(
      makeStubPool(captured, {
        isOwner: true,
        parentOf: { [DEPT_ID]: null, [child]: DEPT_ID },
      }),
    );
    try {
      const r = await request(port, "PATCH", `/api/departments/${DEPT_ID}`, {
        tenant_id: TENANT_A, parent_id: child,
      });
      expect(r.status).toBe(400);
      expect(errCode(r.body)).toBe("CYCLE");
      expect(captured.auditEvents).toHaveLength(0);
    } finally { await close(); }
  });

  it("self-parent → 400 CYCLE", async () => {
    const captured: Captured = { auditEvents: [] };
    const { port, close } = await startServer(
      makeStubPool(captured, { isOwner: true, parentOf: { [DEPT_ID]: null } }),
    );
    try {
      const r = await request(port, "PATCH", `/api/departments/${DEPT_ID}`, {
        tenant_id: TENANT_A, parent_id: DEPT_ID,
      });
      expect(r.status).toBe(400);
      expect(errCode(r.body)).toBe("CYCLE");
    } finally { await close(); }
  });
});

// ---------------------------------------------------------------------------
// (6) not found
// ---------------------------------------------------------------------------

describe("T-0655 move-API — non-existent id", () => {
  it("PATCH /api/employees/:id for a missing employee → 404", async () => {
    const captured: Captured = { auditEvents: [] };
    const { port, close } = await startServer(
      makeStubPool(captured, { isOwner: true, rowExists: false }),
    );
    try {
      const r = await request(port, "PATCH", `/api/employees/${EMP_ID}`, {
        tenant_id: TENANT_A, position_id: POS_ID,
      });
      expect(r.status).toBe(404);
    } finally { await close(); }
  });
});

// ---------------------------------------------------------------------------
// (7) non-owner without a covering update grant
// ---------------------------------------------------------------------------

describe("T-0655 move-API — non-owner without grant rejected", () => {
  it("PATCH /api/departments/:id by a same-tenant non-owner with no mgmt grant → 403", async () => {
    const captured: Captured = { auditEvents: [] };
    // Same tenant (passes authorizeOrgWrite) but NOT owner and no delegable grant
    // → assertOrgObjectAuthority throws 403.
    const { port, close } = await startServer(
      makeStubPool(captured, { isOwner: false, parentOf: { [DEPT_ID]: null } }),
    );
    try {
      const r = await request(port, "PATCH", `/api/departments/${DEPT_ID}`, {
        tenant_id: TENANT_A, display_name: "X",
      });
      expect(r.status).toBe(403);
      expect(captured.auditEvents).toHaveLength(0);
    } finally { await close(); }
  });
});
