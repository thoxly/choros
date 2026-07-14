/**
 * src/core/bpmn-process-meta.ts — T-0732 (E16 T-0349, O-1 из ревью T-0717).
 *
 * PURE, framework-free extraction of a BPMN process's identity from its XML:
 * the `<process id="…" name="…">` pair. This is the "parse <process name> at
 * deploy" primitive — a server-side deploy path (or the acceptance bootstrap,
 * or a future engine-deploy endpoint) parses the BPMN being deployed and, when
 * a human name is present, stores it tenant-scoped via registerEngineProcessName
 * (src/db/engine-process-name.ts). The read path (resolveDefinitionNames /
 * buildCatalogDefinitions) then surfaces that human name for engine-source
 * (no-modeler-row) processes instead of the demoted raw key.
 *
 * DESIGN DISCIPLINE (mirrors bpmn-deploy-normalizer.ts):
 *   - Structure is READ via the shared fail-closed tokenizer (bpmn-xml-parser),
 *     so we are robust to attribute order / self-closing / whitespace / namespace
 *     prefixes and never guess with a bespoke regex.
 *   - Pure: no IO, no DB, no network. String in / value-or-null out.
 *   - Degrades to null on malformed XML / missing process / missing-or-empty
 *     name — the caller then simply does not register a name (the read path keeps
 *     its honest keyDemoted fallback; the "never a bare key" invariant is upheld
 *     downstream by deriveInstanceTitle, not here).
 *   - CASE-LITERAL FREE: every value returned is DATA read from the supplied XML.
 *     No specific process name or key is ever hardcoded in this module.
 */

import { tokenize } from "./bpmn-xml-parser.js";

/** The identity of a BPMN process definition, as read from its `<process>` element. */
export interface BpmnProcessMeta {
  /** `<process id="…">` — the process-definition key the start path sends to Flowable. */
  readonly processKey: string;
  /** `<process name="…">` — the human-readable process name (guaranteed non-empty). */
  readonly name: string;
}

/**
 * Extract { processKey, name } from a BPMN 2.0 XML string.
 *
 * Selection: the FIRST `<process>` element (open or self-closing) that carries
 * BOTH a non-empty `id` AND a non-empty `name`. A `<process>` with an id but no
 * (or empty) name yields null — there is no human name to register, and the read
 * path must fall back to the demoted key rather than invent one.
 *
 * @param bpmnXml the BPMN 2.0 XML (config file contents / persisted draft).
 * @returns { processKey, name } for the first named process, or null when there
 *   is no `<process>` with a non-empty name, or the document is malformed.
 */
export function parseBpmnProcessMeta(bpmnXml: string): BpmnProcessMeta | null {
  if (typeof bpmnXml !== "string" || bpmnXml.length === 0) return null;

  for (const token of tokenize(bpmnXml)) {
    // Malformed document — let the authoritative linter own the rejection; we
    // simply extract nothing (no name registered → honest keyDemoted fallback).
    if (token.kind === "parse-error") return null;
    if (token.kind !== "open-tag" && token.kind !== "self-close-tag") continue;
    if (token.localName !== "process") continue;

    const id = token.attrs.find((a) => a.name === "id")?.value?.trim() ?? "";
    const name = token.attrs.find((a) => a.name === "name")?.value?.trim() ?? "";
    // Require BOTH: an id to key the row, and a real (non-empty) human name.
    if (id.length > 0 && name.length > 0) {
      return { processKey: id, name };
    }
    // A <process> with no usable name — keep scanning; a later executable process
    // in a multi-process document may carry one. (Deterministic: first-named wins.)
  }

  return null;
}
