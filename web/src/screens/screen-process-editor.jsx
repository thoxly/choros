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
import { useParams, useNavigate } from 'react-router-dom';
import { Button, MonoId, StatusChip, KitIcon, Tooltip, LoadingState, ErrorState, ConfirmDialog } from '../components/components.jsx';
import { ConsequenceSummary, useDestructiveConfirm } from '../util/confirm-helpers.jsx';
import { useDirtyGuard } from '../hooks/useDirtyGuard.js';
import { formatJsonReadable } from '../lib/format.js';
import { formatElementLabel, humanizeViolation } from '../lib/violation-i18n.js';
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
// T-0684 [capstone T-0647 P1]: pre-flight name guard — block save/publish before the
// network call when the author never gave the process a real human name.
import {
  isRejectedProcessName,
  PROCESS_NAME_REQUIRED_MESSAGE,
  UNNAMED_PROCESS_PLACEHOLDER,
} from './process-name-policy.js';
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
export function ValidationBanner({ result, onDismiss }) {
  if (!result) return null;

  const hasErrors = result.errors && result.errors.length > 0;
  const hasWarnings = result.warnings && result.warnings.length > 0;
  // T-0484 (honesty): only show the GREEN "валидна" state when validation
  // actually reported valid === true. Previously an empty errors+warnings list
  // alone painted green — so a result that was NOT valid but happened to carry
  // no listed messages would falsely read as success. Never show invalid as green.
  if (result.valid === true && !hasErrors && !hasWarnings) {
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

  // T-0484: "invalid" outranks "warning". If validation failed (valid === false)
  // treat it as a danger banner even when no specific messages were listed —
  // never downgrade a failed validation to a soft yellow warning.
  const isDanger = hasErrors || result.valid === false;

  return (
    <div className={`chs-banner ${isDanger ? 'chs-banner--danger' : 'chs-banner--warning'}`}>
      <div className="chs-banner__header">
        <span className="chs-banner__title">
          {hasErrors
            ? `Ошибки валидации (${result.errors.length})`
            : result.valid === false
              ? 'Диаграмма не валидна'
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
   T-0659: publish-time lint violations arrive from the server as structured
   objects (src/core/bpmn-linter.ts LintViolation: { type, elementId,
   elementKind, message }) — NOT plain strings. Piping one of those through
   formatJsonReadable() JSON.stringifies the whole envelope and then hard-caps
   it at 120 characters, so the actionable "Fix: ..." guidance that lives at
   the TAIL of a long .message (e.g. timer_escalation_no_convergence) gets
   eaten by the {type,elementId,elementKind} prefix and never reaches the
   builder. VIOLATION_TYPE_LABELS translates the machine `type` into a human
   rule title; the .message itself is always rendered IN FULL below it —
   never truncated. Additive: any LintViolationType not yet listed here still
   renders (falls back to the raw type string), it just isn't translated.

   T-0761: T-0659's own follow-up review (docs/tasks/T-0659.ux-review.json,
   findings -N2/-N3) flagged that this was only half the job — the TITLE was
   Russian but the .message BODY + fix-hint stayed raw English/XML-technical
   (authored server-side, out of this file's scope to rewrite — see
   web/src/lib/violation-i18n.js's header for why), and elementKind rendered
   as raw BPMN camelCase ("boundaryEvent") mid-sentence. violation-i18n.js
   (same additive/fallback-safe mechanism as VIOLATION_TYPE_LABELS) now
   supplies: ELEMENT_KIND_LABELS (elementKind -> human Russian) and
   humanizeViolation() (per-type Russian detail + "как починить" hint,
   falling back to the raw .message, still shown in FULL, for any shape it
   does not recognise).
   -------------------------------------------------------------------------- */
const VIOLATION_TYPE_LABELS = {
  raw_object_binding: 'Несвязанный объект',
  malformed_xml: 'Повреждённый XML',
  binding_mismatch: 'Несовпадение привязки данных',
  gateway_rule_mismatch: 'Несовпадение условия шлюза',
  parallel_gateway_imbalance: 'Разветвление шлюза не сходится',
  timer_malformed: 'Некорректно настроен таймер',
  message_event_incoherent: 'Несогласованное событие-сообщение',
  agent_task_incoherent: 'Несогласованно настроен агентский шаг',
  timer_escalation_no_convergence: 'Ветка эскалации таймера не сходится с основным потоком',
  // T-0661 [ADR-T0612 §8]: convergence alone is not enough — a converging
  // gateway is an uncontrolled merge, so once the timer fires and spawns a
  // second concurrent token, only a scope-local terminateEndEvent can resolve
  // it. This distinct violation names that unresolved case.
  timer_escalation_unresolved_concurrency: 'Эскалация таймера сходится с потоком, но не гасит конкурирующую задачу',
  app_binding_unpublished: 'Привязано неопубликованное приложение',
  step_target_unresolved: 'Не определена цель результата шага',
};

/**
 * Renders ONE publish/lint violation. Structured violations (anything with a
 * string .message — the LintViolation shape) get a human rule title, the
 * element context (elementKind translated via ELEMENT_KIND_LABELS — T-0761),
 * a Russian detail sentence + "Как починить" hint when humanizeViolation()
 * recognises the message shape (T-0761), and the message rendered in full
 * underneath — never truncated, kept verbatim even when translated (so a
 * developer/support escalation always has the exact server text to hand).
 * Plain strings (e.g. legacy warning entries) render as-is. Anything else
 * falls back to formatJsonReadable, matching prior behaviour for shapes the
 * linter has never actually emitted.
 */
export function ViolationItem({ v }) {
  if (typeof v === 'string') return <li>{v}</li>;
  if (v && typeof v === 'object' && typeof v.message === 'string') {
    const title = VIOLATION_TYPE_LABELS[v.type] || v.type || 'Нарушение проверки';
    const elementLabel = formatElementLabel(v);
    const { detail, fix, matched } = humanizeViolation(v);
    return (
      <li className="chs-banner__violation">
        <div className="chs-banner__violation-title">
          {title}
          {elementLabel ? <span className="chs-banner__violation-element"> — {elementLabel}</span> : null}
        </div>
        {matched ? <div className="chs-banner__violation-detail">{detail}</div> : null}
        {fix ? <div className="chs-banner__violation-fix">Как починить: {fix}</div> : null}
        <div className="chs-banner__violation-message">{v.message}</div>
      </li>
    );
  }
  return <li>{formatJsonReadable(v)}</li>;
}

/* --------------------------------------------------------------------------
   StatusBanner
   Shows transient status messages (save OK, load error, publish result, etc.)
   Auto-dismisses after 5 seconds.
   -------------------------------------------------------------------------- */
export function StatusBanner({ message, isError, violations, onDismiss }) {
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
          {violations.map((v, i) => <ViolationItem key={i} v={v} />)}
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
  // T-0684 [capstone T-0647 P1]: editable process-name field.
  nameDraft,
  onNameChange,
  namePlaceholder,
  nameInvalid,
  // T-0437: optional entry point to the branch-rules editor. Only supplied when
  // a real processKey exists (not for unsaved new processes).
  onBranchRules,
}) {
  const statusLabel = processStatus === 'published' ? 'Опубликован' : 'Черновик';
  const statusVal = processStatus === 'published' ? 'done' : 'paused';

  return (
    <div className="chs-edtoolbar">
      <div className="chs-edtoolbar__id">
        {/* T-0684: the name is an EDITABLE input, not derived text — the author must
            give the process a real human name (empty/placeholder is rejected on
            save/publish). aria-invalid + a hint below surface the requirement. */}
        <input
          type="text"
          className={`chs-edtoolbar__name-input${nameInvalid ? ' chs-edtoolbar__name-input--invalid' : ''}`}
          value={nameDraft}
          placeholder={namePlaceholder}
          onChange={(e) => onNameChange(e.target.value)}
          aria-label="Название процесса"
          aria-invalid={nameInvalid || undefined}
          title="Название процесса, которое увидят сотрудники"
        />
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

      {/* T-0437: Правила ветвления — only shown when a real processKey exists. */}
      {onBranchRules && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onBranchRules}
          disabled={isBusy}
          title="Редактор правил ветвления для этого процесса"
        >
          Правила ветвления
        </Button>
      )}

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

      {/* T-0526: визуальный разделитель между сохранением и публикацией */}
      <span className="chs-edtoolbar__pub-sep" aria-hidden="true" />

      {/* T-0324/T-0526: Publish = danger + ConfirmDialog — деплой в живой движок */}
      <Button
        variant="danger"
        size="sm"
        onClick={onPublish}
        disabled={isBusy}
        title="Опубликовать — деплой в живой движок Flowable"
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
  const navigate = useNavigate();
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

  // T-0526: publish confirm dialog state
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);

  // T-0533: beforeunload + react-router route-guard for unsaved BPMN edits.
  const dirtyGuard = useDirtyGuard(isDirty);

  // T-0324: process key — the :id param (never "new" — that triggers blank template)
  const isNew = !id || id === 'new';

  // T-0377 (B19): assignedKey tracks the definitive key after first save of a new process.
  // For existing processes it equals the route :id immediately. For new processes it starts
  // null and is set once the backend returns the auto-generated slug on first save.
  const [assignedKey, setAssignedKey] = useState(isNew ? null : id);

  // The effective key for save/publish calls — assignedKey wins (set after first save),
  // falls back to route :id for existing, null for brand-new unsaved processes.
  const processKey = assignedKey ?? (isNew ? null : id);

  // T-0684 [capstone T-0647 P1]: the process name is now an EDITABLE field the author
  // must fill — the modeler used to derive it silently (placeholder «Новый процесс»
  // for a new process), so a save/publish went through nameless and 11 definitions on
  // the operator's real screens were all named the placeholder. `nameDraft` seeds from
  // the backend name on load (existing process) or stays empty (brand-new → author must
  // type). Empty draft renders the placeholder as an <input placeholder> hint, never as
  // the saved value.
  const [nameDraft, setNameDraft] = useState('');
  // The name used for save/publish + the toolbar/title display: the author's draft when
  // non-empty, else the loaded backend name, else empty (guarded before any write).
  const processName = nameDraft.trim() || backendMeta?.name || '';
  const processId = processKey ? processKey.toUpperCase() : 'PRC-NEW';
  const processStatus = backendMeta?.status || 'draft';
  // T-0684: the name field is "invalid" (visual nudge) once the author has touched it
  // and left it empty/placeholder — but only after a touch, so a freshly-opened new
  // process does not show a red field before the author has done anything.
  const [nameTouched, setNameTouched] = useState(false);
  const nameInvalid = nameTouched && isRejectedProcessName(nameDraft);

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
        // T-0684: seed the editable name field from the loaded definition's name so
        // the author sees/edits the real name (not a placeholder). A pre-fix
        // placeholder-named row loads its placeholder here so the author is nudged to
        // rename it before the next save/publish (the create/publish gates reject it).
        if (typeof def.name === 'string') setNameDraft(def.name);
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
     T-0484: onError callback from BpmnModelerWrapper — surface a failed
     diagram import as an honest banner instead of a silently-blank canvas.
     ------------------------------------------------------------------ */
  const handleModelerError = useCallback((message) => {
    setStatusMsg({ text: message, isError: true });
  }, []);

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
     T-0377 (B19): For new processes (processKey = null) the backend
     auto-generates a collision-safe slug from the process name and
     returns it as `assignedKey`. We store it and replace the browser
     URL so the editor transitions from /processes/new/edit to
     /processes/<slug>/edit without a full remount.
     ------------------------------------------------------------------ */
  const handleSave = useCallback(async () => {
    const modeler = liveModeler;
    if (!modeler || isBusy) return;

    // T-0684 [capstone T-0647 P1]: pre-flight name guard — do not even attempt a save
    // with a missing/placeholder name (the server would 400 anyway). Surface the
    // requirement inline + light up the field instead of a wasted round-trip.
    const name = processName.trim();
    if (isRejectedProcessName(name)) {
      setNameTouched(true);
      setStatusMsg({ text: PROCESS_NAME_REQUIRED_MESSAGE, isError: true });
      return;
    }

    setIsBusy(true);
    setStatusMsg({ text: 'Сохраняю…', isError: false });
    try {
      const { xml } = await saveDiagram(modeler);
      // Pass null processKey for new processes — backend assigns the key.
      const result = await saveProcessDef(processKey || null, name, xml);
      const finalKey = result.assignedKey ?? result.processKey;

      setIsDirty(false);
      setBackendMeta((prev) => ({ ...prev, version: result.version, status: result.status }));
      setStatusMsg({ text: `Черновик сохранён (версия ${result.version})`, isError: false });
      setValidationResult(null);

      // T-0377 (B19): If this was a new process and the backend assigned a key,
      // update local state and replace the URL so the toolbar shows the real key
      // and future saves/publishes use it — no full remount needed.
      if (!processKey && finalKey) {
        setAssignedKey(finalKey);
        navigate(`/processes/${encodeURIComponent(finalKey)}/edit`, { replace: true });
      }
    } catch (err) {
      setStatusMsg({ text: err.message || String(err), isError: true });
    } finally {
      setIsBusy(false);
    }
  }, [liveModeler, isBusy, processKey, processName, navigate]);

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
     T-0377 (B19): Seamless publish for new processes.
       1. Save (auto-assigns key if new, returns assignedKey).
       2. Navigate to real URL (replace) if key was just assigned.
       3. Publish against the now-known key.
     Honest: if Flowable is down, shows real error. No silent failures.
     ------------------------------------------------------------------ */
  const handlePublish = useCallback(async () => {
    const modeler = liveModeler;
    if (!modeler || isBusy) return;

    // T-0684 [capstone T-0647 P1]: pre-flight name guard — a process may not go LIVE
    // nameless. Block before the save+publish round-trip; the server publish path also
    // rejects a placeholder-named draft as a defense-in-depth backstop.
    const name = processName.trim();
    if (isRejectedProcessName(name)) {
      setNameTouched(true);
      setStatusMsg({ text: PROCESS_NAME_REQUIRED_MESSAGE, isError: true });
      return;
    }

    setIsBusy(true);
    setStatusMsg({ text: 'Публикую…', isError: false });
    try {
      // Step 1: Save current XML — auto-assigns key for new processes.
      const { xml } = await saveDiagram(modeler);
      const saved = await saveProcessDef(processKey || null, name, xml);
      const finalKey = saved.assignedKey ?? saved.processKey;

      // Step 2: If this was a new process, update URL and state with the assigned key.
      if (!processKey && finalKey) {
        setAssignedKey(finalKey);
        navigate(`/processes/${encodeURIComponent(finalKey)}/edit`, { replace: true });
      }

      // Step 3: Publish (lint → Flowable deploy → persist deployment_id).
      const pub = await publishProcessDef(finalKey);
      setIsDirty(false);
      setBackendMeta((prev) => ({
        ...prev,
        version: pub.version ?? saved.version,
        status: 'published',
      }));
      // T-0380: surface role warnings from publish response (non-blocking).
      // Collapsed into one setStatusMsg call — no deploymentId (G5 jargon).
      if (pub.warnings?.length > 0) {
        setStatusMsg({
          text: `Опубликован с предупреждениями (версия ${pub.version ?? saved.version})`,
          isError: false,
          violations: pub.warnings,
        });
      } else {
        setStatusMsg({
          text: `Опубликован (версия ${pub.version ?? saved.version})`,
          isError: false,
        });
      }
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
  }, [liveModeler, isBusy, processKey, processName, navigate]);

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
        onPublish={() => setPublishConfirmOpen(true)}
        // T-0684: editable name field.
        nameDraft={nameDraft}
        onNameChange={(v) => { setNameTouched(true); setNameDraft(v); }}
        namePlaceholder={UNNAMED_PROCESS_PLACEHOLDER}
        nameInvalid={nameInvalid}
        // T-0437: navigate to branch-rules editor. Only provided when a real
        // processKey is known (not for unsaved new processes — G3: no dead affordance).
        onBranchRules={processKey ? () => navigate(`/processes/${encodeURIComponent(processKey)}/branch-rules`) : undefined}
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
            onError={handleModelerError}
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

      {/* T-0526: ConfirmDialog для публикации в живой движок */}
      <ConfirmDialog
        open={publishConfirmOpen}
        tone="danger"
        title="Опубликовать процесс?"
        message={
          <ConsequenceSummary
            who={`Процесс «${processName}» (живой движок Flowable)`}
            what="Черновик деплоится в движок. Запущенные экземпляры мигрируют на новую версию."
            reversibility="Необратимо в рамках этой версии. Откат — публикация предыдущей версии."
          />
        }
        confirmLabel="Опубликовать"
        onConfirm={() => { setPublishConfirmOpen(false); handlePublish(); }}
        onClose={() => setPublishConfirmOpen(false)}
        loading={isBusy}
      />

      {/* T-0533: route-guard для несохранённой BPMN-диаграммы */}
      <ConfirmDialog
        open={dirtyGuard.blockerState === 'blocked'}
        title="Несохранённые правки"
        message={
          <>
            <p>В редакторе процесса есть несохранённые изменения.</p>
            <ConsequenceSummary
              who={`BPMN-диаграмма «${processName}»`}
              what="Все несохранённые правки будут потеряны"
              reversibility="Необратимо — восстановить из браузера невозможно"
            />
          </>
        }
        confirmLabel="Уйти без сохранения"
        cancelLabel="Остаться"
        tone="danger"
        onConfirm={dirtyGuard.proceed}
        onClose={dirtyGuard.reset}
      />
    </div>
  );
}
