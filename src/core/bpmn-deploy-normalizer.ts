/**
 * src/core/bpmn-deploy-normalizer.ts — T-0505: normalize modeler BPMN for Flowable deploy.
 *
 * PROBLEM (two confirmed root causes preventing publish→run):
 *
 *   4a. The bpmn-js modeler templates emit `<process … isExecutable="false">`
 *       (screen-process-editor.jsx / bpmn-modeler-wrapper.jsx). Flowable returns
 *       HTTP 500 when asked to deploy a non-executable process; flowable-client
 *       maps any 5xx to ENGINE_UNAVAILABLE → the user sees a misleading «движок
 *       недоступен» instead of «this process is not runnable».
 *
 *   4b. The choros `process_key` is a slug derived from the process NAME
 *       (slugify-process-key.ts), e.g. "novyy-protsess". The BPMN `<process id>`
 *       is whatever bpmn-js minted (e.g. "Process_1" / "Process_new"). Flowable
 *       indexes deployed definitions by `<process id>`, but `startInstance` sends
 *       the choros slug as `processDefinitionKey` → Flowable can't find it → start
 *       fails. The two identifiers are unrelated.
 *
 * FIX (single robust chokepoint, called right before flowable.deployBpmn):
 *   normalizeBpmnForDeploy(xml, processKey) rewrites the BPMN string so that:
 *     1. The executable `<process …>` element carries isExecutable="true"
 *        (rewrite false→true, or add the attribute when missing).
 *     2. The `<process id="…">` equals the choros processKey.
 *     3. The BPMNDI plane that references that process via
 *        `<bpmndi:BPMNPlane … bpmnElement="<oldId>">` is updated to the SAME new
 *        id — otherwise the diagram dangles and Flowable may reject the deploy.
 *
 * DESIGN DISCIPLINE (mirrors lane-role-mapper.ts / timer-escalation-mapper.ts):
 *   - Pure: no IO, no DB, no network. String in / string out.
 *   - Structure is READ via the shared fail-closed tokenizer (bpmn-xml-parser),
 *     so we are robust to attribute order / self-closing / whitespace and never
 *     guess. The actual rewrite is a TARGETED string transform on the specific
 *     `<process>` start-tag and its matching `<bpmndi:BPMNPlane>` start-tag, so
 *     the rest of the document (DI, namespaces, formatting) is byte-preserved.
 *   - Degrades to a no-op on malformed XML: the publish-time linter (lintBpmn)
 *     is the authoritative fail-closed gate; this normalizer must never throw on
 *     content the linter has already (or will) reject.
 *   - Handles the common single-`<process>` case robustly. If multiple processes
 *     are present we normalize the FIRST executable process (deterministic), and
 *     fall back to the first process when none is marked executable.
 */

import { tokenize } from "./bpmn-xml-parser.js";

/**
 * Result of scanning the document for the process element to normalize.
 */
interface ProcessTarget {
  /** the current `id` attribute value of the chosen <process> (may be ""). */
  readonly oldId: string;
  /** whether the chosen <process> already declares an isExecutable attribute. */
  readonly hasIsExecutable: boolean;
}

/**
 * Locate the `<process>` element to normalize and its current id.
 *
 * Selection rule (deterministic):
 *   - Prefer the FIRST process whose isExecutable is NOT "false" (i.e. true,
 *     missing, or any non-"false" value) — that is the runnable one.
 *   - If every process is explicitly isExecutable="false", fall back to the
 *     FIRST process (we are about to flip it to true anyway).
 *
 * Returns null when there is no <process> element (nothing to normalize) or the
 * document is malformed (tokenizer parse-error) — caller treats either as no-op.
 */
function findProcessTarget(bpmnXml: string): ProcessTarget | null {
  let firstProcess: ProcessTarget | null = null;
  let firstExecutable: ProcessTarget | null = null;

  for (const token of tokenize(bpmnXml)) {
    if (token.kind === "parse-error") {
      // Malformed — let the linter own the rejection; we no-op.
      return null;
    }
    if (token.kind !== "open-tag" && token.kind !== "self-close-tag") continue;
    if (token.localName !== "process") continue;

    const idAttr = token.attrs.find((a) => a.name === "id");
    const execAttr = token.attrs.find((a) => a.name === "isExecutable");
    const target: ProcessTarget = {
      oldId: idAttr?.value ?? "",
      hasIsExecutable: execAttr !== undefined,
    };

    if (firstProcess === null) firstProcess = target;

    const isExecutableFalse =
      execAttr !== undefined && execAttr.value.trim().toLowerCase() === "false";
    if (!isExecutableFalse && firstExecutable === null) {
      firstExecutable = target;
    }
  }

  return firstExecutable ?? firstProcess;
}

/**
 * Normalize a modeler-produced BPMN XML string so Flowable can deploy AND start it.
 *
 * @param bpmnXml     the BPMN 2.0 XML (modeler save output / persisted draft)
 * @param processKey  the choros process_key the start path will send to Flowable
 * @returns           the transformed XML (or the input unchanged when there is no
 *                    process element to fix, or the document is malformed). Pure.
 *
 * Idempotent: a document already carrying isExecutable="true" and the right
 * `<process id>` (+ matching BPMNPlane bpmnElement) is returned effectively
 * unchanged.
 */
export function normalizeBpmnForDeploy(bpmnXml: string, processKey: string): string {
  if (typeof bpmnXml !== "string" || bpmnXml.length === 0) return bpmnXml;

  const target = findProcessTarget(bpmnXml);
  if (target === null) return bpmnXml;

  let result = bpmnXml;

  // (1)+(2): rewrite the chosen <process> start-tag — set id=processKey and
  // force isExecutable="true". We match the specific start-tag by its current id
  // when it has one (precise), otherwise the first <process> open-tag.
  result = rewriteProcessTag(result, target, processKey);

  // (3): the BPMNDI plane references the process id via bpmnElement="<oldId>".
  // Re-point it to the new id so the diagram still resolves. Only meaningful when
  // the id actually changed and the old id was non-empty.
  if (target.oldId && target.oldId !== processKey) {
    result = rewritePlaneBpmnElement(result, target.oldId, processKey);
  }

  return result;
}

/**
 * Rewrite the chosen `<process …>` opening tag: ensure id="<processKey>" and
 * isExecutable="true". Operates on the raw string (byte-preserves the rest).
 */
function rewriteProcessTag(
  xml: string,
  target: ProcessTarget,
  processKey: string,
): string {
  // Build a matcher for the specific <process …> start-tag. When the element has
  // a current id we anchor on id="<oldId>" so we touch exactly that tag; when it
  // has no id we match the first <process …> start-tag.
  // [^>]* keeps the match inside a single tag (no '>' allowed within).
  const tagRe = target.oldId
    ? new RegExp(
        `(<(?:\\w+:)?process\\b[^>]*?\\bid=["']${escapeRegex(target.oldId)}["'][^>]*?)(\\s*/?>)`,
      )
    : new RegExp(`(<(?:\\w+:)?process\\b[^>]*?)(\\s*/?>)`);

  let replaced = false;
  const out = xml.replace(tagRe, (full, body: string, close: string) => {
    if (replaced) return full; // only the first matching process
    replaced = true;
    let newBody = body;

    // Force id="<processKey>".
    if (/\bid=["'][^"']*["']/.test(newBody)) {
      newBody = newBody.replace(/\bid=["'][^"']*["']/, `id="${processKey}"`);
    } else {
      // No id at all — insert one right after the element name.
      newBody = newBody.replace(
        /^(<(?:\w+:)?process\b)/,
        `$1 id="${processKey}"`,
      );
    }

    // Force isExecutable="true".
    if (/\bisExecutable=["'][^"']*["']/.test(newBody)) {
      newBody = newBody.replace(
        /\bisExecutable=["'][^"']*["']/,
        `isExecutable="true"`,
      );
    } else {
      newBody = `${newBody} isExecutable="true"`;
    }

    return `${newBody}${close}`;
  });

  return out;
}

/**
 * Re-point the BPMNDI plane: rewrite `bpmnElement="<oldId>"` → the new id on the
 * `<bpmndi:BPMNPlane …>` element that references the process. Only the plane that
 * targets the OLD process id is touched (matched by value), so other bpmnElement
 * references (shapes for tasks/events) are left intact.
 */
function rewritePlaneBpmnElement(
  xml: string,
  oldId: string,
  newId: string,
): string {
  const escapedOld = escapeRegex(oldId);
  // Match a <…BPMNPlane …> start-tag carrying bpmnElement="<oldId>" and rewrite
  // just that attribute. The plane is the only DI element whose bpmnElement is the
  // process id (shapes/edges reference flow-node ids, which differ), but we scope
  // to BPMNPlane to be safe.
  const planeRe = new RegExp(
    `(<(?:\\w+:)?BPMNPlane\\b[^>]*?\\bbpmnElement=["'])${escapedOld}(["'])`,
  );
  return xml.replace(planeRe, (_full, pre: string, post: string) => {
    return `${pre}${newId}${post}`;
  });
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
