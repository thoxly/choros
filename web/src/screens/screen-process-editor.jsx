/* ============================================================================
   CHOROS — screen-process-editor.jsx
   T-0096: Process editor screen embedding the REAL bpmn-js modeler.
   T-0098: Properties panel (executor-type selector → live canvas recolor).
   T-0099: Save / Load / Validate wiring + validation error display.
   T-0323: entry points (from screen-processes.jsx) + toolbar wiring (undo/redo
           via commandStack, bottom-right zoom widget via canvas.zoom).
   T-0324: Real backend wiring:
     - Load: fetches BPMN XML from GET /api/process-defs/:key on mount.
       Uses blank BPMN template when creating a new (/processes/new/edit) or
       when the backend has no record for the key yet (404).
     - Save: persists XML to POST /api/process-defs (upsert draft) — NOT a
       browser download. The old download is kept as a secondary "Экспорт" button.
     - Publish: POST /api/process-defs/:key/publish — lint → Flowable deploy →
       deployment_id persisted. 422 lint errors are surfaced in the error banner.
     - Errors → banners (kit ErrorState-styled inline banners), never silent.

   Layout mirrors the mock:
     toolbar (top) | [canvas — real bpmn-js] | properties panel (right)
   ============================================================================ */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Button, MonoId, StatusChip, KitIcon, Tooltip, LoadingState, ErrorState } from '../components/components.jsx';
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
import {
  fetchProcessDef,
  saveProcessDef,
  publishProcessDef,
} from '../canvas/process-editor-api.js';
import '../canvas/editor.css';

/* --------------------------------------------------------------------------
   Minimal blank BPMN template — used when creating a new definition that has
   no backend record yet (404 from fetchProcessDef or /processes/new/edit).
   -------------------------------------------------------------------------- */
const BLANK_BPMN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:choros="http://choros.io/bpmn"
             id="Definitions_new"
             targetNamespace="http://choros.io/bpmn">
  <process id="Process_new" isExecutable="false">
    <startEvent id="StartEvent_1" name="Начало">
      <outgoing>Flow_1</outgoing>
    </startEvent>
    <endEvent id="EndEvent_1" name="Конец">
      <incoming>Flow_1</incoming>
    </endEvent>
    <sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="EndEvent_1" />
  </process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_new">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="152" y="252" width="36" height="36" />
        <bpmndi:BPMNLabel><dc:Bounds x="145" y="295" width="50" height="14" /></bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1">
        <dc:Bounds x="422" y="252" width="36" height="36" />
        <bpmndi:BPMNLabel><dc:Bounds x="415" y="295" width="50" height="14" /></bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="188" y="270" />
        <di:waypoint x="422" y="270" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;

/* --------------------------------------------------------------------------
   ValidationBanner
   Shows validation errors and warnings below the toolbar.
   -------------------------------------------------------------------------- */
function ValidationBanner({ result, onDismiss }) {
  if (!result) return null;

  const hasErrors = result.errors && result.errors.length > 0;
  const hasWarnings = result.warnings && result.warnings.length > 0;
  if (!hasErrors && !hasWarnings) {
    return (
      <div className="chs-banner chs-banner--success">
        <span className="chs-banner__msg">Диаграмма валидна</span>
        <button
          type="button"
          className="chs-banner__close"
          onClick={onDismiss}
          aria-label="Закрыть"
        >
          <KitIcon name="close" />
        </button>
      </div>
    );
  }

  return (
    <div className={`chs-banner ${hasErrors ? 'chs-banner--danger' : 'chs-banner--warning'}`}>
      <div className="chs-banner__header">
        <span className="chs-banner__title">
          {hasErrors
            ? `Ошибки валидации (${result.errors.length})`
            : `Предупреждения (${result.warnings.length})`}
        </span>
        <button
          type="button"
          className="chs-banner__close"
          onClick={onDismiss}
          aria-label="Закрыть"
        >
          <KitIcon name="close" />
        </button>
      </div>
      {hasErrors && (
        <ul className="chs-banner__list">
          {result.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {hasWarnings && (
        <ul className="chs-banner__list chs-banner__list--warning">
          {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   StatusBanner
   Shows transient status messages (save OK, load error, publish result, etc.)
   Auto-dismisses after 5 seconds.
   -------------------------------------------------------------------------- */
function StatusBanner({ message, isError, violations, onDismiss }) {
  useEffect(() => {
    if (!message) return;
    const id = setTimeout(onDismiss, isError ? 8000 : 5000);
    return () => clearTimeout(id);
  }, [message, isError, onDismiss]);

  if (!message) return null;

  return (
    <div className={`chs-banner ${isError ? 'chs-banner--danger' : 'chs-banner--success'}`}>
      <div className="chs-banner__header">
        <span className="chs-banner__msg">{message}</span>
        <button
          type="button"
          className="chs-banner__close"
          onClick={onDismiss}
          aria-label="Закрыть"
        >
          <KitIcon name="close" />
        </button>
      </div>
      {violations && violations.length > 0 && (
        <ul className="chs-banner__list">
          {violations.map((v, i) => <li key={i}>{typeof v === 'string' ? v : JSON.stringify(v)}</li>)}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Toolbar
   T-0323: Undo/Redo wired to commandStack.
   T-0324: Save persists to backend; Publish enabled + wired.
             "Экспорт" secondary button kept for browser download affordance.
   -------------------------------------------------------------------------- */
function EditorToolbar({
  processName,
  processId,
  processStatus,
  isDirty,
  isBusy,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  onExport,
  onLoad,
  onValidate,
  onPublish,
}) {
  const statusLabel = processStatus === 'published' ? 'Опубликован' : 'Черновик';
  const statusVal = processStatus === 'published' ? 'done' : 'paused';

  return (
    <div className="chs-edtoolbar">
      <div className="chs-edtoolbar__id">
        <span className="chs-edtoolbar__name">
          {processName || 'Процесс'}
        </span>
      </div>
      <div className="chs-edtoolbar__meta">
        <MonoId>{processId || 'PRC-UNKNOWN'}</MonoId>
      </div>
      <div className="chs-edtoolbar__sep" />
      {/* T-0323: Undo/Redo */}
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

      {isDirty && (
        <span className="chs-edtoolbar__dirty">несохранённые изменения</span>
      )}

      <div className="chs-edtoolbar__spacer" />
      <StatusChip status={statusVal} label={statusLabel} />

      {/* Загрузить: open file picker */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onLoad}
        disabled={isBusy}
        title="Загрузить BPMN-файл с диска"
      >
        Загрузить
      </Button>

      {/* Проверить: validate diagram */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onValidate}
        disabled={isBusy}
        title="Проверить диаграмму на валидность"
      >
        Проверить
      </Button>

      {/* Экспорт: secondary browser-download affordance (T-0099 behaviour kept) */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onExport}
        disabled={isBusy}
        title="Скачать BPMN XML как файл"
      >
        Экспорт
      </Button>

      {/* T-0324: Save = persist to backend */}
      <Button
        variant="secondary"
        size="sm"
        onClick={onSave}
        disabled={isBusy}
        title="Сохранить черновик в системе"
      >
        Сохранить
      </Button>

      {/* T-0324: Publish = real lint + Flowable deploy */}
      <Button
        variant="primary"
        size="sm"
        onClick={onPublish}
        disabled={isBusy}
        title="Опубликовать и задеплоить в движок"
      >
        Опубликовать
      </Button>
    </div>
  );
}

/* --------------------------------------------------------------------------
   Main screen
   T-0324: Load-from-backend lifecycle:
     1. On mount, fetch process definition XML from backend by route :id.
     2. Render <LoadingState> while fetching.
     3. On error, render <ErrorState> with retry.
     4. On success (or 404=new), pass fetched XML as `initialXml` to wrapper.
     5. Save persists to backend; Publish calls publish endpoint.
   -------------------------------------------------------------------------- */
export default function ProcessEditorScreen() {
  const { id } = useParams();
  const modelerWrapperRef = useRef(null);

  // T-0324: backend-load state
  const [loadPhase, setLoadPhase] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [loadError, setLoadError] = useState(null);
  const [initialXml, setInitialXml] = useState(null);
  const [backendMeta, setBackendMeta] = useState(null); // { name, version, status } from backend

  // T-0098: hold the live modeler instance in state
  const [liveModeler, setLiveModeler] = useState(null);

  // T-0099: dirty flag
  const [isDirty, setIsDirty] = useState(false);

  // T-0099: busy flag — prevents concurrent save/load/validate/publish
  const [isBusy, setIsBusy] = useState(false);

  // T-0099: validation result state
  const [validationResult, setValidationResult] = useState(null);

  // T-0324: transient status banner (save / publish results)
  const [statusMsg, setStatusMsg] = useState(null); // { text, isError, violations? }

  // T-0323: undo/redo availability
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // T-0323: current canvas zoom
  const [zoomLevel, setZoomLevel] = useState(1);

  // T-0324: process key — the :id param (never "new" — that triggers blank template)
  const isNew = !id || id === 'new';
  const processKey = isNew ? null : id;

  // T-0324: derived process name from backendMeta or route param
  const processName = backendMeta?.name
    || (processKey ? processKey.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Новый процесс');
  const processId = processKey ? processKey.toUpperCase() : 'PRC-NEW';
  const processStatus = backendMeta?.status || 'draft';

  /* ------------------------------------------------------------------
     T-0324: Load definition from backend on mount.
     ------------------------------------------------------------------ */
  const doLoad = useCallback(async () => {
    setLoadPhase('loading');
    setLoadError(null);

    try {
      if (isNew || !processKey) {
        // New definition — use blank template
        setInitialXml(BLANK_BPMN_XML);
        setBackendMeta(null);
        setLoadPhase('ready');
        return;
      }

      const def = await fetchProcessDef(processKey);
      if (!def) {
        // 404 — first time editing this key, use blank template
        setInitialXml(BLANK_BPMN_XML);
        setBackendMeta(null);
      } else {
        setInitialXml(def.bpmnXml);
        setBackendMeta({ name: def.name, version: def.version, status: def.status });
      }
      setLoadPhase('ready');
    } catch (err) {
      setLoadError(err.message || String(err));
      setLoadPhase('error');
    }
  }, [isNew, processKey]);

  useEffect(() => {
    doLoad();
  }, [doLoad]);

  /* ------------------------------------------------------------------
     T-0098: onReady callback from BpmnModelerWrapper.
     ------------------------------------------------------------------ */
  const handleModelerReady = useCallback((modeler) => {
    setLiveModeler(modeler);
    setIsDirty(false);

    try {
      const eventBus = modeler.get('eventBus');
      const commandStack = modeler.get('commandStack');
      const syncHistory = () => {
        setIsDirty(true);
        setCanUndo(commandStack.canUndo());
        setCanRedo(commandStack.canRedo());
      };
      eventBus.on('commandStack.changed', syncHistory);
      setCanUndo(commandStack.canUndo());
      setCanRedo(commandStack.canRedo());
    } catch (_) { /* non-fatal */ }

    try {
      const canvas = modeler.get('canvas');
      setZoomLevel(canvas.zoom());
      const eventBus = modeler.get('eventBus');
      eventBus.on('canvas.viewbox.changed', () => setZoomLevel(canvas.zoom()));
    } catch (_) { /* non-fatal */ }
  }, []);

  /* ------------------------------------------------------------------
     T-0323: Undo / Redo
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
     T-0323: Zoom widget
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
     T-0324: Save handler — persist to backend, not browser download.
     ------------------------------------------------------------------ */
  const handleSave = useCallback(async () => {
    const modeler = liveModeler;
    if (!modeler || isBusy) return;

    setIsBusy(true);
    try {
      const { xml } = await saveDiagram(modeler);
      const key = processKey || 'process-new';
      const name = processName || key;
      const result = await saveProcessDef(key, name, xml);
      setIsDirty(false);
      setBackendMeta((prev) => ({ ...prev, version: result.version, status: result.status }));
      setStatusMsg({ text: `Черновик сохранён (версия ${result.version})`, isError: false });
      setValidationResult(null);
    } catch (err) {
      setStatusMsg({ text: err.message || String(err), isError: true });
    } finally {
      setIsBusy(false);
    }
  }, [liveModeler, isBusy, processKey, processName]);

  /* ------------------------------------------------------------------
     T-0324: Export handler — secondary browser download (kept from T-0099).
     ------------------------------------------------------------------ */
  const handleExport = useCallback(async () => {
    const modeler = liveModeler;
    if (!modeler || isBusy) return;

    setIsBusy(true);
    try {
      const { xml } = await saveDiagram(modeler);
      const filename = processKey ? `${processKey}.bpmn` : 'process.bpmn';
      downloadXml(xml, filename);
      setStatusMsg({ text: `Файл ${filename} скачан`, isError: false });
    } catch (err) {
      setStatusMsg({ text: `Ошибка экспорта: ${err.message || String(err)}`, isError: true });
    } finally {
      setIsBusy(false);
    }
  }, [liveModeler, isBusy, processKey]);

  /* ------------------------------------------------------------------
     T-0099: Load handler — open file picker, import XML into modeler.
     ------------------------------------------------------------------ */
  const handleLoad = useCallback(async () => {
    const modeler = liveModeler;
    if (!modeler || isBusy) return;

    setIsBusy(true);
    try {
      const xml = await openXmlFilePicker();
      const { warnings } = await loadDiagram(modeler, xml);
      setIsDirty(true);
      setValidationResult(null);
      if (warnings.length > 0) {
        setStatusMsg({ text: `Файл загружен с ${warnings.length} предупреждением(-ями)`, isError: false });
      } else {
        setStatusMsg({ text: 'Файл успешно загружен', isError: false });
      }
    } catch (err) {
      if (err.message === 'Отменено пользователем') {
        // cancelled — not an error
      } else {
        setStatusMsg({ text: `Ошибка загрузки файла: ${err.message || String(err)}`, isError: true });
      }
    } finally {
      setIsBusy(false);
    }
  }, [liveModeler, isBusy]);

  /* ------------------------------------------------------------------
     T-0099: Validate handler
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

  /* ------------------------------------------------------------------
     T-0324: Publish handler — lint + Flowable deploy via backend.
     Honest: if Flowable is down or key is missing, shows real error.
     ------------------------------------------------------------------ */
  const handlePublish = useCallback(async () => {
    const modeler = liveModeler;
    if (!modeler || isBusy) return;

    if (!processKey) {
      setStatusMsg({
        text: 'Сначала сохраните черновик с ключом процесса, затем опубликуйте.',
        isError: true,
      });
      return;
    }

    setIsBusy(true);
    try {
      // First save the current XML so the backend publishes the latest version.
      const { xml } = await saveDiagram(modeler);
      const name = processName || processKey;
      const saved = await saveProcessDef(processKey, name, xml);

      // Then publish (lint → deploy → persist deployment_id).
      const pub = await publishProcessDef(processKey);
      setIsDirty(false);
      setBackendMeta((prev) => ({
        ...prev,
        version: pub.version ?? saved.version,
        status: 'published',
      }));
      setStatusMsg({
        text: `Опубликовано (версия ${pub.version ?? saved.version}, deployment: ${pub.deploymentId})`,
        isError: false,
      });
      setValidationResult(null);
    } catch (err) {
      setStatusMsg({
        text: err.message || String(err),
        isError: true,
        violations: err.violations || null,
      });
    } finally {
      setIsBusy(false);
    }
  }, [liveModeler, isBusy, processKey, processName]);

  /* ------------------------------------------------------------------
     Render: loading / error / ready
     ------------------------------------------------------------------ */
  if (loadPhase === 'loading') {
    return (
      <div className="chs-editor" data-screen-label="Редактор процесса" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LoadingState label="Загрузка диаграммы..." />
      </div>
    );
  }

  if (loadPhase === 'error') {
    return (
      <div className="chs-editor" data-screen-label="Редактор процесса" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <ErrorState
          title="Ошибка загрузки процесса"
          message={loadError}
          onRetry={doLoad}
          retryLabel="Повторить"
        />
      </div>
    );
  }

  return (
    <div className="chs-editor" data-screen-label="Редактор процесса" style={{ height: '100%' }}>
      <EditorToolbar
        processName={processName}
        processId={processId}
        processStatus={processStatus}
        isDirty={isDirty}
        isBusy={isBusy}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onSave={handleSave}
        onExport={handleExport}
        onLoad={handleLoad}
        onValidate={handleValidate}
        onPublish={handlePublish}
      />

      {/* T-0099: Validation result banner */}
      <ValidationBanner
        result={validationResult}
        onDismiss={() => setValidationResult(null)}
      />

      {/* T-0324: Status banner (save / publish / error) */}
      <StatusBanner
        message={statusMsg && statusMsg.text}
        isError={statusMsg && statusMsg.isError}
        violations={statusMsg && statusMsg.violations}
        onDismiss={() => setStatusMsg(null)}
      />

      <div className="chs-editor__body">
        {/* Left: real bpmn-js canvas */}
        <div className="chs-canvas-outer">
          <BpmnModelerWrapper
            ref={modelerWrapperRef}
            style={{ position: 'absolute', inset: 0 }}
            onReady={handleModelerReady}
            initialXml={initialXml}
          />

          {/* T-0323: bottom-right zoom widget */}
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

        {/* Right: properties panel (T-0098) */}
        <BpmnPropertiesPanel modeler={liveModeler} />
      </div>
    </div>
  );
}
