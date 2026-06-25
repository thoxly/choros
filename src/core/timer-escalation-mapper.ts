/**
 * src/core/timer-escalation-mapper.ts — T-0458 [D8-R3]: timer/deadline → escalation wiring.
 *
 * Spec: docs/specs/process-element-runtime.spec.md §3.4 (R3).
 *
 *   «Boundary/intermediate timer на Flowable + проекция срабатывания. Связать с
 *    T-0432: таймаут шага/ожидания → эскалация (руководитель/овнер) с предзаполненной
 *    формой. Конфиг элемента: срок (длительность/дата) + действие при срабатывании
 *    (кому эскалация).»
 *
 * WHAT THIS MODULE DOES
 *   Pure XML→XML transform applied at save/publish time (the same seam as the lane
 *   mapper, T-0457). It does TWO things, both keyed off the typed config the timer
 *   properties panel writes onto a boundary/intermediate event:
 *
 *   1. MATERIALISE THE NATIVE TIMER BODY. The panel persists the deadline as the
 *      choros:timerDeadlineKind + choros:timerDeadline pair (an off-canvas, typed
 *      config). Flowable does NOT understand those attributes — it schedules a timer
 *      only from a native <timerEventDefinition> child carrying <timeDuration> /
 *      <timeDate> / <timeCycle>. This mapper INJECTS that native body so the published
 *      BPMN actually schedules the timer. (A timer the user configured but whose body
 *      was never written would silently never fire — the gap this closes.)
 *
 *      - kind="duration" → <timeDuration>PT24H</timeDuration>  (ISO-8601)
 *      - kind="date"     → <timeDate>2026-07-01T14:00:00Z</timeDate>  (fixed date)
 *      - kind="field"    → <timeDate>${record.<field>}</timeDate>  (date from a record
 *                          field, resolved at runtime — the "date from a record field"
 *                          case in the spec). The bare field key is wrapped as an EL
 *                          expression against the process `record` variable.
 *
 *      Idempotent: if the timerEventDefinition already carries a body child, it is left
 *      untouched (explicit hand-authored body wins; re-running is a no-op).
 *
 *   2. WIRE THE ESCALATION TARGET. choros:escalateTo on the timer event says WHOM to
 *      escalate to (manager / owner / a role slug). The escalation user-task is the
 *      node the timer's outgoing sequenceFlow points at. This mapper injects
 *      flowable:candidateGroups onto that target userTask so the firing projection
 *      (engine-drive reconcile in inbox.ts — T-0443/T-0456) surfaces the escalation as
 *      an inbox pool task addressed to the right role. "manager" / "owner" map to the
 *      conventional role slugs the executor-resolver understands.
 *
 *      Idempotent + author-wins: a target userTask that already declares
 *      candidateGroups is left untouched (explicit role or a lane binding wins).
 *
 * WHY A STRING MAPPER (not a moddle write)
 *   Mirrors lane-role-mapper.ts exactly: the BPMN round-trips through the modeler as
 *   raw XML; the publish path is a pure XML→XML pipeline (mapLanes → mapTimers → lint
 *   → deploy). Keeping this a string transform keeps it zero-dep, testable without a
 *   browser, and composable with the other mappers.
 *
 * DESIGN DISCIPLINE
 *   - Pure: no IO, no DB, no network. String-in / string-out.
 *   - Reads structure via the shared tokenizer (bpmn-xml-parser) so parsing is robust
 *     to attribute order / self-closing / whitespace.
 *   - Preserves the rest of the document (DI, namespaces, formatting) via targeted
 *     injection.
 *   - Degrades to a no-op on malformed XML (lintBpmn is the authoritative fail-closed
 *     gate for malformed documents).
 */

import { tokenize, type Attr } from "./bpmn-xml-parser.js";

// ---------------------------------------------------------------------------
// Escalation-target role slug convention (matches executor-resolver / inbox).
// "manager" and "owner" are the two structural escalation targets named in the
// spec (§3.4 / §4.5 process-execution-model). They map to the conventional role
// slugs the live system addresses pools by. Any other value is treated as an
// explicit role slug and passed through (slugified for safety).
// ---------------------------------------------------------------------------

/** Conventional role slug for "escalate to the manager" (the line manager pool). */
export const MANAGER_ROLE_SLUG = "role-manager";
/** Conventional role slug for "escalate to the owner" (the tenant/process owner). */
export const OWNER_ROLE_SLUG = "role-owner";

const CYRILLIC_MAP: Record<string, string> = {
  а: "a",  б: "b",  в: "v",  г: "g",  д: "d",
  е: "e",  ё: "e",  ж: "zh", з: "z",  и: "i",
  й: "y",  к: "k",  л: "l",  м: "m",  н: "n",
  о: "o",  п: "p",  р: "r",  с: "s",  т: "t",
  у: "u",  ф: "f",  х: "h",  ц: "ts", ч: "ch",
  ш: "sh", щ: "sch", ъ: "",  ы: "y",  ь: "",
  э: "e",  ю: "yu", я: "ya",
};

/** Slugify a free-text escalation role (Cyrillic-aware), mirroring lane-role-mapper. */
function slugifyRole(name: string): string {
  if (!name || !name.trim()) return "";
  return name
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => CYRILLIC_MAP[ch] ?? ch)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Resolve a choros:escalateTo value to the role slug the pool is addressed by.
 *   "manager" → role-manager · "owner" → role-owner · anything else → slugified role.
 * Returns "" for an empty/blank value (caller skips — no escalation role intent).
 */
export function resolveEscalationRole(escalateTo: string): string {
  const v = (escalateTo ?? "").trim();
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower === "manager") return MANAGER_ROLE_SLUG;
  if (lower === "owner") return OWNER_ROLE_SLUG;
  // Already a conventional slug (e.g. "role-approver") → pass through unchanged.
  if (/^[a-z0-9-]+$/.test(v)) return v;
  return slugifyRole(v);
}

// ---------------------------------------------------------------------------
// Timer body materialisation.
// ---------------------------------------------------------------------------

/** The native BPMN timer body element name for each deadline kind. */
type TimerBodyKind = "duration" | "date" | "field";

function timerBodyElement(kind: TimerBodyKind, value: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  switch (kind) {
    case "duration":
      // ISO-8601 duration (e.g. PT24H) — or an EL expression passed through.
      return `<timeDuration>${escapeXml(v)}</timeDuration>`;
    case "date":
      // Fixed ISO-8601 date — or an EL expression passed through.
      return `<timeDate>${escapeXml(v)}</timeDate>`;
    case "field":
      // Date pulled from a record field. A bare field key becomes an EL expression
      // against the process `record` variable; an already-EL value is passed through.
      return `<timeDate>${escapeXml(toRecordFieldExpression(v))}</timeDate>`;
    default:
      return null;
  }
}

/**
 * Wrap a record-field key into the EL expression Flowable resolves at runtime.
 * "dueDate" → "${record.dueDate}"; an already-wrapped "${...}" is passed through.
 */
export function toRecordFieldExpression(fieldKey: string): string {
  const v = (fieldKey ?? "").trim();
  if (!v) return v;
  if (v.startsWith("${")) return v; // already an EL expression
  // Strip a leading "record." the author may have typed, then re-prefix canonically.
  const bare = v.replace(/^record\./, "");
  return `\${record.${bare}}`;
}

/** Minimal XML-text escaper for injected body values. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Collected timer-event config (read during the token walk).
// ---------------------------------------------------------------------------

interface TimerEventConfig {
  /** Event element id ("" when absent — such an event cannot be wired). */
  id: string;
  /** boundary | intermediate (informational; both are wired identically here). */
  kind: "boundary" | "intermediate";
  /** choros:timerDeadlineKind: duration | date | field (default duration). */
  deadlineKind: TimerBodyKind;
  /** choros:timerDeadline value (interpreted per deadlineKind). */
  deadline: string;
  /** choros:escalateTo: manager | owner | role slug. */
  escalateTo: string;
  /** Whether the timerEventDefinition already has a body child (skip materialise). */
  hasBody: boolean;
}

/**
 * Extract the timer-event configs that need wiring from a BPMN document.
 * Reads choros:* attributes off boundary/intermediate events that carry a
 * timerEventDefinition, plus whether that definition already has a body child.
 * Pure — tokenizer-driven, no mutation.
 */
export function extractTimerConfigs(bpmnXml: string): TimerEventConfig[] {
  const configs: TimerEventConfig[] = [];
  let current: TimerEventConfig | null = null;
  let inTimerDef = false;

  for (const token of tokenize(bpmnXml)) {
    if (token.kind === "parse-error") break;

    if (token.kind === "open-tag" || token.kind === "self-close-tag") {
      const { localName, attrs } = token;
      if (localName === "boundaryEvent" || localName === "intermediateCatchEvent") {
        const id = attrs.find((a) => a.name === "id")?.value ?? "";
        const deadlineKind = parseDeadlineKind(attrs.find((a) => a.name === "timerDeadlineKind")?.value);
        const deadline = attrs.find((a) => a.name === "timerDeadline")?.value ?? "";
        const escalateTo = attrs.find((a) => a.name === "escalateTo")?.value ?? "";
        current = {
          id,
          kind: localName === "boundaryEvent" ? "boundary" : "intermediate",
          deadlineKind,
          deadline,
          escalateTo,
          hasBody: false,
        };
        // A self-closing event tag cannot host a timerEventDefinition → commit now
        // only if it has any config (it won't have a body). Such an event is malformed
        // (no timer def) and the linter will flag it; we still record nothing useful.
        if (token.kind === "self-close-tag") {
          current = null;
        }
      } else if (current !== null && localName === "timerEventDefinition") {
        inTimerDef = true;
        // A self-closing <timerEventDefinition/> has no body child.
        if (token.kind === "self-close-tag") inTimerDef = false;
      } else if (current !== null && inTimerDef && isTimerBodyChild(localName)) {
        current.hasBody = true;
      }
      continue;
    }

    if (token.kind === "close-tag") {
      if (current !== null && token.localName === "timerEventDefinition") {
        inTimerDef = false;
      } else if (
        current !== null &&
        (token.localName === "boundaryEvent" || token.localName === "intermediateCatchEvent")
      ) {
        configs.push(current);
        current = null;
        inTimerDef = false;
      }
      continue;
    }
  }

  return configs;
}

function parseDeadlineKind(v: string | undefined): TimerBodyKind {
  if (v === "date") return "date";
  if (v === "field") return "field";
  return "duration"; // default
}

function isTimerBodyChild(localName: string): boolean {
  return localName === "timeDuration" || localName === "timeDate" || localName === "timeCycle";
}

// ---------------------------------------------------------------------------
// Outgoing-flow resolution: timer event id → escalation target node id.
// ---------------------------------------------------------------------------

/** Build a map: sourceNodeId → first targetRef (the escalation target of a timer). */
function buildTimerTargets(bpmnXml: string): Map<string, string> {
  const targetBySource = new Map<string, string>();
  for (const token of tokenize(bpmnXml)) {
    if (token.kind === "parse-error") break;
    if (token.kind !== "open-tag" && token.kind !== "self-close-tag") continue;
    if (token.localName !== "sequenceFlow") continue;
    const src = token.attrs.find((a) => a.name === "sourceRef")?.value ?? "";
    const tgt = token.attrs.find((a) => a.name === "targetRef")?.value ?? "";
    if (src && tgt && !targetBySource.has(src)) targetBySource.set(src, tgt);
  }
  return targetBySource;
}

// ---------------------------------------------------------------------------
// Main transform.
// ---------------------------------------------------------------------------

/**
 * Wire timer deadlines + escalation for a BPMN document.
 *
 *   1. For every timer event configured with a deadline but whose
 *      timerEventDefinition has no body child, inject the native body
 *      (<timeDuration>/<timeDate>) so Flowable schedules it.
 *   2. For every timer event with a choros:escalateTo, inject
 *      flowable:candidateGroups onto the escalation-target userTask (the node the
 *      timer flows to) so the firing projection addresses the right pool.
 *
 * Pure — string in / string out. Idempotent and additive: existing bodies and
 * existing candidateGroups are preserved. A document with no configured timer
 * events is returned unchanged.
 */
export function mapTimerEscalation(bpmnXml: string): string {
  const configs = extractTimerConfigs(bpmnXml);
  if (configs.length === 0) return bpmnXml;

  const timerTargets = buildTimerTargets(bpmnXml);

  let result = bpmnXml;

  // Pass 1: materialise the native timer body for events missing one.
  for (const cfg of configs) {
    if (!cfg.id) continue;
    if (cfg.hasBody) continue; // explicit body wins
    const bodyEl = timerBodyElement(cfg.deadlineKind, cfg.deadline);
    if (bodyEl === null) continue; // no deadline configured → nothing to materialise
    result = injectTimerBody(result, cfg.id, bodyEl);
  }

  // Pass 2: wire escalation candidateGroups onto the timer's target userTask.
  for (const cfg of configs) {
    if (!cfg.id) continue;
    const roleSlug = resolveEscalationRole(cfg.escalateTo);
    if (!roleSlug) continue; // no escalation target configured
    const targetId = timerTargets.get(cfg.id);
    if (!targetId) continue; // timer leads nowhere (linter flags this separately)
    result = injectCandidateGroupsOnTask(result, targetId, roleSlug);
  }

  return result;
}

/**
 * Inject a native timer body element into the (empty) <timerEventDefinition> of the
 * timer event whose id equals `eventId`. Targets the FIRST timerEventDefinition that
 * appears after the event's open tag. Handles both an empty paired element
 * (<timerEventDefinition></timerEventDefinition>) and a self-closing one
 * (<timerEventDefinition/>). Pure string transform.
 */
function injectTimerBody(xml: string, eventId: string, bodyEl: string): string {
  const escId = escapeRegex(eventId);
  // Locate the event's open tag, then the next timerEventDefinition within its scope.
  // We match from the event open-tag id up to the timerEventDefinition and rewrite it.
  // 1) self-closing <timerEventDefinition/> → expand to carry the body.
  const selfCloseRe = new RegExp(
    `(<(?:boundaryEvent|intermediateCatchEvent)\\b[^>]*\\bid=["']${escId}["'][\\s\\S]*?<timerEventDefinition\\b[^>]*?)/>`,
  );
  if (selfCloseRe.test(xml)) {
    return xml.replace(selfCloseRe, (_full, head: string) => `${head}>${bodyEl}</timerEventDefinition>`);
  }
  // 2) empty paired <timerEventDefinition ...></timerEventDefinition> → insert body.
  const pairedRe = new RegExp(
    `(<(?:boundaryEvent|intermediateCatchEvent)\\b[^>]*\\bid=["']${escId}["'][\\s\\S]*?<timerEventDefinition\\b[^>]*?>)(\\s*)(</timerEventDefinition>)`,
  );
  return xml.replace(pairedRe, (_full, open: string, _ws: string, close: string) => `${open}${bodyEl}${close}`);
}

/** Does this task open-tag already declare a candidateGroups attribute? */
function hasCandidateGroups(attrs: Attr[]): boolean {
  return attrs.some((a) => a.name === "candidateGroups");
}

/**
 * Inject flowable:candidateGroups="<roleSlug>" onto the userTask whose id equals
 * `taskId`, unless it already declares candidateGroups (author / lane wins).
 * Only userTasks are wired — an escalation target must be a human pool task for the
 * inbox projection to address it. Pure string transform; idempotent.
 */
function injectCandidateGroupsOnTask(xml: string, taskId: string, roleSlug: string): string {
  // Verify the target is a userTask WITHOUT candidateGroups via the tokenizer first,
  // so we never inject onto a non-userTask (e.g. an endEvent the timer points at).
  let isUserTaskNeedingRole = false;
  for (const token of tokenize(xml)) {
    if (token.kind === "parse-error") break;
    if (token.kind !== "open-tag" && token.kind !== "self-close-tag") continue;
    if (token.localName !== "userTask") continue;
    const id = token.attrs.find((a) => a.name === "id")?.value;
    if (id !== taskId) continue;
    if (hasCandidateGroups(token.attrs)) return xml; // explicit role wins
    isUserTaskNeedingRole = true;
    break;
  }
  if (!isUserTaskNeedingRole) return xml;

  const escId = escapeRegex(taskId);
  const tagRe = new RegExp(`(<userTask\\b[^>]*\\bid=["']${escId}["'][^>]*?)(\\s*/?>)`);
  return xml.replace(tagRe, (full, body: string, close: string) => {
    if (/\bcandidateGroups=/.test(body)) return full;
    return `${body} flowable:candidateGroups="${roleSlug}"${close}`;
  });
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
