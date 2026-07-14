/**
 * T-0154 · ВРАГ — deterministic adversarial harness over the HTTP/PDP surface.
 *
 * Эпик E-VRG / T-0151 «Враг». spec: playbooks/enemy-redteam-backlog.md §6
 * (репо Demiurge). Invariant catalog: docs/design/T-0152-security-invariants-catalog.md.
 *
 * WHAT THIS IS
 * ------------
 * A DETERMINISTIC property/fuzz layer built ON TOP of the existing
 * `*.adversarial.test.ts`. It generalises the hand-written adversarial cases into
 * a seeded generator of adversarial INPUTS (cross-tenant ids, forged/insufficient
 * grants, boundary scopes, dev-auth-in-prod) and runs each one against the REAL
 * attack surface — the T-0021 grant-resolver PDP (`resolveFor`) and the T-0054
 * auth seam (`withAuth`/`authenticate`). Each generated case PROBES one invariant
 * family from the T-0152 catalog and asserts the system HOLDS (deny / isolate /
 * no-leak). A case that the system FAILS is a confirmed attack.
 *
 * DETERMINISM (the whole value — a flaky Enemy is worthless)
 * ----------------------------------------------------------
 *   - NO Math.random, NO Date.now. All randomness is a seeded LCG (the same
 *     generator the existing grant-lattice.adversarial.test.ts uses), so the SAME
 *     seed always yields the SAME case stream, and CI never flakes.
 *   - The PDP is driven via injected in-memory ports (GrantSource/RecordSource/
 *     AncestryOracle) with an injected `now` — no DB, no clock, no network. This
 *     runs inside the ordinary `vitest run` CI flow (the sealed arena from T-0153
 *     is reserved for the heavier live attack runs; §6 of the spec lets the
 *     deterministic Enemy run against the normal CI test harness).
 *
 * WHY IT CAN BITE
 * ---------------
 * The harness is parameterised by the PDP it attacks. `runEnemy` takes a
 * `resolveSubjectView` function; in CI it is wired to the REAL `resolveFor`. The
 * `--self-test` path (see enemy.adversarial.test.ts) wires it to a deliberately
 * BROKEN resolver (allow-by-default / tenant-blind) and asserts the harness
 * detects the violation — proving the Enemy is not a no-op.
 */

import {
  type ResourceRef,
  type ResolvedView,
  type ResolveSubject,
} from "../../core/object-handle.js";
import { type Grant, type ScopeElement, type AncestryOracle } from "../../core/grant-lattice.js";

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG — identical construction to the existing
// grant-lattice.adversarial.test.ts (Knuth LCG). NO Math.random.
// ---------------------------------------------------------------------------

export function makeLcg(seed: number): () => number {
  const a = 1664525;
  const c = 1013904223;
  let s = seed >>> 0;
  return () => {
    s = (a * s + c) >>> 0; // stays in [0, 2^32)
    return s;
  };
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[rng() % arr.length]!;
}

// ---------------------------------------------------------------------------
// Invariant families attacked (subset of the T-0152 catalog reachable purely
// in-process). Each generated case names the family it probes.
// ---------------------------------------------------------------------------

export type InvariantFamily =
  | "TENANT-ISO" // §1 — cross-tenant IDOR via the PDP must be denied (cross_tenant)
  | "PDP-DENY" // §2 — default-deny: no covering grant ⇒ no_grant
  | "GRANT-ESCALATION" // §5 — a grant on a disjoint/sibling node must not cover the handle
  | "DEV-AUTH-PROD" // §3 — keycloak-mode rejects x-dev-user without a Bearer JWT
  // ── T-0253 · 6 strictly-additive in-process families (ВРАГ only gets stronger) ──
  | "PRECHECK-DEFAULT" // §2/INV-DEFAULT — classifyOutcome proceeds ONLY when every gate passes
  | "REASONING-EGRESS" // §6/NO-SECRET/D-139 — no reasoning substring escapes the PrecheckOutcome
  | "FIELD-MASK" // §5/§7.3 — system-only field write variants are all denied
  | "STATUS-TRANSITION" // §5 — the frozen customer transition table; archived is terminal
  | "DORMANT-GATE" // §7.3 — liveEnabled=false selects dormant port (no live issuance)
  | "PDP-DENY-MATRIX"; // §2 Gap-4 — exhaustive deny-matrix + composition-root default = denyAll

/** What outcome the harness asserts the system must produce for a case. */
export type ExpectedVerdict =
  | { kind: "pdp-deny"; reason: "cross_tenant" | "no_grant" } // PDP must deny with this reason
  | { kind: "http-401" } // auth seam must reject with 401
  // ── T-0253 additive verdicts (one per new surface) ──────────────────────────
  | { kind: "classify-not-proceed" } // classifyOutcome must NOT return kind:"proceed"
  | { kind: "no-reasoning-egress"; reasoning: string } // outcome must not contain `reasoning`
  | { kind: "mask-denied" } // checkWriteMask must deny (denied:true)
  | { kind: "transition-allowed"; allowed: boolean } // isAllowedTransition must equal `allowed`
  | { kind: "dormant-selected" } // runIssueKey must select the dormant port (no live issuance)
  | { kind: "resolver-identity-deny" }; // composition-root default resolver is denyAll-equivalent

/**
 * A single adversarial case. JSON-serialisable so it round-trips verbatim
 * to/from the append-only corpus (a confirmed attack becomes a permanent line).
 */
export interface AttackCase {
  /** Stable id — `<family>:<discriminator>`; the corpus key (dedup + provenance). */
  id: string;
  family: InvariantFamily;
  /** Human note: what this case attempts. */
  attack: string;
  /** The probe input, shape depends on family. */
  input: EnemyProbeInput;
  /** What the system MUST do. A different outcome = confirmed vulnerability. */
  expect: ExpectedVerdict;
}

/** Input for a PDP (resolveFor) probe. */
export interface PdpProbeInput {
  surface: "pdp";
  subject: ResolveSubject;
  /** The handle's ref (its tenant may differ from subject ⇒ cross-tenant attack). */
  handleRef: ResourceRef;
  /** The grants the (forged) subject holds. */
  grants: Grant[];
}

/** Input for the auth-seam (withAuth) probe. */
export interface AuthProbeInput {
  surface: "auth";
  authMode: "keycloak"; // we attack the prod path
  headers: Record<string, string>; // e.g. forged x-dev-user, no Bearer
}

// ---------------------------------------------------------------------------
// T-0253 — probe inputs for the 6 additive in-process surfaces. Each is a
// JSON-serialisable record so it round-trips verbatim through corpus.jsonl.
// ---------------------------------------------------------------------------

/**
 * PRECHECK-DEFAULT: signals fed to the REAL classifyOutcome. At least one gate
 * is fuzzed FALSE/doubtful so the classifier must NEVER collapse to `proceed`.
 * The signals object is exactly OutcomeSignals (mirrored loosely as a JSON record
 * so the corpus line is self-describing); the surface re-types it on the way in.
 */
export interface ClassifyProbeInput {
  surface: "classify";
  /** The OutcomeSignals object (any gate may be doubtful → never proceed). */
  signals: Record<string, unknown>;
}

/**
 * REASONING-EGRESS (D-139): an LlmResult carrying reasoning text is injected via
 * a stub LlmPort into runLegalPrecheck; the returned PrecheckOutcome must contain
 * NO reasoning substring (reasoning lives only as an opaque reasoning_trace_ref).
 */
export interface ReasoningEgressProbeInput {
  surface: "precheck-egress";
  /** The raw reasoning text the stubbed model emits (must NOT leak to egress). */
  reasoning: string;
  /** The model self-confidence the stub reports. */
  confidence: number;
  /** The safe summary the stub puts on the answer (distinct from reasoning). */
  summary: string;
}

/**
 * FIELD-MASK: a single requestedFields variant (casing/whitespace/alias/dup of a
 * system-only field) checked against the REAL checkWriteMask under a restricted
 * (vendor-admin) write facet. Every variant that RESOLVES to a system-only field
 * must be denied.
 */
export interface FieldMaskProbeInput {
  surface: "field-mask";
  /** The vendor-admin grant's write facet (restricted; never whole-resource). */
  writeFacet: string[];
  /** The field names the caller attempts to write (a system-only variant). */
  requestedFields: string[];
}

/**
 * STATUS-TRANSITION: a single from×to pair checked against isAllowedTransition.
 * `expectedAllowed` is computed from the frozen CUSTOMER_TRANSITIONS table in the
 * generator (the oracle); the surface asserts isAllowedTransition matches it, and
 * that archived→* is ALWAYS false.
 */
export interface StatusTransitionProbeInput {
  surface: "status-transition";
  from: string;
  to: string;
}

/**
 * DORMANT-GATE: drive runIssueKey with a LIVE-succeeding entitlement adapter but
 * liveEnabled=false. The dormant port MUST be selected (no live issuance; the
 * audit trail records key_issue_failed, never key_issued).
 */
export interface DormantGateProbeInput {
  surface: "dormant-gate";
  /** circuit id passed to runIssueKey (echoed back only if the live port runs). */
  circuitId: string;
  /** A record `plan` value (present so the step reaches the port pick). */
  plan: string;
}

/**
 * PDP-DENY-MATRIX (Gap-4): a single subject×resource×op deny cell driven through
 * the REAL PDP (no covering grant ⇒ deny), PLUS the composition-root assertion
 * that the default resolver is identity-equal to denyAllResolver.
 */
export interface PdpDenyMatrixProbeInput {
  surface: "pdp-deny-matrix";
  subject: ResolveSubject;
  handleRef: ResourceRef;
  op: "read" | "update" | "delete" | "approve" | "transition";
  /** When true, this case asserts the composition-root default == denyAllResolver. */
  assertRootIdentity: boolean;
}

/** The full probe-input union across every surface. */
export type EnemyProbeInput =
  | PdpProbeInput
  | AuthProbeInput
  | ClassifyProbeInput
  | ReasoningEgressProbeInput
  | FieldMaskProbeInput
  | StatusTransitionProbeInput
  | DormantGateProbeInput
  | PdpDenyMatrixProbeInput;

// ---------------------------------------------------------------------------
// Deterministic ancestry oracle for the PDP probes.
// Fixed resource tree:  rec-* ⊑ reg-1 ⊑ app-1   (sibling reg-2 is DISJOINT)
//
// CRITICAL for GRANT-ESCALATION: every generated rec-* MUST be a genuine
// descendant of reg-1 in the oracle, otherwise a deny would fire trivially
// (orphan record ⇒ no_grant for any grant) and the test would NOT actually
// exercise the cross-subtree containment check (reg-2 grant must not reach a
// record that REALLY sits under reg-1). So the oracle treats ANY `rec-*` id as
// a child of reg-1 (the leaf records all belong to reg-1; reg-2 is the disjoint
// sibling holding no records the Enemy reaches for).
// ---------------------------------------------------------------------------

const TREE_EDGES: Array<[string, string]> = [
  ["reg-1", "app-1"],
  ["reg-2", "app-1"],
];

export function enemyOracle(): AncestryOracle {
  const parents = new Map<string, Set<string>>();
  for (const [child, parent] of TREE_EDGES) {
    if (!parents.has(child)) parents.set(child, new Set());
    parents.get(child)!.add(parent);
  }
  const parentsOf = (id: string): Set<string> => {
    // Every record (rec-*) is a leaf under reg-1 (see header note).
    if (id.startsWith("rec-")) return new Set(["reg-1"]);
    return parents.get(id) ?? new Set();
  };
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const p of parentsOf(cur)) {
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return seen;
  };
  return {
    isDescendantOrSelf(_h, descendantId, ancestorId): boolean {
      if (descendantId === ancestorId) return true;
      return ancestors(descendantId).has(ancestorId);
    },
  };
}

// ---------------------------------------------------------------------------
// Case generators — each emits adversarial cases that MUST be denied/blocked.
// ---------------------------------------------------------------------------

const TENANTS = ["tenant-A", "tenant-B", "tenant-C"] as const;
const REGISTRIES = ["reg-1", "reg-2"] as const;

function nodeScope(nodeId: string, nodeLevel: "registry" | "application"): ScopeElement {
  return { kind: "node", hierarchy: "resource", nodeId, nodeLevel };
}

function grantFor(tenantId: string, scope: ScopeElement, op: Grant["operation"] = "read"): Grant {
  return {
    tenantId,
    id: "g-enemy",
    roleId: "role-enemy",
    resourceType: "record",
    operation: op,
    scope,
    delegable: true,
    grantedBy: "admin",
    createdAt: 0,
  };
}

/**
 * TENANT-ISO (catalog §1, Gap-2): a subject in tenant X holding a fully-covering
 * grant in X tries to resolve a handle that belongs to tenant Y. The tenant-gate
 * must fire BEFORE any grant is even consulted ⇒ cross_tenant.
 */
function genTenantIso(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  for (let i = 0; i < n; i++) {
    const subjTenant = pick(TENANTS, rng);
    let handleTenant = pick(TENANTS, rng);
    if (handleTenant === subjTenant) {
      // force a genuine cross-tenant attack
      handleTenant = TENANTS[(TENANTS.indexOf(subjTenant) + 1) % TENANTS.length]!;
    }
    const reg = pick(REGISTRIES, rng);
    const recId = `rec-${rng() % 1000}`;
    // The forged subject even holds a maximally-covering grant — IN ITS OWN tenant.
    // It must STILL be denied for the foreign handle (the gate is tenant-first).
    out.push({
      // `#${i}` makes the id UNIQUE within a generation (the tenant/reg/recId
      // space can repeat under the fixed seed; a non-unique id would silently
      // collapse cases and corrupt the corpus key). Deterministic by index.
      id: `TENANT-ISO:${subjTenant}->${handleTenant}/${reg}/${recId}#${i}`,
      family: "TENANT-ISO",
      attack: `subject in ${subjTenant} (with app-wide grant) resolves a handle owned by ${handleTenant}`,
      input: {
        surface: "pdp",
        subject: { tenantId: subjTenant, subjectId: "attacker" },
        handleRef: { kind: "record", tenantId: handleTenant, registryId: reg, recordId: recId },
        grants: [grantFor(subjTenant, nodeScope("app-1", "application"))],
      },
      expect: { kind: "pdp-deny", reason: "cross_tenant" },
    });
  }
  return out;
}

/**
 * PDP-DENY (catalog §2, Gap-3/4): default-deny. A subject with NO covering grant
 * (empty set, or a grant for the wrong operation) must be denied no_grant. The
 * tenant matches here, so the ONLY thing standing between the attacker and the
 * record is the deny-by-default PDP.
 */
function genPdpDeny(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  for (let i = 0; i < n; i++) {
    const tenant = pick(TENANTS, rng);
    const reg = pick(REGISTRIES, rng);
    const recId = `rec-${rng() % 1000}`;
    // Variant: empty grants, or a grant for a DIFFERENT operation (write, not read).
    const variant = rng() % 2;
    const grants =
      variant === 0
        ? [] // no grants at all
        : [grantFor(tenant, nodeScope("app-1", "application"), "update")]; // wrong op
    out.push({
      id: `PDP-DENY:${tenant}/${reg}/${recId}/v${variant}#${i}`,
      family: "PDP-DENY",
      attack:
        variant === 0
          ? `subject with NO grants reads a record (must default-deny)`
          : `subject holds only an UPDATE grant, attempts READ (op mismatch must deny)`,
      input: {
        surface: "pdp",
        subject: { tenantId: tenant, subjectId: "attacker" },
        handleRef: { kind: "record", tenantId: tenant, registryId: reg, recordId: recId },
        grants,
      },
      expect: { kind: "pdp-deny", reason: "no_grant" },
    });
  }
  return out;
}

/**
 * GRANT-ESCALATION (catalog §5, Gap-8): a subject holds a grant on a SIBLING /
 * disjoint node (reg-2) and tries to reach a handle under reg-1. The scope-
 * containment check must reject — no widening from reg-2 to reg-1.
 */
function genGrantEscalation(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  for (let i = 0; i < n; i++) {
    const tenant = pick(TENANTS, rng);
    const recId = `rec-${rng() % 1000}`;
    // Grant is scoped to reg-2; the handle lives under reg-1 — disjoint subtrees.
    out.push({
      id: `GRANT-ESCALATION:${tenant}/reg-2-grant->reg-1-handle/${recId}#${i}`,
      family: "GRANT-ESCALATION",
      attack: `subject holds a grant on reg-2 only, attempts to reach a record under reg-1 (disjoint scope)`,
      input: {
        surface: "pdp",
        subject: { tenantId: tenant, subjectId: "attacker" },
        handleRef: { kind: "record", tenantId: tenant, registryId: "reg-1", recordId: recId },
        grants: [grantFor(tenant, nodeScope("reg-2", "registry"))],
      },
      expect: { kind: "pdp-deny", reason: "no_grant" },
    });
  }
  return out;
}

/**
 * DEV-AUTH-PROD (catalog §3, Gap-5): in keycloak (prod) mode the server must
 * reject a request that carries only a forged `x-dev-user` header and no Bearer
 * JWT — the dev stub must NOT be honoured in prod ⇒ 401.
 */
function genDevAuthProd(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  const forgedUsers = ["admin", "root", "founder", "system", "tenant-A:owner"];
  for (let i = 0; i < n; i++) {
    const user = pick(forgedUsers, rng);
    // Sometimes also include a malformed Authorization header (not a Bearer) —
    // must still 401, never fall through to the dev stub.
    const malformed = rng() % 2 === 0;
    const headers: Record<string, string> = { "x-dev-user": user };
    if (malformed) headers["authorization"] = "Basic Zm9vOmJhcg==";
    out.push({
      id: `DEV-AUTH-PROD:${user}/${malformed ? "basic" : "nobearer"}#${i}`,
      family: "DEV-AUTH-PROD",
      attack: `keycloak-mode request with forged x-dev-user='${user}'${
        malformed ? " + non-Bearer Authorization" : " and no JWT"
      } must be rejected (dev stub not honoured in prod)`,
      input: { surface: "auth", authMode: "keycloak", headers },
      expect: { kind: "http-401" },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// T-0253 — generators for the 6 additive in-process families. All deterministic
// (seeded LCG; no Math.random/Date.now). Each emits cases the system MUST hold.
// ---------------------------------------------------------------------------

/**
 * PRECHECK-DEFAULT (catalog §2 / INV-DEFAULT): the REAL classifyOutcome must
 * return `proceed` ONLY when every gate passes. We fuzz OutcomeSignals so that
 * AT LEAST ONE gate is failing/doubtful — the classifier must therefore land on
 * fail-closed or defer, NEVER proceed (fail-closed>defer>proceed never collapses
 * to proceed on doubt). A valid answer is included so the ONLY thing standing
 * between the signal set and proceed is the doubtful gate under test.
 */
function genPrecheckDefault(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  // Each "doubt" injects exactly one failing/uncertain gate atop an otherwise
  // proceed-eligible signal set. Index picks which doubt this case exercises.
  const doubts = [
    "pdpDenied",
    "llmError",
    "llmDormant",
    "thresholdFailed",
    "lowConfidence",
    "undefinedConfidence",
    "ambiguous",
    "noAnswer",
  ] as const;
  const validAnswer = {
    answerForm: "legal_precheck_v1",
    redFlags: [{ clause: "C", risk: "R", severity: "high" }],
    summary: "a clearly non-ambiguous summary string",
  };
  for (let i = 0; i < n; i++) {
    const doubt = pick(doubts, rng);
    // Base: a fully proceed-eligible signal set (all gates green).
    const base: Record<string, unknown> = {
      pdpDenied: false,
      llmDormant: false,
      modelConfidence: 0.95,
      thresholdFailed: false,
      ambiguous: false,
      answer: validAnswer,
    };
    // Inject exactly one doubt.
    switch (doubt) {
      case "pdpDenied":
        base["pdpDenied"] = true;
        base["pdpReason"] = "no_grant";
        break;
      case "llmError":
        base["llmError"] = "llm_error";
        break;
      case "llmDormant":
        base["llmDormant"] = true;
        break;
      case "thresholdFailed":
        base["thresholdFailed"] = true;
        break;
      case "lowConfidence":
        base["modelConfidence"] = 0.5; // below CONFIDENCE_FLOOR (0.7)
        break;
      case "undefinedConfidence":
        delete base["modelConfidence"]; // missing ⇒ defer
        break;
      case "ambiguous":
        base["ambiguous"] = true;
        break;
      case "noAnswer":
        delete base["answer"]; // missing answer ⇒ fail-closed
        break;
    }
    out.push({
      id: `PRECHECK-DEFAULT:${doubt}#${i}`,
      family: "PRECHECK-DEFAULT",
      attack: `classifyOutcome must NOT proceed when gate '${doubt}' is failing/doubtful (INV-DEFAULT)`,
      input: { surface: "classify", signals: base },
      expect: { kind: "classify-not-proceed" },
    });
  }
  return out;
}

/**
 * REASONING-EGRESS (catalog §6 / D-139): the model's reasoning text must NEVER
 * appear in the returned PrecheckOutcome — only as an opaque reasoning_trace_ref
 * inside the audit payload. We inject distinctive reasoning markers and assert no
 * substring survives into the outcome.
 */
function genReasoningEgress(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  for (let i = 0; i < n; i++) {
    // A distinctive, unlikely-to-collide marker per case so a substring scan is
    // unambiguous. Deterministic from the LCG.
    const marker = `REASONING_SECRET_${rng() % 100000}`;
    const reasoning = `chain-of-thought: ${marker} — the model internally concluded X because Y`;
    const confidence = 0.9;
    const summary = `safe summary ${i}`;
    out.push({
      id: `REASONING-EGRESS:${marker}#${i}`,
      family: "REASONING-EGRESS",
      attack: `model reasoning '${marker}' must NOT leak into the PrecheckOutcome egress (D-139)`,
      input: { surface: "precheck-egress", reasoning, confidence, summary },
      expect: { kind: "no-reasoning-egress", reasoning },
    });
  }
  return out;
}

/**
 * FIELD-MASK (catalog §5 / §7.3): casing/whitespace/alias/duplicate variants of
 * `circuit_id` & `activation_key_issued_at` that RESOLVE to a system-only field
 * must all be denied by checkWriteMask under a restricted vendor-admin facet.
 *
 * CRITICAL: the surface NORMALISES each variant back to its canonical system-only
 * field name (the same normalisation the real call-site must apply) and then
 * calls the REAL checkWriteMask. The broken self-test surface allow-lists by
 * substring (so an aliased/cased field slips through) — exactly the bug we hunt.
 */
function genFieldMask(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  // Variant builders that all RESOLVE to a system-only canonical field but are
  // NON-canonical on the wire — a substring/exact allow-list (the broken
  // self-test surface) fails to catch them, while the REAL canonicalising guard
  // does. (No exact-passthrough variant: that would let the broken surface
  // correctly deny, defeating the "self-test catches every case" invariant.)
  const variants: Array<(canon: string) => string> = [
    (c) => c.toUpperCase(), // casing
    (c) => `  ${c}  `, // whitespace pad
    (c) => `${c}\t`, // trailing tab
    (c) => c.replace(/_/g, "-"), // alias: snake→kebab (e.g. circuit-id)
    (c) => ` ${c.toUpperCase()} `, // casing + whitespace
    (c) => `${c} `, // trailing space
  ];
  const canon = ["circuit_id", "activation_key_issued_at"] as const;
  for (let i = 0; i < n; i++) {
    const c = pick(canon, rng);
    const make = pick(variants, rng);
    const variant = make(c);
    // The vendor-admin facet allows only innocuous fields (never the system-only one).
    const writeFacet = ["plan", "notes", "not_after"];
    // Duplicate the field sometimes to exercise dedup-blind allow-lists.
    const dup = rng() % 2 === 0;
    const requestedFields = dup ? [variant, variant, "plan"] : [variant, "notes"];
    out.push({
      id: `FIELD-MASK:${c}/${JSON.stringify(variant)}/${dup ? "dup" : "single"}#${i}`,
      family: "FIELD-MASK",
      attack: `requestedFields variant ${JSON.stringify(variant)} resolves to system-only '${c}' — must be denied`,
      input: { surface: "field-mask", writeFacet, requestedFields },
      expect: { kind: "mask-denied" },
    });
  }
  return out;
}

/**
 * STATUS-TRANSITION (catalog §5): enumerate from×to pairs against the FROZEN
 * CUSTOMER_TRANSITIONS oracle. The generator computes the expected verdict from a
 * LOCAL copy of the frozen table; the surface asserts the REAL isAllowedTransition
 * matches it. archived→* is ALWAYS false (terminal). The broken self-test table
 * reopens archived.
 */
const STATUSES = ["draft", "trial", "active", "expired", "custom", "archived"] as const;
/** Local oracle copy of the frozen table (kept in sync as a regression check). */
const FROZEN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ["trial", "active", "archived"],
  trial: ["active", "expired", "custom", "archived"],
  active: ["expired", "custom", "archived"],
  expired: ["active", "custom", "archived"],
  custom: ["active", "expired", "archived"],
  archived: [],
};
function genStatusTransition(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  // Enumerate the full from×to matrix deterministically; if n < 36 we still pick
  // pairs by the LCG so the stream is seeded, but bias toward archived rows so the
  // terminal invariant is always probed.
  for (let i = 0; i < n; i++) {
    // First STATUSES.length cases sweep archived→every-target (the terminal law),
    // remaining cases fuzz the full matrix.
    let from: string;
    let to: string;
    if (i < STATUSES.length) {
      from = "archived";
      to = STATUSES[i % STATUSES.length]!;
    } else {
      from = pick(STATUSES, rng);
      to = pick(STATUSES, rng);
    }
    const allowed = (FROZEN_TRANSITIONS[from] ?? []).includes(to);
    out.push({
      id: `STATUS-TRANSITION:${from}->${to}/${allowed ? "allow" : "deny"}#${i}`,
      family: "STATUS-TRANSITION",
      attack: `isAllowedTransition(${from}, ${to}) must equal frozen=${allowed} (archived→* always false)`,
      input: { surface: "status-transition", from, to },
      expect: { kind: "transition-allowed", allowed },
    });
  }
  return out;
}

/**
 * DORMANT-GATE (catalog §7.3): drive runIssueKey with a LIVE-succeeding
 * entitlement adapter but liveEnabled=false. The dormant port must be selected —
 * NO live issuance, audit trail = key_issue_failed (never key_issued). The broken
 * self-test surface honours the live adapter despite liveEnabled=false.
 */
function genDormantGate(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  const plans = ["pilot", "pro", "enterprise"];
  for (let i = 0; i < n; i++) {
    const plan = pick(plans, rng);
    const circuitId = `circ-${rng() % 100000}`;
    out.push({
      id: `DORMANT-GATE:${plan}/${circuitId}#${i}`,
      family: "DORMANT-GATE",
      attack: `runIssueKey with liveEnabled=false must select the dormant port (no live issuance) for circuit '${circuitId}'`,
      input: { surface: "dormant-gate", circuitId, plan },
      expect: { kind: "dormant-selected" },
    });
  }
  return out;
}

/**
 * PDP-DENY-MATRIX (catalog §2 Gap-4): an exhaustive subject×resource×op deny
 * matrix — for every cell the subject holds NO covering grant, so the REAL PDP
 * must deny (no_grant). Additionally, a fraction of cases carry
 * `assertRootIdentity` so the surface asserts the composition-root DEFAULT
 * resolver is identity-equal to denyAllResolver (no allow-by-default resolver
 * swapped in at the root). The broken self-test surface allows by default.
 */
function genPdpDenyMatrix(rng: () => number, n: number): AttackCase[] {
  const out: AttackCase[] = [];
  const ops = ["read", "update", "delete", "approve", "transition"] as const;
  const kinds = ["record", "registry", "application"] as const;
  for (let i = 0; i < n; i++) {
    const tenant = pick(TENANTS, rng);
    const op = pick(ops, rng);
    const kind = pick(kinds, rng);
    const recId = `rec-${rng() % 1000}`;
    const reg = pick(REGISTRIES, rng);
    // Build a same-tenant handleRef with NO covering grant ⇒ must deny no_grant.
    let handleRef: ResourceRef;
    if (kind === "record") {
      handleRef = { kind: "record", tenantId: tenant, registryId: reg, recordId: recId };
    } else if (kind === "registry") {
      handleRef = {
        kind: "registry",
        tenantId: tenant,
        applicationId: "app-1",
        registryId: reg,
      };
    } else {
      handleRef = { kind: "application", tenantId: tenant, applicationId: "app-1" };
    }
    // Every 6th case also asserts the composition-root default == denyAllResolver.
    const assertRootIdentity = i % 6 === 0;
    out.push({
      id: `PDP-DENY-MATRIX:${tenant}/${kind}/${op}/${recId}${assertRootIdentity ? "/root" : ""}#${i}`,
      family: "PDP-DENY-MATRIX",
      attack: `${op} on ${kind} in ${tenant} with NO covering grant must deny (no_grant)${
        assertRootIdentity ? " + composition-root default == denyAllResolver" : ""
      }`,
      input: { surface: "pdp-deny-matrix", subject: { tenantId: tenant, subjectId: "attacker" }, handleRef, op, assertRootIdentity },
      expect: assertRootIdentity
        ? { kind: "resolver-identity-deny" }
        : { kind: "pdp-deny", reason: "no_grant" },
    });
  }
  return out;
}

/**
 * The full deterministic generator. Given a seed and a per-family count, it
 * emits a STABLE, reproducible stream of adversarial cases across all families.
 */
export function generateCases(seed: number, perFamily = 24): AttackCase[] {
  // One LCG, threaded through every generator → fully deterministic ordering.
  const rng = makeLcg(seed);
  return [
    ...genTenantIso(rng, perFamily),
    ...genPdpDeny(rng, perFamily),
    ...genGrantEscalation(rng, perFamily),
    ...genDevAuthProd(rng, perFamily),
    // ── T-0253 additive families (appended AFTER the original four so the
    //    existing four families' case stream is byte-identical for any seed) ──
    ...genPrecheckDefault(rng, perFamily),
    ...genReasoningEgress(rng, perFamily),
    ...genFieldMask(rng, perFamily),
    ...genStatusTransition(rng, perFamily),
    ...genDormantGate(rng, perFamily),
    ...genPdpDenyMatrix(rng, perFamily),
  ];
}

// ---------------------------------------------------------------------------
// The attack runner. Parameterised by the surfaces it drives so the self-test
// can swap in a deliberately-broken implementation and prove the Enemy bites.
// ---------------------------------------------------------------------------

/** A PDP under attack: resolve a handle ref for a subject given its grants. */
export type PdpUnderAttack = (input: PdpProbeInput) => Promise<ResolvedView>;

/** An auth seam under attack: returns the HTTP status the seam would emit. */
export type AuthUnderAttack = (input: AuthProbeInput) => Promise<number>;

// ---------------------------------------------------------------------------
// T-0253 — observation types returned by the 6 additive surfaces. Each surface
// returns a small, JSON-shaped OBSERVATION; runCase compares it to case.expect.
// The surface NEVER decides the verdict — the harness does (so the broken
// self-test surface can return a violating observation and the Enemy bites).
// ---------------------------------------------------------------------------

/** PRECHECK-DEFAULT: the classifier's resulting outcome kind. */
export type ClassifyObservation = { outcomeKind: "proceed" | "defer-to-human" | "fail-closed" };

/** REASONING-EGRESS: the egress payload (serialised PrecheckOutcome the consumer sees). */
export type ReasoningEgressObservation = { egress: string };

/** FIELD-MASK: whether the REAL checkWriteMask denied. */
export type FieldMaskObservation = { denied: boolean };

/** STATUS-TRANSITION: the REAL isAllowedTransition result. */
export type StatusTransitionObservation = { allowed: boolean };

/** DORMANT-GATE: which port ran + whether a live issuance happened + final audit type. */
export type DormantGateObservation = {
  livePortRan: boolean;
  outcomeOk: boolean;
  lastAuditType: string;
};

/** PDP-DENY-MATRIX: the PDP view + (for root cases) whether the default == denyAll. */
export type PdpDenyMatrixObservation = {
  denied: boolean;
  reason?: string;
  /** For assertRootIdentity cases: the composition-root default resolver's verdict. */
  rootDefaultDenied?: boolean;
  rootDefaultReason?: string;
};

export type ClassifyUnderAttack = (input: ClassifyProbeInput) => Promise<ClassifyObservation>;
export type ReasoningEgressUnderAttack = (
  input: ReasoningEgressProbeInput,
) => Promise<ReasoningEgressObservation>;
export type FieldMaskUnderAttack = (input: FieldMaskProbeInput) => Promise<FieldMaskObservation>;
export type StatusTransitionUnderAttack = (
  input: StatusTransitionProbeInput,
) => Promise<StatusTransitionObservation>;
export type DormantGateUnderAttack = (
  input: DormantGateProbeInput,
) => Promise<DormantGateObservation>;
export type PdpDenyMatrixUnderAttack = (
  input: PdpDenyMatrixProbeInput,
) => Promise<PdpDenyMatrixObservation>;

export interface EnemySurfaces {
  pdp: PdpUnderAttack;
  auth: AuthUnderAttack;
  // ── T-0253 additive surfaces ─────────────────────────────────────────────
  classify: ClassifyUnderAttack;
  precheckEgress: ReasoningEgressUnderAttack;
  fieldMask: FieldMaskUnderAttack;
  statusTransition: StatusTransitionUnderAttack;
  dormantGate: DormantGateUnderAttack;
  pdpDenyMatrix: PdpDenyMatrixUnderAttack;
}

/** A confirmed attack: the system did NOT hold for this case. */
export interface AttackFinding {
  case: AttackCase;
  observed: string; // what the system actually did (vs. case.expect)
}

/**
 * Run one case against the given surfaces. Returns a finding iff the system
 * FAILED to hold (i.e. a real vulnerability), else null.
 */
export async function runCase(
  c: AttackCase,
  surfaces: EnemySurfaces,
): Promise<AttackFinding | null> {
  if (c.input.surface === "pdp") {
    const view = await surfaces.pdp(c.input);
    if (c.expect.kind !== "pdp-deny") {
      return { case: c, observed: `expected http verdict but case targeted PDP` };
    }
    // The invariant: the PDP MUST deny, with the expected reason.
    if (!view.denied) {
      return {
        case: c,
        observed: `PDP ALLOWED access (denied=false) — expected deny:${c.expect.reason}`,
      };
    }
    if (view.reason !== c.expect.reason) {
      return {
        case: c,
        observed: `PDP denied with reason='${view.reason}' — expected '${c.expect.reason}'`,
      };
    }
    return null; // held
  }

  if (c.input.surface === "auth") {
    const status = await surfaces.auth(c.input);
    if (c.expect.kind !== "http-401") {
      return { case: c, observed: `expected PDP verdict but case targeted auth` };
    }
    if (status !== 401) {
      return {
        case: c,
        observed: `auth seam returned HTTP ${status} — expected 401 (dev stub honoured in prod!)`,
      };
    }
    return null; // held
  }

  // ── T-0253 additive surfaces ─────────────────────────────────────────────

  if (c.input.surface === "classify") {
    const obs = await surfaces.classify(c.input);
    if (c.expect.kind !== "classify-not-proceed") {
      return { case: c, observed: `expected classify verdict but case mismatched` };
    }
    // INV-DEFAULT: a doubtful signal set must NEVER yield proceed.
    if (obs.outcomeKind === "proceed") {
      return {
        case: c,
        observed: `classifyOutcome returned PROCEED on a doubtful signal set — INV-DEFAULT collapsed`,
      };
    }
    return null; // held (defer-to-human or fail-closed)
  }

  if (c.input.surface === "precheck-egress") {
    const obs = await surfaces.precheckEgress(c.input);
    if (c.expect.kind !== "no-reasoning-egress") {
      return { case: c, observed: `expected reasoning-egress verdict but case mismatched` };
    }
    // D-139: the reasoning text must NOT appear anywhere in the egress payload.
    if (obs.egress.includes(c.expect.reasoning)) {
      return {
        case: c,
        observed: `reasoning text LEAKED into the PrecheckOutcome egress (D-139 violated): found in ${obs.egress.slice(0, 120)}…`,
      };
    }
    return null; // held
  }

  if (c.input.surface === "field-mask") {
    const obs = await surfaces.fieldMask(c.input);
    if (c.expect.kind !== "mask-denied") {
      return { case: c, observed: `expected field-mask verdict but case mismatched` };
    }
    if (!obs.denied) {
      return {
        case: c,
        observed: `checkWriteMask ALLOWED a system-only field variant (denied=false) — mask escaped`,
      };
    }
    return null; // held
  }

  if (c.input.surface === "status-transition") {
    const obs = await surfaces.statusTransition(c.input);
    if (c.expect.kind !== "transition-allowed") {
      return { case: c, observed: `expected status-transition verdict but case mismatched` };
    }
    if (obs.allowed !== c.expect.allowed) {
      return {
        case: c,
        observed: `isAllowedTransition(${c.input.from}→${c.input.to})=${obs.allowed} — frozen table requires ${c.expect.allowed}`,
      };
    }
    return null; // held
  }

  if (c.input.surface === "dormant-gate") {
    const obs = await surfaces.dormantGate(c.input);
    if (c.expect.kind !== "dormant-selected") {
      return { case: c, observed: `expected dormant-gate verdict but case mismatched` };
    }
    // liveEnabled=false ⇒ the dormant port MUST be selected: no live issuance,
    // the step must NOT succeed, and the last audit must be key_issue_failed.
    if (obs.livePortRan) {
      return {
        case: c,
        observed: `LIVE entitlement port RAN despite liveEnabled=false — dormant gate bypassed`,
      };
    }
    if (obs.outcomeOk) {
      return {
        case: c,
        observed: `runIssueKey returned ok=true with liveEnabled=false — a live key was issued`,
      };
    }
    if (obs.lastAuditType !== "customer.key_issue_failed") {
      return {
        case: c,
        observed: `last audit type='${obs.lastAuditType}' — expected customer.key_issue_failed (dormant)`,
      };
    }
    return null; // held
  }

  // pdp-deny-matrix surface
  if (c.input.surface === "pdp-deny-matrix") {
    const obs = await surfaces.pdpDenyMatrix(c.input);
    if (c.input.assertRootIdentity) {
      if (c.expect.kind !== "resolver-identity-deny") {
        return { case: c, observed: `expected resolver-identity verdict but case mismatched` };
      }
      // The composition-root default resolver MUST be denyAll-equivalent.
      if (obs.rootDefaultDenied !== true || obs.rootDefaultReason !== "no_grant") {
        return {
          case: c,
          observed: `composition-root default resolver is NOT denyAll-equivalent (denied=${obs.rootDefaultDenied}, reason=${obs.rootDefaultReason}) — Gap-4 allow-by-default`,
        };
      }
      // And the matrix cell itself must still deny.
      if (!obs.denied || obs.reason !== "no_grant") {
        return {
          case: c,
          observed: `PDP-DENY-MATRIX root cell did not deny no_grant (denied=${obs.denied}, reason=${obs.reason})`,
        };
      }
      return null; // held
    }
    if (c.expect.kind !== "pdp-deny") {
      return { case: c, observed: `expected pdp-deny verdict but case mismatched` };
    }
    if (!obs.denied) {
      return {
        case: c,
        observed: `PDP-DENY-MATRIX cell ALLOWED access (denied=false) — expected deny:${c.expect.reason}`,
      };
    }
    if (obs.reason !== c.expect.reason) {
      return {
        case: c,
        observed: `PDP-DENY-MATRIX denied with reason='${obs.reason}' — expected '${c.expect.reason}'`,
      };
    }
    return null; // held
  }

  // Exhaustiveness guard — an unknown surface is a wiring bug, fail-closed.
  return {
    case: c,
    observed: `unknown probe surface '${(c.input as { surface: string }).surface}' — harness wiring bug`,
  };
}

/** Run every case; return all confirmed attacks (findings). */
export async function runEnemy(
  cases: AttackCase[],
  surfaces: EnemySurfaces,
): Promise<AttackFinding[]> {
  const findings: AttackFinding[] = [];
  for (const c of cases) {
    const f = await runCase(c, surfaces);
    if (f) findings.push(f);
  }
  return findings;
}
