/* ============================================================================
   CHOROS — screen-process-editor.jsx
   T-0096: Process editor screen embedding the REAL bpmn-js modeler.

   This screen replaces the hand-rolled SVG mock in screen-editor.jsx for the
   routed /processes/:id/edit path. The mock (screen-editor.jsx) is preserved
   for reference and for the standalone preview/process-editor.html.

   Layout mirrors the mock:
     toolbar (top) | [canvas — real bpmn-js] | properties panel (right stub)

   Properties panel is a structural stub here — full customisation is T-0098.
   ============================================================================ */

import React, { useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, MonoId, StatusChip } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import BpmnModelerWrapper from '../canvas/bpmn-modeler-wrapper.jsx';
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
   Properties panel stub (T-0098 will flesh this out)
   -------------------------------------------------------------------------- */
function PropertiesPanelStub() {
  return (
    <div
      className="bio-properties-panel-container"
      style={{ borderLeft: '1px solid var(--chs-color-border)' }}
    >
      <div className="bio-properties-panel">
        <div className="bio-properties-panel-header" style={{ padding: 'var(--chs-space-5)' }}>
          <span className="bio-properties-panel-header-labels">
            <span className="bio-properties-panel-header-type" style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-faint)' }}>
              Выберите элемент диаграммы
            </span>
            <span className="bio-properties-panel-header-label" style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-faint)' }}>
              Панель свойств — T-0098
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Main screen
   -------------------------------------------------------------------------- */
export default function ProcessEditorScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const modelerRef = useRef(null);

  // Derive a display name from the route id param
  const processName = id
    ? id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Редактор процесса';
  const processId = id ? id.toUpperCase() : 'PRC-EDITOR';

  return (
    <div className="chs-editor" data-screen-label="Редактор процесса" style={{ height: '100%' }}>
      <EditorToolbar processName={processName} processId={processId} />

      <div className="chs-editor__body">
        {/* Left: real bpmn-js canvas */}
        <div className="chs-canvas-outer">
          <BpmnModelerWrapper
            ref={modelerRef}
            style={{ position: 'absolute', inset: 0 }}
          />
        </div>

        {/* Right: properties panel stub */}
        <PropertiesPanelStub />
      </div>
    </div>
  );
}
