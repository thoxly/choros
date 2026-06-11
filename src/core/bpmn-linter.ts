/**
 * T-0027: BPMN Deploy-time Linter — Library
 *
 * Pure function. No I/O. No network. No DB.
 *
 * @deploy-gate-contract
 * Returns { ok: true } iff the BPMN XML contains no raw-object bindings and is
 * well-formed per the linter's whitelist parser.
 *
 * T-0058/T-0064 MUST call lintBpmn() before accepting any BPMN deploy request
 * and MUST reject with HTTP 422 if ok: false.
 * See docs/design/T-0027-bpmn-linter-deploy-contract.md.
 */

import { tokenize } from "./bpmn-xml-parser.js";
import type { Attr } from "./bpmn-xml-parser.js";
import { parseHandle } from "./object-handle.js";
import {
  checkBindingCompat,
  KEY_RE,
  type BindingField,
} from "./binding-compat.js";

// ---------------------------------------------------------------------------
// Exported types (frozen public surface — T-0058/T-0064 wire against this)
// ---------------------------------------------------------------------------

// T-0072: "binding_mismatch" added additively (NF-4 / AC-13 — no existing tests broken).
export type LintViolationType = "raw_object_binding" | "malformed_xml" | "binding_mismatch";

export interface LintViolation {
  type: LintViolationType;
  elementId: string; // BPMN element id attribute, or "" if absent
  elementKind: string; // "serviceTask" | "userTask" | "sendTask" | "conditionExpression" | "dataObject" | "dataObjectReference" | "malformed_xml"
  message: string;
}

export type LintResult =
  | { ok: true }
  | { ok: false; violations: LintViolation[] };

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ScanContext {
  elementKind: string;
  elementId: string;
  inExtension: boolean;
  isConditionExpression: boolean;
  isDataObject: boolean;
  textBuffer: string;
}

// ---------------------------------------------------------------------------
// Scoped element names
// ---------------------------------------------------------------------------

/** Element local names that carry binding sites we must scan. */
const SCOPED_ELEMENTS = new Set([
  "serviceTask",
  "userTask",
  "sendTask",
  "conditionExpression",
  "dataObject",
  "dataObjectReference",
]);

/** Extension element local names that mark the binding zone inside a scoped task. */
const EXTENSION_CONTAINER_NAMES = new Set([
  "extensionElements",
  // Flowable / Camunda / Activiti extension sub-elements
  "field",
  "in",
  "out",
  "executionListener",
  "taskListener",
  "properties",
  "property",
  "formProperty",
  "formField",
]);

// ---------------------------------------------------------------------------
// Record-identity / payload keys (ADR §2.3)
// ---------------------------------------------------------------------------

const RAW_OBJECT_KEYS = new Set([
  "registryId",
  "recordId",
  "applicationId",
  "data",
  "fields",
  "payload",
  "view",
]);

// ---------------------------------------------------------------------------
// Raw-object detector (ADR §2.3 pipeline)
// ---------------------------------------------------------------------------

/**
 * Determines whether a candidate string value represents a raw-object binding.
 *
 * Pipeline:
 *   1. Attempt parseHandle(trimmed) first — if it succeeds, value is a valid
 *      handle: NOT a violation. This short-circuits the secondary scan for
 *      serialized handles (which contain registryId/recordId nested in ref).
 *   2. If value starts with '{' (after trimming): attempt JSON.parse.
 *      - JSON.parse throws → not valid JSON → proceed to secondary scan.
 *      - JSON.parse succeeds and result is a plain object with record keys → violation.
 *   3. Secondary embedded-object scan: for EL / script bodies, any embedded
 *      '{...}' substring is also subjected to the same check.
 *   4. EL expressions like "${someVar}", primitives, plain strings → false.
 */
function isRawObjectBinding(value: string): boolean {
  const trimmed = value.trim();

  // Step 1: If the trimmed value is a valid serialized handle, it is NOT a violation.
  // This must come first to avoid false-positives on handles that contain nested
  // record-identity keys inside their `ref` field.
  if (trimmed.startsWith("{")) {
    try {
      parseHandle(trimmed);
      // parseHandle succeeded → valid handle → not a violation
      return false;
    } catch {
      // Not a valid handle — continue to step 2
    }

    // Step 2: attempt JSON.parse on the whole trimmed value
    const parsed = tryJsonParse(trimmed);
    if (parsed !== null && isPlainObject(parsed)) {
      if (hasRawObjectKey(parsed as Record<string, unknown>)) {
        // Has record keys and is not a valid handle → violation
        return true;
      }
    }
    // Not a raw-object at top level; fall through to secondary scan
  }

  // Step 3: Secondary scan — look for embedded JSON objects inside EL / script strings
  // This catches: ${execution.setVariable('x', {"registryId":"y"})} and similar
  return containsEmbeddedRawObject(value);
}

/**
 * Scans for embedded raw-object literals inside a larger string.
 * Finds all '{' characters and tests substrings for the raw-object shape.
 */
function containsEmbeddedRawObject(value: string): boolean {
  let searchFrom = 0;
  while (true) {
    const braceIdx = value.indexOf("{", searchFrom);
    if (braceIdx === -1) break;

    // Try to parse a JSON object starting at this brace
    // We progressively extend the substring until JSON.parse succeeds or we've tried all
    // Try from the brace to various closing braces
    const rest = value.slice(braceIdx);
    const candidate = extractJsonObject(rest);
    if (candidate !== null) {
      const parsed = tryJsonParse(candidate);
      if (parsed !== null && isPlainObject(parsed) && hasRawObjectKey(parsed as Record<string, unknown>)) {
        // Check if it's a valid handle
        try {
          parseHandle(candidate);
          // Valid handle — continue searching for other objects
        } catch {
          return true; // raw object embedded in expression
        }
      }
    }

    searchFrom = braceIdx + 1;
  }
  return false;
}

/**
 * Attempt to extract a complete JSON object substring starting at position 0.
 * Returns the shortest valid JSON object string, or null if none found.
 */
function extractJsonObject(s: string): string | null {
  if (!s.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(0, i + 1);
      }
    }
  }
  return null;
}

/**
 * Safe JSON.parse — returns null if parsing fails.
 */
function tryJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Returns true if value is a non-null, non-array object.
 */
function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Returns true if the object has at least one record-identity or payload key.
 */
function hasRawObjectKey(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (RAW_OBJECT_KEYS.has(key)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// T-0072: LintOpts — optional second argument for binding compat check
// ---------------------------------------------------------------------------

/**
 * Optional opts for lintBpmn (T-0072 additive extension).
 * bindingSchema: if supplied, triggers binding_mismatch check using
 *   checkBindingCompat(bindingSchema, bpmnVarNames).
 * Absent (undefined) → identical behavior to T-0027 (NF-4 / AC-13).
 */
export interface LintOpts {
  bindingSchema?: BindingField[];
}

// ---------------------------------------------------------------------------
// T-0072: EL variable extractor regex (ADR §2.4, NF-5)
//
// Best-effort: extracts the ROOT variable name from EL expressions.
// ${supplier}         → "supplier"
// ${supplier.name}    → "supplier"   (dot-walk — only root extracted)
// ${amount > 100}     → "amount"
// ${a && b}           → "a"          (only first root extracted — known limitation)
//
// Ложные отрицания допустимы (NF-5). Ложных срабатываний нет:
// регекс требует первый символ буква/underscore — цифры/символы не пропускаются.
// Закреплено этим ADR; полный OGNL/MVEL-парсер вне скоупа T-0072.
// ---------------------------------------------------------------------------

const EL_VAR_RE = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;

// ---------------------------------------------------------------------------
// Main lintBpmn function
// ---------------------------------------------------------------------------

/**
 * Validates a BPMN 2.0 XML document for raw-object binding violations.
 *
 * @deploy-gate-contract
 * Pure function — no I/O, no network, no DB, no side effects.
 * T-0058/T-0064 MUST call this before accepting any BPMN deploy request.
 *
 * @param xml  - The BPMN 2.0 XML document as a UTF-8 string.
 * @param opts - Optional. T-0072: if opts.bindingSchema is supplied, an
 *               additional binding_mismatch check is performed after the
 *               raw-object check. Without opts the function is byte-for-byte
 *               identical to T-0027 behavior (NF-4 / AC-13).
 * @returns { ok: true } if the document passes all checks.
 *          { ok: false; violations: LintViolation[] } if any violation is found,
 *          including malformed XML (fail-closed).
 */
export function lintBpmn(xml: string, opts?: LintOpts): LintResult {
  const violations: LintViolation[] = [];

  // T-0072: collect bpmnVarNames during the token walk (only when bindingSchema supplied).
  // The Set is populated aditively in the token loop below; checkBindingCompat is
  // called after the walk completes (post-walk, before final violations check).
  const bpmnVarNames: Set<string> | null = opts?.bindingSchema !== undefined
    ? new Set<string>()
    : null;

  // Validate UTF-8 by checking for replacement characters that Node may have
  // inserted for invalid byte sequences. We operate on a JS string, so we
  // check for U+FFFD which signals lossy decoding.
  // Note: if the caller decoded bytes lossily, U+FFFD may appear.
  // We reject any document containing U+FFFD.
  if (xml.includes("�")) {
    return {
      ok: false,
      violations: [{
        type: "malformed_xml",
        elementId: "",
        elementKind: "malformed_xml",
        message: "document contains invalid UTF-8 sequences (U+FFFD replacement character detected)",
      }],
    };
  }

  // Element stack for tracking open elements and scan contexts
  // Used to detect unclosed tags at end of document (malformed-closed check)
  const elementStack: Array<{ localName: string; id: string }> = [];
  const contextStack: ScanContext[] = [];
  let hadAnyElement = false;

  const tokens = tokenize(xml);

  for (const token of tokens) {
    if (token.kind === "parse-error") {
      return {
        ok: false,
        violations: [{
          type: "malformed_xml",
          elementId: "",
          elementKind: "malformed_xml",
          message: token.reason,
        }],
      };
    }

    if (token.kind === "open-tag" || token.kind === "self-close-tag") {
      const { localName, attrs } = token;

      // Get element id
      const idAttr = attrs.find((a) => a.name === "id");
      const elementId = idAttr ? idAttr.value : "";

      hadAnyElement = true;
      elementStack.push({ localName, id: elementId });

      // Check if this is a scoped element
      if (SCOPED_ELEMENTS.has(localName)) {
        const isConditionExpr = localName === "conditionExpression";
        const isDataObj = localName === "dataObject" || localName === "dataObjectReference";

        const ctx: ScanContext = {
          elementKind: localName,
          elementId,
          inExtension: false,
          isConditionExpression: isConditionExpr,
          isDataObject: isDataObj,
          textBuffer: "",
        };
        contextStack.push(ctx);

        // Scan attributes of scoped elements for raw-object bindings
        // (not needed for conditionExpression/dataObject — those rely on text content)
        if (!isConditionExpr && !isDataObj) {
          // Scan all attribute values of the task element itself
          for (const attr of attrs) {
            if (attr.name !== "id" && attr.name !== "name") {
              checkAttrValue(attr, localName, elementId, violations);
            }
          }
        }
      } else if (contextStack.length > 0) {
        const ctx = contextStack[contextStack.length - 1];

        // Check if entering an extension element context
        if (EXTENSION_CONTAINER_NAMES.has(localName)) {
          ctx.inExtension = true;
        }

        // Scan attributes of extension elements
        if (ctx.inExtension || ctx.isDataObject) {
          for (const attr of attrs) {
            if (attr.name !== "id" && attr.name !== "name") {
              checkAttrValue(attr, ctx.elementKind, ctx.elementId, violations);
            }
          }
        }

        // T-0072: varName extraction from extension variable sources (ADR §2.4).
        // Sources #1/#2: <in name="X"> / <out name="Y"> (call-activity mappings)
        // Sources #3/#4: <formProperty id="Z"> / <formField id="W"> (form element ids)
        // Key shape is filtered through KEY_RE to avoid injecting malformed names.
        if (bpmnVarNames !== null) {
          extractVarNameFromToken(localName, attrs, bpmnVarNames);
        }
      } else if (bpmnVarNames !== null) {
        // T-0072: extract varNames even from top-level (non-child) occurrences
        // e.g. <in> / <out> / <formProperty> / <formField> appearing without a
        // scoped parent in this document. Best-effort.
        extractVarNameFromToken(localName, attrs, bpmnVarNames);
      }

      // Self-close: immediately pop the scoped context if it was just pushed
      if (token.kind === "self-close-tag") {
        elementStack.pop();
        if (contextStack.length > 0) {
          const ctx = contextStack[contextStack.length - 1];
          if (elementStack.length === 0 || elementStack[elementStack.length - 1]?.localName !== ctx.elementKind) {
            // Check if the self-closed element was the scoped element itself
            // We need to verify the context was for this element
            const peeked = contextStack[contextStack.length - 1];
            if (peeked.elementKind === localName && peeked.elementId === elementId) {
              // Flush textBuffer for self-closing scoped elements (empty)
              contextStack.pop();
            }
          }
        }
      }

      continue;
    }

    if (token.kind === "text") {
      if (contextStack.length > 0) {
        const ctx = contextStack[contextStack.length - 1];
        // Accumulate text for conditionExpression, dataObject, or extension contexts
        if (ctx.isConditionExpression || ctx.isDataObject || ctx.inExtension) {
          ctx.textBuffer += token.value;
        }
      }
      continue;
    }

    if (token.kind === "close-tag") {
      const { localName } = token;

      // Pop element stack
      if (elementStack.length > 0) {
        elementStack.pop();
      }

      // Check if this closes a scoped element
      if (contextStack.length > 0) {
        const ctx = contextStack[contextStack.length - 1];

        if (ctx.elementKind === localName) {
          // Flush accumulated text for conditionExpression / dataObject
          if ((ctx.isConditionExpression || ctx.isDataObject) && ctx.textBuffer.trim().length > 0) {
            checkTextContent(ctx.textBuffer, ctx.elementKind, ctx.elementId, violations);
          }
          // T-0072: varName extraction — Source #5: EL ${...} in <conditionExpression> text (ADR §2.4).
          // Best-effort regex (NF-5): extracts root var name from EL expressions.
          // Ложные отрицания допустимы; ложные срабатывания исключены (KEY_RE shape).
          if (bpmnVarNames !== null && ctx.isConditionExpression && ctx.textBuffer.length > 0) {
            EL_VAR_RE.lastIndex = 0;
            let elMatch: RegExpExecArray | null;
            while ((elMatch = EL_VAR_RE.exec(ctx.textBuffer)) !== null) {
              const varName = elMatch[1];
              if (varName !== undefined && KEY_RE.test(varName)) {
                bpmnVarNames.add(varName);
              }
            }
          }
          contextStack.pop();
        } else if (EXTENSION_CONTAINER_NAMES.has(localName) && !SCOPED_ELEMENTS.has(localName)) {
          // Flush text for extension element closing
          if (ctx.inExtension && ctx.textBuffer.trim().length > 0) {
            checkTextContent(ctx.textBuffer, ctx.elementKind, ctx.elementId, violations);
            ctx.textBuffer = "";
          }
        }
      }

      continue;
    }
  }

  // Fail-closed: if any elements were opened but not closed, the document is malformed.
  // This catches the case of unclosed tags that the tokenizer successfully tokenizes
  // (each individual token is valid, but the document structure is incomplete).
  if (hadAnyElement && elementStack.length > 0) {
    return {
      ok: false,
      violations: [{
        type: "malformed_xml",
        elementId: "",
        elementKind: "malformed_xml",
        message: `document has ${elementStack.length} unclosed element(s): ${elementStack.map((e) => `<${e.localName}>`).join(", ")}`,
      }],
    };
  }

  // T-0072: binding compat check (ADR §2.4 / AC-6 / AC-7).
  // Runs AFTER the raw-object walk so parse errors short-circuit above.
  // Only activated when opts.bindingSchema is supplied.
  if (bpmnVarNames !== null && opts?.bindingSchema !== undefined) {
    const compatResult = checkBindingCompat(opts.bindingSchema, bpmnVarNames);
    if (!compatResult.ok) {
      for (const v of compatResult.violations) {
        violations.push({
          type: "binding_mismatch",
          elementId: "",
          elementKind: "binding_mismatch",
          message: v.message,
        });
      }
    }
  }

  if (violations.length === 0) {
    return { ok: true };
  }
  return { ok: false, violations };
}

// ---------------------------------------------------------------------------
// T-0072: varName extraction helper (ADR §2.4)
// ---------------------------------------------------------------------------

/**
 * Extracts a variable name from a token and adds it to bpmnVarNames if valid.
 * Sources:
 *   <in name="X">        / <out name="Y">      → attrs.name value
 *   <formProperty id="Z"> / <formField id="W"> → attrs.id value
 * Names not passing KEY_RE are discarded (prevent false positives, NF-5).
 */
function extractVarNameFromToken(
  localName: string,
  attrs: Attr[],
  bpmnVarNames: Set<string>,
): void {
  if (localName === "in" || localName === "out") {
    const nameAttr = attrs.find((a) => a.name === "name");
    if (nameAttr?.value && KEY_RE.test(nameAttr.value)) {
      bpmnVarNames.add(nameAttr.value);
    }
  } else if (localName === "formProperty" || localName === "formField") {
    const idAttr = attrs.find((a) => a.name === "id");
    if (idAttr?.value && KEY_RE.test(idAttr.value)) {
      bpmnVarNames.add(idAttr.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for checking values
// ---------------------------------------------------------------------------

function checkAttrValue(
  attr: Attr,
  elementKind: string,
  elementId: string,
  violations: LintViolation[],
): void {
  if (isRawObjectBinding(attr.value)) {
    violations.push({
      type: "raw_object_binding",
      elementId,
      elementKind,
      message: `raw-object binding detected in attribute "${attr.name}" of <${elementKind}${elementId ? ` id="${elementId}"` : ""}>: value contains record-identity or payload keys; use an ObjectHandle instead`,
    });
  }
}

function checkTextContent(
  text: string,
  elementKind: string,
  elementId: string,
  violations: LintViolation[],
): void {
  if (isRawObjectBinding(text)) {
    violations.push({
      type: "raw_object_binding",
      elementId,
      elementKind,
      message: `raw-object binding detected in text content of <${elementKind}${elementId ? ` id="${elementId}"` : ""}>: value contains record-identity or payload keys; use an ObjectHandle instead`,
    });
  }
}
