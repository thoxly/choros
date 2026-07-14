/**
 * web/src/screens/org-crud.test.js — T-0269
 *
 * Unit tests for the org-structure CRUD pure logic (org-crud.js):
 *   - per-entity validation (departments / positions / employees / roles / assignments)
 *     catches missing-required + bad-slug client-side;
 *   - payload assembly produces the EXACT body shape each backend endpoint expects
 *     (optional fields omitted, not sent blank), so the server's typeof guards pass;
 *   - buildOrgScope emits a ScopeElement of the exact shape parseScopeElement
 *     (src/http/grants.ts) accepts ({kind:"node",hierarchy:"org",nodeId,nodeLevel});
 *   - mapOrgError surfaces the shared write-route contract (409/403/404/401/400) honestly;
 *   - indexBySlug bridges tenant-state UUID rows → slug→uuid maps.
 */

import { describe, it, expect } from "vitest";
import {
  SLUG_RE,
  EMPLOYEE_KINDS,
  validateDepartment,
  validatePosition,
  validateEmployee,
  validateRole,
  validateAssignment,
  buildDepartmentPayload,
  buildPositionPayload,
  buildEmployeePayload,
  buildRolePayload,
  buildOrgScope,
  buildAssignmentPayload,
  mapOrgError,
  indexBySlug,
} from "./org-crud.js";

const TENANT = "a0000000-0000-0000-0000-000000000001";
const DEPT = "b0000000-0000-0000-0000-000000000001";
const POS = "c0000000-0000-0000-0000-000000000001";
const EMP = "d0000000-0000-0000-0000-000000000001";
const ROLE = "e0000000-0000-0000-0000-000000000001";

describe("slug grammar", () => {
  it("mirrors the constructor slug regex", () => {
    expect(SLUG_RE.test("sales-eu")).toBe(true);
    expect(SLUG_RE.test("a")).toBe(true);
    expect(SLUG_RE.test("Sales")).toBe(false); // uppercase
    expect(SLUG_RE.test("-lead")).toBe(false); // leading dash
    expect(SLUG_RE.test("with space")).toBe(false);
    expect(SLUG_RE.test("")).toBe(false);
  });
});

describe("validateDepartment", () => {
  it("accepts a valid department", () => {
    expect(validateDepartment({ slug: "sales", display_name: "Продажи" }).valid).toBe(true);
  });
  // T-0650 [UX-study §7]: slug is now OPTIONAL — an empty slug is valid (server
  // auto-generates from display_name); only the required NAME is still enforced.
  it("accepts an empty slug (auto-generated server-side) but still requires a name", () => {
    const { valid, errors } = validateDepartment({ slug: "", display_name: "" });
    expect(valid).toBe(false);
    expect(errors.slug).toBeUndefined();
    expect(errors.display_name).toBeTruthy();
  });
  it("accepts an empty slug together with a valid name (full auto-slug path)", () => {
    expect(validateDepartment({ slug: "", display_name: "Продажи" }).valid).toBe(true);
  });
  it("flags malformed slug when one IS provided", () => {
    expect(validateDepartment({ slug: "Sales!", display_name: "X" }).errors.slug).toBeTruthy();
  });
});

describe("validatePosition", () => {
  it("accepts valid", () => {
    expect(validatePosition({ department_id: DEPT, slug: "lead", title: "Лид" }).valid).toBe(true);
  });
  it("requires a department", () => {
    expect(validatePosition({ department_id: "", slug: "lead", title: "Лид" }).errors.department_id).toBeTruthy();
  });
  it("requires a title", () => {
    expect(validatePosition({ department_id: DEPT, slug: "lead", title: "  " }).errors.title).toBeTruthy();
  });
});

describe("validateEmployee", () => {
  it("accepts a valid human (no position)", () => {
    expect(validateEmployee({ kind: "human", slug: "j-doe", display_name: "J. Doe" }).valid).toBe(true);
  });
  it("accepts a valid agent", () => {
    expect(validateEmployee({ kind: "agent", slug: "bot-1", display_name: "Bot" }).valid).toBe(true);
  });
  it("rejects an unknown kind", () => {
    expect(validateEmployee({ kind: "robot", slug: "x", display_name: "X" }).errors.kind).toBeTruthy();
  });
  it("kinds list matches backend enum", () => {
    expect(EMPLOYEE_KINDS).toEqual(["human", "agent"]);
  });
});

describe("validateRole", () => {
  it("accepts valid", () => {
    expect(validateRole({ slug: "approver", display_name: "Согласующий" }).valid).toBe(true);
  });
  it("flags missing name", () => {
    expect(validateRole({ slug: "approver", display_name: "" }).errors.display_name).toBeTruthy();
  });
});

describe("validateAssignment", () => {
  it("accepts a full assignment", () => {
    expect(validateAssignment({ employee_id: EMP, role_id: ROLE, department_id: DEPT }).valid).toBe(true);
  });
  it("flags each missing field", () => {
    const { errors } = validateAssignment({ employee_id: "", role_id: "", department_id: "" });
    expect(errors.employee_id).toBeTruthy();
    expect(errors.role_id).toBeTruthy();
    expect(errors.department_id).toBeTruthy();
  });
});

describe("payload assembly", () => {
  it("department: omits parent_id when blank, includes when set", () => {
    expect(buildDepartmentPayload(TENANT, { slug: "sales", display_name: " Продажи " })).toEqual({
      tenant_id: TENANT,
      slug: "sales",
      display_name: "Продажи",
    });
    const withParent = buildDepartmentPayload(TENANT, { slug: "sub", display_name: "Под", parent_id: DEPT });
    expect(withParent.parent_id).toBe(DEPT);
  });

  // T-0650: an empty slug is OMITTED from the payload (not sent as ""), so the
  // server's "blank/absent slug → auto-generate" branch fires.
  it("department: omits slug when blank (auto-slug path, T-0650)", () => {
    const body = buildDepartmentPayload(TENANT, { slug: "", display_name: "Продажи" });
    expect("slug" in body).toBe(false);
    expect(body).toEqual({ tenant_id: TENANT, display_name: "Продажи" });
  });

  it("position: exact shape", () => {
    expect(buildPositionPayload(TENANT, { department_id: DEPT, slug: "lead", title: " Лид " })).toEqual({
      tenant_id: TENANT,
      department_id: DEPT,
      slug: "lead",
      title: "Лид",
    });
  });

  it("position: omits slug when blank (auto-slug path, T-0650)", () => {
    const body = buildPositionPayload(TENANT, { department_id: DEPT, slug: "", title: "Лид" });
    expect("slug" in body).toBe(false);
  });

  it("employee: omits position_id when blank, includes when set", () => {
    const noPos = buildEmployeePayload(TENANT, { kind: "human", slug: "j", display_name: "J" });
    expect(noPos).toEqual({ tenant_id: TENANT, kind: "human", slug: "j", display_name: "J" });
    expect("position_id" in noPos).toBe(false);
    const withPos = buildEmployeePayload(TENANT, { kind: "agent", slug: "b", display_name: "B", position_id: POS });
    expect(withPos.position_id).toBe(POS);
  });

  it("employee: omits slug when blank (auto-slug path, T-0650)", () => {
    const body = buildEmployeePayload(TENANT, { kind: "human", slug: "", display_name: "J. Doe" });
    expect("slug" in body).toBe(false);
    expect(body).toEqual({ tenant_id: TENANT, kind: "human", display_name: "J. Doe" });
  });

  it("role: omits description when blank, includes when set", () => {
    const noDesc = buildRolePayload(TENANT, { slug: "r", display_name: "R" });
    expect("description" in noDesc).toBe(false);
    const withDesc = buildRolePayload(TENANT, { slug: "r", display_name: "R", description: " note " });
    expect(withDesc.description).toBe("note");
  });

  it("role: omits slug when blank (auto-slug path, T-0650)", () => {
    const body = buildRolePayload(TENANT, { slug: "", display_name: "Согласующий" });
    expect("slug" in body).toBe(false);
  });

  it("buildOrgScope: matches parseScopeElement node shape", () => {
    expect(buildOrgScope(DEPT)).toEqual({
      kind: "node",
      hierarchy: "org",
      nodeId: DEPT,
      nodeLevel: "department",
    });
  });

  it("assignment: derives granted_by + manual source + node scope", () => {
    const body = buildAssignmentPayload({ employee_id: EMP, role_id: ROLE, department_id: DEPT }, "e-owner");
    expect(body).toEqual({
      employee_id: EMP,
      role_id: ROLE,
      org_scope: { kind: "node", hierarchy: "org", nodeId: DEPT, nodeLevel: "department" },
      source: "manual",
      granted_by: "e-owner",
    });
  });
});

describe("mapOrgError", () => {
  it("409 CONFLICT → slug conflict on the slug field (create flows)", () => {
    const r = mapOrgError(409, { error: { code: "CONFLICT", message: "slug exists" } });
    expect(r.field).toBe("slug");
    expect(r.message).toMatch(/занят/);
  });
  it("409 FK_IN_USE → honest in-use hint (T-0292: backend maps pg 23503 → 409)", () => {
    const r = mapOrgError(409, { error: { code: "FK_IN_USE", message: "department cannot be deleted" } }, "подразделение");
    expect(r.field).toBeUndefined();
    expect(r.message).toMatch(/связанные записи/);
    expect(r.message).toMatch(/подразделение/);
    // must NOT claim it's a slug conflict
    expect(r.message).not.toMatch(/Слаг/);
  });
  it("409 without a code → slug conflict (backward-compat)", () => {
    // bare 409 (no body code) still maps to slug conflict for create flows
    const r = mapOrgError(409, { error: { message: "x" } });
    expect(r.field).toBe("slug");
    expect(r.message).toMatch(/занят/);
  });
  it("403 → honest genesis-owner message", () => {
    expect(mapOrgError(403, null).message).toMatch(/владелец/i);
  });
  it("404 → not found", () => {
    expect(mapOrgError(404, null).message).toMatch(/не найдена/i);
  });
  it("401 → re-login", () => {
    expect(mapOrgError(401, null).message).toMatch(/авторизована/i);
  });
  it("400 → surfaces server VALIDATION message verbatim", () => {
    expect(mapOrgError(400, { error: { message: "slug is required" } }).message).toBe("slug is required");
  });
  it("500 → generic fallback (T-0292: FK violations now return 409 FK_IN_USE, not 500)", () => {
    // 500 is now only for truly unexpected server errors; the FK-in-use case is
    // mapped backend-side to 409 FK_IN_USE (T-0292). 500 surfaces server message.
    const r = mapOrgError(500, { error: { message: "internal server error" } }, "роль");
    expect(r.message).toBe("internal server error");
  });
  it("unknown status fallback uses entity label", () => {
    expect(mapOrgError(418, null, "подразделение").message).toMatch(/подразделение/);
  });
});

describe("indexBySlug", () => {
  it("maps slug → uuid, skips malformed rows", () => {
    const m = indexBySlug([
      { id: DEPT, slug: "fin" },
      { id: POS, slug: "fin-ctrl" },
      { slug: "no-id" },
      null,
    ]);
    expect(m).toEqual({ fin: DEPT, "fin-ctrl": POS });
  });
  it("tolerates non-arrays", () => {
    expect(indexBySlug(undefined)).toEqual({});
  });
});
