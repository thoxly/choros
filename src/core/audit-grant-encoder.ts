/**
 * src/core/audit-grant-encoder.ts
 *
 * T-0031: Pure encoder functions that map GrantAuditEvent / AssignmentAuditEvent
 * to AuditEventInput ready to pass to appendAuditEvent (T-0016 append path).
 *
 * DESIGN INVARIANTS (ADR §4.1 / NF-1 / NF-2):
 *  - Both encoder functions are pure and IO-free. No DB/network/LLM calls.
 *  - GrantAuditEvent is imported verbatim from grant-lattice.ts — NOT redefined here.
 *  - No import from pg, http, https, net, fetch, child_process.
 *  - Chain columns (seq, prev_hash, row_hash, vocab_version) are absent from output.
 *  - AuditEventInput is the contractual seam T-0030 calls before appendAuditEvent.
 */

import { randomUUID } from "node:crypto";
import type { GrantAuditEvent, Scope } from "./grant-lattice.js";

// Re-export Scope for use by DB/HTTP layers that need the type without importing grant-lattice
export type { Scope };

// Re-export GrantAuditEvent so T-0030 can import it from a single seam module if desired
export type { GrantAuditEvent };

// ---------------------------------------------------------------------------
// AuditEventInput — the concrete TS type for the T-0016 appendAuditEvent seam.
// Maps directly onto audit_event columns that callers can supply.
// Chain columns (seq, prev_hash, row_hash, vocab_version) are ABSENT — they
// are computed by appendAuditEvent (T-0016 §4.3 contract).
// ---------------------------------------------------------------------------

export type AuditEventInput = {
  id: string;             // stable UUID; caller-minted or encoder-generated
  type: string;           // e.g. "grant.create", "assignment.revoke"
  actor: string;
  subject: string | null;
  scope: unknown | null;  // ScopeElement; JCS-serialization is appendAuditEvent's duty
  via: string | null;
  proposed_by: string | null;
  confirmed_by: string | null;
  payload: unknown;       // plain JSON-serializable object
  occurred_at: number;    // epoch-ms bigint as TS number (safe for 2^53)
};

// ---------------------------------------------------------------------------
// AssignmentAuditEvent — shape for role-assignment level audit events (T-0031 FR-2).
// Exported so T-0030 can pass the correct shape to encodeAssignmentAuditEvent.
// ---------------------------------------------------------------------------

export type AssignmentAuditEvent = {
  kind: "assignment.create" | "assignment.revoke";
  actor: string;
  employeeId: string;
  roleId: string;
  orgScope: unknown;    // ScopeElement (hierarchy: "org")
  proposedBy?: string;
  confirmedBy?: string;
};

// ---------------------------------------------------------------------------
// encodeGrantAuditEvent — pure encoder for grant create/revoke events.
//
// Parameters:
//   e          — the GrantAuditEvent shape from grant-lattice.ts (FR-7)
//   nowMs      — epoch-ms timestamp supplied by caller (Date.now() at call site)
//   idOverride — optional deterministic UUID for tests; omit in production
//
// Returns an AuditEventInput ready to pass verbatim to appendAuditEvent(tx, input).
// ---------------------------------------------------------------------------

export function encodeGrantAuditEvent(
  e: GrantAuditEvent,
  nowMs: number,
  idOverride?: string,
): AuditEventInput {
  const payload: Record<string, unknown> = {
    resourceType: e.capability.resourceType,
    operation: e.capability.operation,
  };
  if (e.capability.resourceFacet !== undefined) {
    payload["resourceFacet"] = e.capability.resourceFacet;
  }

  return {
    id: idOverride ?? randomUUID(),
    type: e.kind,
    actor: e.actor,
    subject: e.subjectRoleId,
    scope: e.scope as unknown,
    via: null,
    proposed_by: e.proposedBy ?? null,
    confirmed_by: e.confirmedBy ?? null,
    payload,
    occurred_at: nowMs,
  };
}

// ---------------------------------------------------------------------------
// encodeAssignmentAuditEvent — pure encoder for role-assignment create/revoke events.
//
// Parameters:
//   e          — the AssignmentAuditEvent shape
//   nowMs      — epoch-ms timestamp
//   idOverride — optional deterministic UUID for tests
// ---------------------------------------------------------------------------

export function encodeAssignmentAuditEvent(
  e: AssignmentAuditEvent,
  nowMs: number,
  idOverride?: string,
): AuditEventInput {
  return {
    id: idOverride ?? randomUUID(),
    type: e.kind,
    actor: e.actor,
    subject: e.employeeId,
    scope: e.orgScope,
    via: null,
    proposed_by: e.proposedBy ?? null,
    confirmed_by: e.confirmedBy ?? null,
    payload: { roleId: e.roleId },
    occurred_at: nowMs,
  };
}
