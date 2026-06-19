/* ============================================================================
   CHOROS — screen-process-editor.jsx
   T-0096: Process editor screen embedding the REAL bpmn-js modeler.
   T-0098: Properties panel (executor-type selector → live canvas recolor).
   T-0099: Save / Load / Validate wiring + validation error display.

   T-0323: entry points (from screen-processes.jsx) + toolbar wiring (undo/redo
   via commandStack, bottom-right zoom widget via canvas.zoom) + Publish disabled
   with «скоро» until T-0324. The legacy hand-rolled SVG mock (former
   canvas/screen-editor.jsx) was deleted — this is the only process editor for the
   routed /processes/:id/edit path.

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
import { Button, MonoId, StatusChip, KitIcon, Tooltip } from '../components/components.jsx';
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
          borderBottom: '1px solid var(--chs-color-success)',
          fontSize: 'var(--chs-text-sm)',
          color: 'var(--chs-color-success)',
          flexShrink: 0,
        }}
      >
        <span>Диаграмма валидна</span>
        <button
          onClick={onDismiss}
          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '0 var(--chs-space-3)', fontSize: 'var(--chs-text-sm)', display: 'inline-flex', alignItems: 'center' }}
          aria-label="Закрыть"
        >
          <KitIcon name="close" />
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
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--chs-color-text-muted)', padding: '0 var(--chs-space-3)', fontSize: 'var(--chs-text-sm)', display: 'inline-flex', alignItems: 'center' }}
          aria-label="Закрыть"
        >
          <KitIcon name="close" />
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
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '0 var(--chs-space-3)', display: 'inline-flex', alignItems: 'center' }}
        aria-label="Закрыть"
      >
        <KitIcon name="close" />
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
  canUndo,
  canRedo,
  onUndo,
  onRedo,
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
      {/* T-0323: Undo/Redo wired to the bpmn-js commandStack. Disabled (not a
          silent no-op) when there is nothing to undo/redo — principle §4. */}
      <div className="chs-edtoolbar__group">
        <button
          type="button"
          className="chs-iconbtn"
          title="Отменить"
          aria-label="Отменить"
          onClick={onUndo}
          disabled={!canUndo}
          aria-disabled={!canUndo || undefined}
          style={{ transform: 'scaleX(-1)' }}
        >
          <Icon name="chevron" />
        </button>
        <button
          type="button"
          className="chs-iconbtn"
          title="Повторить"
          aria-label="Повторить"
          onClick={onRedo}
          disabled={!canRedo}
          aria-disabled={!canRedo || undefined}
        >
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

      {/* Publish — backend wiring lands in a follow-up (T-0324). Until then the
          control is disabled with a «скоро» hint rather than left as a silent
          no-op enabled button (principle §4 affordance rule, gate G3). */}
      <Tooltip label="Скоро">
        <Button variant="primary" size="sm" disabled>
          Опубликовать
        </Button>
      </Tooltip>
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

  // T-0323: undo/redo availability, reflected from the bpmn-js commandStack so
  // the toolbar buttons are enabled only when there is history to walk.
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // T-0323: current canvas zoom (1 = 100%), shown + driven by the zoom widget.
  const [zoomLevel, setZoomLevel] = useState(1);

  // T-0098: onReady is called by BpmnModelerWrapper once importXML resolves.
  // Stable reference so the modeler wrapper's effect closure captures it.
  const handleModelerReady = useCallback((modeler) => {
    setLiveModeler(modeler);
    setIsDirty(false);

    // T-0099 + T-0323: listen for diagram changes — set the dirty flag and
    // refresh undo/redo availability from the commandStack.
    try {
      const eventBus = modeler.get('eventBus');
      const commandStack = modeler.get('commandStack');
      const syncHistory = () => {
        setIsDirty(true);
        setCanUndo(commandStack.canUndo());
        setCanRedo(commandStack.canRedo());
      };
      eventBus.on('commandStack.changed', syncHistory);
      // Initial state (no history yet on a fresh import).
      setCanUndo(commandStack.canUndo());
      setCanRedo(commandStack.canRedo());
    } catch (_) {
      // Non-fatal if eventBus/commandStack is not available
    }

    // T-0323: track zoom so the widget value stays in sync with canvas gestures.
    try {
      const canvas = modeler.get('canvas');
      setZoomLevel(canvas.zoom());
      const eventBus = modeler.get('eventBus');
      eventBus.on('canvas.viewbox.changed', () => setZoomLevel(canvas.zoom()));
    } catch (_) {
      // Non-fatal if canvas is not available
    }
  }, []);

  /* ------------------------------------------------------------------
     T-0323: Undo / Redo — drive the bpmn-js commandStack directly.
     ------------------------------------------------------------------ */
  const handleUndo = useCallback(() => {
    if (!liveModeler) return;
    try {
      const cs = liveModeler.get('commandStack');
      if (cs.canUndo()) cs.undo();
    } catch (_) { /* non-fatal */ }
  }, [liveModeler]);

  const handleRedo = useCallback(() => {
    if (!liveModeler) return;
    try {
      const cs = liveModeler.get('commandStack');
      if (cs.canRedo()) cs.redo();
    } catch (_) { /* non-fatal */ }
  }, [liveModeler]);

  /* ------------------------------------------------------------------
     T-0323: Zoom widget — canvas.zoom() in / out / reset + fit-viewport.
     ------------------------------------------------------------------ */
  const ZOOM_STEP = 0.2;
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 4;

  const applyZoom = useCallback((next) => {
    if (!liveModeler) return;
    try {
      const canvas = liveModeler.get('canvas');
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      canvas.zoom(clamped);
      setZoomLevel(canvas.zoom());
    } catch (_) { /* non-fatal */ }
  }, [liveModeler]);

  const handleZoomIn = useCallback(() => applyZoom(zoomLevel + ZOOM_STEP), [applyZoom, zoomLevel]);
  const handleZoomOut = useCallback(() => applyZoom(zoomLevel - ZOOM_STEP), [applyZoom, zoomLevel]);

  const handleZoomFit = useCallback(() => {
    if (!liveModeler) return;
    try {
      const canvas = liveModeler.get('canvas');
      canvas.zoom('fit-viewport', 'auto');
      setZoomLevel(canvas.zoom());
    } catch (_) { /* non-fatal */ }
  }, [liveModeler]);

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
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
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

          {/* T-0323: bottom-right zoom widget — wired to canvas.zoom().
              .chs-zoom skin already lives in editor.css; glyphs are typographic
              −/+ sized by .chs-zoom button (not emoji — principle §2). */}
          <div className="chs-zoom" role="group" aria-label="Масштаб">
            <button type="button" onClick={handleZoomOut} title="Уменьшить" aria-label="Уменьшить масштаб" disabled={!liveModeler}>
              <span aria-hidden="true">&minus;</span>
            </button>
            <button
              type="button"
              className="chs-zoom__val"
              onClick={handleZoomFit}
              title="Вписать в экран"
              aria-label="Вписать в экран"
              disabled={!liveModeler}
            >
              {Math.round(zoomLevel * 100)}%
            </button>
            <button type="button" onClick={handleZoomIn} title="Увеличить" aria-label="Увеличить масштаб" disabled={!liveModeler}>
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>

        {/* Right: properties panel (T-0098) — shows EmptyState until element selected */}
        <BpmnPropertiesPanel modeler={liveModeler} />
      </div>
    </div>
  );
}
