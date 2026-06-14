/**
 * src/db/agent-instruction-store.ts — T-0123 competence layer DAO.
 *
 * The write/read DAO for choros.agent_instruction. Runs INSIDE the caller's open
 * withTenantTx transaction (PgClientLike, choros.tenant_id GUC already set) — it
 * does NOT open its own BEGIN/COMMIT (mirrors the agent-provision.ts / audit-writer
 * enqueueInTx pattern). tenant_id leads every statement (T-0013 invariant).
 *
 * Implements docs/design/T-0123-agent-competency-layer.adr.md §3 contract 3.
 *
 * VERSIONING REUSES T-0087 (NF-1):
 *  - saveDraft writes ONLY tier='draft'. Before mutating an existing row it calls
 *    assertWritable(currentTier) (src/core/env-tier.ts); a PUBLISHED_LOCKED result
 *    raises InstructionPublishedLockedError → the HTTP layer maps it to 409 (AC-5,
 *    FF-COMP-7). The DB trigger tier_published_locked (049) is the fail-closed half.
 *  - This DAO NEVER promotes a row to the published tier (that is promoteTier's
 *    sole job) and NEVER sets choros.promoting (the promote service's privilege).
 *    Promote draft→published goes through src/http/artifacts.ts::promoteTier
 *    (agent_instruction is registered in CONFIG_TABLES) — NOT a parallel mechanism.
 *
 * AUDIT (AC-9): each mutator appends an audit row via the canonical AuditWriter in
 * the SAME tx (atomic audit+DB, T-0042/T-0087 pattern). Draft create/edit →
 * agent.instruction.draft_saved; clear/delete → agent.instruction.cleared. Promote
 * is audited by the existing artifact.promoted type (in promoteTier), NOT here.
 *
 * RUNTIME-DORMANT (FF-COMP-6): this is an authoring DAO — no engine / worker /
 * response handler reads it day-1.
 */

import { randomUUID } from "node:crypto";
import { assertWritable, type Tier } from "../core/env-tier.js";
import {
  diffInstruction,
  type AgentInstruction,
  type AgentInstructionDraft,
  type SemanticChange,
} from "../core/agent-instruction.js";
import type { AuditWriter, PgClientLike } from "./audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";

// ---------------------------------------------------------------------------
// Typed errors (HTTP layer maps codes to status).
// ---------------------------------------------------------------------------

/** Raised when saveDraft is attempted on a published instruction (AC-5 → 409). */
export class InstructionPublishedLockedError extends Error {
  readonly code = "PUBLISHED_LOCKED" as const;
  constructor() {
    super("agent_instruction is published — direct edit forbidden (promote-locked)");
    this.name = "InstructionPublishedLockedError";
  }
}

// ---------------------------------------------------------------------------
// Row mapping.
// ---------------------------------------------------------------------------

interface AgentInstructionRow {
  tenant_id: string;
  id: string;
  employee_id: string;
  employee_kind: string;
  tier: string;
  instruction_text: string;
  answer_form: string | null;
  instruction_meta: Record<string, unknown>;
  bundle_id: string | null;
  created_at: string | number;
  updated_at: string | number;
}

function mapRow(r: AgentInstructionRow): AgentInstruction {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    employeeId: r.employee_id,
    employeeKind: "agent",
    tier: r.tier as Tier,
    instructionText: r.instruction_text,
    answerForm: r.answer_form,
    instructionMeta: r.instruction_meta ?? {},
    bundleId: r.bundle_id,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Reads (tenant-scoped via RLS; default read-tier via readTierScope at the caller).
// ---------------------------------------------------------------------------

/** Read the published instruction for an agent (null when absent). */
export async function readPublished(
  tx: PgClientLike,
  employeeId: string,
): Promise<AgentInstruction | null> {
  return readByTier(tx, employeeId, "published");
}

/** Read the draft instruction for an agent (null when absent). */
export async function readDraft(
  tx: PgClientLike,
  employeeId: string,
): Promise<AgentInstruction | null> {
  return readByTier(tx, employeeId, "draft");
}

async function readByTier(
  tx: PgClientLike,
  employeeId: string,
  tier: Tier,
): Promise<AgentInstruction | null> {
  const res = (await tx.query(
    `SELECT tenant_id, id, employee_id, employee_kind, tier, instruction_text,
            answer_form, instruction_meta, bundle_id, created_at, updated_at
       FROM choros.agent_instruction
      WHERE employee_id = $1 AND tier = $2`,
    [employeeId, tier],
  )) as { rows: AgentInstructionRow[] };
  const row = res.rows[0];
  return row ? mapRow(row) : null;
}

/** Read the single instruction row for an agent regardless of tier (null when absent). */
async function readCurrent(
  tx: PgClientLike,
  employeeId: string,
): Promise<AgentInstruction | null> {
  const res = (await tx.query(
    `SELECT tenant_id, id, employee_id, employee_kind, tier, instruction_text,
            answer_form, instruction_meta, bundle_id, created_at, updated_at
       FROM choros.agent_instruction
      WHERE employee_id = $1`,
    [employeeId],
  )) as { rows: AgentInstructionRow[] };
  const row = res.rows[0];
  return row ? mapRow(row) : null;
}

// ---------------------------------------------------------------------------
// saveDraft — UPSERT the draft instruction (tier='draft' only) + audit.
// ---------------------------------------------------------------------------

export interface SaveDraftArgs {
  draft: AgentInstructionDraft;
  /** Audit actor (the authenticated principal — human admin or config-agent). */
  actor: string;
  /** Audit actor type (from the authenticated claim; the config-agent authors drafts). */
  actorType: "human" | "agent";
  nowMs: number;
}

/**
 * Create or edit the DRAFT instruction for an agent, then append a
 * agent.instruction.draft_saved audit row in the SAME tx.
 *
 * Fail-closed published-lock (FF-COMP-7 / AC-5): if a row already exists and is
 * 'published', assertWritable returns PUBLISHED_LOCKED and this throws
 * InstructionPublishedLockedError BEFORE any write. The DB trigger is the second,
 * fail-closed half. This DAO never writes the published tier and never sets
 * choros.promoting — promotion is promoteTier's sole privilege.
 *
 * The audit payload carries the SEMANTIC changelog (diffInstruction), never the raw
 * instruction_text body (FF-COMP-8 / AC-7).
 */
export async function saveDraft(
  tx: PgClientLike,
  writer: AuditWriter,
  args: SaveDraftArgs,
): Promise<{ id: string; changes: SemanticChange[] }> {
  const { draft, actor, actorType, nowMs } = args;

  // 1. Published-lock guard (app-layer half). Read the current row (any tier).
  const existing = await readCurrent(tx, draft.employeeId);
  if (existing !== null) {
    const writable = assertWritable(existing.tier);
    if (!writable.ok) {
      // PUBLISHED_LOCKED → HTTP 409 (AC-5). No write, no audit.
      throw new InstructionPublishedLockedError();
    }
  }

  // 2. Semantic changelog vs the current published instruction (AC-7).
  const published = await readPublished(tx, draft.employeeId);
  const changes = diffInstruction(published, draft);

  // 3. UPSERT the draft row (tier='draft' ALWAYS). On conflict (one row per agent
  //    via UNIQUE(tenant_id, employee_id)) update the editable fields. tenant_id is
  //    sourced from the GUC the caller set (T-0013) — never from an untrusted arg.
  const id = existing?.id ?? draft.id ?? randomUUID();
  await tx.query(
    `INSERT INTO choros.agent_instruction
       (tenant_id, id, employee_id, employee_kind, tier, instruction_text,
        answer_form, instruction_meta, bundle_id, created_at, updated_at)
     VALUES (current_setting('choros.tenant_id', false)::uuid,
             $1, $2, 'agent', 'draft', $3, $4, $5::jsonb, $6, $7, $7)
     ON CONFLICT (tenant_id, employee_id) DO UPDATE SET
       instruction_text = EXCLUDED.instruction_text,
       answer_form      = EXCLUDED.answer_form,
       instruction_meta = EXCLUDED.instruction_meta,
       bundle_id        = EXCLUDED.bundle_id,
       updated_at       = EXCLUDED.updated_at`,
    [
      id,
      draft.employeeId,
      draft.instructionText,
      draft.answerForm,
      JSON.stringify(draft.instructionMeta ?? {}),
      draft.bundleId,
      nowMs,
    ],
  );

  // 4. Audit (atomic in the same tx). Semantic changelog only — no raw body (AC-7).
  await writer.appendAuditEvent(
    tx,
    draftSavedEvent(id, draft.employeeId, actor, actorType, changes, nowMs),
  );

  return { id, changes };
}

// ---------------------------------------------------------------------------
// clear — delete/clear the instruction (RED-LINES human-confirm path) + audit.
// ---------------------------------------------------------------------------

export interface ClearArgs {
  employeeId: string;
  /** Audit actor (RED-LINES default-DENY: a human confirmer, AC-14). */
  actor: string;
  nowMs: number;
}

/**
 * Clear (delete) an agent's instruction — the RED-LINES irreversible path (AC-14).
 * Audited as agent.instruction.cleared with actor.type='human' (the HTTP layer is
 * responsible for the human-confirm gate before calling this).
 *
 * A DELETE of a 'published' row trips the fail-closed DB trigger (049) — clearing a
 * published instruction is not a silent app-layer bypass. Returns whether a row was
 * removed (idempotent: clearing an absent instruction is a no-op, no audit).
 */
export async function clear(
  tx: PgClientLike,
  writer: AuditWriter,
  args: ClearArgs,
): Promise<{ cleared: boolean }> {
  const { employeeId, actor, nowMs } = args;

  const existing = await readCurrent(tx, employeeId);
  if (existing === null) {
    return { cleared: false };
  }

  await tx.query(
    `DELETE FROM choros.agent_instruction WHERE employee_id = $1`,
    [employeeId],
  );

  await writer.appendAuditEvent(
    tx,
    clearedEvent(existing.id, employeeId, actor, nowMs),
  );

  return { cleared: true };
}

// ---------------------------------------------------------------------------
// Audit encoders (T-0016 open-vocab agent.instruction.* — rows in audit_event).
// ---------------------------------------------------------------------------

function draftSavedEvent(
  instructionId: string,
  employeeId: string,
  actor: string,
  actorType: "human" | "agent",
  changes: SemanticChange[],
  nowMs: number,
): AuditEventInput {
  return {
    id: randomUUID(),
    type: "agent.instruction.draft_saved",
    actor,
    subject: `agent_instruction:${instructionId}`,
    scope: { employee_id: employeeId, tier: "draft" },
    via: "agent-instruction-authoring",
    proposed_by: null,
    // The config-agent (actorType='agent') proposes drafts; a human admin may also
    // author. confirmed_by is left null for drafts — draft is not a promote (AC-9).
    confirmed_by: actorType === "human" ? actor : null,
    // SEMANTIC changelog only — NEVER the raw instruction_text body (FF-COMP-8 / AC-7).
    payload: { actor_type: actorType, changes },
    occurred_at: nowMs,
  };
}

function clearedEvent(
  instructionId: string,
  employeeId: string,
  actor: string,
  nowMs: number,
): AuditEventInput {
  return {
    id: randomUUID(),
    type: "agent.instruction.cleared",
    actor,
    subject: `agent_instruction:${instructionId}`,
    scope: { employee_id: employeeId },
    via: "agent-instruction-authoring",
    proposed_by: null,
    confirmed_by: actor, // RED-LINES default-DENY: the human confirmer (AC-14).
    payload: { employee_id: employeeId },
    occurred_at: nowMs,
  };
}
