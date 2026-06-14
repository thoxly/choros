/**
 * src/core/agent-instruction.ts — T-0123 competence layer (PURE, IO-FREE).
 *
 * The TS shape of the per-agent competence instruction + the deterministic
 * semantic changelog differ. Implements
 * docs/design/T-0123-agent-competency-layer.adr.md §3 contracts 2 / 4.
 *
 * No import from pg / http / https / net / fetch / child_process — this module is
 * pure (the DB DAO lives in src/db/agent-instruction-store.ts; the promote path
 * lives in src/http/artifacts.ts). The `tier` field REUSES the T-0087 `Tier` type
 * from ./env-tier.js — T-0123 declares NO tier union of its own (NF-1).
 *
 * DESIGN INVARIANTS:
 *  - tier is the T-0087 `Tier`, never a private union.
 *  - The changelog is SEMANTIC (a per-field change signal), never a raw text-diff
 *    of instruction_text (FF-COMP-8 / AC-7): the human-facing layer never receives
 *    the full instruction body in the changelog.
 */

import type { Tier } from "./env-tier.js";

// ---------------------------------------------------------------------------
// AgentInstruction — the competence-instruction artifact (mirrors choros.agent_instruction).
// ---------------------------------------------------------------------------

/** A per-agent competence instruction artifact (one row per agent). */
export interface AgentInstruction {
  tenantId: string;
  id: string;
  employeeId: string;
  /** Pinned to 'agent' by the DB CHECK; only kind='agent' employees own an instruction. */
  employeeKind: "agent";
  /** REUSES T-0087 Tier ('draft' | 'published') — no private union (NF-1). */
  tier: Tier;
  /** Main competence text (AC-1). */
  instructionText: string;
  /** Machine-distinct answer-form param ('sum' / 'sum_with_breakdown' / …); null = unset. */
  answerForm: string | null;
  /** Extensible envelope of further form params (no migration per bank case). */
  instructionMeta: Record<string, unknown>;
  /** Forward-compat pointer to the E12.1/T-0082 bundle; null + NO FK day-1 (dormant). */
  bundleId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A draft edition of an instruction (the writable subset). `tier` is NOT part of
 * the draft edition — the writer always writes 'draft' and the DB CHECK + trigger
 * enforce it; tier transitions to 'published' happen ONLY via promoteTier.
 */
export interface AgentInstructionDraft {
  tenantId: string;
  id: string;
  employeeId: string;
  instructionText: string;
  answerForm: string | null;
  instructionMeta: Record<string, unknown>;
  bundleId: string | null;
}

// ---------------------------------------------------------------------------
// Semantic changelog (FF-COMP-8 / AC-7) — deterministic per-field differ.
// ---------------------------------------------------------------------------

/**
 * One semantic change between a published instruction and a draft edition.
 *
 * For `instruction_text` ONLY the fact-of-change is reported (`changed: true`),
 * NEVER the body — the human-facing changelog must not serialize the full text
 * (FF-COMP-8). For `answer_form` the old/new VALUES are reported (they are short
 * machine-distinct form codes, not free text — extensibility §9 / AC-7).
 */
export type SemanticChange =
  | { field: "instruction_text"; changed: true }
  | { field: "answer_form"; from: string | null; to: string | null }
  | { field: "instruction_meta"; changed: true };

/**
 * Deterministic per-field differ between the current published instruction and a
 * draft edition. Returns the SEMANTIC change set — never a raw code-diff (AC-7).
 *
 * Pure: same inputs → same output, no IO. When `published` is null (no prior
 * published instruction), every present field that differs from the empty baseline
 * is reported as a change (first publication).
 */
export function diffInstruction(
  published: AgentInstruction | null,
  draft: AgentInstructionDraft,
): SemanticChange[] {
  const changes: SemanticChange[] = [];

  const prevText = published?.instructionText ?? null;
  if (prevText !== draft.instructionText) {
    // FF-COMP-8: report the fact-of-change ONLY, never the body.
    changes.push({ field: "instruction_text", changed: true });
  }

  const prevForm = published?.answerForm ?? null;
  if (prevForm !== draft.answerForm) {
    // answer_form is a short machine-distinct form code — values are safe to surface.
    changes.push({ field: "answer_form", from: prevForm, to: draft.answerForm });
  }

  const prevMeta = JSON.stringify(published?.instructionMeta ?? {});
  const nextMeta = JSON.stringify(draft.instructionMeta ?? {});
  if (prevMeta !== nextMeta) {
    changes.push({ field: "instruction_meta", changed: true });
  }

  return changes;
}
