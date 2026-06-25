/**
 * src/core/lane-role-mapper.ts — T-0457 [D8-R2]: lane → role wiring.
 *
 * Spec: docs/specs/process-element-runtime.spec.md §3.3 (R2).
 *
 *   «Capability исполняется — нужен визуал. Завайрить laneSet/lane ↔
 *    candidateGroups задач внутри неё: положил userTask в дорожку «Бухгалтер» →
 *    candidateGroups=role:бухгалтер. Резолв уже есть (executor-resolver).»
 *
 * WHAT THIS MODULE DOES
 *   Pure XML→XML transformation applied at save/publish time. It reads the BPMN
 *   `<laneSet>/<lane>` structure (visual swimlanes the user drew in the modeler)
 *   and, for every `<userTask>` whose id is referenced by a lane's `<flowNodeRef>`,
 *   injects `flowable:candidateGroups="<role-slug>"` derived from the lane's name.
 *
 *   This is the AUTHORING→MODEL wiring. The runtime side is already built:
 *   `executor-resolver.ts` consumes candidateGroups (the role slug) and resolves
 *   it against the live org structure (role_assignment JOIN employee). A userTask
 *   sitting in lane «Бухгалтер» therefore reaches whoever holds that role.
 *
 * ROLE-SLUG CONVENTION (matches the live system, NOT the spec's literal example)
 *   The spec illustrates the binding as `candidateGroups=role:бухгалтер`, but the
 *   ACTUAL convention consumed by executor-resolver / inbox / the deploy-time
 *   `candidategroups-role-slug-linter.sh` is a BARE role slug (e.g. the seeded
 *   processes use `role-approver`, `role-initiator`, `vendor-admin`). A literal
 *   `role:` prefix would never match a `role.slug`, so the task would silently
 *   miss its pool. We therefore slugify the lane NAME into the same slug shape the
 *   resolver matches (Cyrillic-aware: «Бухгалтер» → "buhgalter").
 *
 * PRECEDENCE (explicit author intent wins)
 *   If a userTask ALREADY carries a candidateGroups attribute (the properties
 *   panel let the author set a role directly, T-0325), we DO NOT overwrite it —
 *   the explicit value is authoritative. The lane only fills the gap for tasks
 *   that have no role yet. This keeps lane-based and panel-based role assignment
 *   composable and idempotent (re-running the mapper is a no-op).
 *
 * DESIGN DISCIPLINE
 *   - Pure: no IO, no DB, no network. String-in / string-out.
 *   - Preserves the whole document (including bpmndi DI, namespaces, formatting)
 *     by doing targeted attribute injection on the userTask open-tags only.
 *   - Reads structure via the shared tokenizer (bpmn-xml-parser) so lane parsing
 *     is robust to attribute order / self-closing / whitespace.
 *   - Idempotent: a userTask that already has candidateGroups is left untouched.
 *   - Lanes with a blank/whitespace-only name produce NO binding (a nameless lane
 *     carries no role intent).
 */

import { tokenize, type Attr } from "./bpmn-xml-parser.js";

// ---------------------------------------------------------------------------
// Cyrillic transliteration (mirrors slugify-process-key.ts — duplicated to keep
// this module zero-dep and avoid a cross-module import cycle).
// ---------------------------------------------------------------------------

const CYRILLIC_MAP: Record<string, string> = {
  а: "a",  б: "b",  в: "v",  г: "g",  д: "d",
  е: "e",  ё: "e",  ж: "zh", з: "z",  и: "i",
  й: "y",  к: "k",  л: "l",  м: "m",  н: "n",
  о: "o",  п: "p",  р: "r",  с: "s",  т: "t",
  у: "u",  ф: "f",  х: "h",  ц: "ts", ч: "ch",
  ш: "sh", щ: "sch", ъ: "",  ы: "y",  ь: "",
  э: "e",  ю: "yu", я: "ya",
};

const ROLE_SLUG_MAX = 60;

/**
 * Pure: derive a role-pool slug from a lane name.
 * «Бухгалтер» → "buhgalter"; "Finance Team" → "finance-team".
 * Returns "" for a blank/whitespace-only name (caller skips empty slugs).
 */
export function slugifyLaneRole(laneName: string): string {
  if (!laneName || !laneName.trim()) return "";
  const slug = laneName
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => CYRILLIC_MAP[ch] ?? ch)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, ROLE_SLUG_MAX);
}

// ---------------------------------------------------------------------------
// Lane structure extraction
// ---------------------------------------------------------------------------

/**
 * One resolved lane → role binding: a flow-node id and the role slug derived
 * from the lane that contains it.
 */
export interface LaneRoleBinding {
  /** id of the flow node (userTask) referenced by the lane's flowNodeRef. */
  readonly flowNodeId: string;
  /** the lane's display name (raw). */
  readonly laneName: string;
  /** the role slug derived from the lane name (slugifyLaneRole). */
  readonly roleSlug: string;
}

/**
 * Extract the lane→flow-node bindings from a BPMN XML document.
 *
 * Walks `<lane name="…"> <flowNodeRef>nodeId</flowNodeRef> … </lane>` structures
 * (inside any `<laneSet>`). Each flowNodeRef text becomes a binding to the
 * containing lane's role slug.
 *
 * Pure — reads via the tokenizer, no mutation. Lanes without a usable role slug
 * (blank name) are skipped. If a flow node appears in multiple lanes (malformed),
 * the FIRST lane wins (deterministic).
 */
export function extractLaneRoleBindings(bpmnXml: string): LaneRoleBinding[] {
  const bindings: LaneRoleBinding[] = [];
  const seenNodes = new Set<string>();

  // State while walking: the lane we're currently inside (name + slug), and
  // whether we're collecting text for a <flowNodeRef> element.
  let currentLaneName: string | null = null;
  let currentRoleSlug = "";
  let inFlowNodeRef = false;
  let flowNodeRefBuffer = "";

  for (const token of tokenize(bpmnXml)) {
    if (token.kind === "parse-error") {
      // Malformed XML — return whatever bindings were collected so far.
      // The publish-time linter (lintBpmn) is the authoritative fail-closed gate
      // for malformed documents; this mapper degrades to a no-op rather than throw.
      break;
    }

    if (token.kind === "open-tag" || token.kind === "self-close-tag") {
      const { localName, attrs } = token;

      if (localName === "lane") {
        const nameAttr = attrs.find((a) => a.name === "name");
        currentLaneName = nameAttr?.value ?? "";
        currentRoleSlug = slugifyLaneRole(currentLaneName);
      } else if (localName === "flowNodeRef" && token.kind === "open-tag") {
        inFlowNodeRef = true;
        flowNodeRefBuffer = "";
      }
      continue;
    }

    if (token.kind === "text") {
      if (inFlowNodeRef) flowNodeRefBuffer += token.value;
      continue;
    }

    if (token.kind === "close-tag") {
      if (token.localName === "flowNodeRef" && inFlowNodeRef) {
        inFlowNodeRef = false;
        const nodeId = flowNodeRefBuffer.trim();
        if (
          nodeId &&
          currentRoleSlug &&
          currentLaneName !== null &&
          !seenNodes.has(nodeId)
        ) {
          seenNodes.add(nodeId);
          bindings.push({
            flowNodeId: nodeId,
            laneName: currentLaneName,
            roleSlug: currentRoleSlug,
          });
        }
        flowNodeRefBuffer = "";
      } else if (token.localName === "lane") {
        currentLaneName = null;
        currentRoleSlug = "";
      }
      continue;
    }
  }

  return bindings;
}

// ---------------------------------------------------------------------------
// userTask attribute injection
// ---------------------------------------------------------------------------

/** Does this userTask open-tag already declare a candidateGroups attribute? */
function hasCandidateGroups(attrs: Attr[]): boolean {
  return attrs.some((a) => a.name === "candidateGroups");
}

/**
 * Map BPMN swimlanes to userTask candidateGroups.
 *
 * For every `<userTask id="X">` whose id is referenced by a named lane, and which
 * does NOT already carry a candidateGroups attribute, inject
 * `flowable:candidateGroups="<lane-role-slug>"` into its open tag.
 *
 * @param bpmnXml  the BPMN 2.0 XML (modeler save output)
 * @returns        the transformed XML (or the input unchanged when no lane binds
 *                 any role-less userTask). Pure — string in / string out.
 *
 * Idempotent: userTasks that already have candidateGroups (panel-assigned role or
 * a previous run of this mapper) are left untouched.
 */
export function mapLanesToCandidateGroups(bpmnXml: string): string {
  const bindings = extractLaneRoleBindings(bpmnXml);
  if (bindings.length === 0) return bpmnXml;

  // Index bindings by flow-node id for O(1) lookup during the rewrite walk.
  const roleByNodeId = new Map<string, string>();
  for (const b of bindings) roleByNodeId.set(b.flowNodeId, b.roleSlug);

  // Determine which userTask ids actually NEED injection: in a lane, role-less.
  // We re-walk with the tokenizer to find each userTask, then inject by id via a
  // targeted regex on the raw string (preserving the rest of the document).
  const needsInjection = new Map<string, string>(); // userTaskId → roleSlug

  for (const token of tokenize(bpmnXml)) {
    if (token.kind === "parse-error") break;
    if (token.kind !== "open-tag" && token.kind !== "self-close-tag") continue;
    if (token.localName !== "userTask") continue;

    const idAttr = token.attrs.find((a) => a.name === "id");
    const id = idAttr?.value;
    if (!id) continue;

    const role = roleByNodeId.get(id);
    if (!role) continue; // not in a (named) lane
    if (hasCandidateGroups(token.attrs)) continue; // explicit role wins

    needsInjection.set(id, role);
  }

  if (needsInjection.size === 0) return bpmnXml;

  // Targeted injection: for each userTask id needing a role, find its opening
  // tag in the raw XML and add flowable:candidateGroups before the closing
  // ">" or "/>" of that start-tag. We match the specific id to avoid touching
  // any other element.
  let result = bpmnXml;
  for (const [userTaskId, roleSlug] of needsInjection) {
    result = injectCandidateGroups(result, userTaskId, roleSlug);
  }
  return result;
}

/**
 * Inject `flowable:candidateGroups="<roleSlug>"` into the opening `<userTask …>`
 * tag whose id attribute equals `userTaskId`. Operates on the raw string so the
 * document (DI, namespaces, formatting) is otherwise byte-preserved.
 *
 * Matches the start-tag `<userTask … id="userTaskId" … >` (or self-closing) and
 * inserts the attribute just before the tag's closing delimiter. Pure.
 */
function injectCandidateGroups(
  xml: string,
  userTaskId: string,
  roleSlug: string,
): string {
  // Match an opening <userTask ...> start tag that contains id="<userTaskId>"
  // (single OR double quoted) and capture up to its closing delimiter.
  // [^>]* keeps the match within a single tag (no '>' allowed inside).
  const escapedId = escapeRegex(userTaskId);
  const tagRe = new RegExp(
    // group 1: the tag body up to (but not including) the closing delimiter
    // group 2: the closing delimiter — "/>" (self-close) or ">"
    `(<userTask\\b[^>]*\\bid=["']${escapedId}["'][^>]*?)(\\s*/?>)`,
  );
  return xml.replace(tagRe, (full, body: string, close: string) => {
    // Defensive: if a candidateGroups attr is somehow already present in this
    // exact tag body, do not double-inject.
    if (/\bcandidateGroups=/.test(body)) return full;
    return `${body} flowable:candidateGroups="${roleSlug}"${close}`;
  });
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
