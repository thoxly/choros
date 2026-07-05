/**
 * src/core/user-task-role-mapper.ts — T-0642 [столп1/P0]: userTask assignedRoleId → candidateGroups.
 *
 * LIVE_PROOF T-0588 wiring gap:
 *   The properties panel lets an author pick a "Назначенная роль" for ANY task
 *   element (bpmn-properties-panel.jsx — the «Назначение» PanelGroup renders for
 *   every `isTask` element, not just agentTask). It writes `choros:assignedRoleId`
 *   — the role's UUID (`role.id`, sourced from GET /api/org/tenant-state → roles[].id,
 *   T-0325) — onto the element's moddle extension (extends bpmn:Activity, so both
 *   userTask and serviceTask/agentTask inherit the attribute).
 *
 *   Two OTHER publish-transform mappers already translate an authored role intent
 *   into `flowable:candidateGroups` for a userTask:
 *     - lane-role-mapper.ts (T-0457): lane NAME → slugified role slug.
 *     - timer-escalation-mapper.ts (T-0458): choros:escalateTo (already a role
 *       SLUG string) → candidateGroups on the escalation-target userTask.
 *   Neither reads `choros:assignedRoleId`. agent-task-external-mapper.ts (T-0460)
 *   DOES read `choros:assignedRoleId` — but only off a `<serviceTask
 *   executorType="agent">`, and threads it as the dispatcher's `roleId` extension
 *   field (gate B criticality check, role-criticality.ts), NEVER as candidateGroups.
 *
 *   Net effect: a plain userTask with a panel-assigned role publishes WITHOUT any
 *   candidateGroups — Flowable creates the task in an empty pool. It never reaches
 *   an inbox; the process silently hangs. The panel implies "role assigned", the
 *   publish succeeds (200), but nothing routes.
 *
 * THE FIX (this module)
 *   For every `<userTask>` carrying `choros:assignedRoleId` and NOT already
 *   carrying `candidateGroups` (explicit author / lane / timer-escalation value
 *   wins — same precedence discipline as the other two mappers), resolve the role
 *   UUID to its slug and inject `flowable:candidateGroups="<slug>"`.
 *
 * WHY A UUID→SLUG RESOLUTION IS REQUIRED (not a pure string transform alone)
 *   `choros:assignedRoleId` is the role's UUID (`role.id`). Every consumer of
 *   `candidateGroups` — executor-resolver.ts::resolveExecutor (`roleSlug` param,
 *   documented "the role the step is addressed to (candidateGroups, from BPMN)"),
 *   grants-dao.ts::getHoldersForRole (`WHERE r.slug = $2`), inbox.ts (reads
 *   candidateGroups[0] off the live engine task and passes it VERBATIM as
 *   roleSlug) — matches by SLUG, never by UUID. Writing the raw UUID into
 *   candidateGroups would resolve to an always-empty pool (fallback to tenant
 *   owner), which is the exact bug this task fixes, just relocated. Unlike the
 *   pure lane/timer mappers (which derive a slug from XML text alone), this one
 *   needs a DB read (`choros.role` — has both `id` uuid and `slug` text, migration
 *   019_role.sql) — so the pure transform below takes the resolution as an
 *   INJECTED PORT (`resolveRoleSlug`), keeping the string-rewrite logic testable
 *   without a DB while the caller (publishProcessByKey) wires the real DB-backed
 *   resolver — same pattern as executor-resolver.ts's RoleHolderSource port.
 *
 * PUBLISH-TIME ONLY (not draft-save)
 *   Because resolution needs IO, this mapper cannot run in the pure draft-save
 *   pipeline (mapLanesToCandidateGroups / mapTimerEscalation, which run at POST
 *   /api/process-defs and persist their output). It runs in publishProcessByKey,
 *   on the local `publishXml` variable — mirroring mapAgentTaskToExternal (T-0635):
 *   never persisted back to `bpmn_xml`, so the draft the modeler re-opens is
 *   untouched (`choros:assignedRoleId` stays the author's UUID attribute).
 *
 * PRECEDENCE (explicit value wins — matches lane-role-mapper / timer-escalation-mapper)
 *   A userTask that ALREADY carries candidateGroups (author set it directly, or a
 *   prior mapper in the chain — lane/timer — already wired it) is left untouched.
 *
 * DEGRADATION (non-blocking — unlike the agentRef executor-resolution gate)
 *   If `resolveRoleSlug` returns null (role deleted / never existed / cross-tenant
 *   UUID collision), the userTask is left WITHOUT candidateGroups. This does not
 *   fail publish — buildUnfilledRoleWarnings (process-defs.ts) already warns
 *   (never blocks) when a written candidateGroups slug has no confirmed holders;
 *   an unresolvable role is a step further back in the same non-blocking spirit.
 *
 * DESIGN DISCIPLINE
 *   - The string-rewrite core (extractUserTaskRoleRefs, injectCandidateGroups) is
 *     pure: no IO, no DB, no network.
 *   - mapUserTaskRoleToCandidateGroups is async (awaits the injected resolver) but
 *     performs no IO of its OWN — the port is the only IO surface, exactly like
 *     executor-resolver.ts's resolveExecutor.
 *   - Idempotent: a userTask already carrying candidateGroups is never touched;
 *     re-running with the same resolver is a no-op (f(f(x))==f(x)).
 *   - Additive: a diagram with no assignedRoleId-carrying, candidateGroups-less
 *     userTask is returned byte-identical; the resolver is never called in that case.
 *   - Reuses ensureFlowableNamespace (agent-task-external-mapper.ts, T-0635) rather
 *     than duplicating the xmlns:flowable guard.
 */

import { tokenize, type Attr } from "./bpmn-xml-parser.js";
import { ensureFlowableNamespace } from "./agent-task-external-mapper.js";

// ---------------------------------------------------------------------------
// Extraction — which userTasks need resolution.
// ---------------------------------------------------------------------------

/** One userTask that carries an (unresolved) role reference needing candidateGroups. */
export interface UserTaskRoleRef {
  /** userTask/@id ("" is skipped by the caller — cannot target an id-less tag). */
  readonly userTaskId: string;
  /** choros:assignedRoleId — the role UUID (role.id) authored via the panel. */
  readonly roleId: string;
}

/** Does this task open-tag already declare a candidateGroups attribute? */
function hasCandidateGroups(attrs: Attr[]): boolean {
  return attrs.some((a) => a.name === "candidateGroups");
}

/** Read an attribute's value by local name, or "" when absent. */
function attrFor(attrs: Attr[], name: string): string {
  return attrs.find((a) => a.name === name)?.value ?? "";
}

/**
 * Extract every `<userTask>` that carries a non-empty `choros:assignedRoleId`
 * AND does not already carry `candidateGroups` (explicit/lane/timer wins).
 *
 * Pure — tokenizer-driven, no mutation. Degrades to whatever was collected on a
 * parse error (lintBpmn is the authoritative fail-closed gate for malformed XML).
 */
export function extractUserTaskRoleRefs(bpmnXml: string): UserTaskRoleRef[] {
  const refs: UserTaskRoleRef[] = [];

  for (const token of tokenize(bpmnXml)) {
    if (token.kind === "parse-error") break;
    if (token.kind !== "open-tag" && token.kind !== "self-close-tag") continue;
    if (token.localName !== "userTask") continue;

    const { attrs } = token;
    if (hasCandidateGroups(attrs)) continue; // explicit/lane/timer value wins

    const roleId = attrFor(attrs, "assignedRoleId");
    if (!roleId.trim()) continue; // no role assigned via the panel

    const userTaskId = attrFor(attrs, "id");
    if (!userTaskId) continue; // an id-less userTask cannot be targeted

    refs.push({ userTaskId, roleId: roleId.trim() });
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Injected resolution port — DB-backed in production (process-defs.ts wiring),
// in-memory in tests. Mirrors executor-resolver.ts's RoleHolderSource shape.
// ---------------------------------------------------------------------------

/**
 * Resolve a role UUID (role.id) to its slug within the publishing tenant.
 * Returns null when the id does not resolve (deleted / never existed /
 * cross-tenant) — the caller degrades by leaving that userTask unrouted rather
 * than failing publish.
 */
export type ResolveRoleSlug = (roleId: string) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Main transform.
// ---------------------------------------------------------------------------

/**
 * Map every panel-assigned userTask role (choros:assignedRoleId, a UUID) to
 * `flowable:candidateGroups="<slug>"`, resolving the UUID via the injected port.
 *
 * Pure aside from the injected `resolveRoleSlug` IO. Idempotent and additive:
 * a userTask already carrying candidateGroups, or with no assignedRoleId, is
 * left untouched; a diagram with nothing to resolve returns the input unchanged
 * WITHOUT calling the resolver at all.
 *
 * @param bpmnXml         the BPMN 2.0 XML (after the lane + timer + agent-task
 *                        mappers in the publish chain — order does not matter
 *                        for correctness since this only targets bare userTasks
 *                        without candidateGroups, but it runs after those in
 *                        publishProcessByKey for consistency with the rest of
 *                        the pipeline).
 * @param resolveRoleSlug DB-backed (or in-memory, for tests) role.id → role.slug
 *                        lookup, scoped to the publishing tenant by the caller.
 * @returns               the transformed XML, or the input unchanged when no
 *                         userTask needs resolution.
 */
export async function mapUserTaskRoleToCandidateGroups(
  bpmnXml: string,
  resolveRoleSlug: ResolveRoleSlug,
): Promise<string> {
  const refs = extractUserTaskRoleRefs(bpmnXml);
  if (refs.length === 0) return bpmnXml;

  let result = bpmnXml;
  let wired = false;

  for (const ref of refs) {
    const slug = await resolveRoleSlug(ref.roleId);
    if (!slug) continue; // unresolvable role — degrade, leave unrouted (non-blocking)
    result = injectCandidateGroups(result, ref.userTaskId, slug);
    wired = true;
  }

  // Only guarantee xmlns:flowable when this call actually emitted new
  // flowable:* content — additive, matches agent-task-external-mapper.ts (T-0635).
  if (wired) {
    result = ensureFlowableNamespace(result);
  }

  return result;
}

/**
 * Inject `flowable:candidateGroups="<roleSlug>"` into the opening `<userTask …>`
 * tag whose id attribute equals `userTaskId`. Operates on the raw string so the
 * document (DI, namespaces, formatting) is otherwise byte-preserved. Mirrors
 * lane-role-mapper.ts::injectCandidateGroups exactly.
 */
function injectCandidateGroups(
  xml: string,
  userTaskId: string,
  roleSlug: string,
): string {
  const escapedId = escapeRegex(userTaskId);
  const tagRe = new RegExp(
    `(<userTask\\b[^>]*\\bid=["']${escapedId}["'][^>]*?)(\\s*/?>)`,
  );
  return xml.replace(tagRe, (full, body: string, close: string) => {
    // Defensive: if candidateGroups somehow already present in this exact tag
    // body (should not happen — extractUserTaskRoleRefs already filtered), skip.
    if (/\bcandidateGroups=/.test(body)) return full;
    return `${body} flowable:candidateGroups="${roleSlug}"${close}`;
  });
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
