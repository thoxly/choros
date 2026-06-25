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
import type { DmnRuleTable } from "./dmn-middle.js";

// ---------------------------------------------------------------------------
// Exported types (frozen public surface — T-0058/T-0064 wire against this)
// ---------------------------------------------------------------------------

// T-0072: "binding_mismatch" added additively (NF-4 / AC-13 — no existing tests broken).
// T-0436: "gateway_rule_mismatch" added additively — publish-time coherence guard.
// T-0456 [D8-R1]: "parallel_gateway_imbalance" added additively — AND split/join
//   well-formedness guard (balanced split↔join, no dangling parallel gateway).
// T-0458 [D8-R3]: "timer_malformed" added additively — boundary/intermediate timer
//   well-formedness guard (valid timer body + boundary attach + outgoing escalation).
export type LintViolationType =
  | "raw_object_binding"
  | "malformed_xml"
  | "binding_mismatch"
  | "gateway_rule_mismatch"
  | "parallel_gateway_imbalance"
  | "timer_malformed";

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
 *
 * T-0436: ruleTables — if supplied, triggers gateway_rule_mismatch check.
 * For every exclusiveGateway with ≥2 conditioned outgoing flows, the gateway's
 * choros:routingVar is matched against the routing-outcome name of published
 * rule tables. A mismatch (no table for the variable, or a flow literal not
 * covered by any rule) produces a gateway_rule_mismatch violation → 422.
 * Absent (undefined) → no gateway coherence check (identical T-0072 behavior).
 */
export interface LintOpts {
  bindingSchema?: BindingField[];
  ruleTables?: DmnRuleTable[];
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

  // T-0436: collect gateway info during the token walk (only when ruleTables supplied).
  // gateways: map from gateway elementId (or generated key) to GatewayInfo.
  //
  // Fix (review finding): conditions are associated to gateways by sequenceFlow sourceRef,
  // NOT by variable name. When two gateways share the same routingVar, keying by varName
  // would merge their branch literals and cause false-positive 422 / misattribution.
  // Correct design: each <sequenceFlow sourceRef="<gatewayId>"> owns its condition;
  // we build literalsByGatewayId keyed by the gateway element id.
  const collectGateways = opts?.ruleTables !== undefined;
  const gatewayMap = new Map<string, GatewayInfo>(); // key = elementId or index
  let gatewayIndex = 0;
  // literalsByGatewayId: maps gateway element id → array of {varName, literal} pairs
  // collected from the sequenceFlows whose sourceRef points at that gateway id.
  const literalsByGatewayId = new Map<string, Array<{ varName: string; literal: string }>>();
  // State for collecting conditionExpression text in this scan.
  // currentSeqFlowSourceRef: sourceRef of the sequenceFlow currently being parsed.
  let inCondExprForGateway = false;
  let condExprBuffer = "";
  let currentSeqFlowSourceRef = "";

  // T-0456 [D8-R1]: parallelGateway collection — always on (no opts gate; the AND
  // split/join well-formedness check is structural, needs no rule tables). We track
  // every parallelGateway element id, and collect ALL sequenceFlow source/target refs.
  // Refs are RESOLVED to gateways AFTER the full walk (BPMN does NOT guarantee a flow
  // is declared after its referenced gateway — counting inline would miss earlier flows).
  const parallelGatewayIds = new Set<string>(); // declared parallelGateway element ids
  const allFlowSourceRefs: string[] = []; // sourceRef of every sequenceFlow (= outgoing of source node)
  const allFlowTargetRefs: string[] = []; // targetRef of every sequenceFlow (= incoming of target node)

  // T-0458 [D8-R3]: timer event collection — always on (structural well-formedness,
  // no opts gate). We collect every boundaryEvent / intermediateCatchEvent that carries
  // a <timerEventDefinition>, plus the timer-body text (timeDuration / timeDate /
  // timeCycle) and the boundary's attachedToRef. Flows are resolved post-walk (BPMN
  // does not guarantee a timer's outgoing flow is declared after the timer element).
  const timerEvents: TimerEventCollect[] = [];
  // Cursor for the event element currently being parsed (null when not inside one).
  // Both boundaryEvent and intermediateCatchEvent can host a timerEventDefinition.
  let currentTimerEvent: TimerEventCollect | null = null;
  // Tracks which timer-body child (timeDuration/timeDate/timeCycle) we are inside so
  // the text token can be attributed to it.
  let inTimerBodyChild: TimerBodyKind | null = null;

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

      // T-0436: gateway collection — track exclusiveGateway elements for coherence check.
      // The routingVar attribute is written by gateway-condition-panel.jsx as
      // choros:routingVar; after namespace prefix stripping by the tokenizer,
      // the attribute local name is "routingVar".
      if (collectGateways && localName === "exclusiveGateway") {
        const routingVarAttr = attrs.find((a) => a.name === "routingVar");
        const routingVar = routingVarAttr?.value ?? "";
        const gwKey = elementId || `__gw_${gatewayIndex}`;
        gatewayIndex++;
        gatewayMap.set(gwKey, { id: elementId, routingVar, branchLiterals: [] });
      }

      // T-0436: track sequenceFlow sourceRef so conditionExpression can be associated
      // to the correct owning gateway by gateway id, NOT by variable name.
      if (collectGateways && localName === "sequenceFlow") {
        const sourceRefAttr = attrs.find((a) => a.name === "sourceRef");
        currentSeqFlowSourceRef = sourceRefAttr?.value ?? "";
      }

      // T-0456 [D8-R1]: collect parallelGateway element ids (resolved after the walk).
      if (localName === "parallelGateway") {
        // An id-less parallelGateway is itself malformed for flow-balance purposes; the
        // structural check below flags any parallel gateway it can identify. Without an
        // id we cannot link flows to it, so it would appear as 0/0 (dangling) — which is
        // the correct outcome. Use a synthetic key so it is still surfaced.
        parallelGatewayIds.add(elementId || `__pg_anon_${parallelGatewayIds.size}`);
      }

      // T-0456 [D8-R1]: collect EVERY sequenceFlow's source/target ref. Resolved to
      // gateways post-walk (declaration order is not guaranteed in BPMN). Independent
      // of the T-0436 collectGateways flag — runs on every publish.
      if (localName === "sequenceFlow") {
        const srcAttr = attrs.find((a) => a.name === "sourceRef");
        const tgtAttr = attrs.find((a) => a.name === "targetRef");
        if (srcAttr?.value) allFlowSourceRefs.push(srcAttr.value);
        if (tgtAttr?.value) allFlowTargetRefs.push(tgtAttr.value);
      }

      // T-0458 [D8-R3]: timer event collection. boundaryEvent / intermediateCatchEvent
      // open a timer-event cursor; the <timerEventDefinition> child marks it as a timer;
      // timeDuration/timeDate/timeCycle children carry the timer body text. Resolved to
      // outgoing flows post-walk. cancelActivity (interrupting) is read off boundaryEvent.
      if (localName === "boundaryEvent" || localName === "intermediateCatchEvent") {
        const attachedToAttr = attrs.find((a) => a.name === "attachedToRef");
        // cancelActivity defaults to "true" in BPMN when absent (interrupting boundary).
        const cancelAttr = attrs.find((a) => a.name === "cancelActivity");
        currentTimerEvent = {
          id: elementId,
          kind: localName === "boundaryEvent" ? "boundary" : "intermediate",
          attachedToRef: attachedToAttr?.value ?? "",
          cancelActivity: cancelAttr ? cancelAttr.value !== "false" : true,
          hasTimerDef: false,
          timerBodyKind: null,
          timerBody: "",
        };
      }
      if (currentTimerEvent !== null && localName === "timerEventDefinition") {
        currentTimerEvent.hasTimerDef = true;
      }
      if (currentTimerEvent !== null) {
        const tbk = TIMER_BODY_NAMES[localName];
        if (tbk !== undefined) {
          inTimerBodyChild = tbk;
          currentTimerEvent.timerBodyKind = tbk;
          // Self-closing <timeDuration/> (no text) leaves body empty → caught as malformed.
        }
      }

      // T-0436: conditionExpression gateway collection.
      // When we encounter a <conditionExpression> element (already tracked by
      // SCOPED_ELEMENTS → contextStack), we also track it in our parallel
      // gateway buffer. After the close-tag, we parse the condition and add
      // the literal to the owning gateway via the sequenceFlow's sourceRef.
      if (collectGateways && localName === "conditionExpression") {
        inCondExprForGateway = true;
        condExprBuffer = "";
      }

      // Self-close: immediately pop the scoped context if it was just pushed
      if (token.kind === "self-close-tag") {
        // T-0458 [D8-R3]: a self-closing timer-body child (<timeDuration/>) carries no
        // text → leave timerBody empty (caught as malformed) and stop accumulating.
        if (currentTimerEvent !== null && TIMER_BODY_NAMES[localName] !== undefined) {
          inTimerBodyChild = null;
        }
        // A self-closing boundary/intermediate timer host (no children) cannot carry a
        // timerEventDefinition, so it is never committed here; reset the cursor anyway.
        if (
          currentTimerEvent !== null &&
          (localName === "boundaryEvent" || localName === "intermediateCatchEvent")
        ) {
          if (currentTimerEvent.hasTimerDef) {
            timerEvents.push(currentTimerEvent);
          }
          currentTimerEvent = null;
          inTimerBodyChild = null;
        }
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
      // T-0436: accumulate text for gateway conditionExpression buffer in parallel.
      if (inCondExprForGateway) {
        condExprBuffer += token.value;
      }
      // T-0458 [D8-R3]: accumulate timer-body text (timeDuration / timeDate / timeCycle).
      if (currentTimerEvent !== null && inTimerBodyChild !== null) {
        currentTimerEvent.timerBody += token.value;
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

      // T-0436: flush gateway conditionExpression buffer on </conditionExpression>.
      // Associate the parsed literal to the owning gateway by sourceRef (gateway id),
      // NOT by variable name — fixes false-positive when two gateways share routingVar.
      if (collectGateways && localName === "conditionExpression" && inCondExprForGateway) {
        inCondExprForGateway = false;
        const parsed = parseGatewayCondition(condExprBuffer);
        if (parsed !== null && currentSeqFlowSourceRef) {
          // Accumulate literal under the owning gateway's id (sourceRef of the flow).
          let entries = literalsByGatewayId.get(currentSeqFlowSourceRef);
          if (entries === undefined) {
            entries = [];
            literalsByGatewayId.set(currentSeqFlowSourceRef, entries);
          }
          entries.push(parsed);
        }
        condExprBuffer = "";
      }

      // T-0436: clear sequenceFlow tracking state when the sequenceFlow closes.
      if (collectGateways && localName === "sequenceFlow") {
        currentSeqFlowSourceRef = "";
      }

      // T-0458 [D8-R3]: timer-event close handling. Close a timer-body child to stop
      // text accumulation; close the host event to commit the collected timer (only if
      // it actually carried a <timerEventDefinition>).
      if (currentTimerEvent !== null && TIMER_BODY_NAMES[localName] !== undefined) {
        inTimerBodyChild = null;
      }
      if (
        currentTimerEvent !== null &&
        (localName === "boundaryEvent" || localName === "intermediateCatchEvent")
      ) {
        if (currentTimerEvent.hasTimerDef) {
          timerEvents.push(currentTimerEvent);
        }
        currentTimerEvent = null;
        inTimerBodyChild = null;
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

  // T-0436: gateway coherence check.
  // Runs AFTER the raw-object walk so parse errors short-circuit above.
  // Only activated when opts.ruleTables is supplied.
  if (collectGateways && opts?.ruleTables !== undefined) {
    // Attach collected condition literals to each gateway by its element id.
    // literalsByGatewayId is keyed by the sequenceFlow's sourceRef (= gateway id),
    // so each gateway only receives literals from its OWN outgoing flows —
    // no cross-gateway merge even when two gateways share the same routingVar.
    for (const gw of gatewayMap.values()) {
      const gwId = gw.id;
      if (gwId) {
        const entries = literalsByGatewayId.get(gwId);
        if (entries !== undefined) {
          // Merge literals into gw.branchLiterals (deduplicate).
          for (const entry of entries) {
            if (!gw.branchLiterals.includes(entry.literal)) {
              gw.branchLiterals.push(entry.literal);
            }
          }
        }
      }
    }

    checkGatewayRuleCoherence(Array.from(gatewayMap.values()), opts.ruleTables, violations);
  }

  // T-0456 [D8-R1]: parallelGateway (AND split/join) well-formedness — ALWAYS on.
  // Resolve the collected flow refs into per-gateway in/out counts, then run the
  // structural coherence check (balanced split↔join, no dangling). Runs on every
  // publish (structural — no rule tables needed).
  if (parallelGatewayIds.size > 0) {
    const parallelGateways: ParallelGatewayInfo[] = [];
    for (const id of parallelGatewayIds) {
      // Anonymous (id-less) gateways start with the synthetic prefix and can never be
      // referenced by a flow → they resolve to 0/0 and are reported as dangling, which
      // is the correct fail-closed outcome.
      const isAnon = id.startsWith("__pg_anon_");
      const realId = isAnon ? "" : id;
      const outgoing = realId ? allFlowSourceRefs.filter((r) => r === realId).length : 0;
      const incoming = realId ? allFlowTargetRefs.filter((r) => r === realId).length : 0;
      parallelGateways.push({ id: realId, incoming, outgoing });
    }
    checkParallelGatewayCoherence(parallelGateways, violations);
  }

  // T-0458 [D8-R3]: timer event well-formedness — ALWAYS on. Resolve the collected
  // timer events' outgoing flow counts, then run the structural check (valid timer
  // body + boundary attach + leads-somewhere escalation). Runs on every publish.
  if (timerEvents.length > 0) {
    const timers: TimerEventInfo[] = timerEvents.map((t) => ({
      id: t.id,
      kind: t.kind,
      attachedToRef: t.attachedToRef,
      cancelActivity: t.cancelActivity,
      timerBodyKind: t.timerBodyKind,
      timerBody: t.timerBody.trim(),
      // Resolve outgoing flows by element id (id-less timers resolve to 0 → dangling).
      outgoing: t.id ? allFlowSourceRefs.filter((r) => r === t.id).length : 0,
    }));
    checkTimerCoherence(timers, violations);
  }

  if (violations.length === 0) {
    return { ok: true };
  }
  return { ok: false, violations };
}

// ---------------------------------------------------------------------------
// T-0456 [D8-R1]: Parallel gateway (AND split/join) well-formedness check
// ---------------------------------------------------------------------------

/**
 * Describes one parallelGateway found in the BPMN XML, with its incoming and
 * outgoing sequenceFlow counts (resolved from flow source/target refs after the
 * token walk). Pure data; collected by lintBpmn.
 */
interface ParallelGatewayInfo {
  /** Element id of the parallelGateway ("" when the element had no id attribute). */
  id: string;
  /** Number of sequenceFlows whose targetRef points at this gateway (join arity). */
  incoming: number;
  /** Number of sequenceFlows whose sourceRef points at this gateway (split arity). */
  outgoing: number;
}

/**
 * Validate AND split/join well-formedness for every parallelGateway:
 *
 *   - DANGLING: a parallelGateway with 0 incoming or 0 outgoing flows is dangling
 *     (no token can flow through it / it leads nowhere) → violation. This also
 *     catches id-less gateways (which cannot be referenced by any flow).
 *
 *   - UNBALANCED FORK: a split (1 incoming, ≥2 outgoing) creates N concurrent
 *     tokens. A diverging+converging gateway (≥2 in AND ≥2 out, a "mixed" gateway)
 *     is rejected — BPMN best practice and Flowable execution clarity require a
 *     dedicated split and a dedicated join, not a single mixed gateway. Balanced
 *     well-formed shapes are: pure SPLIT (1-in / N-out) and pure JOIN (N-in / 1-out).
 *     A 1-in/1-out parallel gateway is a no-op pass-through (allowed, advisory-clean).
 *
 * Note on whole-process balance (every split has a matching join): a full
 * reachability/path analysis is out of v1 scope (spec §3.2 — "balanced split/join,
 * no dangling"). Per-gateway arity + no-dangling catches the common authoring
 * mistakes (fork that never joins back via a mixed gateway; a gateway wired to
 * nothing). Flowable itself rejects truly unreachable graphs at deploy.
 *
 * Pure: no IO, no DB, no side effects.
 */
function checkParallelGatewayCoherence(
  gateways: ParallelGatewayInfo[],
  violations: LintViolation[],
): void {
  for (const gw of gateways) {
    const elemDesc = gw.id ? `parallelGateway id="${gw.id}"` : "parallelGateway (no id)";

    // Dangling: a parallel gateway with no incoming or no outgoing flow is unreachable
    // or leads nowhere — a token can never split/join correctly.
    if (gw.incoming === 0 || gw.outgoing === 0) {
      violations.push({
        type: "parallel_gateway_imbalance",
        elementId: gw.id,
        elementKind: "parallelGateway",
        message:
          `<${elemDesc}> is dangling: it has ${gw.incoming} incoming and ${gw.outgoing} ` +
          `outgoing sequence flow(s). A parallel (AND) gateway must have at least one ` +
          `incoming and one outgoing flow; a split needs 1 incoming and ≥2 outgoing, ` +
          `a join needs ≥2 incoming and 1 outgoing`,
      });
      continue;
    }

    // Mixed split+join in a single gateway: ≥2 incoming AND ≥2 outgoing. Reject —
    // split and join must be distinct gateways for correct, readable AND semantics.
    if (gw.incoming >= 2 && gw.outgoing >= 2) {
      violations.push({
        type: "parallel_gateway_imbalance",
        elementId: gw.id,
        elementKind: "parallelGateway",
        message:
          `<${elemDesc}> mixes split and join: it has ${gw.incoming} incoming and ` +
          `${gw.outgoing} outgoing flows. Use a dedicated AND-split (1 incoming, ≥2 ` +
          `outgoing) and a dedicated AND-join (≥2 incoming, 1 outgoing) instead of one ` +
          `mixed parallel gateway`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// T-0458 [D8-R3]: Timer / deadline event well-formedness check
// ---------------------------------------------------------------------------

/**
 * The three BPMN timer-body child element local names and the timer kind each maps
 * to. timerEventDefinition must contain exactly one of these with a non-empty body
 * (an ISO-8601 duration, a fixed date, or a recurring cycle).
 */
const TIMER_BODY_NAMES: Record<string, TimerBodyKind> = {
  timeDuration: "duration",
  timeDate: "date",
  timeCycle: "cycle",
};

/** Which kind of timer body a <timerEventDefinition> carries. */
type TimerBodyKind = "duration" | "date" | "cycle";

/**
 * Raw collection record for a timer-bearing event, accumulated during the token walk.
 * Resolved to a TimerEventInfo (with outgoing flow count) post-walk.
 */
interface TimerEventCollect {
  id: string;
  kind: "boundary" | "intermediate";
  attachedToRef: string;
  cancelActivity: boolean;
  hasTimerDef: boolean;
  timerBodyKind: TimerBodyKind | null;
  timerBody: string;
}

/**
 * Resolved timer event: a boundary/intermediate catch event carrying a
 * <timerEventDefinition>, with its outgoing sequenceFlow count resolved.
 */
interface TimerEventInfo {
  /** Element id ("" when absent). */
  id: string;
  /** boundary (attached to a task — the deadline) vs intermediate (inline wait). */
  kind: "boundary" | "intermediate";
  /** attachedToRef of a boundary event (the task the deadline guards); "" otherwise. */
  attachedToRef: string;
  /** cancelActivity (interrupting). Defaults true. Informational for the message. */
  cancelActivity: boolean;
  /** duration | date | cycle, or null if no recognised timer body child was present. */
  timerBodyKind: TimerBodyKind | null;
  /** Trimmed timer body text (ISO-8601 duration / date / cron-or-cycle). */
  timerBody: string;
  /** Number of outgoing sequenceFlows from this event (where the escalation goes). */
  outgoing: number;
}

/**
 * ISO-8601 duration regex (e.g. PT24H, P1D, P1DT12H, PT30M). The 'P' designator is
 * required; at least one component must be present. Flowable accepts the standard
 * ISO-8601 duration grammar for <timeDuration>. We validate the common, well-formed
 * shape and reject obviously-empty or non-ISO strings (the authoring panel only ever
 * emits this shape; a hand-edited malformed value is caught here at publish).
 */
const ISO8601_DURATION_RE =
  /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;

/**
 * ISO-8601 date / datetime regex (e.g. 2026-07-01 or 2026-07-01T14:00:00Z). A fixed
 * deadline date. Also accepts an EL expression (${...}) — a date pulled from a record
 * field is bound as an EL expression resolved at runtime (spec §3.4: "a date from a
 * record field"). We accept any non-empty ${...} expression for the date case.
 */
const ISO8601_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** EL expression: ${...} (a date pulled from a record field, resolved at runtime). */
const EL_EXPRESSION_RE = /^\$\{[^}]+\}$/;

/**
 * Validate the well-formedness of every collected timer event:
 *
 *   - NO TIMER BODY: a timerEventDefinition with no timeDuration/timeDate/timeCycle
 *     child (or an empty one) → violation. Flowable cannot schedule a timer without
 *     a body; the deadline is undefined.
 *
 *   - MALFORMED DURATION/DATE: a timeDuration that is not a valid ISO-8601 duration,
 *     or a timeDate that is neither an ISO-8601 date nor an EL expression → violation.
 *     This catches a hand-edited XML deadline that Flowable would reject at deploy.
 *
 *   - DANGLING (leads nowhere): a timer event with 0 outgoing sequenceFlows has no
 *     escalation target — the deadline fires but nothing happens → violation. The
 *     escalation user-task must be reachable from the timer.
 *
 *   - BOUNDARY WITHOUT ATTACH: a boundaryEvent with no attachedToRef is not attached
 *     to any task — Flowable cannot schedule it relative to an activity → violation.
 *
 * Pure: no IO, no DB, no side effects.
 */
function checkTimerCoherence(
  timers: TimerEventInfo[],
  violations: LintViolation[],
): void {
  for (const t of timers) {
    const elemKind = t.kind === "boundary" ? "boundaryEvent" : "intermediateCatchEvent";
    const elemDesc = t.id ? `${elemKind} id="${t.id}"` : `${elemKind} (no id)`;

    // 1. No / empty timer body.
    if (t.timerBodyKind === null || t.timerBody.length === 0) {
      violations.push({
        type: "timer_malformed",
        elementId: t.id,
        elementKind: elemKind,
        message:
          `<${elemDesc}> has a <timerEventDefinition> without a valid deadline: it must ` +
          `contain a non-empty <timeDuration> (ISO-8601 duration, e.g. PT24H), ` +
          `<timeDate> (a fixed date or a \${record.field} expression), or <timeCycle>`,
      });
      // No body → no point validating the (empty) body shape; still check flows below.
    } else {
      // 2. Malformed body shape per kind.
      if (t.timerBodyKind === "duration" && !ISO8601_DURATION_RE.test(t.timerBody) && !EL_EXPRESSION_RE.test(t.timerBody)) {
        violations.push({
          type: "timer_malformed",
          elementId: t.id,
          elementKind: elemKind,
          message:
            `<${elemDesc}> has a <timeDuration> "${t.timerBody}" that is not a valid ` +
            `ISO-8601 duration (expected e.g. PT24H, P1D, P1DT12H) nor a \${...} expression`,
        });
      } else if (
        t.timerBodyKind === "date" &&
        !ISO8601_DATE_RE.test(t.timerBody) &&
        !EL_EXPRESSION_RE.test(t.timerBody)
      ) {
        violations.push({
          type: "timer_malformed",
          elementId: t.id,
          elementKind: elemKind,
          message:
            `<${elemDesc}> has a <timeDate> "${t.timerBody}" that is neither an ISO-8601 ` +
            `date (e.g. 2026-07-01T14:00:00Z) nor a \${record.field} expression`,
        });
      }
      // cycle: accept any non-empty body (cron / R/PT1H grammar is broad — Flowable validates).
    }

    // 3. Boundary timer must be attached to an activity.
    if (t.kind === "boundary" && t.attachedToRef.length === 0) {
      violations.push({
        type: "timer_malformed",
        elementId: t.id,
        elementKind: elemKind,
        message:
          `<${elemDesc}> is a boundary timer with no attachedToRef — it must be attached ` +
          `to the task whose deadline it guards`,
      });
    }

    // 4. Dangling: a timer that fires but leads nowhere (no escalation target).
    if (t.outgoing === 0) {
      violations.push({
        type: "timer_malformed",
        elementId: t.id,
        elementKind: elemKind,
        message:
          `<${elemDesc}> has no outgoing sequence flow — when the deadline fires there is ` +
          `no escalation target to route to. Connect the timer to the escalation step`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// T-0436: Gateway coherence check (publish-time rule-table link by routing-var)
// ---------------------------------------------------------------------------

/**
 * Describes one exclusive gateway found in the BPMN XML, along with the
 * branch literals collected from its outgoing conditionExpression elements.
 * Pure data; collected during the token walk (lintBpmn collects these when
 * opts.ruleTables is provided).
 */
interface GatewayInfo {
  /** Element id of the exclusiveGateway (may be empty string if absent). */
  id: string;
  /** choros:routingVar attribute value (after namespace prefix stripping → "routingVar"). */
  routingVar: string;
  /** Outgoing flow literal values extracted from ${routingVar == 'value'} conditions. */
  branchLiterals: string[];
}

/**
 * Regex to parse a conditionExpression body in canonical gateway form:
 * ${varName == 'value'}
 * Captures: [1] = varName, [2] = value string.
 * Matches the form written by buildConditionBody() in gateway-condition-panel.jsx.
 */
const GATEWAY_CONDITION_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\s*==\s*'([^']*)'\}$/;

/**
 * Extract the routing variable name and branch literal from a conditionExpression
 * body string in the canonical gateway form `${varName == 'value'}`.
 * Returns null if the expression does not match (e.g. non-gateway EL expressions).
 */
function parseGatewayCondition(body: string): { varName: string; literal: string } | null {
  const m = GATEWAY_CONDITION_RE.exec(body.trim());
  if (!m) return null;
  return { varName: m[1]!, literal: m[2]! };
}

/**
 * Given the collected GatewayInfo[] and the published rule tables, emit
 * gateway_rule_mismatch violations for any gateway whose routingVar either:
 *  a) has no published rule table whose routing-outcome name matches it, OR
 *  b) has a branch literal that cannot be produced by any rule in that table.
 *
 * Link strategy (T-0436 architect note): gateway.routingVar === ruleTable's
 * routing-outcome name. The routing-outcome name of a table is the `name`
 * field of any `set_routing_outcome` effect across its rules (all rules in a
 * validated table share one name — enforced by validateDmnRuleTable's
 * INCONSISTENT_ROUTING_NAME check).
 *
 * Pure: no IO, no DB, no side effects.
 */
function checkGatewayRuleCoherence(
  gateways: GatewayInfo[],
  ruleTables: DmnRuleTable[],
  violations: LintViolation[],
): void {
  // Build a map: routingOutcomeName → Set<string> of producible values.
  // A table's routing-outcome name is derived from set_routing_outcome effects.
  const tableOutcomeValues = new Map<string, Set<string>>();

  for (const table of ruleTables) {
    for (const rule of table.rules) {
      for (const effect of rule.effects) {
        if (effect.kind === "set_routing_outcome") {
          let valueSet = tableOutcomeValues.get(effect.name);
          if (valueSet === undefined) {
            valueSet = new Set<string>();
            tableOutcomeValues.set(effect.name, valueSet);
          }
          valueSet.add(effect.value);
        }
      }
    }
  }

  for (const gw of gateways) {
    // Skip gateways that have fewer than 2 branch literals (0 or 1 conditioned
    // flows — nothing to validate: no table link needed for unconditional flows
    // or single-branch gateways without conditions).
    if (gw.branchLiterals.length < 2) continue;

    const varName = gw.routingVar;
    const elemDesc = gw.id ? `exclusiveGateway id="${gw.id}"` : "exclusiveGateway";

    if (!varName) {
      // No routingVar declared — cannot link to any table. Skip (no violation:
      // a gateway without choros:routingVar may be using non-table routing logic).
      continue;
    }

    const valueSet = tableOutcomeValues.get(varName);

    if (valueSet === undefined) {
      // No published rule table whose routing-outcome name matches this variable.
      violations.push({
        type: "gateway_rule_mismatch",
        elementId: gw.id,
        elementKind: "exclusiveGateway",
        message:
          `<${elemDesc}> uses routing variable "${varName}" but no published ` +
          `rule table declares a routing outcome with that name; ` +
          `publish a rule table that sets routing outcome "${varName}" before publishing this process`,
      });
      continue;
    }

    // Check each branch literal is producible by the table.
    for (const literal of gw.branchLiterals) {
      if (!valueSet.has(literal)) {
        violations.push({
          type: "gateway_rule_mismatch",
          elementId: gw.id,
          elementKind: "exclusiveGateway",
          message:
            `<${elemDesc}> has a branch condition "${varName} == '${literal}'" ` +
            `but the rule table for routing outcome "${varName}" does not produce ` +
            `the value "${literal}"; update the rule table or remove the branch condition`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// T-0436: varName extraction helper (ADR §2.4)
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
