/* ============================================================================
   CHOROS — bpmn-user-tasks.js  (T-0665)

   Best-effort extraction of `userTask` id/name pairs from a BPMN XML string,
   for the FormDesigner step picker (F1/T-0665). NOT a BPMN-moddle integration
   (out of scope — see ADR-T0665 §3.1): a lightweight, dependency-free regex
   scan that works identically in the browser AND in the Node vitest tier
   (there is no DOMParser/jsdom in web/vitest.config.js's "node" environment —
   see bpmn-save-load.js's DOMParser try/catch for the analogous constraint).

   This is a SUGGESTION aid only: the step-key field in FormDesigner remains
   free text (same as FormBuilder.jsx's existing pattern) — a parse failure or
   an empty/malformed XML yields an empty suggestion list, never an error, and
   never blocks manual entry.

   Matches both namespaced (`<bpmn:userTask id="..." name="...">`) and
   unprefixed (`<userTask id="..." name="...">`) forms, self-closing or not,
   with id/name attributes in either order — real BPMN definitions deployed
   by this product use both conventions depending on which tool generated
   the XML (some declare a default `bpmn:` namespace, some do not).
   ============================================================================ */

/**
 * @typedef {{ id: string, name: string }} BpmnUserTask
 */

/** Decode the handful of XML entities that can legally appear in an attribute value. */
function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Matches an opening userTask tag (namespaced or not), capturing the full
// attribute string so id/name can be pulled regardless of their order.
// Non-greedy up to the first `>` — a userTask start tag never contains a
// literal `>` inside its attributes (XML attribute values cannot contain
// unescaped `>` per spec in practice for this generator's output).
const USER_TASK_TAG_RE = /<(?:[a-zA-Z0-9_]+:)?userTask\b([^>]*)>/g;
const ID_ATTR_RE = /\bid\s*=\s*"([^"]*)"/;
const NAME_ATTR_RE = /\bname\s*=\s*"([^"]*)"/;

/**
 * Extract { id, name } for every <userTask>/<bpmn:userTask> element in a BPMN
 * XML string. Best-effort: returns [] for empty/non-string/unparseable input
 * rather than throwing — callers use this to POPULATE a suggestion list next
 * to a free-text field, never as the sole path to set a value.
 *
 * @param {string} bpmnXml
 * @returns {BpmnUserTask[]} in document order; entries without an `id` are
 *   skipped (an id-less userTask cannot be a step-key candidate). `name`
 *   falls back to the `id` when absent (BPMN allows a task with no name).
 */
export function extractUserTasks(bpmnXml) {
  if (typeof bpmnXml !== 'string' || bpmnXml.length === 0) return [];
  const out = [];
  const seenIds = new Set();
  let match;
  USER_TASK_TAG_RE.lastIndex = 0;
  while ((match = USER_TASK_TAG_RE.exec(bpmnXml)) !== null) {
    const attrs = match[1] || '';
    const idMatch = ID_ATTR_RE.exec(attrs);
    if (!idMatch || !idMatch[1]) continue; // no id → not a usable step-key candidate
    const id = decodeXmlEntities(idMatch[1]);
    if (seenIds.has(id)) continue; // defensive: a malformed doc could repeat an id
    seenIds.add(id);
    const nameMatch = NAME_ATTR_RE.exec(attrs);
    const name = nameMatch && nameMatch[1] ? decodeXmlEntities(nameMatch[1]) : id;
    out.push({ id, name });
  }
  return out;
}
