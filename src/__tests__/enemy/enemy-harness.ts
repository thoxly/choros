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
  | "DEV-AUTH-PROD"; // §3 — keycloak-mode rejects x-dev-user without a Bearer JWT

/** What outcome the harness asserts the system must produce for a case. */
export type ExpectedVerdict =
  | { kind: "pdp-deny"; reason: "cross_tenant" | "no_grant" } // PDP must deny with this reason
  | { kind: "http-401" }; // auth seam must reject with 401

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
  input: PdpProbeInput | AuthProbeInput;
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

export interface EnemySurfaces {
  pdp: PdpUnderAttack;
  auth: AuthUnderAttack;
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

  // auth surface
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
