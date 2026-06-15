/**
 * T-0231: Implementation Loop B-2..B-5
 *
 * B-2: Implementation phase-machine + bundle projection model.
 * B-3: Bundle grant-consistency validator (resolvable-assignee + drain-desync).
 *      Uses isNarrowerOrEqual from T-0018 as a pure reader — does NOT modify grant-lattice.ts.
 * B-4: Interview protocol (interview_claim + read-only org validation).
 * B-5: Simulation mode-1 — deterministic route-calc extending bpmn-linter.ts.
 *
 * FROZEN-CLEAR invariant:
 *   src/core/grant-lattice.ts and src/core/object-handle.ts are NOT modified by this build.
 *   B-3 imports isNarrowerOrEqual as a pure reader (no write path to lattice).
 *
 * Design contract: docs/design/T-0129-implementation-loop.adr.md §2/§5/§6/§7/§8/§11/§15.
 *
 * Agent LLM runtime stays DORMANT (day-1 = governance + deterministic guards, like T-0077).
 *
 * Pure module — no DB/IO/LLM at module level.
 * All I/O is behind injected ports (AuditWriter, OrgReader).
 */

// B-3 uses isNarrowerOrEqual as a READ-ONLY import from the frozen T-0018 module.
// This file NEVER modifies grant-lattice.ts.
import {
  isNarrowerOrEqual,
  type ScopeElement,
  type AncestryOracle,
} from "./grant-lattice.js";
import { lintBpmn } from "./bpmn-linter.js";
import type { AuditEventInput } from "./audit-grant-encoder.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// § B-2: Implementation phase-machine types (ADR §2)
// ---------------------------------------------------------------------------

/**
 * The seven phases of an implementation (ADR §2 table).
 * Transitions are validated by transitionPhase() — illegal transitions are
 * rejected fail-closed (FR-B2-1 / AC-1).
 */
export type ImplementationPhase =
  | "org_ready"
  | "interview"
  | "draft_bundle"
  | "simulation"
  | "pilot"
  | "promote_pending"
  | "production";

/**
 * Transition action labels — the named edges of the phase DAG.
 * revise and evolve are the two backward edges (ADR §2).
 */
export type PhaseTransition =
  | "start_interview"       // org_ready → interview
  | "complete_interview"    // interview → draft_bundle
  | "start_simulation"      // draft_bundle → simulation
  | "start_pilot"           // simulation → pilot  (after human-gate promote)
  | "request_promote"       // simulation|pilot → promote_pending
  | "promote"               // promote_pending → production  (HUMAN-GATE ONLY)
  | "revise_to_interview"   // simulation → interview  (revise backward edge)
  | "revise_to_draft"       // simulation → draft_bundle  (revise backward edge)
  | "evolve";               // production → interview  (evolve: new increment)

/**
 * Who initiates each transition.
 * The only human-initiated transition is promote_pending → production (FR-B2-2 / AC-2).
 */
export type TransitionInitiator = "agent" | "human";

interface TransitionEdge {
  from: ImplementationPhase;
  to: ImplementationPhase;
  transition: PhaseTransition;
  initiator: TransitionInitiator;
}

/**
 * Legal transition edges (ADR §2 table + revise/evolve backward edges).
 * FR-B2-1: illegal transitions are rejected fail-closed.
 * FR-B2-2: promote_pending→production is the ONLY human-initiated transition.
 */
const LEGAL_TRANSITIONS: TransitionEdge[] = [
  { from: "org_ready",       to: "interview",        transition: "start_interview",      initiator: "agent" },
  { from: "interview",       to: "draft_bundle",     transition: "complete_interview",   initiator: "agent" },
  { from: "draft_bundle",    to: "simulation",       transition: "start_simulation",     initiator: "agent" },
  { from: "simulation",      to: "pilot",            transition: "start_pilot",          initiator: "agent" },
  { from: "simulation",      to: "promote_pending",  transition: "request_promote",      initiator: "agent" },
  { from: "pilot",           to: "promote_pending",  transition: "request_promote",      initiator: "agent" },
  // THE ONLY HUMAN-GATE: promote_pending → production
  { from: "promote_pending", to: "production",       transition: "promote",              initiator: "human" },
  // Backward edges: revise (simulation → interview|draft_bundle)
  { from: "simulation",      to: "interview",        transition: "revise_to_interview",  initiator: "agent" },
  { from: "simulation",      to: "draft_bundle",     transition: "revise_to_draft",      initiator: "agent" },
  // Backward edge: evolve (production → interview — incremental new cycle)
  { from: "production",      to: "interview",        transition: "evolve",               initiator: "agent" },
];

/**
 * sImplementation: the phase-machine entity.
 * This is a projection — not a new authority-store (ADR §15 / NF-1).
 */
export interface Implementation {
  implementationId: string;
  tenantId: string;
  phase: ImplementationPhase;
  createdAt: number;
  updatedAt: number;
}

/**
 * Result of a phase transition attempt.
 */
export type TransitionResult =
  | { ok: true; newPhase: ImplementationPhase }
  | { ok: false; error: string };

/**
 * Attempt a phase transition on an implementation.
 * Fail-closed: any illegal transition returns ok:false (FR-B2-1 / AC-1).
 * Human-gate: promote_pending→production is the only human-initiated transition (FR-B2-2 / AC-2).
 *
 * The caller is responsible for persisting the new phase and calling appendAuditEvent
 * with type "impl.phase.transitioned" (FR-B2-6 / AC-5).
 */
export function transitionPhase(
  current: ImplementationPhase,
  transition: PhaseTransition,
): TransitionResult {
  const edge = LEGAL_TRANSITIONS.find(
    (e) => e.from === current && e.transition === transition,
  );
  if (!edge) {
    return {
      ok: false,
      error: `Illegal phase transition: ${current} --[${transition}]--> (no such edge). Fail-closed.`,
    };
  }
  return { ok: true, newPhase: edge.to };
}

/**
 * Returns true if the given transition is legal from the given phase.
 * Useful for UI-level gate checks without mutating state.
 */
export function isLegalTransition(
  from: ImplementationPhase,
  transition: PhaseTransition,
): boolean {
  return LEGAL_TRANSITIONS.some((e) => e.from === from && e.transition === transition);
}

/**
 * Returns the initiator (agent|human) for a transition, or null if not a legal edge.
 * AC-2: verifies that self-promote (agent-initiated promote) is not a legal edge.
 */
export function getTransitionInitiator(
  from: ImplementationPhase,
  transition: PhaseTransition,
): TransitionInitiator | null {
  const edge = LEGAL_TRANSITIONS.find(
    (e) => e.from === from && e.transition === transition,
  );
  return edge ? edge.initiator : null;
}

/**
 * Returns ALL legal transitions from a given phase.
 */
export function legalTransitionsFrom(phase: ImplementationPhase): TransitionEdge[] {
  return LEGAL_TRANSITIONS.filter((e) => e.from === phase);
}

// ---------------------------------------------------------------------------
// § B-2: Bundle projection model (ADR §5)
// ---------------------------------------------------------------------------

/**
 * A reference to a role/position in the org-tree (not a zapped assignee — ADR §5.2).
 * Bundle.components.roles holds RoleRefs; actual assignees resolve from live org at runtime.
 */
export interface RoleRef {
  roleId: string;
  displayName?: string;
}

/**
 * A grant specification on a bundle step — resource_type × operation × scope (T-0018).
 * scope is a ScopeElement from the T-0018 lattice (grant-lattice.ts).
 */
export interface GrantSpec {
  stepId: string;
  roleRef: RoleRef;
  resourceType: string;
  operation: string;
  scope: ScopeElement;
}

/**
 * A form specification (Floor-1 JSON-Schema + UI-schema, extensibility §4).
 */
export interface FormSpec {
  formId: string;
  name: string;
  jsonSchema: unknown;
  uiSchema?: unknown;
}

/**
 * Status model for the bundle (ADR §2.7 / reference-process: 6 statuses + 2 terminals).
 */
export interface StatusModel {
  statuses: Array<{
    statusId: string;
    name: string;
    terminal?: boolean;
  }>;
  transitions: Array<{
    from: string;
    to: string;
    label?: string;
  }>;
}

/**
 * Semantic changelog entry — NOT raw git-diff (ADR §5.1/§5.3 / FR-B2-5).
 * Example: { kind: "field_added", description: "Added field X; soft migration Y." }
 */
export interface ChangelogEntry {
  kind: string;
  description: string;
  componentId?: string;
}

/** Semantic changelog — array of entries (ADR §5.1 / FR-B2-5). */
export type SemanticChangelog = ChangelogEntry[];

/**
 * The bundle components (ADR §5.1 coherent unit).
 */
export interface BundleComponents {
  /** BPMN 2.0 XML — linted by lintBpmn (T-0027). */
  process: string;
  /** Forms (Floor-1 JSON-Schema + UI-schema). */
  forms: FormSpec[];
  /** Status model (statuses and transitions). */
  statuses: StatusModel;
  /** Role references (NOT zapped assignees — live org resolves at runtime). */
  roles: RoleRef[];
  /** Grant specifications for steps (resource × operation × scope). */
  grants: GrantSpec[];
}

/**
 * Bundle: the coherent versioned draft/published unit (ADR §5.1, FR-B2-3).
 * This is a PROJECTION — not a new authority-store (ADR §15 / NF-1).
 *
 * tier: "draft" | "published" — logical tiers (extensibility §8), NOT new env entities.
 * version: monotonically increasing integer; published-version == promoted draft-version.
 * coherence_hash: deterministic function of component versions (FR-B2-4).
 * changelog: semantic (not raw git-diff) (FR-B2-5).
 *
 * Partial promote is structurally impossible: coherence_hash ties all components
 * into a single version-unit (ADR §10.1 / FR-B2-7).
 */
export interface Bundle {
  bundleId: string;
  implementationId: string;
  tier: "draft" | "published";
  version: number;
  components: BundleComponents;
  coherenceHash: string;
  changelog: SemanticChangelog;
}

/**
 * Compute the deterministic coherence_hash for a bundle's components.
 *
 * The hash is a SHA-256 of the canonical JSON representation of all components.
 * Deterministic: identical components → identical hash (FR-B2-4 / AC-4).
 * Design-owned choice G-2: SHA-256 of canonical JSON (simplest deterministic approach).
 *
 * The hash captures version desync: if any component differs, the hash differs.
 * This makes partial-promote structurally impossible (FR-B2-7 / AC-6).
 */
export function computeCoherenceHash(components: BundleComponents): string {
  // Canonical JSON: sort keys at every level for determinism.
  const canonical = canonicalJson(components);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Canonical JSON serialization — sorts object keys alphabetically at all levels.
 * This ensures determinism regardless of insertion order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const pairs = sorted.map(
    (k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]),
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * Assemble a draft bundle from components.
 * Computes coherenceHash. Emits impl.bundle.assembled audit event via provided sink.
 *
 * The audit sink takes an AuditEventInput and returns a Promise<void>.
 * Caller is responsible for providing a transaction-scoped sink.
 *
 * FR-B2-6 / AC-5: audit via appendAuditEvent (T-0031) — no new audit-log.
 * FR-B2-3 / AC-3: all required fields present.
 */
export interface AuditSink {
  append(input: AuditEventInput): Promise<void>;
}

export interface AssembleBundleOptions {
  implementationId: string;
  tenantId: string;
  version: number;
  components: BundleComponents;
  changelog: SemanticChangelog;
  actor: string;
  auditSink: AuditSink;
}

export async function assembleDraftBundle(opts: AssembleBundleOptions): Promise<Bundle> {
  const coherenceHash = computeCoherenceHash(opts.components);
  const bundle: Bundle = {
    bundleId: randomUUID(),
    implementationId: opts.implementationId,
    tier: "draft",
    version: opts.version,
    components: opts.components,
    coherenceHash,
    changelog: opts.changelog,
  };

  // Emit audit event: impl.bundle.assembled (FR-B2-6 / AC-5)
  await opts.auditSink.append({
    id: randomUUID(),
    type: "impl.bundle.assembled",
    actor: opts.actor,
    subject: opts.implementationId,
    scope: null,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: {
      bundleId: bundle.bundleId,
      version: bundle.version,
      tier: bundle.tier,
      coherenceHash,
    },
    occurred_at: Date.now(),
  });

  return bundle;
}

/**
 * Emit the impl.phase.transitioned audit event.
 * Call this after a successful transitionPhase() to record the transition.
 * FR-B2-6 / AC-5.
 */
export async function emitPhaseTransitionAudit(
  implementationId: string,
  fromPhase: ImplementationPhase,
  toPhase: ImplementationPhase,
  transition: PhaseTransition,
  actor: string,
  auditSink: AuditSink,
): Promise<void> {
  await auditSink.append({
    id: randomUUID(),
    type: "impl.phase.transitioned",
    actor,
    subject: implementationId,
    scope: null,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: { fromPhase, toPhase, transition },
    occurred_at: Date.now(),
  });
}

/**
 * Verify bundle coherence: checks that the stored coherenceHash matches a freshly
 * computed hash over the components. Mismatch → desync error.
 * Used to guard partial-promote: published = exactly the draft that ran (FR-B2-7 / AC-6).
 */
export function verifyBundleCoherence(bundle: Bundle): { ok: true } | { ok: false; error: string } {
  const recomputed = computeCoherenceHash(bundle.components);
  if (recomputed !== bundle.coherenceHash) {
    return {
      ok: false,
      error: `Bundle coherence violation: stored hash ${bundle.coherenceHash} ≠ recomputed ${recomputed}. Component version desync.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// § B-3: Bundle grant-consistency validator (ADR §6 / FR-B3-*)
//
// Uses isNarrowerOrEqual from T-0018 as a READ-ONLY import.
// Does NOT modify grant-lattice.ts (FROZEN-CLEAR / NF-2 / AC-8/AC-12).
// ---------------------------------------------------------------------------

/**
 * A node in the org-tree that a GrantSpec.scope can resolve against.
 * For B-3 resolvable-assignee check (FR-B3-1 / AC-9).
 */
export interface OrgNode {
  nodeId: string;
  parentId?: string;
  roleIds: string[];
  displayName?: string;
}

/**
 * The live org-tree of a tenant — read-only for B-3/B-4.
 * B-3 reads this to check resolvable-assignees. B-4 reads it for interview validation.
 * Neither B-3 nor B-4 writes to this (FR-B4-2 / FR-B4-3 / AC-15).
 */
export interface OrgTree {
  /** Returns all nodes for the tenant. Pure, no side effects. */
  getNodes(): OrgNode[];
  /** Returns a node by id, or undefined if not found. */
  getNode(nodeId: string): OrgNode | undefined;
  /** Returns all roles for the tenant. */
  getRoleIds(): string[];
}

/**
 * Validate grant consistency of a bundle against the live org-tree (ADR §6 / FR-B3-*).
 *
 * Three checks:
 *  1. Resolvable-assignee: each GrantSpec.scope resolves to ≥1 org-node (FR-B3-1 / AC-9).
 *  2. Narrowing via isNarrowerOrEqual: grant scope is not wider than parent role scope (FR-B3-2 / AC-10).
 *  3. Drain-desync: grantSpecVersion must match bundleVersion for drained instances (FR-B3-3 / AC-11).
 *
 * Returns ok:true if all pass, or ok:false with a list of violations.
 *
 * Note: FR-B3-4 — missing role is a discrepancy (input for B-4 ask_interview_question),
 * not a silent/phantom grant. The validator flags it and the caller routes to B-4.
 *
 * READER-ONLY over isNarrowerOrEqual: B-3 calls the imported function as a pure reader.
 * The grant-lattice module is not modified anywhere in this file (FROZEN-CLEAR).
 */
export interface GrantConsistencyViolation {
  stepId: string;
  kind: "unresolvable_assignee" | "scope_too_wide" | "drain_desync";
  description: string;
}

export type GrantConsistencyResult =
  | { ok: true }
  | { ok: false; violations: GrantConsistencyViolation[] };

/**
 * Options for grant consistency validation.
 * parentRoleScope: the scope of the parent role (used for narrowing check).
 *   If absent for a grant, the narrowing check is skipped (conservative).
 * drainedBundleVersion: if provided, checks drain-desync (FR-B3-3).
 */
export interface GrantConsistencyOptions {
  org: OrgTree;
  oracle: AncestryOracle;
  /** For each roleRef.roleId → the scope of the parent role (for narrowing check). */
  parentRoleScopes?: Map<string, ScopeElement>;
  /**
   * If provided, checks that no grant in this bundle was absent in the version
   * with this version number. The grantSpecVersions map: stepId → version the grant
   * first appeared in the bundle. If grant appeared at version > drainedBundleVersion → desync.
   */
  drainedBundleVersion?: number;
  grantSpecVersions?: Map<string, number>;
}

export function validateGrantConsistency(
  bundle: Bundle,
  opts: GrantConsistencyOptions,
): GrantConsistencyResult {
  const violations: GrantConsistencyViolation[] = [];
  const nodes = opts.org.getNodes();
  const allRoleIds = new Set(opts.org.getRoleIds());

  for (const grant of bundle.components.grants) {
    const { stepId, roleRef, scope } = grant;

    // Check 1: resolvable assignee (FR-B3-1 / AC-9)
    // The scope must resolve to at least one org-node or role in the org-tree.
    const resolvable = isGrantScopeResolvable(scope, nodes, allRoleIds, opts.oracle);
    if (!resolvable) {
      violations.push({
        stepId,
        kind: "unresolvable_assignee",
        description: `GrantSpec for step "${stepId}" (role "${roleRef.roleId}") has a scope that resolves to no org-node or role. Discrepancy — not a silent grant. (FR-B3-1 / FR-B3-4)`,
      });
      continue; // Don't run narrowing check on an unresolvable scope
    }

    // Check 2: narrowing via isNarrowerOrEqual — READER-ONLY over T-0018 (FR-B3-2 / AC-10).
    // If parentRoleScopes is provided, verify grant scope ⊑ parent role scope.
    if (opts.parentRoleScopes) {
      const parentScope = opts.parentRoleScopes.get(roleRef.roleId);
      if (parentScope !== undefined) {
        // isNarrowerOrEqual(child, parent, oracle): true if child ⊑ parent
        const narrow = isNarrowerOrEqual(scope, parentScope, opts.oracle);
        if (!narrow) {
          violations.push({
            stepId,
            kind: "scope_too_wide",
            description: `GrantSpec for step "${stepId}" (role "${roleRef.roleId}") has scope wider than parent role scope. Narrowing violation (T-0018 / FR-B3-2).`,
          });
        }
      }
    }

    // Check 3: drain-desync (FR-B3-3 / AC-11)
    // If drainedBundleVersion is provided, check that this grant existed in that version.
    if (
      opts.drainedBundleVersion !== undefined &&
      opts.grantSpecVersions !== undefined
    ) {
      const grantVersion = opts.grantSpecVersions.get(stepId);
      if (grantVersion !== undefined && grantVersion > opts.drainedBundleVersion) {
        violations.push({
          stepId,
          kind: "drain_desync",
          description: `GrantSpec for step "${stepId}" first appeared at bundle version ${grantVersion}, but the drained instance is on version ${opts.drainedBundleVersion}. Desync — not a silent grant. (FR-B3-3)`,
        });
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true };
}

/**
 * Checks if a scope resolves to at least one org-node or role (FR-B3-1).
 * A node-scope resolves if the nodeId exists in the org-tree.
 * A tags-scope resolves if at least one node has a matching role.
 * A set-scope resolves if at least one member resolves.
 * An interval-scope resolves if the org-tree has any node (conservative: interval scope
 * is a numeric filter, not an org filter; any org presence satisfies).
 */
function isGrantScopeResolvable(
  scope: ScopeElement,
  nodes: OrgNode[],
  allRoleIds: Set<string>,
  oracle: AncestryOracle,
): boolean {
  switch (scope.kind) {
    case "node": {
      // The nodeId must exist in the org-tree
      return nodes.some((n) => oracle.isDescendantOrSelf(scope.hierarchy, n.nodeId, scope.nodeId) ||
        oracle.isDescendantOrSelf(scope.hierarchy, scope.nodeId, n.nodeId));
    }
    case "tags": {
      // At least one role must match all tags
      // Tags here reference role slugs / tag labels — we check against known roleIds
      return scope.tags.some((tag) => allRoleIds.has(tag));
    }
    case "interval": {
      // Interval scope is a numeric filter (e.g., amount ≥ 5M).
      // It resolves as long as there is at least one org node that could receive the grant.
      return nodes.length > 0;
    }
    case "set": {
      // Set scope: at least one member must resolve
      return scope.members.some((m) =>
        isGrantScopeResolvable(m as ScopeElement, nodes, allRoleIds, oracle),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// § B-4: Interview protocol (ADR §7 / FR-B4-*)
// ---------------------------------------------------------------------------

/**
 * Resolution status of an interview claim (ADR §7).
 */
export type ClaimResolution = "resolved" | "discrepancy";

/**
 * Discrepancy kind (ADR §7 / FR-B4-3).
 * missing_role: role/node referenced in claim does not exist in org-tree.
 * ambiguous_assignee: multiple org-nodes match; cannot unambiguously resolve.
 * scope_unrepresentable: the claim scope cannot be represented in the grant-lattice.
 */
export type DiscrepancyKind = "missing_role" | "ambiguous_assignee" | "scope_unrepresentable";

/**
 * Discrepancy info — attached to an interview_claim when resolution=discrepancy.
 * Includes the question to ask the human (via ask_interview_question audit event).
 */
export interface ClaimDiscrepancy {
  kind: DiscrepancyKind;
  question: string;
}

/**
 * interview_claim: the unit of B-4 interview protocol (ADR §7 / FR-B4-1).
 *
 * claim_id: stable UUID
 * text: the assertion about the process ("≥5M → legal dept approves")
 * org_refs: role references the assertion refers to
 * resolution: "resolved" | "discrepancy"
 * discrepancy: present iff resolution=discrepancy
 */
export interface InterviewClaim {
  claimId: string;
  text: string;
  orgRefs: RoleRef[];
  resolution: ClaimResolution;
  discrepancy?: ClaimDiscrepancy;
}

/**
 * Options for processing an interview claim.
 * org: read-only org-tree (FR-B4-2 — interview reads, never writes).
 * auditSink: receives impl.interview.question_asked / impl.interview.claim_resolved events.
 */
export interface ProcessClaimOptions {
  claim: Omit<InterviewClaim, "resolution" | "discrepancy">;
  implementationId: string;
  tenantId: string;
  actor: string;
  org: OrgTree;
  auditSink: AuditSink;
}

/**
 * Process an interview claim against the read-only org-tree.
 *
 * Algorithm (ADR §7 / FR-B4-2/B4-3):
 *   For each orgRef in claim.orgRefs:
 *     1. Look up roleId in org-tree.
 *     2. If not found → discrepancy(missing_role) + ask_interview_question.
 *     3. If multiple matches → discrepancy(ambiguous_assignee) + ask_interview_question.
 *     4. If exactly one match → resolved.
 *
 * INVARIANT: org-tree is READ-ONLY — this function NEVER creates/modifies org nodes.
 * The org-node count does not change after this call (FR-B4-2 / AC-15).
 *
 * INVARIANT: If discrepancy → explicit question raised (ask_interview_question audit),
 * NO phantom org-node created (FR-B4-3 / AC-13).
 */
export async function processInterviewClaim(
  opts: ProcessClaimOptions,
): Promise<InterviewClaim> {
  const { claim, implementationId, actor, org, auditSink } = opts;

  // Validate each orgRef against the read-only org-tree
  for (const ref of claim.orgRefs) {
    // Find nodes that carry this roleId
    const matchingNodes = org.getNodes().filter((n) => n.roleIds.includes(ref.roleId));
    const roleExists = org.getRoleIds().includes(ref.roleId);

    if (!roleExists && matchingNodes.length === 0) {
      // missing_role: the role/position does not exist in the org-tree
      const question = `Role "${ref.roleId}" (${ref.displayName ?? ref.roleId}) referenced in claim "${claim.text}" does not exist in the org-tree. Who should be assigned?`;
      const discrepancy: ClaimDiscrepancy = { kind: "missing_role", question };

      // Emit audit: impl.interview.question_asked (FR-B4-3 / AC-13)
      await auditSink.append({
        id: randomUUID(),
        type: "impl.interview.question_asked",
        actor,
        subject: implementationId,
        scope: null,
        via: null,
        proposed_by: null,
        confirmed_by: null,
        payload: { claimId: claim.claimId, discrepancyKind: "missing_role", question },
        occurred_at: Date.now(),
      });

      // Return immediately with discrepancy — do NOT create phantom org node
      return {
        ...claim,
        resolution: "discrepancy",
        discrepancy,
      };
    }

    if (matchingNodes.length > 1) {
      // ambiguous_assignee: multiple nodes match this roleId
      const nodeIds = matchingNodes.map((n) => n.nodeId).join(", ");
      const question = `Role "${ref.roleId}" matches multiple org-nodes (${nodeIds}). Which one should be the assignee for claim "${claim.text}"?`;
      const discrepancy: ClaimDiscrepancy = { kind: "ambiguous_assignee", question };

      // Emit audit: impl.interview.question_asked (FR-B4-3 / AC-14)
      await auditSink.append({
        id: randomUUID(),
        type: "impl.interview.question_asked",
        actor,
        subject: implementationId,
        scope: null,
        via: null,
        proposed_by: null,
        confirmed_by: null,
        payload: { claimId: claim.claimId, discrepancyKind: "ambiguous_assignee", question },
        occurred_at: Date.now(),
      });

      return {
        ...claim,
        resolution: "discrepancy",
        discrepancy,
      };
    }
    // Exactly one match (or role exists with 0 nodes — positional reference) → continue
  }

  // All orgRefs resolved → resolved claim
  // Emit audit: impl.interview.claim_resolved (FR-B4-4 / AC-15)
  await auditSink.append({
    id: randomUUID(),
    type: "impl.interview.claim_resolved",
    actor,
    subject: implementationId,
    scope: null,
    via: null,
    proposed_by: null,
    confirmed_by: null,
    payload: { claimId: claim.claimId },
    occurred_at: Date.now(),
  });

  return {
    ...claim,
    resolution: "resolved",
  };
}

// ---------------------------------------------------------------------------
// § B-5: Simulation mode-1 — deterministic route-calc (ADR §8.1 / FR-B5-*)
//
// Extends bpmn-linter.ts (T-0027) — consumes lintBpmn as the SOLE BPMN linter.
// No Flowable / no DB / no network (pure function — FR-B5-2 / AC-18).
// Does NOT introduce a new/parallel BPMN parser (FR-B5-3 / AC-19).
// ---------------------------------------------------------------------------

/**
 * A synthetic test case for simulation mode-1.
 * attributes: key-value pairs representing case data (e.g. { amount: 6000000 }).
 */
export interface SimulationCase {
  caseId: string;
  attributes: Record<string, unknown>;
}

/**
 * A BPMN gateway condition specification (for DMN-style evaluation in mode-1).
 * Uses simple attribute comparisons — no Flowable engine required.
 */
export interface GatewayRoute {
  gatewayId: string;
  /** Conditions: array of {attribute, op, value} — first matching condition wins (default-last). */
  conditions: Array<{
    attribute: string;
    op: "gte" | "lte" | "gt" | "lt" | "eq" | "neq" | "default";
    value?: number | string | boolean;
    nextStepId: string;
    assigneeRoleId?: string;
  }>;
}

/**
 * Route result for a single case.
 * path: ordered list of stepIds the case traverses.
 * assignees: map of stepId → resolved RoleRef (from live org-tree, read-only).
 */
export interface CaseRouteResult {
  caseId: string;
  path: string[];
  /** Map of stepId → RoleRef (from bundle.components.roles, resolved from org). */
  assignees: Map<string, RoleRef>;
  error?: string;
}

/**
 * Full simulation mode-1 result: case → route → assignee table (ADR §8.1 / FR-B5-1).
 * Deterministic: same bundle + same cases → same result (FR-B5-2 / AC-17).
 */
export interface SimulationResult {
  bundleId: string;
  bundleVersion: number;
  cases: CaseRouteResult[];
}

/**
 * Options for runSimulationMode1.
 * org: read-only org-tree for resolving role assignees (FR-B5-4).
 * gatewayRoutes: explicit routing rules for gateways in the BPMN.
 * entryStepId: the ID of the start event / first step.
 */
export interface SimulationOptions {
  cases: SimulationCase[];
  org: OrgTree;
  gatewayRoutes: GatewayRoute[];
  entryStepId?: string;
}

/**
 * Run simulation mode-1: deterministic route-calculation over a draft bundle.
 *
 * Protocol (ADR §8.1 / FR-B5-1):
 *   1. Call lintBpmn(bundle.components.process) as the SOLE BPMN linter (FR-B5-3).
 *      If lint fails → fail-closed, return error (FR-B5-2 / AC-19).
 *   2. For each synthetic case, deterministically route through gateways by evaluating
 *      gateway conditions against case attributes.
 *   3. Resolve assignee role from live org-tree (read-only) for each step (FR-B5-4).
 *   4. Return table: case → path → assignee (FR-B5-1 / AC-17).
 *
 * Pure function: no network, no DB, no Flowable, no side effects (FR-B5-2 / AC-18).
 * Deterministic: same input → byte-identical output (AC-17).
 *
 * NOTE: B-5 does NOT define a new BPMN parser — it uses lintBpmn from bpmn-linter.ts
 * as the single BPMN validator (FR-B5-3 / AC-19). The lintBpmn function is imported
 * above from "./bpmn-linter.js".
 */
export function runSimulationMode1(
  bundle: Bundle,
  opts: SimulationOptions,
): SimulationResult {
  // Step 1: lint BPMN using the SOLE T-0027 linter (FR-B5-3 / AC-19).
  // Fail-closed: invalid BPMN → refuse to simulate (NF-4).
  const lintResult = lintBpmn(bundle.components.process);
  if (!lintResult.ok) {
    // Return error results for all cases (fail-closed)
    return {
      bundleId: bundle.bundleId,
      bundleVersion: bundle.version,
      cases: opts.cases.map((c) => ({
        caseId: c.caseId,
        path: [],
        assignees: new Map(),
        error: `BPMN lint failed (fail-closed): ${JSON.stringify(lintResult.violations)}`,
      })),
    };
  }

  // Build a lookup map for gateway routes
  const gatewayMap = new Map<string, GatewayRoute>(
    opts.gatewayRoutes.map((g) => [g.gatewayId, g]),
  );

  // Build role-ref lookup from bundle components
  const roleRefMap = new Map<string, RoleRef>(
    bundle.components.roles.map((r) => [r.roleId, r]),
  );

  // Build grant-step assignee map: stepId → roleId
  const stepRoleMap = new Map<string, string>(
    bundle.components.grants.map((g) => [g.stepId, g.roleRef.roleId]),
  );

  // Step 2: route each case deterministically
  const caseResults: CaseRouteResult[] = opts.cases.map((simCase) => {
    return routeCase(simCase, gatewayMap, roleRefMap, stepRoleMap, opts.org, opts.entryStepId);
  });

  return {
    bundleId: bundle.bundleId,
    bundleVersion: bundle.version,
    cases: caseResults,
  };
}

/**
 * Deterministically route a single case through the gateway network.
 *
 * For each gateway encountered, evaluates conditions in order — first matching wins.
 * A "default" condition matches unconditionally (used as fallback).
 *
 * This is purely functional: same case + same gatewayMap → same path.
 *
 * FR-B5-4: resolves assignee RoleRef from live org-tree (read-only).
 * The reference-process example: "amount ≥ 5M → юротдел" (AC-18).
 */
function routeCase(
  simCase: SimulationCase,
  gatewayMap: Map<string, GatewayRoute>,
  roleRefMap: Map<string, RoleRef>,
  stepRoleMap: Map<string, string>,
  org: OrgTree,
  entryStepId: string | undefined,
): CaseRouteResult {
  const path: string[] = [];
  const assignees = new Map<string, RoleRef>();

  // Start from entry if specified
  let currentStepId = entryStepId;
  const visited = new Set<string>();

  // Traverse gateways in topological order (each gateway contributes one step to path)
  // We process gateways in insertion order (stable, deterministic for same input)
  // Each gateway is a decision point; we follow the winning branch.
  for (const [gatewayId, gateway] of gatewayMap) {
    // Avoid cycles
    if (visited.has(gatewayId)) continue;
    visited.add(gatewayId);

    // Add gateway to path
    if (path.length === 0 && currentStepId && currentStepId !== gatewayId) {
      path.push(currentStepId);
      // Resolve assignee for entry step
      const entryRoleId = stepRoleMap.get(currentStepId);
      if (entryRoleId) {
        const roleRef = resolveRoleRef(entryRoleId, roleRefMap, org);
        if (roleRef) assignees.set(currentStepId, roleRef);
      }
    }
    path.push(gatewayId);

    // Evaluate gateway conditions deterministically
    let matchedNextStep: string | undefined;
    let matchedRoleId: string | undefined;
    for (const cond of gateway.conditions) {
      if (cond.op === "default") {
        matchedNextStep = cond.nextStepId;
        matchedRoleId = cond.assigneeRoleId;
        break; // default wins only if no prior condition matched
      }
      const attrValue = simCase.attributes[cond.attribute];
      if (evaluateCondition(attrValue, cond.op, cond.value)) {
        matchedNextStep = cond.nextStepId;
        matchedRoleId = cond.assigneeRoleId;
        break; // first match wins
      }
    }

    if (matchedNextStep) {
      path.push(matchedNextStep);
      // Resolve assignee from org-tree (read-only, FR-B5-4)
      const roleId = matchedRoleId ?? stepRoleMap.get(matchedNextStep);
      if (roleId) {
        const roleRef = resolveRoleRef(roleId, roleRefMap, org);
        if (roleRef) assignees.set(matchedNextStep, roleRef);
      }
      currentStepId = matchedNextStep;
    }
  }

  // If no gateways traversed but entryStepId given, record at least the entry
  if (path.length === 0 && entryStepId) {
    path.push(entryStepId);
    const entryRoleId = stepRoleMap.get(entryStepId);
    if (entryRoleId) {
      const roleRef = resolveRoleRef(entryRoleId, roleRefMap, org);
      if (roleRef) assignees.set(entryStepId, roleRef);
    }
  }

  return { caseId: simCase.caseId, path, assignees };
}

/**
 * Resolve a RoleRef for a given roleId from the bundle's role-ref map and org-tree.
 * Returns the RoleRef if found, or undefined if the role is not in the org-tree.
 * FR-B5-4: read-only org resolution.
 */
function resolveRoleRef(
  roleId: string,
  roleRefMap: Map<string, RoleRef>,
  org: OrgTree,
): RoleRef | undefined {
  // Check bundle role-refs first
  const bundleRef = roleRefMap.get(roleId);
  if (bundleRef) return bundleRef;
  // Check if role exists in org-tree
  if (org.getRoleIds().includes(roleId)) {
    return { roleId };
  }
  return undefined;
}

/**
 * Evaluate a single gateway condition against a case attribute value.
 * Pure, deterministic, no side effects.
 */
function evaluateCondition(
  attrValue: unknown,
  op: GatewayRoute["conditions"][number]["op"],
  condValue: number | string | boolean | undefined,
): boolean {
  if (op === "default") return true;
  if (attrValue === undefined || attrValue === null) return false;

  const numAttr = typeof attrValue === "number" ? attrValue : parseFloat(String(attrValue));
  const numCond = typeof condValue === "number" ? condValue : parseFloat(String(condValue));

  switch (op) {
    case "gte": return numAttr >= numCond;
    case "gt":  return numAttr > numCond;
    case "lte": return numAttr <= numCond;
    case "lt":  return numAttr < numCond;
    case "eq":  return attrValue === condValue;
    case "neq": return attrValue !== condValue;
    default:    return false;
  }
}
