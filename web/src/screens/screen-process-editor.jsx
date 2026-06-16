/* ============================================================================
   CHOROS — screen-process-editor.jsx
   T-0096: Process editor screen embedding the REAL bpmn-js modeler.
   T-0098: Properties panel (executor-type selector → live canvas recolor).
   T-0099: Save / Load / Validate wiring + validation error display.

   This screen replaces the hand-rolled SVG mock in screen-editor.jsx for the
   routed /processes/:id/edit path. The mock (screen-editor.jsx) is preserved
   for reference and for the standalone preview/process-editor.html.

   Layout mirrors the mock:
     toolbar (top) | [canvas — real bpmn-js] | properties panel (right)

   T-0098 adds:
     - BpmnPropertiesPanel replacing the PropertiesPanelStub
     - onReady callback from BpmnModelerWrapper to pass the live modeler instance
       to BpmnPropertiesPanel once importXML has resolved

   T-0099 adds:
     - Save button: calls saveDiagram(modeler) → downloadXml() (browser download)
     - Load button: calls openXmlFilePicker() → loadDiagram(modeler, xml)
     - Validate button: calls validateDiagram(modeler) → surfaces errors/warnings
     - Inline validation result banner below the toolbar
     - Dirty tracking: "несохранённые изменения" dot appears on any diagram change
   ============================================================================ */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Button, MonoId, StatusChip } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import BpmnModelerWrapper from '../canvas/bpmn-modeler-wrapper.jsx';
import BpmnPropertiesPanel from '../canvas/bpmn-properties-panel.jsx';
import {
  saveDiagram,
  loadDiagram,
  validateDiagram,
  downloadXml,
  openXmlFilePicker,
} from '../canvas/bpmn-save-load.js';
import '../canvas/editor.css';

/* --------------------------------------------------------------------------
   ValidationBanner
   Shows validation errors and warnings below the toolbar.
   Dismiss button calls onDismiss().
   -------------------------------------------------------------------------- */
function ValidationBanner({ result, onDismiss }) {
  if (!result) return null;

  const hasErrors = result.errors && result.errors.length > 0;
  const hasWarnings = result.warnings && result.warnings.length > 0;
  if (!hasErrors && !hasWarnings) {
    // Valid and clean — show a brief green tick
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--chs-space-5)',
          padding: 'var(--chs-space-4) var(--chs-space-7)',
          background: 'var(--chs-color-success-soft)',
          borderBottom: '1px solid var(--chs-color-success-border, var(--chs-color-border))',
          fontSize: 'var(--chs-text-sm)',
          color: 'var(--chs-color-success)',
          flexShrink: 0,
        }}
      >
        <span>Диаграмма валидна</span>
        <button
          onClick={onDismiss}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '0 var(--chs-space-3)', fontSize: 'var(--chs-text-sm)' }}
          aria-label="Закрыть"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 'var(--chs-space-4) var(--chs-space-7)',
        background: hasErrors ? 'var(--chs-color-danger-soft)' : 'var(--chs-color-warning-soft)',
        borderBottom: '1px solid var(--chs-color-border)',
        flexShrink: 0,
        fontSize: 'var(--chs-text-sm)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 'var(--chs-space-3)' }}>
        <span
          style={{
            fontWeight: 'var(--chs-weight-semibold)',
            color: hasErrors ? 'var(--chs-color-danger)' : 'var(--chs-color-warning)',
            flex: 1,
          }}
        >
          {hasErrors
            ? `Ошибки валидации (${result.errors.length})`
            : `Предупреждения (${result.warnings.length})`}
        </span>
        <button
          onClick={onDismiss}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--chs-color-text-muted)', padding: '0 var(--chs-space-3)', fontSize: 'var(--chs-text-sm)' }}
          aria-label="Закрыть"
        >
          ✕
        </button>
      </div>

      {hasErrors && (
        <ul style={{ margin: 0, paddingLeft: 'var(--chs-space-6)', color: 'var(--chs-color-danger)', lineHeight: 'var(--chs-leading-snug)' }}>
          {result.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {hasWarnings && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 'var(--chs-space-6)', color: 'var(--chs-color-warning)', lineHeight: 'var(--chs-leading-snug)' }}>
          {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   SaveLoadStatusBanner
   Shows transient status messages (save OK, load error, etc.)
   Auto-dismisses after 4 seconds.
   -------------------------------------------------------------------------- */
function SaveLoadStatusBanner({ message, isError, onDismiss }) {
  useEffect(() => {
    if (!message) return;
    const id = setTimeout(onDismiss, 4000);
    return () => clearTimeout(id);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--chs-space-5)',
        padding: 'var(--chs-space-3) var(--chs-space-7)',
        background: isError ? 'var(--chs-color-danger-soft)' : 'var(--chs-color-success-soft)',
        borderBottom: '1px solid var(--chs-color-border)',
        fontSize: 'var(--chs-text-sm)',
        color: isError ? 'var(--chs-color-danger)' : 'var(--chs-color-success)',
        flexShrink: 0,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button
        onClick={onDismiss}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '0 var(--chs-space-3)' }}
        aria-label="Закрыть"
      >
        ✕
      </button>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Toolbar
   T-0099: Save / Load / Validate buttons are now wired.
   -------------------------------------------------------------------------- */
function EditorToolbar({
  processName,
  processId,
  isDirty,
  isBusy,
  onSave,
  onLoad,
  onValidate,
}) {
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
        <button className="chs-iconbtn" title="Отменить" aria-label="Undo">
          <Icon name="chevron" />
        </button>
        <button className="chs-iconbtn" title="Повторить" style={{ transform: 'scaleX(-1)' }} aria-label="Redo">
          <Icon name="chevron" />
        </button>
      </div>

      {/* Dirty indicator */}
      {isDirty && (
        <span className="chs-edtoolbar__dirty">несохранённые изменения</span>
      )}

      <div className="chs-edtoolbar__spacer" />
      <StatusChip status="paused" label="Не опубликован" />

      {/* T-0099: Load button — opens file picker, imports XML */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onLoad}
        disabled={isBusy}
        title="Загрузить BPMN-файл"
      >
        Загрузить
      </Button>

      {/* T-0099: Validate button — checks diagram and shows result */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onValidate}
        disabled={isBusy}
        title="Проверить диаграмму на валидность"
      >
        Проверить
      </Button>

      {/* T-0099: Save button — exports XML to browser download */}
      <Button
        variant="secondary"
        size="sm"
        onClick={onSave}
        disabled={isBusy}
        title="Сохранить BPMN XML (скачать файл)"
      >
        Сохранить
      </Button>

      {/* Publish — future T-0xxx */}
      <Button variant="primary" size="sm" disabled={isBusy}>
        Опубликовать
      </Button>
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

  // T-0099: dirty flag — set whenever the diagram changes
  const [isDirty, setIsDirty] = useState(false);

  // T-0099: busy flag — prevents concurrent save/load/validate
  const [isBusy, setIsBusy] = useState(false);

  // T-0099: validation result state (null = no result yet)
  const [validationResult, setValidationResult] = useState(null);

  // T-0099: transient save/load status message
  const [statusMsg, setStatusMsg] = useState(null);   // { text: string, isError: bool }

  // T-0098: onReady is called by BpmnModelerWrapper once importXML resolves.
  // Stable reference so the modeler wrapper's effect closure captures it.
  const handleModelerReady = useCallback((modeler) => {
    setLiveModeler(modeler);
    setIsDirty(false);

    // T-0099: listen for any diagram changes to set the dirty flag
    try {
      const eventBus = modeler.get('eventBus');
      eventBus.on('commandStack.changed', () => setIsDirty(true));
    } catch (_) {
      // Non-fatal if eventBus is not available
    }
  }, []);

  /* ------------------------------------------------------------------
     T-0099: Save handler
     Calls saveDiagram → downloadXml. Sets dirty=false on success.
     ------------------------------------------------------------------ */
  const handleSave = useCallback(async () => {
    const modeler = liveModeler;
    if (!modeler || isBusy) return;

    setIsBusy(true);
    try {
      const { xml } = await saveDiagram(modeler);
      const filename = id ? `${id}.bpmn` : 'process.bpmn';
      downloadXml(xml, filename);
      setIsDirty(false);
      setStatusMsg({ text: `Файл ${filename} сохранён`, isError: false });
      // Clear any stale validation result
      setValidationResult(null);
    } catch (err) {
      setStatusMsg({ text: `Ошибка сохранения: ${err.message || String(err)}`, isError: true });
    } finally {
      setIsBusy(false);
    }
  }, [liveModeler, isBusy, id]);

  /* ------------------------------------------------------------------
     T-0099: Load handler
     Opens a file picker, reads XML, imports into modeler.
     ------------------------------------------------------------------ */
  const handleLoad = useCallback(async () => {
    const modeler = liveModeler;
    if (!modeler || isBusy) return;

    setIsBusy(true);
    try {
      const xml = await openXmlFilePicker();
      const { warnings } = await loadDiagram(modeler, xml);
      setIsDirty(false);
      setValidationResult(null);
      if (warnings.length > 0) {
        setStatusMsg({ text: `Диаграмма загружена с ${warnings.length} предупреждением(-ями)`, isError: false });
      } else {
        setStatusMsg({ text: 'Диаграмма успешно загружена', isError: false });
      }
    } catch (err) {
      if (err.message === 'Отменено пользователем') {
        // User closed the picker — not an error
      } else {
        setStatusMsg({ text: `Ошибка загрузки: ${err.message || String(err)}`, isError: true });
      }
    } finally {
      setIsBusy(false);
    }
  }, [liveModeler, isBusy]);

  /* ------------------------------------------------------------------
     T-0099: Validate handler
     Runs validateDiagram and shows result in the ValidationBanner.
     ------------------------------------------------------------------ */
  const handleValidate = useCallback(async () => {
    const modeler = liveModeler;
    if (!modeler || isBusy) return;

    setIsBusy(true);
    try {
      const result = await validateDiagram(modeler);
      setValidationResult(result);
      setStatusMsg(null);
    } catch (err) {
      setStatusMsg({ text: `Ошибка валидации: ${err.message || String(err)}`, isError: true });
    } finally {
      setIsBusy(false);
    }
  }, [liveModeler, isBusy]);

  // Derive a display name from the route id param
  const processName = id
    ? id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'Редактор процесса';
  const processId = id ? id.toUpperCase() : 'PRC-EDITOR';

  return (
    <div className="chs-editor" data-screen-label="Редактор процесса" style={{ height: '100%' }}>
      <EditorToolbar
        processName={processName}
        processId={processId}
        isDirty={isDirty}
        isBusy={isBusy}
        onSave={handleSave}
        onLoad={handleLoad}
        onValidate={handleValidate}
      />

      {/* T-0099: Validation result banner */}
      <ValidationBanner
        result={validationResult}
        onDismiss={() => setValidationResult(null)}
      />

      {/* T-0099: Transient save/load status */}
      <SaveLoadStatusBanner
        message={statusMsg && statusMsg.text}
        isError={statusMsg && statusMsg.isError}
        onDismiss={() => setStatusMsg(null)}
      />

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
