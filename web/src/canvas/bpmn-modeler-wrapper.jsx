/* ============================================================================
   CHOROS — bpmn-modeler-wrapper.jsx
   T-0096: Embeds the REAL bpmn-js BpmnModeler into a React component.
   T-0097: Wires the executor-type chs-exec-* marker layer (bpmn-exec-markers.js).
   T-0099: Registers the choros moddle extension (executorType round-trip).
   T-0324: Accepts initialXml prop — uses fetched backend XML instead of the
           hardcoded default when provided. The DEFAULT_DIAGRAM_XML is used only
           when creating a new (blank) definition that has no backend record yet.

   Scope of this component (T-0096 + T-0097 + T-0099):
     - Instantiate BpmnModeler mounted into a DOM container ref
     - Import a minimal default BPMN diagram (Start → typed tasks → End)
     - Apply the product CSS layer (diagram-js.css, bpmn.css, bpmn-theme.css)
       so the real diagram-js DOM picks up --chs-* tokens
     - T-0097: After importXML resolves, call applyExecMarkers() to add
       chs-exec-human/agent/service marker classes via canvas.addMarker().
       Attach EventBus listeners for re-import and palette drops.
     - T-0099: Pass ChorosModdleDescriptor via moddleExtensions so that
       choros:executorType survives saveXML/importXML round-trips.

   Explicitly NOT in scope here:
     - Palette / context-pad / properties customisation → T-0098
     - BPMN-XML save / load UI                         → T-0099 (screen-process-editor)

   The component is a controlled wrapper: it exposes a ref-forwarded
   `modelerRef` so parent screens can access the BpmnModeler instance later.
   ============================================================================ */

import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import BpmnModeler from 'bpmn-js/lib/Modeler';

// Base bpmn-js CSS layers (must precede bpmn-theme.css)
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css';

// Product theme override — applies --chs-* tokens on top of base DOM
import './bpmn-theme.css';

// T-0097: executor-type marker layer
import { applyExecMarkers, attachExecMarkerListeners } from './bpmn-exec-markers.js';

// T-0098: custom palette provider (replaces generic task with 3 Choros executor types)
import ChorosPaletteModule from './bpmn-palette-provider.js';

// T-0099: choros moddle extension — registers choros:executorType as a
// first-class serializable attribute on bpmn:Activity so saveXML preserves it.
import ChorosModdleDescriptor from './choros-moddle-extension.js';

// T-0615: guarantee renderable diagram interchange — definitions ingested as
// raw BPMN (seed / API / AI-emit) lack DI and would blank the canvas; this
// computes a layout before importXML while leaving author layouts untouched.
import { ensureLayout } from './bpmn-ensure-layout.js';

/* --------------------------------------------------------------------------
   Default diagram: Start → UserTask (human) → ServiceTask (service/agent) →
                    SendTask (external) → End
   Uses BPMN typed task elements so the T-0097 marker layer can classify them.
   T-0097: Each task has a distinct $type so execMarkerFor() assigns the
           correct chs-exec-* class after importXML resolves.
   -------------------------------------------------------------------------- */
const DEFAULT_DIAGRAM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:choros="http://choros.io/bpmn"
             id="Definitions_choros"
             targetNamespace="http://choros.io/bpmn">
  <process id="Process_choros" isExecutable="false">
    <startEvent id="StartEvent_1" name="Счёт&#10;поступил">
      <outgoing>Flow_1</outgoing>
    </startEvent>
    <userTask id="Activity_user" name="Согласовать счёт">
      <incoming>Flow_1</incoming>
      <outgoing>Flow_2</outgoing>
    </userTask>
    <serviceTask id="Activity_agent" name="Проверить реквизиты" choros:executorType="agent">
      <incoming>Flow_2</incoming>
      <outgoing>Flow_3</outgoing>
    </serviceTask>
    <sendTask id="Activity_ext" name="Провести платёж">
      <incoming>Flow_3</incoming>
      <outgoing>Flow_4</outgoing>
    </sendTask>
    <endEvent id="EndEvent_1" name="Платёж&#10;проведён">
      <incoming>Flow_4</incoming>
    </endEvent>
    <sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Activity_user" />
    <sequenceFlow id="Flow_2" sourceRef="Activity_user" targetRef="Activity_agent" />
    <sequenceFlow id="Flow_3" sourceRef="Activity_agent" targetRef="Activity_ext" />
    <sequenceFlow id="Flow_4" sourceRef="Activity_ext" targetRef="EndEvent_1" />
  </process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_choros">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="152" y="222" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="135" y="265" width="70" height="27" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Activity_user_di" bpmnElement="Activity_user">
        <dc:Bounds x="240" y="200" width="100" height="80" />
        <bpmndi:BPMNLabel />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Activity_agent_di" bpmnElement="Activity_agent">
        <dc:Bounds x="400" y="200" width="100" height="80" />
        <bpmndi:BPMNLabel />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Activity_ext_di" bpmnElement="Activity_ext">
        <dc:Bounds x="560" y="200" width="100" height="80" />
        <bpmndi:BPMNLabel />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1">
        <dc:Bounds x="722" y="222" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="705" y="265" width="70" height="27" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="188" y="240" />
        <di:waypoint x="240" y="240" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">
        <di:waypoint x="340" y="240" />
        <di:waypoint x="400" y="240" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_3_di" bpmnElement="Flow_3">
        <di:waypoint x="500" y="240" />
        <di:waypoint x="560" y="240" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_4_di" bpmnElement="Flow_4">
        <di:waypoint x="660" y="240" />
        <di:waypoint x="722" y="240" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;

/* --------------------------------------------------------------------------
   BpmnModelerWrapper
   Props:
     className  — extra CSS class on the container div
     style      — inline style on the container div
     onReady    — T-0098: callback(modeler) fired after importXML resolves;
                  lets parent components (e.g. BpmnPropertiesPanel) receive
                  the modeler instance without polling the ref.
     onError    — T-0484: callback(message) fired when importXML REJECTS (e.g.
                  corrupt/invalid BPMN from the backend). Previously such a
                  failure was only console.error'd → the canvas sat blank with
                  NO user-visible error (silent failure). The parent uses this
                  to show an honest banner instead of a deceptively empty canvas.
   Ref forwarded value:
     { modeler }  — the BpmnModeler instance (or null before mount)
   -------------------------------------------------------------------------- */
const BpmnModelerWrapper = forwardRef(function BpmnModelerWrapper(
  { className = '', style, onReady, onError, initialXml },
  ref
) {
  const containerRef = useRef(null);
  const modelerRef = useRef(null);

  useImperativeHandle(ref, () => ({
    get modeler() { return modelerRef.current; },
  }));

  // T-0324: use initialXml when provided (fetched from backend); fall back to
  // DEFAULT_DIAGRAM_XML only for new definitions that have no backend record yet.
  const xmlToLoad = initialXml || DEFAULT_DIAGRAM_XML;

  useEffect(() => {
    if (!containerRef.current) return;

    const modeler = new BpmnModeler({
      container: containerRef.current,
      // T-0529: bind keyboard to the container (was null — canvas was entirely
      // inaccessible via keyboard). bpmn-js keyboard module handles arrow-key
      // navigation, Delete, Ctrl+Z/Y, etc. when the container has focus.
      keyboard: { bindTo: containerRef.current },
      // T-0098: inject custom Choros palette (human / agent / service task entries)
      additionalModules: [ChorosPaletteModule],
      // T-0099: register choros namespace so saveXML serialises choros:executorType
      // as a proper XML attribute instead of losing it on round-trip.
      moddleExtensions: {
        choros: ChorosModdleDescriptor,
      },
    });

    modelerRef.current = modeler;

    // T-0097: attach EventBus listeners for re-import (T-0099) and palette drops.
    // Returns a detach function used in cleanup.
    const detachMarkerListeners = attachExecMarkerListeners(modeler);

    // T-0615: bpmn-js can only render a definition that carries diagram
    // interchange (a <BPMNDiagram> with node coordinates). Definitions ingested
    // as raw BPMN (seed / API / AI-emit) have none → importXML would reject with
    // "no diagram to display" and leave a blank canvas. ensureLayout() detects
    // the absence of DI and computes a layout (bpmn-auto-layout) BEFORE import,
    // while leaving author-placed layouts untouched. If auto-layout itself
    // fails, it throws — the .catch below surfaces an honest error (never a
    // silent blank canvas). We resolve the render-ready XML in an async step,
    // then feed it to the SAME importXML→.then()/.catch() pipeline as before.
    ensureLayout(xmlToLoad)
      .then((prepared) => modeler.importXML(prepared.xml))
      .then(() => {
        // Fit the diagram into the viewport after import
        modeler.get('canvas').zoom('fit-viewport', 'auto');

        // T-0097 fix: ensure Activity_agent carries choros:executorType="agent"
        // on its businessObject.$attrs so execMarkerFor() returns 'chs-exec-agent'.
        // bpmn-moddle may drop unknown-namespace attributes during XML parse
        // (no registered moddle descriptor for the choros namespace), so we set
        // the $attrs entry explicitly here as a guaranteed fallback.  The XML
        // attribute `choros:executorType="agent"` added to the DEFAULT_DIAGRAM_XML
        // is preserved by bpmn-moddle in $attrs when it encounters an unknown
        // namespace attribute, but this post-import write is the authoritative path.
        const elementRegistry = modeler.get('elementRegistry');
        const agentEl = elementRegistry.get('Activity_agent');
        if (agentEl && agentEl.businessObject) {
          if (!agentEl.businessObject.$attrs) {
            agentEl.businessObject.$attrs = {};
          }
          agentEl.businessObject.$attrs['choros:executorType'] = 'agent';
        }

        // T-0097: classify every element and apply chs-exec-* marker classes
        applyExecMarkers(modeler);

        // T-0529: explicitly re-bind keyboard after import to ensure it is active
        // even if bpmn-js initialised before the DOM element was fully ready.
        try { modeler.get('keyboard').bind(containerRef.current); } catch { /* optional module */ }

        // T-0098: notify parent that the modeler is ready (panel can subscribe)
        if (typeof onReady === 'function') {
          onReady(modeler);
        }
      })
      .catch((err) => {
        // Keep the modeler alive, but DO NOT swallow silently (T-0484): the
        // canvas would otherwise sit blank with no explanation. Log AND notify
        // the parent so it can show an honest error banner.
        console.error('[choros/bpmn-modeler] importXML error:', err);
        if (typeof onError === 'function') {
          // T-0615: distinguish an auto-layout failure (the definition had no
          // diagram interchange AND we could not compute one) from a genuine
          // importXML rejection, so the message names the real cause instead of
          // implying the BPMN itself is corrupt.
          const isLayoutFailure = /auto-layout/i.test(err?.message || '');
          const message = isLayoutFailure
            ? `Не удалось построить схему автоматически: ${err?.message || 'ошибка авто-раскладки'}`
            : `Не удалось открыть диаграмму: ${err?.message || 'неверный или повреждённый BPMN'}`;
          onError(message);
        }
      });

    return () => {
      detachMarkerListeners();
      modeler.destroy();
      modelerRef.current = null;
    };
    // xmlToLoad is intentionally excluded: the modeler mounts once; T-0324 loads
    // the XML before rendering this component so it never changes after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once — diagram XML from backend is loaded before first render

  return (
    <>
      {/* T-0529: sr-only keyboard hint — announced by AT when user enters the canvas */}
      <span id="bpmn-keyboard-hint" className="chs-sr-only">
        Редактор BPMN-диаграммы. Нажмите Tab для входа. Используйте стрелки для навигации по элементам,
        Delete для удаления выбранного, Ctrl+Z/Y для отмены/повтора.
        Нажмите Escape для возврата к навигации по странице.
      </span>
      <div
        ref={containerRef}
        className={`chs-bpmn-real-container ${className}`.trim()}
        style={style}
        role="application"
        aria-label="Редактор BPMN-диаграммы"
        aria-describedby="bpmn-keyboard-hint"
        tabIndex={-1}
        // bpmn-js mounts its own DOM subtree (.djs-container) here
      />
    </>
  );
});

export default BpmnModelerWrapper;
