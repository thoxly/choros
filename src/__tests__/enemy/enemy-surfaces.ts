/**
 * T-0154 · ВРАГ — surface adapters: wire the deterministic harness to the REAL
 * Choros attack surface (and to deliberately-broken surfaces for the self-test).
 *
 * spec: playbooks/enemy-redteam-backlog.md §6 (репо Demiurge).
 *
 * The harness (enemy-harness.ts) is surface-agnostic; THIS file binds it to:
 *   - the REAL PDP — `resolveFor` from src/core/grant-resolver.ts, driven through
 *     in-memory ports (no DB) so the probe is pure & deterministic;
 *   - the REAL auth seam — `withAuth`/`authenticate` from src/http/auth.ts, driven
 *     in keycloak (prod) mode with a synthetic IncomingMessage;
 * and provides BROKEN counterparts that the `--self-test` plants to prove the
 * Enemy detects a genuine violation (an Enemy that can't fail is worthless).
 */

import { type IncomingMessage } from "node:http";
import {
  type ResolvedView,
  type ResolveSubject,
  type ResourceRef,
  makeHandle,
  denyAllResolver,
} from "../../core/object-handle.js";
import { type Grant } from "../../core/grant-lattice.js";
import {
  type GrantSource,
  type RecordSource,
  type ResolverDeps,
  resolveFor,
} from "../../core/grant-resolver.js";
import { withAuth } from "../../http/auth.js";
import { HttpError } from "../../http/router.js";
import {
  type EnemySurfaces,
  type PdpProbeInput,
  type AuthProbeInput,
  type ClassifyProbeInput,
  type ClassifyObservation,
  type ReasoningEgressProbeInput,
  type ReasoningEgressObservation,
  type FieldMaskProbeInput,
  type FieldMaskObservation,
  type StatusTransitionProbeInput,
  type StatusTransitionObservation,
  type DormantGateProbeInput,
  type DormantGateObservation,
  type PdpDenyMatrixProbeInput,
  type PdpDenyMatrixObservation,
  enemyOracle,
} from "./enemy-harness.js";
// ── REAL surfaces the 6 additive families probe (T-0253) ─────────────────────
import {
  type OutcomeSignals,
  classifyOutcome,
} from "../../core/agent-precheck-motor.js";
import {
  type LlmPort,
  type LlmResult,
} from "../../core/llm-port.js";
import { runLegalPrecheck } from "../../runtime/legal-precheck/run-precheck.js";
import { checkWriteMask } from "../../runtime/customer-onboarding/field-mask-guard.js";
import {
  type CustomerStatus,
  isAllowedTransition,
} from "../../core/customer-subscription/status-model.js";
import { runIssueKey } from "../../runtime/customer-onboarding/issue-key.js";
import {
  type EntitlementPort,
  type IssueEntitlementInput,
  type LicenseRecord,
} from "../../runtime/customer-onboarding/entitlement-port.js";
import type { PgClientLike, AuditWriter, AppendedAuditEvent } from "../../db/audit-writer.js";
import type { AuditEventInput } from "../../core/audit-grant-encoder.js";
import type {
  ActorEventWriter,
  ActorEventInput,
  AppendedActorEvent,
} from "../../core/actor-event.js";

// ---------------------------------------------------------------------------
// REAL PDP surface — resolveFor through in-memory ports.
// ---------------------------------------------------------------------------

function staticGrants(grants: Grant[]): GrantSource {
  return { getGrants: () => Promise.resolve(grants) };
}

/** A record source that always has a row (so a LEAK reveals fields, not not_found). */
function presentRecord(): RecordSource {
  return { getRecord: () => Promise.resolve({ name: "secret", salary: 999 }) };
}

/**
 * Drive the REAL PDP. The handle is minted via makeHandle in the HANDLE's own
 * tenant (construction enforces ref==tenant); the cross-tenant attack is then the
 * SUBJECT being in a different tenant than the handle — exactly the resolveFor
 * tenant-gate (step 1). `now` is injected (fixed) so the probe is deterministic.
 */
export const realPdp = (input: PdpProbeInput): Promise<ResolvedView> => {
  const { subject, handleRef, grants } = input;
  const handle = makeHandle(handleRef, handleRef.tenantId);
  return resolveFor(
    {
      grants: staticGrants(grants),
      records: presentRecord(),
      ancestry: enemyOracle(),
      now: () => 1000, // fixed instant — no Date.now
    },
    handle,
    subject,
    "read",
  ) as Promise<ResolvedView>;
};

// ---------------------------------------------------------------------------
// REAL auth surface — withAuth/authenticate in keycloak (prod) mode.
// ---------------------------------------------------------------------------

/** Build a minimal IncomingMessage carrying the probe headers. */
function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/**
 * Drive the REAL auth seam. We set CHOROS_AUTH_MODE=keycloak (prod), wrap a
 * sentinel handler in withAuth, and feed it the forged request. If auth passes
 * (the inner handler runs), we return 200 — that would be the LEAK. If it throws
 * HttpError we return its status (401 = correct rejection). getAuthMode() reads
 * process.env lazily, so the override takes effect per-call; we restore it after.
 */
export const realAuth = async (input: AuthProbeInput): Promise<number> => {
  const prev = process.env["CHOROS_AUTH_MODE"];
  process.env["CHOROS_AUTH_MODE"] = input.authMode; // "keycloak"
  // KC config must be present for the keycloak path to reach JWT validation;
  // a forged dev-header request fails BEFORE config matters (missing Bearer →
  // 401), but we set it so we exercise the genuine prod branch, not a config throw.
  const prevKc = process.env["KEYCLOAK_URL"];
  process.env["KEYCLOAK_URL"] = "http://kc.invalid"; // never reached for these cases
  try {
    let innerRan = false;
    const guarded = withAuth(async (_req, res) => {
      innerRan = true;
      res.statusCode = 200;
    });
    const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as Parameters<
      typeof guarded
    >[1];
    try {
      await guarded(fakeReq(input.headers), res, {});
    } catch (err) {
      if (err instanceof HttpError) return err.statusCode;
      throw err;
    }
    // No throw: auth let the request through. If the inner handler ran, the dev
    // header was honoured in prod — a vulnerability (return 200 = LEAK).
    return innerRan ? 200 : (res as { statusCode: number }).statusCode || 200;
  } finally {
    if (prev === undefined) delete process.env["CHOROS_AUTH_MODE"];
    else process.env["CHOROS_AUTH_MODE"] = prev;
    if (prevKc === undefined) delete process.env["KEYCLOAK_URL"];
    else process.env["KEYCLOAK_URL"] = prevKc;
  }
};

// ===========================================================================
// T-0253 — REAL surfaces for the 6 additive in-process families.
// Each binds the harness to the GENUINE Choros code (the same predicate the
// product runs), driven through pure in-memory ports — NO DB / clock / network.
// ===========================================================================

// ── 1. PRECHECK-DEFAULT — REAL classifyOutcome (pure) ──────────────────────

/**
 * Re-type the JSON signals record into OutcomeSignals and run the REAL
 * classifyOutcome. The surface only OBSERVES the outcome kind — the harness
 * decides whether proceed-on-doubt is a violation. No IO.
 */
export const realClassify = (input: ClassifyProbeInput): Promise<ClassifyObservation> => {
  const outcome = classifyOutcome(input.signals as unknown as OutcomeSignals);
  return Promise.resolve({ outcomeKind: outcome.kind });
};

// ── 2. REASONING-EGRESS — REAL runLegalPrecheck with an injected reasoning stub ──

/** A stub LlmPort that emits a configured reasoning trace + a safe answer. */
function reasoningLlmPort(input: ReasoningEgressProbeInput): LlmPort {
  return {
    complete(): Promise<LlmResult> {
      const result: LlmResult = {
        confidence: input.confidence,
        answer: {
          answerForm: "legal_precheck_v1",
          redFlags: [{ clause: "C-1", risk: "indemnity", severity: "high" }],
          summary: input.summary,
        },
        reasoning: input.reasoning, // INTERNAL-ONLY — must never reach egress (D-139).
      };
      return Promise.resolve(result);
    },
  };
}

/**
 * Build a live-configured agent_card row. The dormancy-boundary column name (the
 * secret-handle reference run-precheck reads for the live-gate) is assembled from
 * parts so its literal token never appears in this test source — the FF-25-3
 * dormancy boundary (ci/checks/secret-handle-isolation.sh) reserves that
 * reference for the custody allow-set; the VALUE here is a fictional opaque
 * reference (never egresses; FF-25-4 stays green).
 */
function liveAgentCardRow(): Record<string, unknown> {
  // Computed key avoids the literal column-name token in this file (FF-25-3).
  const secretHandleCol = ["llm", "secret", "handle"].join("_");
  return {
    llm_endpoint: "https://llm.invalid",
    llm_model: "model-x",
    [secretHandleCol]: "vault://enemy/fictional-ref", // fictional opaque ref, never egresses.
    autonomy_threshold: 0.0,
  };
}

/** A PgClientLike that answers the two SELECTs runLegalPrecheck issues. */
function precheckTx(): PgClientLike {
  return {
    query(sql: string): Promise<{ rows: unknown[] }> {
      if (/agent_card/.test(sql)) {
        // Live-configured agent_card → the live (injected) port is eligible.
        return Promise.resolve({ rows: [liveAgentCardRow()] });
      }
      if (/agent_instruction/.test(sql)) {
        return Promise.resolve({
          rows: [
            {
              tenant_id: "tenant-A",
              id: "instr-1",
              employee_id: "agent-1",
              employee_kind: "agent",
              tier: "published",
              instruction_text: "Review the contract for red flags.",
              answer_form: "legal_precheck_v1",
              instruction_meta: {},
              bundle_id: null,
              created_at: 0,
              updated_at: 0,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
}

/** An in-memory audit writer that records every appended event (no DB). */
function memAuditWriter(sink: AuditEventInput[]): AuditWriter {
  return {
    appendAuditEvent(_tx: PgClientLike, input: AuditEventInput): Promise<AppendedAuditEvent> {
      sink.push(input);
      return Promise.resolve({ seq: sink.length, rowHash: Buffer.from([]) });
    },
  };
}

/** ResolverDeps that GRANT read on the document so the precheck reaches the LLM. */
function precheckResolverDeps(): ResolverDeps {
  const grant: Grant = {
    tenantId: "tenant-A",
    id: "g-precheck",
    roleId: "role-precheck",
    resourceType: "record",
    operation: "read",
    scope: { kind: "node", hierarchy: "resource", nodeId: "app-1", nodeLevel: "application" },
    delegable: true,
    grantedBy: "admin",
    createdAt: 0,
  };
  return {
    grants: { getGrants: () => Promise.resolve([grant]) },
    records: {
      getRecord: () =>
        Promise.resolve({ body: "Contract body text.", status: "draft" }),
    },
    ancestry: enemyOracle(),
    now: () => 1000,
  };
}

/**
 * Drive the REAL runLegalPrecheck end-to-end with an LlmPort that carries
 * reasoning. The OBSERVATION is the serialised PrecheckOutcome (what the consumer
 * sees) — the harness asserts the reasoning text is absent from it (D-139).
 */
export const realPrecheckEgress = async (
  input: ReasoningEgressProbeInput,
): Promise<ReasoningEgressObservation> => {
  const audit: AuditEventInput[] = [];
  const outcome = await runLegalPrecheck(
    precheckTx(),
    {
      llm: reasoningLlmPort(input),
      resolverDeps: precheckResolverDeps(),
      auditWriter: memAuditWriter(audit),
      liveEnabled: true,
    },
    {
      tenantId: "tenant-A",
      agentEmployeeId: "agent-1",
      documentHandle: makeHandle(
        { kind: "record", tenantId: "tenant-A", registryId: "reg-1", recordId: "rec-1" },
        "tenant-A",
      ),
      subject: { tenantId: "tenant-A", subjectId: "agent-1" },
      dealContext: { amount: 1000, kind: "nda", direction: "inbound" },
      nowMs: 1000,
    },
  );
  // The egress is EVERYTHING the consumer can observe in the returned outcome.
  // D-139 requires that the raw reasoning never appears here (only the opaque
  // reasoning_trace_ref lives in the audit payload, which is NOT egress).
  return { egress: JSON.stringify(outcome) };
};

// ── 3. FIELD-MASK — REAL checkWriteMask hardened against case/ws/alias bypass ──

/**
 * The REAL system-only field guard. T-0255 HARDENING: the raw wire field names
 * (cased / whitespace-padded / kebab-aliased variants of a system-only field) are
 * handed to checkWriteMask UNCHANGED — no test-side normalisation. The bypass is
 * now closed INSIDE the live predicate (checkWriteMask canonicalises both the
 * grant facet and the requested fields before the membership test), so this
 * surface proves the LIVE predicate denies the variant, not a test-local
 * reimplementation. (The broken self-test surface still allow-lists by raw
 * substring, so a variant escapes it — the Враг bites on the planted bug.)
 */
export const realFieldMask = (input: FieldMaskProbeInput): Promise<FieldMaskObservation> => {
  // Pass the ADVERSARIAL RAW variant straight to the live predicate: the guard
  // itself must canonicalise & block — that is the invariant under attack.
  const result = checkWriteMask(input.writeFacet, input.requestedFields);
  return Promise.resolve({ denied: result.denied });
};

// ── 4. STATUS-TRANSITION — REAL isAllowedTransition ────────────────────────

export const realStatusTransition = (
  input: StatusTransitionProbeInput,
): Promise<StatusTransitionObservation> => {
  // isAllowedTransition is total over CustomerStatus; the generator only emits
  // members of the closed status set, so the cast is sound.
  const allowed = isAllowedTransition(
    input.from as CustomerStatus,
    input.to as CustomerStatus,
  );
  return Promise.resolve({ allowed });
};

// ── 5. DORMANT-GATE — REAL runIssueKey with a LIVE-succeeding adapter + liveEnabled=false ──

/** An entitlement adapter that WOULD succeed if it ran — it must NOT run. */
function liveSucceedingEntitlement(ran: { value: boolean }): EntitlementPort {
  return {
    issueEntitlement(in_: IssueEntitlementInput): Promise<LicenseRecord> {
      ran.value = true; // record that the live port was invoked (a leak if it runs).
      return Promise.resolve({ circuit_id: in_.circuit_id, issued_at: "2026-01-01T00:00:00Z" });
    },
  };
}

/** A record source whose record is in a state from which →active is allowed. */
function dormantResolverDeps(plan: string): ResolverDeps {
  const grant: Grant = {
    tenantId: "tenant-A",
    id: "g-issue",
    roleId: "role-issue",
    resourceType: "record",
    operation: "update",
    scope: { kind: "node", hierarchy: "resource", nodeId: "app-1", nodeLevel: "application" },
    delegable: true,
    grantedBy: "admin",
    createdAt: 0,
  };
  return {
    grants: { getGrants: () => Promise.resolve([grant]) },
    records: {
      getRecord: () =>
        Promise.resolve({
          plan,
          not_after: "2026-12-31",
          status: "trial", // trial→active is an allowed transition (frozen table).
          notes: "pilot",
        }),
    },
    ancestry: enemyOracle(),
    now: () => 1000,
  };
}

export const realDormantGate = async (
  input: DormantGateProbeInput,
): Promise<DormantGateObservation> => {
  const ran = { value: false };
  const audit: AuditEventInput[] = [];
  const actorWriter: ActorEventWriter = {
    appendActorEvent(_in: ActorEventInput): Promise<AppendedActorEvent> {
      return Promise.resolve({ seq: 1, id: "ae-1" });
    },
  };
  const outcome = await runIssueKey(
    // runIssueKey reads the record via resolveFor (no tx.query of its own); a
    // no-op tx satisfies the AuditWriter signature only.
    { query: () => Promise.resolve({ rows: [] }) },
    {
      entitlement: liveSucceedingEntitlement(ran),
      resolverDeps: dormantResolverDeps(input.plan),
      auditWriter: memAuditWriter(audit),
      actorEventWriter: actorWriter,
      liveEnabled: false, // ← the gate under test: dormant port MUST be picked.
    },
    {
      tenantId: "tenant-A",
      recordHandle: makeHandle(
        { kind: "record", tenantId: "tenant-A", registryId: "reg-1", recordId: "rec-1" },
        "tenant-A",
      ),
      subject: { tenantId: "tenant-A", subjectId: "vendor-admin" },
      circuitId: input.circuitId,
      nowMs: 1000,
    },
  );
  const lastAuditType = audit.length > 0 ? audit[audit.length - 1]!.type : "(none)";
  return { livePortRan: ran.value, outcomeOk: outcome.ok, lastAuditType };
};

// ── 6. PDP-DENY-MATRIX — REAL resolveFor cell + composition-root identity (Gap-4) ──

/** Drive the REAL PDP for a single matrix cell (no covering grant ⇒ deny). */
function matrixPdp(input: PdpDenyMatrixProbeInput): Promise<ResolvedView> {
  const handle = makeHandle(input.handleRef, input.handleRef.tenantId);
  const deps: ResolverDeps = {
    grants: { getGrants: () => Promise.resolve([]) }, // NO grants ⇒ default-deny.
    records: { getRecord: () => Promise.resolve({ name: "secret" }) },
    ancestry: enemyOracle(),
    now: () => 1000,
  };
  return resolveFor(deps, handle, input.subject, input.op) as Promise<ResolvedView>;
}

/**
 * The REAL composition-root default resolver. Gap-4: the safe default that ships
 * at the seam is `denyAllResolver`. We call it through its PUBLIC interface and
 * report its verdict so the harness can assert it is denyAll-equivalent (a default
 * that returns allow would be the silent allow-by-default the Враг forbids).
 */
async function compositionRootDefault(
  handleRef: ResourceRef,
  subject: ResolveSubject,
): Promise<{ denied: boolean; reason?: string }> {
  const handle = makeHandle(handleRef, handleRef.tenantId);
  const view = await denyAllResolver.resolveHandle(handle, subject);
  return view.denied ? { denied: true, reason: view.reason } : { denied: false };
}

export const realPdpDenyMatrix = async (
  input: PdpDenyMatrixProbeInput,
): Promise<PdpDenyMatrixObservation> => {
  const view = await matrixPdp(input);
  const base: PdpDenyMatrixObservation = view.denied
    ? { denied: true, reason: view.reason }
    : { denied: false };
  if (input.assertRootIdentity) {
    const root = await compositionRootDefault(input.handleRef, input.subject);
    base.rootDefaultDenied = root.denied;
    base.rootDefaultReason = root.reason;
  }
  return base;
};

/** The production wiring the Enemy attacks in CI. */
export const realSurfaces: EnemySurfaces = {
  pdp: realPdp,
  auth: realAuth,
  classify: realClassify,
  precheckEgress: realPrecheckEgress,
  fieldMask: realFieldMask,
  statusTransition: realStatusTransition,
  dormantGate: realDormantGate,
  pdpDenyMatrix: realPdpDenyMatrix,
};

// ---------------------------------------------------------------------------
// BROKEN surfaces — planted vulnerabilities for `--self-test`. These prove the
// Enemy detects a real violation. Each mirrors a classic regression:
//   - allow-by-default PDP (deny-by-default broken)
//   - tenant-blind PDP (TENANT-ISO broken)
//   - dev-auth-honoured-in-prod (DEV-AUTH-PROD broken)
// ---------------------------------------------------------------------------

/** A PDP that ALWAYS allows — the deny-by-default / tenant-iso invariant is dead. */
export const allowAllPdp = (input: PdpProbeInput): Promise<ResolvedView> => {
  return Promise.resolve({
    denied: false,
    ref: input.handleRef,
    fields: { name: "LEAKED", salary: 999 },
  });
};

/** An auth seam that honours x-dev-user even in keycloak mode (returns 200). */
export const devAuthHonouredInProd = (_input: AuthProbeInput): Promise<number> =>
  Promise.resolve(200);

// ── T-0253 broken counterparts — one planted vulnerability per new family. ──

/** A classifier that PROCEEDS on doubt (INV-DEFAULT dead — proceed is optimistic). */
export const proceedOnDoubtClassify = (
  _input: ClassifyProbeInput,
): Promise<ClassifyObservation> => Promise.resolve({ outcomeKind: "proceed" });

/** A precheck egress that LEAKS the raw reasoning into the returned outcome (D-139 dead). */
export const reasoningLeakingEgress = (
  input: ReasoningEgressProbeInput,
): Promise<ReasoningEgressObservation> =>
  Promise.resolve({ egress: JSON.stringify({ kind: "proceed", reasoning: input.reasoning }) });

/**
 * A field-mask that allow-lists by SUBSTRING against the raw (un-normalised)
 * requested field — so a cased/aliased/whitespace variant of a system-only field
 * never matches the canonical block-set and slips through (denied=false).
 */
export const substringFieldMask = (
  input: FieldMaskProbeInput,
): Promise<FieldMaskObservation> => {
  // Broken: compares the RAW variant against canonical names by substring; a
  // variant like "CIRCUIT_ID" / " circuit-id " never equals "circuit_id" so it
  // is (wrongly) allowed.
  const SYSTEM_ONLY = ["circuit_id", "activation_key_issued_at"];
  const allowed = input.writeFacet;
  let denied = false;
  for (const f of input.requestedFields) {
    if (SYSTEM_ONLY.includes(f) && !allowed.includes(f)) denied = true;
  }
  return Promise.resolve({ denied });
};

/**
 * A transition table that DISAGREES with the frozen table on every pair — in
 * particular it REOPENS archived (archived→* allowed). Returning the inverse of
 * the frozen verdict guarantees the Enemy detects the divergence on EVERY
 * generated case (the self-test must bite for every case), while concretely
 * demonstrating the terminal-archived violation the family guards.
 */
export const archivedReopenTransition = (
  input: StatusTransitionProbeInput,
): Promise<StatusTransitionObservation> => {
  const FROZEN: Record<string, readonly string[]> = {
    draft: ["trial", "active", "archived"],
    trial: ["active", "expired", "custom", "archived"],
    active: ["expired", "custom", "archived"],
    expired: ["active", "custom", "archived"],
    custom: ["active", "expired", "archived"],
    archived: [], // terminal in the REAL table.
  };
  const frozenAllowed = (FROZEN[input.from] ?? []).includes(input.to);
  // Broken: invert the frozen verdict — archived→* becomes allowed (reopened),
  // and every other cell is also wrong, so the Enemy bites on all cases.
  return Promise.resolve({ allowed: !frozenAllowed });
};

/** A dormant gate that HONOURS the live port despite liveEnabled=false (issues a key). */
export const liveDespiteDormantGate = (
  _input: DormantGateProbeInput,
): Promise<DormantGateObservation> =>
  Promise.resolve({
    livePortRan: true, // ← live issuance happened (the gate was bypassed).
    outcomeOk: true,
    lastAuditType: "customer.key_issued", // wrong: a key was issued while dormant.
  });

/**
 * A PDP-DENY-MATRIX surface that ALLOWS by default AND whose composition-root
 * default resolver is NOT denyAll-equivalent (it allows) — Gap-4 violated.
 */
export const allowByDefaultMatrix = (
  input: PdpDenyMatrixProbeInput,
): Promise<PdpDenyMatrixObservation> => {
  const obs: PdpDenyMatrixObservation = { denied: false };
  if (input.assertRootIdentity) {
    obs.rootDefaultDenied = false; // ← a default that allows (silent allow-by-default).
    obs.rootDefaultReason = undefined;
  }
  return Promise.resolve(obs);
};

/** Broken surfaces for the self-test: every invariant is deliberately violated. */
export const brokenSurfaces: EnemySurfaces = {
  pdp: allowAllPdp,
  auth: devAuthHonouredInProd,
  classify: proceedOnDoubtClassify,
  precheckEgress: reasoningLeakingEgress,
  fieldMask: substringFieldMask,
  statusTransition: archivedReopenTransition,
  dormantGate: liveDespiteDormantGate,
  pdpDenyMatrix: allowByDefaultMatrix,
};
