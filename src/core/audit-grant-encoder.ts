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
// NOTE (R-4 / cross-spec): T-0030 AC-12 specifies a fitness lint asserting that the
// emit call-site imports GrantAuditEvent from grant-lattice.ts.  T-0031 §6 specifies
// that T-0030 imports encodeGrantAuditEvent from this file (audit-grant-encoder.ts).
// Because this module re-exports GrantAuditEvent, T-0030 can satisfy AC-12 by
// importing from either source — creating spec ambiguity.  No change needed here;
// when T-0030 is reviewed its AC-12 fitness lint should additionally assert the
// encodeGrantAuditEvent import from audit-grant-encoder.ts.  Resolution deferred to
// the T-0030 merge review (orchestrator-owned).

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

// ---------------------------------------------------------------------------
// SodMutationAuditEvent — shape for SoD constraint write events (T-0409).
//
// Emitted by src/http/rights-sod-admin.ts on every create/update/delete of a
// sod_constraint row. The audit trail must capture who/what/when for every
// structural change to a compliance-critical control (SoD).
//
// subject: the sod_constraint id (the row being created/updated/deleted).
// payload: the full mutation context so a verifier can reconstruct the change.
// ---------------------------------------------------------------------------

export type SodMutationAuditEvent = {
  kind: "sod.create" | "sod.update" | "sod.delete";
  actor: string;            // authenticated employee slug
  constraintId: string;     // sod_constraint.id (subject)
  constraintKind: "static" | "dynamic";
  payload?: Record<string, unknown>; // mutation context (partial update fields, etc.)
};

// ---------------------------------------------------------------------------
// encodeSodMutationAuditEvent — pure encoder for SoD constraint mutation events.
//
// Parameters:
//   e          — the SodMutationAuditEvent shape
//   nowMs      — epoch-ms timestamp supplied by caller (Date.now() at call site)
//   idOverride — optional deterministic UUID for tests; omit in production
//
// Returns an AuditEventInput ready to pass verbatim to appendAuditEvent(tx, input).
// ---------------------------------------------------------------------------

export function encodeSodMutationAuditEvent(
  e: SodMutationAuditEvent,
  nowMs: number,
  idOverride?: string,
): AuditEventInput {
  return {
    id: idOverride ?? randomUUID(),
    type: e.kind,
    actor: e.actor,
    subject: e.constraintId,
    scope: null,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: {
      constraintKind: e.constraintKind,
      ...(e.payload ?? {}),
    },
    occurred_at: nowMs,
  };
}

// ---------------------------------------------------------------------------
// InvokeAuditEvent — shape for invoke request/command audit events (T-0024).
// Exported so src/http/invoke.ts can pass the correct shape to
// encodeInvokeAuditEvent.
// ---------------------------------------------------------------------------

export type InvokeAuditEvent = {
  kind: "invoke.request" | "invoke.command";
  actor: string;         // caller employee id
  targetAgentId: string; // subject = target agent employee id
  agentRoleId: string;
  orgScope: unknown;     // the grant's matched org ScopeElement
  goal: string;
};

// ---------------------------------------------------------------------------
// encodeInvokeAuditEvent — pure encoder for invoke request/command events.
//
// Parameters:
//   e          — the InvokeAuditEvent shape
//   nowMs      — epoch-ms timestamp supplied by caller (Date.now() at call site)
//   idOverride — optional deterministic UUID for tests; omit in production
//
// Returns an AuditEventInput ready to pass verbatim to appendAuditEvent(tx, input).
// ---------------------------------------------------------------------------

export function encodeInvokeAuditEvent(
  e: InvokeAuditEvent,
  nowMs: number,
  idOverride?: string,
): AuditEventInput {
  const mode = e.kind === "invoke.request" ? "request" : "command";
  return {
    id: idOverride ?? randomUUID(),
    type: e.kind,
    actor: e.actor,
    subject: e.targetAgentId,
    scope: e.orgScope,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: {
      mode,
      target_agent_id: e.targetAgentId,
      agent_role_id: e.agentRoleId,
      org_scope: e.orgScope,
      goal: e.goal,
    },
    occurred_at: nowMs,
  };
}
