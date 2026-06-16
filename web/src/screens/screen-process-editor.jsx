/* ============================================================================
   CHOROS — screen-process-editor.jsx
   T-0096: Process editor screen embedding the REAL bpmn-js modeler.
   T-0098: Properties panel (executor-type selector → live canvas recolor).

   This screen replaces the hand-rolled SVG mock in screen-editor.jsx for the
   routed /processes/:id/edit path. The mock (screen-editor.jsx) is preserved
   for reference and for the standalone preview/process-editor.html.

   Layout mirrors the mock:
     toolbar (top) | [canvas — real bpmn-js] | properties panel (right)

   T-0098 adds:
     - BpmnPropertiesPanel replacing the PropertiesPanelStub
     - onReady callback from BpmnModelerWrapper to pass the live modeler instance
       to BpmnPropertiesPanel once importXML has resolved
   ============================================================================ */

import React, { useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Button, MonoId, StatusChip } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import BpmnModelerWrapper from '../canvas/bpmn-modeler-wrapper.jsx';
import BpmnPropertiesPanel from '../canvas/bpmn-properties-panel.jsx';
import '../canvas/editor.css';

/* --------------------------------------------------------------------------
   Toolbar
   -------------------------------------------------------------------------- */
function EditorToolbar({ processName, processId }) {
  return (
    <div className="chs-edtoolbar">
      <div className="chs-edtoolbar__id">
        <span className="chs-edtoolbar__name">
          {processName || 'Процесс'}
        </span>
      </div>
      <div className="chs-edtoolbar__meta">
        <MonoId>{processId || 'PRC-UNKNOWN'}</MonoId>
        <MonoId>v1 · черновик</MonoId>
      </div>
      <div className="chs-edtoolbar__sep" />
      <div className="chs-edtoolbar__group">
        <button className="chs-iconbtn" title="Отменить">
          <Icon name="chevron" />
        </button>
        <button className="chs-iconbtn" title="Повторить" style={{ transform: 'scaleX(-1)' }}>
          <Icon name="chevron" />
        </button>
      </div>
      <span className="chs-edtoolbar__dirty">несохранённые изменения</span>
      <div className="chs-edtoolbar__spacer" />
      <StatusChip status="paused" label="Не опубликован" />
      <Button variant="ghost" size="sm">Проверить</Button>
      <Button variant="secondary" size="sm">Сохранить</Button>
      <Button variant="primary" size="sm">Опубликовать</Button>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Main screen
   -------------------------------------------------------------------------- */
export default function ProcessEditorScreen() {
  const { id } = useParams();
  const modelerWrapperRef = useRef(null);

  // T-0098: hold the live modeler instance in state so BpmnPropertiesPanel
  // re-renders with the instance as soon as importXML has resolved.
  const [liveModeler, setLiveModeler] = useState(null);

  // T-0098: onReady is called by BpmnModelerWrapper once importXML resolves.
  // Stable reference so the modeler wrapper's effect closure captures it.
  const handleModelerReady = useCallback((modeler) => {
    setLiveModeler(modeler);
  }, []);

  // Derive a display name from the route id param
  const processName = id
    ? id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Редактор процесса';
  const processId = id ? id.toUpperCase() : 'PRC-EDITOR';

  return (
    <div className="chs-editor" data-screen-label="Редактор процесса" style={{ height: '100%' }}>
      <EditorToolbar processName={processName} processId={processId} />

      <div className="chs-editor__body">
        {/* Left: real bpmn-js canvas (T-0096 + T-0097 palette + T-0098 palette provider) */}
        <div className="chs-canvas-outer">
          <BpmnModelerWrapper
            ref={modelerWrapperRef}
            style={{ position: 'absolute', inset: 0 }}
            onReady={handleModelerReady}
          />
        </div>

        {/* Right: properties panel (T-0098) — shows EmptyState until element selected */}
        <BpmnPropertiesPanel modeler={liveModeler} />
      </div>
    </div>
  );
}
