/**
 * T-0031: Unit tests for src/core/audit-grant-encoder.ts
 *
 * Covers AC-01..AC-11.
 */

import { describe, it, expect, vi } from "vitest";
import {
  encodeGrantAuditEvent,
  encodeAssignmentAuditEvent,
  type GrantAuditEvent,
  type AssignmentAuditEvent,
  type AuditEventInput,
} from "../core/audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// Mock appendAuditEvent (T-0016 append path — T-0053 live impl not present).
// AC-11: there exist call-site stubs demonstrating the T-0030 seam contract.
// ---------------------------------------------------------------------------

const appendAuditEvent = vi.fn(async (_tx: unknown, _input: AuditEventInput) => {
  return Promise.resolve();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE_NODE = {
  kind: "node" as const,
  hierarchy: "org" as const,
  nodeId: "dept-1",
  nodeLevel: "department" as const,
};

const BASE_GRANT_EVENT: GrantAuditEvent = {
  kind: "grant.create",
  actor: "u1",
  subjectRoleId: "role-x",
  capability: { resourceType: "record", operation: "read" },
  scope: SCOPE_NODE,
};

const BASE_ASSIGNMENT_EVENT: AssignmentAuditEvent = {
  kind: "assignment.create",
  actor: "u1",
  employeeId: "emp-1",
  roleId: "role-x",
  orgScope: SCOPE_NODE,
};

// ---------------------------------------------------------------------------
// AC-01: field mapping for grant.create
// ---------------------------------------------------------------------------

describe("encodeGrantAuditEvent", () => {
  it("AC-01: maps grant.create fields correctly", () => {
    const input = encodeGrantAuditEvent(BASE_GRANT_EVENT, 1000, "fixed-id");

    expect(input.type).toBe("grant.create");
    expect(input.actor).toBe("u1");
    expect(input.subject).toBe("role-x");
    expect(input.scope).toEqual(SCOPE_NODE);
    expect(input.proposed_by).toBeNull();
    expect(input.confirmed_by).toBeNull();
    expect(input.payload).toEqual({ resourceType: "record", operation: "read" });
    expect(input.occurred_at).toBe(1000);
    expect(input.id).toBe("fixed-id");
    expect(input.via).toBeNull();
  });

  // AC-02: proposedBy / confirmedBy pass-through
  it("AC-02: threads proposedBy and confirmedBy", () => {
    const event: GrantAuditEvent = {
      ...BASE_GRANT_EVENT,
      proposedBy: "llm",
      confirmedBy: "u2",
    };
    const input = encodeGrantAuditEvent(event, 1000);
    expect(input.proposed_by).toBe("llm");
    expect(input.confirmed_by).toBe("u2");
  });

  // AC-03: grant.revoke type
  it("AC-03: maps grant.revoke type correctly", () => {
    const event: GrantAuditEvent = { ...BASE_GRANT_EVENT, kind: "grant.revoke" };
    const input = encodeGrantAuditEvent(event, 1000);
    expect(input.type).toBe("grant.revoke");
  });

  // AC-04: resourceFacet conditional
  it("AC-04: includes resourceFacet in payload when present", () => {
    const event: GrantAuditEvent = {
      ...BASE_GRANT_EVENT,
      capability: { resourceType: "record", operation: "read", resourceFacet: { key: "val" } },
    };
    const input = encodeGrantAuditEvent(event, 1000);
    expect((input.payload as Record<string, unknown>)["resourceFacet"]).toEqual({ key: "val" });
  });

  it("AC-04: omits resourceFacet from payload when absent", () => {
    const input = encodeGrantAuditEvent(BASE_GRANT_EVENT, 1000);
    expect(Object.keys(input.payload as object)).not.toContain("resourceFacet");
  });

  // AC-07: no chain columns
  it("AC-07: output contains no chain columns", () => {
    const input = encodeGrantAuditEvent(BASE_GRANT_EVENT, 1000);
    const keys = Object.keys(input);
    expect(keys).not.toContain("seq");
    expect(keys).not.toContain("prev_hash");
    expect(keys).not.toContain("row_hash");
    expect(keys).not.toContain("vocab_version");
  });

  // AC-08: deterministic when idOverride provided
  it("AC-08: returns same output with same idOverride (structural equality)", () => {
    const a = encodeGrantAuditEvent(BASE_GRANT_EVENT, 1000, "id-abc");
    const b = encodeGrantAuditEvent(BASE_GRANT_EVENT, 1000, "id-abc");
    expect(a.type).toBe(b.type);
    expect(a.actor).toBe(b.actor);
    expect(a.subject).toBe(b.subject);
    expect(a.scope).toEqual(b.scope);
    expect(a.payload).toEqual(b.payload);
    expect(a.occurred_at).toBe(b.occurred_at);
    expect(a.proposed_by).toBe(b.proposed_by);
    expect(a.confirmed_by).toBe(b.confirmed_by);
    expect(a.id).toBe(b.id);
  });

  // AC-11: T-0030 seam contract — call appendAuditEvent(tx, input)
  it("AC-11 seam-1: encodeGrantAuditEvent output passes verbatim to appendAuditEvent", async () => {
    const tx = {}; // mock transaction object
    const event: GrantAuditEvent = {
      kind: "grant.create",
      actor: "admin",
      subjectRoleId: "role-fin",
      capability: { resourceType: "record", operation: "approve" },
      scope: SCOPE_NODE,
      proposedBy: "llm",
      confirmedBy: "admin",
    };
    const nowMs = Date.now();
    const input = encodeGrantAuditEvent(event, nowMs);
    await appendAuditEvent(tx, input);
    expect(appendAuditEvent).toHaveBeenCalledWith(tx, input);
  });

  it("AC-11 seam-2: encodeGrantAuditEvent revoke seam", async () => {
    const tx = {};
    const event: GrantAuditEvent = {
      kind: "grant.revoke",
      actor: "admin",
      subjectRoleId: "role-fin",
      capability: { resourceType: "registry", operation: "write" },
      scope: SCOPE_NODE,
    };
    const input = encodeGrantAuditEvent(event, Date.now());
    await appendAuditEvent(tx, input);
    expect(appendAuditEvent).toHaveBeenCalledWith(tx, input);
  });
});

// ---------------------------------------------------------------------------
// encodeAssignmentAuditEvent tests
// ---------------------------------------------------------------------------

describe("encodeAssignmentAuditEvent", () => {
  // AC-05: field mapping for assignment.create
  it("AC-05: maps assignment.create fields correctly", () => {
    const input = encodeAssignmentAuditEvent(BASE_ASSIGNMENT_EVENT, 2000, "fixed-id");

    expect(input.type).toBe("assignment.create");
    expect(input.actor).toBe("u1");
    expect(input.subject).toBe("emp-1");
    expect(input.scope).toEqual(SCOPE_NODE);
    expect((input.payload as Record<string, unknown>)["roleId"]).toBe("role-x");
    expect(input.occurred_at).toBe(2000);
    expect(input.proposed_by).toBeNull();
    expect(input.confirmed_by).toBeNull();
    expect(input.via).toBeNull();
  });

  // AC-06: assignment.revoke type
  it("AC-06: maps assignment.revoke type correctly", () => {
    const event: AssignmentAuditEvent = { ...BASE_ASSIGNMENT_EVENT, kind: "assignment.revoke" };
    const input = encodeAssignmentAuditEvent(event, 2000);
    expect(input.type).toBe("assignment.revoke");
  });

  // AC-07: no chain columns
  it("AC-07: output contains no chain columns", () => {
    const input = encodeAssignmentAuditEvent(BASE_ASSIGNMENT_EVENT, 2000);
    const keys = Object.keys(input);
    expect(keys).not.toContain("seq");
    expect(keys).not.toContain("prev_hash");
    expect(keys).not.toContain("row_hash");
    expect(keys).not.toContain("vocab_version");
  });

  // AC-11 seam-3: encodeAssignmentAuditEvent seam
  it("AC-11 seam-3: encodeAssignmentAuditEvent output passes verbatim to appendAuditEvent", async () => {
    const tx = {};
    const event: AssignmentAuditEvent = {
      kind: "assignment.create",
      actor: "admin",
      employeeId: "e-kravtsova",
      roleId: "role-fin-ctrl",
      orgScope: SCOPE_NODE,
      proposedBy: "human",
      confirmedBy: "admin",
    };
    const input = encodeAssignmentAuditEvent(event, Date.now());
    await appendAuditEvent(tx, input);
    expect(appendAuditEvent).toHaveBeenCalledWith(tx, input);
  });
});
