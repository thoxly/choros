/**
 * src/runtime/legal-precheck/demo-run.ts — T-0234 DEMO-3 composition.
 *
 * Runs the legal_precheck AGENT (T-0233 runLegalPrecheck) as the S3 actor of the
 * linear ТЭЛ demo (T-0218 agent_slot.legal_precheck), DETERMINISTICALLY and with
 * ZERO paid LLM calls. The agent produces a PrecheckOutcome and CANNOT approve
 * (moat — verified separately at the PDP layer; see demoApproveDenied()).
 *
 * WHAT THIS MODULE IS / ISN'T:
 *   - It CONSUMES the merged T-0233 motor via its injectable ports. It does NOT
 *     edit the frozen motor core (run-precheck.ts / agent-precheck-motor.ts /
 *     llm-port.ts) — touched_frozen=false.
 *   - All IO is in-memory: InMemoryAuditWriter + inMemoryTx + in-memory
 *     ResolverDeps (allow). No Postgres, no network.
 *   - The LlmPort here is a deterministic in-process stub (DemoStubLlmPort) —
 *     NO SDK import, NO fetch, NO network (FF-LP-1(b) / FF-LP-3 / openai=$0).
 *     The real OpenAI adapter is deploy-time only (RL-3, founder-gated).
 *
 * D-139: buildLegalPrecheckSliceView surfaces ONLY the safe answer (red flags +
 * summary) + an OPAQUE reasoning_trace_ref. The raw chain-of-thought is never
 * surfaced — it lives only inside the motor's internal audit payload.
 *
 * dealContext = T-0233 fixture {5_500_000, service_agreement, outbound} — the one
 * dealContext with a contract body + deterministic expected answer (3 red flags).
 */

import { randomUUID } from "node:crypto";

import type { ChatLlmRequest, ChatLlmResult, LlmPort, LlmRequest, LlmResult, PrecheckAnswer } from "../../core/llm-port.js";
import { LlmDormantError, dormantLlmPort } from "../../core/llm-port.js";
import type { PrecheckOutcome } from "../../core/agent-precheck-motor.js";
import { runLegalPrecheck, type PrecheckDeps } from "./run-precheck.js";

import type { PgClientLike } from "../../db/audit-writer.js";
import { InMemoryAuditWriter } from "../../db/audit-writer.js";

import type { ResolverDeps, GrantSource, RecordSource } from "../../core/grant-resolver.js";
import { resolveFor } from "../../core/grant-resolver.js";
import type { Grant, AncestryOracle } from "../../core/grant-lattice.js";
import {
  makeHandle,
  type ObjectHandle,
  type ResourceRef,
  type ResolveSubject,
} from "../../core/object-handle.js";

// ---------------------------------------------------------------------------
// Demo fixtures — dealContext aligned with T-0233 (service_agreement, outbound).
// Self-contained (runtime module must not import test fixtures).
// ---------------------------------------------------------------------------

/** Demo deal context ≥ 5M₽ — EXACTLY T-0233's DEMO_DEAL_CONTEXT (ТЭЛ §1.4 trigger). */
export const DEMO_LEGAL_PRECHECK_DEAL: {
  readonly amount: number;
  readonly kind: string;
  readonly direction: string;
} = {
  amount: 5_500_000,
  kind: "service_agreement",
  direction: "outbound",
} as const;

/** Fictional contract body for the demo (договор оказания услуг) — not real data. */
export const DEMO_CONTRACT_BODY =
  "ДОГОВОР ОКАЗАНИЯ УСЛУГ №2026-TEL-0042 · 5 500 000 ₽ · " +
  "§4.2 односторонний перенос оплаты на 90 дней · " +
  "§7.1 ответственность ограничена 10% · " +
  "§11.3 арбитраж в иностранной юрисдикции (Гаага)";

/**
 * Deterministic red-flags answer for the demo contract (mirrors T-0233's
 * DEMO_PRECHECK_ANSWER). D-139: no reasoning fields in the answer.
 */
const DEMO_ANSWER: PrecheckAnswer = {
  answerForm: "legal_precheck_v1",
  redFlags: [
    {
      clause: "§4.2 Payment Terms",
      risk: "Contract allows unilateral extension of payment deadline by counterparty up to 90 days",
      severity: "high",
    },
    {
      clause: "§7.1 Liability Cap",
      risk: "Liability capped at 10% of contract value, insufficient for deals ≥5M₽",
      severity: "med",
    },
    {
      clause: "§11.3 Jurisdiction",
      risk: "Foreign arbitration clause — increases enforcement complexity",
      severity: "low",
    },
  ],
  summary: "Contract contains 3 risk clauses requiring legal review before signing",
};

// ---------------------------------------------------------------------------
// DemoStubLlmPort — deterministic, zero-network. NO SDK import (FF-LP-1(b)).
// ---------------------------------------------------------------------------

/**
 * In-process deterministic LlmPort for the demo run.
 * complete() returns the fixed demo red-flags answer (confidence 0.92).
 * There is no fetch / SDK / network path — structurally openai=$0.
 */
export class DemoStubLlmPort implements LlmPort {
  complete(req: LlmRequest): Promise<LlmResult> {
    const result: LlmResult = {
      confidence: 0.92,
      answer: { ...DEMO_ANSWER, answerForm: req.answerForm },
      // Internal-only chain-of-thought — the motor masks this into audit;
      // it MUST NOT reach buildLegalPrecheckSliceView (D-139).
      reasoning:
        "Internal: reviewed §4.2/§7.1/§11.3, flagged payment/liability/jurisdiction risk",
    };
    return Promise.resolve(result);
  }

  // T-0359: demo run is complete()-only; chat() not wired (fail closed).
  chat(_req: ChatLlmRequest): Promise<ChatLlmResult> {
    throw new LlmDormantError("DemoStubLlmPort does not support chat()");
  }
}

// ---------------------------------------------------------------------------
// In-memory PDP / tx fixtures (mirror run-precheck.test.ts deps; no Postgres).
// ---------------------------------------------------------------------------

const DEMO_TENANT = "d0d0d0d0-0000-0000-0000-00000000d010";
const DEMO_AGENT_ID = "d0d0d0d0-0000-0000-0000-00000000a6e7";
const DEMO_SUBJECT_ID = "d0d0d0d0-0000-0000-0000-00000000506b";
const DEMO_REG_ID = "d0d0d0d0-0000-0000-0000-0000000060e9";
const DEMO_REC_ID = "d0d0d0d0-0000-0000-0000-0000000060ec";
const DEMO_NOW_MS = 1_750_000_000_000;

function makeReadGrant(operation: Grant["operation"]): Grant {
  return {
    tenantId: DEMO_TENANT,
    id: `grant-${operation}-demo`,
    roleId: "role-intake-agent",
    resourceType: "record",
    operation,
    scope: { kind: "node", hierarchy: "resource", nodeId: DEMO_REG_ID, nodeLevel: "registry" },
    delegable: false,
    grantedBy: "admin",
    createdAt: 0,
  };
}

/**
 * Grants for the demo agent role: read (precheck) — NO approve grant (moat).
 * This mirrors seed/demo/tel-scenario.ts DEMO_GRANTS_INTAKE (read + update, NO approve).
 */
function demoGrantSource(): GrantSource {
  return { getGrants: () => Promise.resolve([makeReadGrant("read")]) };
}

function demoRecordSource(): RecordSource {
  return { getRecord: () => Promise.resolve({ body: DEMO_CONTRACT_BODY }) };
}

const demoOracle: AncestryOracle = {
  isDescendantOrSelf(_h, d, a): boolean {
    if (d === a) return true;
    return d === DEMO_REC_ID && a === DEMO_REG_ID;
  },
};

function demoResolverDeps(): ResolverDeps {
  return {
    grants: demoGrantSource(),
    records: demoRecordSource(),
    ancestry: demoOracle,
    now: () => DEMO_NOW_MS,
  };
}

function demoDocHandle(): ObjectHandle {
  const ref: ResourceRef = {
    kind: "record",
    tenantId: DEMO_TENANT,
    registryId: DEMO_REG_ID,
    recordId: DEMO_REC_ID,
  };
  return makeHandle(ref, DEMO_TENANT);
}

function demoSubject(): ResolveSubject {
  return { tenantId: DEMO_TENANT, subjectId: DEMO_SUBJECT_ID };
}

/**
 * A live-configured agent_card row for the demo: all three `llm_*` columns
 * non-null ⇒ the motor treats the agent as live-configured and uses the INJECTED
 * DemoStubLlmPort (NOT a real network call). This module CUSTODIES NO SECRET —
 * the demo never holds a real key; the `llm_secret_handle` column carries only an
 * opaque, fictional vault REFERENCE (`vault://demo/llm-key`, like the T-0233 test
 * fixture). The value never flows to a log/console/error/egress (FF-25-4 intent).
 *
 * Because this is a legitimate (fictional) custody site, `demo-run.ts` is added
 * to the FF-25-3 dormancy-boundary allow-set via the FF-FCI12 frozen-sanction
 * channel (additive, D-060 — same pattern as T-0233/T-0236). The literal column
 * name is written plainly; we do NOT hide it behind a dynamic-key construction.
 * The motor only checks these three are non-null (`llmConfigured`).
 */
function demoAgentCardRow(): Record<string, unknown> {
  return {
    llm_endpoint: "https://demo.local/v1",
    llm_model: "demo-stub",
    // Fictional opaque reference — never a real secret (NF / FF-25-4 intent).
    llm_secret_handle: "vault://demo/llm-key",
    autonomy_threshold: null,
  };
}

/**
 * Combined tx: returns the live-configured agent_card + published instruction
 * (so the motor reaches its proceed branch) and carries __tenantId for the
 * in-memory audit writer. Mirrors run-precheck.test.ts makeTxWithAgentCard.
 */
function demoTx(): PgClientLike & { __tenantId: string } {
  return {
    __tenantId: DEMO_TENANT,
    query: async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes("FROM choros.agent_card")) {
        return { rows: [demoAgentCardRow()] };
      }
      if (sql.includes("FROM choros.agent_instruction")) {
        return {
          rows: [
            {
              tenant_id: DEMO_TENANT,
              id: randomUUID(),
              employee_id: DEMO_AGENT_ID,
              employee_kind: "agent",
              tier: "published",
              instruction_text:
                "Вы — юридический аналитик по рискам договоров. Определите проблемные клаузулы и дайте резюме.",
              answer_form: "legal_precheck_v1",
              instruction_meta: {},
              bundle_id: null,
              created_at: DEMO_NOW_MS,
              updated_at: DEMO_NOW_MS,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// runDemoLegalPrecheck — one deterministic agent run as the S3 actor.
// ---------------------------------------------------------------------------

export type DemoRunMode = "live-stub" | "dormant";

export interface DemoRunResult {
  readonly outcome: PrecheckOutcome;
  readonly dealContext: typeof DEMO_LEGAL_PRECHECK_DEAL;
  /** Number of audit events the motor wrote (single-audit-sink → exactly 1). */
  readonly auditEventCount: number;
  /** The single audit event type the motor emitted. */
  readonly auditEventType: string | null;
  readonly mode: DemoRunMode;
}

/**
 * Run the legal_precheck agent (S3 actor) once.
 *
 *   mode="live-stub" — DemoStubLlmPort + liveEnabled → proceed + red flags.
 *   mode="dormant"   — liveEnabled=false → motor forces dormant → defer-to-human.
 *
 * Zero network, zero Postgres, deterministic (same input → same outcome).
 */
export async function runDemoLegalPrecheck(
  mode: DemoRunMode = "live-stub",
): Promise<DemoRunResult> {
  const auditWriter = new InMemoryAuditWriter();
  const tx = demoTx();

  const deps: PrecheckDeps = {
    llm: mode === "live-stub" ? new DemoStubLlmPort() : dormantLlmPort,
    resolverDeps: demoResolverDeps(),
    auditWriter,
    liveEnabled: mode === "live-stub",
  };

  const outcome = await runLegalPrecheck(tx, deps, {
    tenantId: DEMO_TENANT,
    agentEmployeeId: DEMO_AGENT_ID,
    documentHandle: demoDocHandle(),
    subject: demoSubject(),
    dealContext: DEMO_LEGAL_PRECHECK_DEAL,
    nowMs: DEMO_NOW_MS,
  });

  const rows = auditWriter.rows(DEMO_TENANT);

  return {
    outcome,
    dealContext: DEMO_LEGAL_PRECHECK_DEAL,
    auditEventCount: rows.length,
    auditEventType: rows[0]?.type ?? null,
    mode,
  };
}

// ---------------------------------------------------------------------------
// demoApproveDenied — the MOAT: the agent CANNOT approve.
// ---------------------------------------------------------------------------

export interface DemoApproveProbe {
  /** True iff the PDP denied the agent's attempt to `approve` (moat holds). */
  readonly denied: boolean;
  readonly reason: string | null;
}

/**
 * Probe the moat: resolve operation="approve" for the demo agent subject against
 * the SAME single PDP (resolveFor, T-0021). The demo agent role has read but NO
 * approve grant (mirrors role-intake-agent in tel-scenario.ts), so the PDP must
 * deny. This is the structural moat S3→S4: approve stays a human card-action.
 */
export async function demoApproveDenied(): Promise<DemoApproveProbe> {
  const view = await resolveFor(
    demoResolverDeps(),
    demoDocHandle(),
    demoSubject(),
    "approve",
  );
  return {
    denied: view.denied === true,
    reason: view.denied === true ? (view.reason ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// buildLegalPrecheckSliceView — D-139-safe surface for the clickable slice.
// ---------------------------------------------------------------------------

export interface SliceRedFlag {
  readonly clause: string;
  readonly risk: string;
  readonly severity: "low" | "med" | "high";
}

/**
 * D-139-SAFE serializable view of the precheck outcome for the slice.
 *
 * INVARIANT: this object NEVER contains the raw chain-of-thought. It carries
 * only the safe answer (red flags + summary) and an OPAQUE reasoning_trace_ref
 * (presence marker, not text). The slice can show "reasoning recorded" without
 * any reasoning egress.
 */
export interface LegalPrecheckSliceView {
  readonly kind: PrecheckOutcome["kind"];
  readonly redFlags: readonly SliceRedFlag[];
  readonly summary: string | null;
  /** Opaque reference proving reasoning was recorded in audit (NOT the text). */
  readonly reasoningTraceRef: string;
  /** Safe deal summary (amount/kind/direction — no record field values). */
  readonly dealSummary: string;
  /** For defer/fail-closed: the safe doubt/cause reason. */
  readonly note: string | null;
}

/**
 * Project a PrecheckOutcome into the D-139-safe slice view. The reasoning trace
 * ref is a deterministic opaque token derived from the outcome shape — it is a
 * PRESENCE marker, carrying no chain-of-thought.
 */
export function buildLegalPrecheckSliceView(
  outcome: PrecheckOutcome,
): LegalPrecheckSliceView {
  const dealSummary = `${DEMO_LEGAL_PRECHECK_DEAL.kind} · ${DEMO_LEGAL_PRECHECK_DEAL.direction} · ${DEMO_LEGAL_PRECHECK_DEAL.amount} ₽`;
  // Opaque, deterministic presence-ref (NOT reasoning text). D-139.
  const reasoningTraceRef = `trace:legal_precheck:${outcome.kind}`;

  if (outcome.kind === "proceed") {
    return {
      kind: "proceed",
      redFlags: outcome.answer.redFlags.map((r) => ({
        clause: r.clause,
        risk: r.risk,
        severity: r.severity,
      })),
      summary: outcome.answer.summary,
      reasoningTraceRef,
      dealSummary,
      note: null,
    };
  }

  if (outcome.kind === "defer-to-human") {
    return {
      kind: "defer-to-human",
      redFlags: [],
      summary: null,
      reasoningTraceRef,
      dealSummary,
      note: outcome.doubtReason,
    };
  }

  // fail-closed
  return {
    kind: "fail-closed",
    redFlags: [],
    summary: null,
    reasoningTraceRef,
    dealSummary,
    note: outcome.cause,
  };
}
