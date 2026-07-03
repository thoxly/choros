/* ============================================================================
   CHOROS — bpmn-ensure-layout.js
   T-0615: Guarantee every BPMN definition can be rendered by bpmn-js.

   THE PROBLEM (verified live on the stand, choros.process_definition.bpmn_xml):
     bpmn-js REQUIRES diagram-interchange (DI) — the <bpmndi:BPMNDiagram> block
     with per-node coordinates — to draw a diagram. importXML rejects any
     definition WITHOUT DI ("no diagram to display"), leaving the user staring
     at a blank canvas with a palette but no process. Definitions authored in
     the modeler carry DI, but definitions ingested as raw BPMN (via seed, API,
     or the AI assistant's emit path) do NOT — the modeler never touched them,
     so no coordinates were ever computed. Those definitions are un-viewable and
     un-editable until DI exists.

   THE MECHANISM (generic — NO business-case knowledge):
     Detect the ABSENCE of DI structurally (does the XML contain a BPMNDiagram
     element?), and if absent, compute a layout with bpmn-auto-layout's
     layoutProcess() — the bpmn-io auto-layout engine, a pure bpmn-moddle
     transform with no DOM dependency — BEFORE handing the XML to importXML.
     If DI is already present, the XML is returned UNTOUCHED: the author's
     hand-placed layout is authoritative and must never be overwritten.

   HONEST DEGRADATION:
     ensureLayout() throws a descriptive Error if auto-layout itself fails
     (malformed BPMN the layouter cannot parse). The caller surfaces that to the
     user ("could not build the diagram automatically") instead of a silent
     blank canvas — the failure is named, not swallowed.

   Exports:
     hasDiagramInterchange(xml) → boolean   (pure, synchronous)
     ensureLayout(xml)          → Promise<{ xml: string; layoutApplied: boolean }>
   ============================================================================ */

import { layoutProcess } from 'bpmn-auto-layout';

/* --------------------------------------------------------------------------
   hasDiagramInterchange
   TRUE iff the BPMN XML carries a diagram-interchange plane, i.e. a
   <BPMNDiagram> element (in the http://www.omg.org/spec/BPMN/20100524/DI
   namespace — conventionally prefixed `bpmndi:`, but the prefix is arbitrary
   per XML namespace rules, so we match the LOCAL name, not a fixed prefix).

   This is the exact structure bpmn-js needs to render: no BPMNDiagram → no
   BPMNPlane → no BPMNShape/BPMNEdge → nothing to draw → importXML rejects.

   Pure string inspection (no XML parse): the backend stores BPMN as opaque
   text and never round-trips it through a modeller, so a structural regex over
   the element's local name is the cheapest and most robust detector — it is
   prefix-agnostic and matches whether the element is self-closed or not.
   -------------------------------------------------------------------------- */
export function hasDiagramInterchange(xml) {
  if (typeof xml !== 'string' || xml.length === 0) return false;
  // Match an opening <…:BPMNDiagram or <BPMNDiagram tag (any / no namespace
  // prefix), followed by whitespace, '>' or '/'. Anchored on '<' so it cannot
  // match the string inside an attribute value or comment body incidentally.
  return /<(?:[A-Za-z_][\w.-]*:)?BPMNDiagram(?=[\s/>])/.test(xml);
}

/* --------------------------------------------------------------------------
   ensureLayout
   Returns XML that bpmn-js can render:
     - DI already present → the input XML, verbatim   (layoutApplied: false)
     - DI absent          → layoutProcess(xml) output (layoutApplied: true)

   Throws if the input is not a non-empty string, or if auto-layout fails on a
   DI-less input (so the caller can degrade honestly instead of importing XML
   that will reject with a bare "no diagram to display").

   layoutProcess is async and returns the full definitions XML with a freshly
   generated <BPMNDiagram> for the (first) process. It is a pure bpmn-moddle
   transform — safe to run in any environment, no browser globals required.
   -------------------------------------------------------------------------- */
export async function ensureLayout(xml) {
  if (typeof xml !== 'string' || xml.length === 0) {
    throw new Error('ensureLayout: xml must be a non-empty string');
  }

  // DI present: the author's layout wins. Do NOT re-layout — that would discard
  // hand-placed coordinates and reshuffle a diagram the user deliberately arranged.
  if (hasDiagramInterchange(xml)) {
    return { xml, layoutApplied: false };
  }

  // DI absent: compute one. Wrap the layouter so its failure carries an honest,
  // user-facing cause instead of leaking an opaque internal moddle error.
  let laidOut;
  try {
    laidOut = await layoutProcess(xml);
  } catch (err) {
    throw new Error(
      `auto-layout failed: ${err && err.message ? err.message : String(err)}`,
    );
  }

  // Defensive: a successful layoutProcess must yield DI. If it somehow did not
  // (empty output, or a shape the detector still reads as DI-less), treat it as
  // a layout failure rather than pass XML that will reject in importXML.
  if (!laidOut || !hasDiagramInterchange(laidOut)) {
    throw new Error('auto-layout produced no diagram interchange');
  }

  return { xml: laidOut, layoutApplied: true };
}
