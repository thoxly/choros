/* ============================================================================
   CHOROS — bpmn-modeler-wrapper.jsx
   T-0096: Embeds the REAL bpmn-js BpmnModeler into a React component.

   Scope of this component (T-0096 only):
     - Instantiate BpmnModeler mounted into a DOM container ref
     - Import a minimal default BPMN diagram (Start → Task → End)
     - Apply the product CSS layer (diagram-js.css, bpmn.css, bpmn-theme.css)
       so the real diagram-js DOM picks up --chs-* tokens

   Explicitly NOT in scope here:
     - Custom renderer for chs-exec-* colors         → T-0097
     - Palette / context-pad / properties customisation → T-0098
     - BPMN-XML save / load                           → T-0099

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

/* --------------------------------------------------------------------------
   Default diagram: a minimal Start → Task → End pool to prove real rendering.
   Deliberately simple — content/theming customised in T-0097+.
   -------------------------------------------------------------------------- */
const DEFAULT_DIAGRAM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             id="Definitions_choros"
             targetNamespace="http://choros.io/bpmn">
  <process id="Process_choros" isExecutable="false">
    <startEvent id="StartEvent_1" name="Счёт&#10;поступил">
      <outgoing>Flow_1</outgoing>
    </startEvent>
    <task id="Activity_1" name="Согласовать счёт">
      <incoming>Flow_1</incoming>
      <outgoing>Flow_2</outgoing>
    </task>
    <endEvent id="EndEvent_1" name="Платёж&#10;проведён">
      <incoming>Flow_2</incoming>
    </endEvent>
    <sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Activity_1" />
    <sequenceFlow id="Flow_2" sourceRef="Activity_1" targetRef="EndEvent_1" />
  </process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_choros">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="172" y="192" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="155" y="235" width="70" height="27" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Activity_1_di" bpmnElement="Activity_1">
        <dc:Bounds x="270" y="170" width="100" height="80" />
        <bpmndi:BPMNLabel />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1">
        <dc:Bounds x="432" y="192" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="415" y="235" width="70" height="27" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="208" y="210" />
        <di:waypoint x="270" y="210" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">
        <di:waypoint x="370" y="210" />
        <di:waypoint x="432" y="210" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;

/* --------------------------------------------------------------------------
   BpmnModelerWrapper
   Props:
     className  — extra CSS class on the container div
     style      — inline style on the container div
   Ref forwarded value:
     { modeler }  — the BpmnModeler instance (or null before mount)
   -------------------------------------------------------------------------- */
const BpmnModelerWrapper = forwardRef(function BpmnModelerWrapper(
  { className = '', style },
  ref
) {
  const containerRef = useRef(null);
  const modelerRef = useRef(null);

  useImperativeHandle(ref, () => ({
    get modeler() { return modelerRef.current; },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const modeler = new BpmnModeler({
      container: containerRef.current,
      // Keyboard shortcuts disabled for now — no custom binding needed yet
      keyboard: { bindTo: null },
    });

    modelerRef.current = modeler;

    modeler
      .importXML(DEFAULT_DIAGRAM_XML)
      .then(() => {
        // Fit the default diagram into the viewport after import
        modeler.get('canvas').zoom('fit-viewport', 'auto');
      })
      .catch((err) => {
        // Non-fatal: log parse errors but keep the modeler alive
        console.error('[choros/bpmn-modeler] importXML error:', err);
      });

    return () => {
      modeler.destroy();
      modelerRef.current = null;
    };
  }, []); // mount once — diagram XML is the default only (T-0099 adds load/save)

  return (
    <div
      ref={containerRef}
      className={`chs-bpmn-real-container ${className}`.trim()}
      style={style}
      // bpmn-js mounts its own DOM subtree (.djs-container) here
    />
  );
});

export default BpmnModelerWrapper;
