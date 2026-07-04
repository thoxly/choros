/**
 * src/core/sandbox-gate.ts — T-0557: the runtime-visibility decision layer for
 * the sandbox / draft-tier gate.
 *
 * PURE, IO-FREE. No import from pg, http, https, net, fetch, fs, child_process.
 * Mirrors the purity discipline of src/core/env-tier.ts: every function here is a
 * total, side-effect-free decision over already-resolved inputs. The DB-side
 * actor-privilege resolution lives in src/db/sandbox-gate-dao.ts; this module is
 * the decidable layer those resolved facts feed into.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * FROZEN INTERFACE (T-0558 builds against this — do NOT change signatures):
 *
 *   type Tier                         — re-exported from env-tier.ts.
 *   DraftVisibilityInput              — input to decideDraftVisibility.
 *   DraftVisibilityDecision           — { visible, reason } result.
 *   decideDraftVisibility(input)      — published→all; draft→privileged only.
 *   SandboxReadPredicateOptions       — input to sandboxReadPredicate.
 *   SandboxReadPredicate              — { sql, params } SQL fragment.
 *   sandboxReadPredicate(opts)        — AND-able runtime read restriction.
 *
 * CONTRACT FOR T-0558:
 *   1. Resolve the actor's privilege ONCE (db/sandbox-gate-dao.resolveActorPrivilege)
 *      → { isOwnerOrAdmin, hasAuthoringDraftGrant }.
 *   2. For an individual artifact already loaded, gate visibility with
 *      decideDraftVisibility — it returns a stable `reason` string for audit/log.
 *   3. For a runtime LIST query, append sandboxReadPredicate(...).sql as an extra
 *      `AND` and splice .params onto the parameter array. The fragment is
 *      $-placeholder–FREE: it emits a self-contained literal/tautology so the
 *      caller's existing parameter indices are never perturbed. (See the
 *      sandboxReadPredicate doc for the precise placeholder discipline.)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * DESIGN INVARIANTS:
 *  - No IO, no side-effects. Every function is pure and total (exhaustive).
 *  - `actor` privilege flags ALWAYS originate from the AUTHENTICATED, tenant-scoped
 *    DAO resolution — never from a request body or header (the caller's contract,
 *    same discipline as env-tier.ts decidePromote.actorType).
 *  - Fail-closed: an unprivileged actor sees ONLY published artifacts.
 */

import type { Tier } from "./env-tier.js";

export type { Tier };

// ---------------------------------------------------------------------------
// decideDraftVisibility — per-artifact runtime visibility decision.
// ---------------------------------------------------------------------------

/**
 * Input to {@link decideDraftVisibility}.
 *
 * @property artifactTier  The artifact's tier ("draft" | "published").
 * @property actor         The resolved, authenticated privilege of the viewer.
 *                         Both flags come from the tenant-scoped, fail-closed DAO
 *                         (db/sandbox-gate-dao.resolveActorPrivilege) — never trust
 *                         a header or request body to populate them.
 */
export interface DraftVisibilityInput {
  artifactTier: Tier;
  actor: {
    /** Genesis owner or a tenant admin (mgmt-grant holder). */
    isOwnerOrAdmin: boolean;
    /** Holds an effective `authoring_draft` capability grant (T-0462). */
    hasAuthoringDraftGrant: boolean;
  };
}

/**
 * Decision returned by {@link decideDraftVisibility}.
 *
 * @property visible  Whether the actor may see this artifact at runtime.
 * @property reason   Stable machine-readable token explaining the decision, for
 *                    audit/log. One of:
 *                      - "published_visible_to_all"
 *                      - "draft_visible_owner_admin"
 *                      - "draft_visible_authoring_grant"
 *                      - "draft_hidden_unprivileged"
 */
export interface DraftVisibilityDecision {
  visible: boolean;
  reason:
    | "published_visible_to_all"
    | "draft_visible_owner_admin"
    | "draft_visible_authoring_grant"
    | "draft_hidden_unprivileged";
}

/**
 * Pure, exhaustive runtime-visibility decision for a single artifact.
 *
 * Rules (fail-closed):
 *  - A `published` artifact is visible to EVERYONE in the tenant.
 *  - A `draft` artifact is visible ONLY to an owner/admin OR to a holder of the
 *    `authoring_draft` grant. Everyone else: hidden.
 *
 * The owner/admin branch is checked before the authoring-grant branch purely so
 * the returned `reason` reflects the strongest authority; both yield visible=true.
 */
export function decideDraftVisibility(
  input: DraftVisibilityInput,
): DraftVisibilityDecision {
  if (input.artifactTier === "published") {
    return { visible: true, reason: "published_visible_to_all" };
  }
  // artifactTier === "draft" — sandbox: privileged viewers only.
  if (input.actor.isOwnerOrAdmin) {
    return { visible: true, reason: "draft_visible_owner_admin" };
  }
  if (input.actor.hasAuthoringDraftGrant) {
    return { visible: true, reason: "draft_visible_authoring_grant" };
  }
  return { visible: false, reason: "draft_hidden_unprivileged" };
}

// ---------------------------------------------------------------------------
// sandboxReadPredicate — AND-able SQL fragment for runtime LIST queries.
// ---------------------------------------------------------------------------

/**
 * Input to {@link sandboxReadPredicate}.
 *
 * @property tierColumn         A TRUSTED, caller-provided column identifier naming
 *                              the tier column to restrict (e.g. `"a.tier"`). This
 *                              is spliced verbatim into the SQL fragment — it MUST
 *                              be a compile-time/code-level constant and MUST NOT
 *                              be derived from user input (no SQL-injection surface
 *                              is opened only because the caller never passes user
 *                              data here).
 * @property actorIsPrivileged  True iff the actor may see drafts (owner/admin OR
 *                              authoring_draft holder) — the boolean OR of the two
 *                              flags resolved by the DAO. When true the predicate
 *                              imposes NO restriction.
 * @property creatorEscape      T-0623 (столп-4, «create must not create an object
 *                              invisible to yourself»): OPTIONAL creator-own floor.
 *                              A non-privileged actor is STILL allowed to see a row
 *                              of a DRAFT (sandbox) application when that row was
 *                              CREATED BY the actor themselves — otherwise a
 *                              rank-and-file employee who writes a record into a
 *                              draft-tier app (create is not sandbox-gated) can
 *                              never read it back (GET 404 / list empty) or delete
 *                              it (403). This is a per-ROW ownership escape ONLY: it
 *                              never widens visibility to any OTHER user's rows, and
 *                              never relaxes the tenant scope (RLS + the caller's
 *                              own `tenant_id` guard are untouched). When present,
 *                              the sandbox restriction becomes
 *                                  (<tierColumn> = 'published' OR <ownerColumn> = <ownerParam>)
 *                              for a non-privileged actor.
 *                                - `ownerColumn`: a TRUSTED, code-level column
 *                                  identifier (e.g. `"r.created_by"`) — like
 *                                  `tierColumn`, MUST NOT be sourced from a request.
 *                                - `ownerParam`: the `$N` placeholder STRING the
 *                                  caller has ALREADY allocated for the actor slug
 *                                  bind value (e.g. `"$4"`). Keeping the value as a
 *                                  bind param (never a literal) is what makes this
 *                                  safe against the ONE piece of caller-derived data
 *                                  in the fragment (the actor slug). The caller is
 *                                  responsible for pushing the actor slug onto its
 *                                  params array at the matching index.
 *                              Omitted (undefined) ⇒ byte-identical to the
 *                              pre-T-0623 fragment (no creator floor).
 */
export interface SandboxReadPredicateOptions {
  tierColumn: string;
  actorIsPrivileged: boolean;
  creatorEscape?: {
    ownerColumn: string;
    ownerParam: string;
  };
}

/**
 * SQL fragment returned by {@link sandboxReadPredicate}.
 *
 * @property sql     A boolean SQL expression intended to be appended to a query as
 *                   an additional `AND (<sql>)`. It is $-placeholder–FREE: a
 *                   privileged actor gets a tautology (`TRUE`), an unprivileged
 *                   actor gets `<tierColumn> = 'published'` with the tier value as
 *                   a SQL string literal. Because it carries no `$n` placeholders,
 *                   the caller's existing parameter indices are never shifted.
 * @property params  Always an empty array — present to keep the call site uniform
 *                   with parameterized-fragment patterns and to leave room for a
 *                   future parameterized variant without a signature change.
 */
export interface SandboxReadPredicate {
  sql: string;
  params: unknown[];
}

/**
 * Pure builder for the runtime read restriction a LIST query APPENDS as an extra
 * `AND`.
 *
 * - `actorIsPrivileged === true`  → NO restriction. Returns `{ sql: "TRUE", params: [] }`
 *   (a tautology: appending `AND (TRUE)` changes nothing). Privileged actors see
 *   every tier.
 * - `actorIsPrivileged === false` → restrict to published rows only. Returns
 *   `{ sql: "<tierColumn> = 'published'", params: [] }`.
 *
 * SECURITY NOTE on the tier value: 'published' is the `Tier` enum's published
 * value — a fixed code-level constant, NOT user input — so emitting it as a SQL
 * string literal is safe and keeps this fragment parameter-index-neutral. The
 * `tierColumn` identifier is likewise a TRUSTED caller constant (see
 * {@link SandboxReadPredicateOptions.tierColumn}); it MUST NOT be sourced from a
 * request. No value here is ever derived from user input.
 *
 * Usage (T-0558):
 *
 *   const pred = sandboxReadPredicate({ tierColumn: "a.tier", actorIsPrivileged });
 *   const sql  = `SELECT ... FROM choros.artifact a WHERE a.tenant_id = $1 AND (${pred.sql})`;
 *   //                                                                          ^ no index shift
 */
export function sandboxReadPredicate(
  opts: SandboxReadPredicateOptions,
): SandboxReadPredicate {
  if (opts.actorIsPrivileged) {
    // No restriction — privileged actors see drafts AND published.
    return { sql: "TRUE", params: [] };
  }
  // Restrict to the published tier. 'published' is the Tier enum constant, not
  // user input → safe as a SQL string literal; keeps the fragment $-free so the
  // caller's parameter indices stay intact.
  const publishedOnly = `${opts.tierColumn} = 'published'`;
  // T-0623 (столп-4): a non-privileged actor additionally keeps sight of the
  // rows they CREATED themselves — a draft-tier row of their own is not hidden
  // from them (create is not sandbox-gated, so hiding it on read would leave an
  // object invisible to its own author). This is strictly ADDITIVE (an OR with
  // the actor's own slug bound as a param) — it never reveals any OTHER actor's
  // draft row and never touches the tenant scope. Absent creatorEscape ⇒ the
  // exact pre-T-0623 published-only fragment.
  if (opts.creatorEscape !== undefined) {
    const { ownerColumn, ownerParam } = opts.creatorEscape;
    return { sql: `(${publishedOnly} OR ${ownerColumn} = ${ownerParam})`, params: [] };
  }
  return { sql: publishedOnly, params: [] };
}
