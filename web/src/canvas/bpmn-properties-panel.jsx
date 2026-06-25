/* ============================================================================
   CHOROS — bpmn-properties-panel.jsx
   T-0098: React properties panel for the embedded bpmn-js modeler.

   Responsibility:
     - Subscribes to the modeler EventBus ('selection.changed', 'element.changed')
       to react to what the user selected on the canvas.
     - Reads the selected element's businessObject ($type, name, id, $attrs).
     - Provides a dropdown to pick executor type (human / agent / service),
       which writes `choros:executorType` onto businessObject.$attrs — the same
       attribute that T-0097's execMarkerFor() reads to recolor the element.
     - On executor-type change, calls applyExecMarkerToElement() so the canvas
       recolors the node LIVE without needing a re-import.
     - Styled using the .bio-properties-panel-* CSS classes already present
       in bpmn-theme.css — no new CSS classes needed.

   Wiring (recolor loop):
     1. User opens dropdown → selects "Agent Task"
     2. Panel writes bo.$attrs['choros:executorType'] = 'agent'
     3. Panel calls applyExecMarkerToElement(modeler, element)
     4. applyExecMarkerToElement → canvas.removeMarker(…) + canvas.addMarker('chs-exec-agent')
     5. bpmn-theme.css rule `.djs-element.chs-exec-agent .djs-visual > :nth-child(1)`
        applies --chs-exec-agent stroke/fill — element recolors immediately.

   Props:
     modeler  — BpmnModeler instance (or null if not yet initialized)

   Usage in screen-process-editor.jsx:
     <BpmnPropertiesPanel modeler={modelerRef.current?.modeler} />
   ============================================================================ */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { applyExecMarkerToElement } from './bpmn-exec-markers.js';
import {
  OUTCOME_PRESETS,
  CUSTOM_PRESET_ID,
  defaultOutcomesFor,
} from './outcome-presets.js';
import { authHeaders } from '../app-shell/dev-auth.js';
import { getActiveTenantId } from '../app-shell/active-tenant.js';
import { Field, Select } from '../components/components.jsx';
import { GatewayConditionPanel } from './gateway-condition-panel.jsx';

/* --------------------------------------------------------------------------
   Dev tenant UUID — same constant used throughout the codebase (screen-agents,
   screen-org, ra-intents). Scopes the tenant-state fetch.
   -------------------------------------------------------------------------- */
// Tenant id resolved at runtime from the caller's identity (see active-tenant.js).

/* --------------------------------------------------------------------------
   useRoles — loads org roles once (panel lifetime).
   Returns { roles, loading, error }
   roles = [{ value: '<uuid>', label: '<slug>' }, ...]  or []

   Mirrors the fetch pattern in screen-agents.jsx:loadPositions:
     GET /api/org/tenant-state?tenant_id=…  (genesis-owner gated)

   T-0484 (honesty): a 403 is honest-empty (caller is not the tenant owner → the
   assignment list legitimately stays unpopulated). But a 5xx / engine-unavailable
   / any other non-ok status is a REAL FAILURE and was previously swallowed into an
   empty list — indistinguishable from "no roles exist". That made the «Назначение»
   control look usable-but-dead. We now surface such failures as a typed `error` so
   the panel shows an honest message instead of a misleading empty dropdown.
   -------------------------------------------------------------------------- */
function useRoles() {
  const [roles, setRoles] = useState(null);   // null = not yet fetched
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/org/tenant-state?tenant_id=${getActiveTenantId()}`,
          { headers: authHeaders() },
        );
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 403) {
            // 403 = caller is not the tenant owner → honest empty (NOT an error).
            setRoles([]);
            setLoading(false);
            return;
          }
          // Any other non-ok status (500, 503/engine-unavailable, …) is a real
          // failure. Surface it honestly — never let it masquerade as empty.
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json();
            detail = body?.error?.message || body?.message || detail;
          } catch { /* non-JSON body — keep status-based detail */ }
          setError(`Не удалось загрузить роли: ${detail}`);
          setRoles([]);
          setLoading(false);
          return;
        }
        const data = await res.json();
        const list = (data.roles || []).map((r) => ({
          value: r.id,
          label: r.slug || r.id,
        }));
        setRoles(list);
      } catch (err) {
        if (!cancelled) {
          setError(`Не удалось загрузить роли: ${err?.message || 'сеть недоступна'}`);
          setRoles([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return { roles: roles || [], loading, error };
}

/* --------------------------------------------------------------------------
   Step type → executor type mapping (T-0098 spec)
   userTask → human
   serviceTask + executorType=agent → agent
   serviceTask (plain or executorType=service) → service
   sendTask / businessRuleTask / scriptTask / manualTask → service
   -------------------------------------------------------------------------- */
const BPMN_TYPE_LABELS = {
  'bpmn:UserTask':        'User Task',
  'bpmn:ServiceTask':     'Service Task',
  'bpmn:SendTask':        'Send Task',
  'bpmn:ReceiveTask':     'Receive Task',
  'bpmn:BusinessRuleTask':'Business Rule Task',
  'bpmn:ScriptTask':      'Script Task',
  'bpmn:ManualTask':      'Manual Task',
  'bpmn:SubProcess':      'Sub-Process',
  'bpmn:Task':            'Task',
  'bpmn:StartEvent':      'Start Event',
  'bpmn:EndEvent':        'End Event',
  'bpmn:IntermediateCatchEvent': 'Intermediate Event',
  'bpmn:ExclusiveGateway': 'Exclusive Gateway',
  'bpmn:ParallelGateway':  'Parallel Gateway',
  'bpmn:InclusiveGateway': 'Inclusive Gateway',
};

/* Which BPMN $types are executor-typed tasks (can have executor selector) */
const TASK_TYPES = new Set([
  'bpmn:Task',
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:SendTask',
  'bpmn:ReceiveTask',
  'bpmn:BusinessRuleTask',
  'bpmn:ScriptTask',
  'bpmn:ManualTask',
]);

/* Derive the effective executor type from a businessObject.
   T-0099: reads bo.executorType (moddle registered property, set on importXML)
   first, then falls back to bo.$attrs['choros:executorType'] (T-0098 legacy). */
function effectiveExecType(bo) {
  if (!bo) return null;
  // Primary: registered moddle property (T-0099 round-trip path)
  if (bo.executorType) return bo.executorType;
  // Fallback: $attrs path written by T-0098 and by raw XML import
  const explicit = bo.$attrs && bo.$attrs['choros:executorType'];
  if (explicit) return explicit;
  if (bo.$type === 'bpmn:UserTask') return 'human';
  if (TASK_TYPES.has(bo.$type)) return 'service';
  return null;
}

/* Exec type display labels */
const EXEC_OPTIONS = [
  { value: 'human',   label: 'User Task — человек',      cssClass: 'chs-exec-dot--human' },
  { value: 'agent',   label: 'Agent Task — ИИ-агент',    cssClass: 'chs-exec-dot--agent' },
  { value: 'service', label: 'External Task — сервис',   cssClass: 'chs-exec-dot--service' },
];

/* --------------------------------------------------------------------------
   Sub-components (reuse bio-properties-panel-* CSS classes from bpmn-theme.css)
   -------------------------------------------------------------------------- */

function PanelGroup({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bio-properties-panel-group">
      <div
        className="bio-properties-panel-group-header"
        role="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="bio-properties-panel-group-header-title">{title}</span>
        <span className="bio-properties-panel-arrow">
          <svg viewBox="0 0 10 10" aria-hidden="true" style={{ width: 10, height: 10, transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 120ms' }}>
            <path d="M2 3l3 4 3-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
      {open && (
        <div className="bio-properties-panel-group-entries">
          {children}
        </div>
      )}
    </div>
  );
}

function PPEntry({ label, children, mono }) {
  return (
    <div className="bio-properties-panel-entry" data-mono={mono ? '' : undefined}>
      {label && <label className="bio-properties-panel-label">{label}</label>}
      {children}
    </div>
  );
}

/* Exec-type colored dot indicator */
function ExecDot({ type }) {
  const colorVar = type === 'human'   ? 'var(--chs-exec-human)'
                 : type === 'agent'   ? 'var(--chs-exec-agent)'
                 : type === 'service' ? 'var(--chs-exec-service)'
                 : 'var(--chs-color-text-faint)';
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: colorVar,
        marginRight: 'var(--chs-space-3)',
        flexShrink: 0,
        verticalAlign: 'middle',
      }}
    />
  );
}

/* Header icon: small colored square/circle matching exec type */
function HeaderExecIcon({ type }) {
  const colorVar = type === 'human'   ? 'var(--chs-exec-human)'
                 : type === 'agent'   ? 'var(--chs-exec-agent)'
                 : type === 'service' ? 'var(--chs-exec-service)'
                 : 'var(--chs-color-text-muted)';
  return (
    <svg
      width="14" height="14" viewBox="0 0 14 14"
      fill="none" stroke={colorVar} strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      {type === 'human'   && <circle cx="7" cy="7" r="5" />}
      {type === 'agent'   && <rect x="3" y="3" width="8" height="8" rx="0.8" transform="rotate(45 7 7)" />}
      {type === 'service' && <rect x="2.5" y="2.5" width="9" height="9" rx="1.2" />}
      {!type && <rect x="2.5" y="2.5" width="9" height="9" rx="2" />}
    </svg>
  );
}

/* --------------------------------------------------------------------------
   TARGET_KIND_LABELS — human-readable labels for OutcomeTargetKind values
   -------------------------------------------------------------------------- */
const TARGET_KIND_LABELS = {
  'next':            '→ Дальше (следующий шаг)',
  'end':             '→ Конец (завершить процесс)',
  'back':            '→ Назад (на доработку / возврат)',
  'subprocess-sync': '→ Подпроцесс (ждём результата)',
  'process-async':   '→ Запустить процесс (асинхронно)',
};

const BUTTON_COLOR_LABELS = {
  primary: 'Синий (основной)',
  success: 'Зелёный (позитив)',
  danger:  'Красный (отклонение)',
  warning: 'Жёлтый (внимание)',
  neutral: 'Серый (нейтральный)',
};

/* --------------------------------------------------------------------------
   OutcomesPanel — T-0353 [E16]

   Shows the «Исходы шага» group for a bpmn:UserTask.

   Design:
     - Preset picker (Готово / Решение / Решение с доработкой / Свои исходы).
     - Per-outcome styling (text-override, color, requiresComment, confirm, targetKind).
       STYLING IS OFF-CANVAS — it lives in choros:outcomeButtonsJson on the UserTask.
     - When a preset is selected, it pre-fills the outcomes list from OUTCOME_PRESETS.
     - Custom preset: user can add/remove/rename outcomes.
     - On any change: writes choros:outcomePreset and choros:outcomeButtonsJson to the
       businessObject so saveXML captures them in the XML.
     - DOES NOT write conditions to SequenceFlows here — that is the modeler's structural
       concern. Only the semantic outcomeName on the flow (written when user names a flow
       from the canvas selection) routes the branch.

   SEPARATION FROM DMN:
     This panel is ONLY for UserTask outcome buttons (human-chosen branches).
     DMN gateways (bpmn:ExclusiveGateway with choros:dmnGateway) are handled
     separately and are NEVER shown here (T-0340 / dmn-gateway.ts).
   -------------------------------------------------------------------------- */

/**
 * Parse choros:outcomeButtonsJson from the businessObject.
 * Returns an empty array on failure.
 */
function parseOutcomeButtons(bo) {
  // T-0099: registered moddle property path first.
  const jsonStr = bo.outcomeButtonsJson
    ?? (bo.$attrs && bo.$attrs['choros:outcomeButtonsJson'])
    ?? null;
  if (!jsonStr) return [];
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Serialize the outcome buttons list to JSON and write to the businessObject.
 * Also writes to bo.$attrs for the legacy/fallback path.
 */
function writeOutcomeButtons(bo, buttons) {
  const json = JSON.stringify(buttons);
  // Registered moddle property (T-0099 round-trip path).
  bo.outcomeButtonsJson = json;
  // Also write to $attrs for compatibility with raw XML import fallback.
  if (!bo.$attrs) bo.$attrs = {};
  bo.$attrs['choros:outcomeButtonsJson'] = json;
}

/**
 * Write the preset id to the businessObject.
 */
function writeOutcomePreset(bo, presetId) {
  bo.outcomePreset = presetId;
  if (!bo.$attrs) bo.$attrs = {};
  bo.$attrs['choros:outcomePreset'] = presetId;
}

/**
 * Read the preset id from the businessObject.
 */
function readOutcomePreset(bo) {
  return bo.outcomePreset
    ?? (bo.$attrs && bo.$attrs['choros:outcomePreset'])
    ?? null;
}

/** One outcome row inside the outcomes editor. */
function OutcomeRow({ outcome, index, onChange, onRemove, isCustom }) {
  return (
    <div
      style={{
        border: '1px solid var(--chs-color-border)',
        borderRadius: 'var(--chs-radius-md)',
        padding: 'var(--chs-space-4)',
        marginBottom: 'var(--chs-space-3)',
        background: 'var(--chs-color-surface)',
      }}
    >
      {/* Outcome name (editable only in custom preset) */}
      <div className="bio-properties-panel-entry">
        <label className="bio-properties-panel-label">Название исхода</label>
        <div className="bio-properties-panel-textfield">
          <input
            className="bio-properties-panel-input"
            value={outcome.name}
            readOnly={!isCustom}
            onChange={(e) => onChange(index, 'name', e.target.value)}
            style={{ cursor: isCustom ? undefined : 'default' }}
          />
        </div>
      </div>

      {/* Button label override */}
      <div className="bio-properties-panel-entry">
        <label className="bio-properties-panel-label">Текст кнопки (если отличается)</label>
        <div className="bio-properties-panel-textfield">
          <input
            className="bio-properties-panel-input"
            value={outcome.label ?? ''}
            placeholder={outcome.name}
            onChange={(e) => onChange(index, 'label', e.target.value || undefined)}
          />
        </div>
      </div>

      {/* Color */}
      <div className="bio-properties-panel-entry">
        <label className="bio-properties-panel-label">Цвет кнопки</label>
        <div className="bio-properties-panel-select">
          <select
            value={outcome.color ?? 'primary'}
            onChange={(e) => onChange(index, 'color', e.target.value)}
          >
            {Object.entries(BUTTON_COLOR_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Routing target */}
      <div className="bio-properties-panel-entry">
        <label className="bio-properties-panel-label">Цель маршрута</label>
        <div className="bio-properties-panel-select">
          <select
            value={outcome.targetKind ?? 'next'}
            onChange={(e) => onChange(index, 'targetKind', e.target.value)}
          >
            {Object.entries(TARGET_KIND_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Subprocess/process target id when applicable */}
      {(outcome.targetKind === 'subprocess-sync' || outcome.targetKind === 'process-async') && (
        <div className="bio-properties-panel-entry">
          <label className="bio-properties-panel-label">
            {outcome.targetKind === 'subprocess-sync' ? 'ID подпроцесса' : 'Ключ процесса'}
          </label>
          <div className="bio-properties-panel-textfield">
            <input
              className="bio-properties-panel-input chs-mono"
              value={outcome.target ?? ''}
              placeholder={outcome.targetKind === 'subprocess-sync' ? 'SubProcess_1' : 'myProcessKey'}
              onChange={(e) => onChange(index, 'target', e.target.value || undefined)}
            />
          </div>
        </div>
      )}

      {/* Flags */}
      <div className="bio-properties-panel-entry" style={{ flexDirection: 'row', gap: 'var(--chs-space-4)', alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)', fontSize: 'var(--chs-text-sm)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!outcome.requiresComment}
            onChange={(e) => onChange(index, 'requiresComment', e.target.checked)}
          />
          Требует комментарий
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)', fontSize: 'var(--chs-text-sm)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!outcome.confirm}
            onChange={(e) => onChange(index, 'confirm', e.target.checked)}
          />
          Подтверждение
        </label>
      </div>

      {/* Remove button (custom preset only) */}
      {isCustom && (
        <button
          type="button"
          onClick={() => onRemove(index)}
          style={{
            marginTop: 'var(--chs-space-3)',
            fontSize: 'var(--chs-text-xs)',
            color: 'var(--chs-color-danger, #c00)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          Удалить исход
        </button>
      )}
    </div>
  );
}

/** The «Исходы шага» panel group for a bpmn:UserTask. */
function OutcomesPanel({ bo, modeler, element }) {
  const [presetId, setPresetId] = useState(() => readOutcomePreset(bo) ?? 'done');
  const [outcomes, setOutcomes] = useState(() => {
    const stored = parseOutcomeButtons(bo);
    if (stored.length > 0) return stored;
    // Nothing stored yet → derive from current preset
    return defaultOutcomesFor(readOutcomePreset(bo) ?? 'done');
  });

  // Commit to businessObject + fire element.changed so the canvas is aware.
  const commit = useCallback((newPresetId, newOutcomes) => {
    if (!bo) return;
    writeOutcomePreset(bo, newPresetId);
    writeOutcomeButtons(bo, newOutcomes);
    try {
      if (modeler) {
        const eventBus = modeler.get('eventBus');
        eventBus.fire('element.changed', { element });
      }
    } catch (_) { /* non-fatal */ }
  }, [bo, modeler, element]);

  const handlePresetChange = (newPresetId) => {
    setPresetId(newPresetId);
    if (newPresetId !== CUSTOM_PRESET_ID) {
      // Reset outcomes to the preset defaults.
      const presetOutcomes = defaultOutcomesFor(newPresetId);
      setOutcomes(presetOutcomes);
      commit(newPresetId, presetOutcomes);
    } else {
      // Switching to custom: keep existing outcomes as the starting point.
      commit(newPresetId, outcomes);
    }
  };

  const handleOutcomeChange = (index, field, value) => {
    setOutcomes((prev) => {
      const next = prev.map((o, i) =>
        i === index ? { ...o, [field]: value } : o,
      );
      commit(presetId, next);
      return next;
    });
  };

  const handleAddOutcome = () => {
    setOutcomes((prev) => {
      const next = [...prev, { name: 'Новый исход', targetKind: 'next', color: 'neutral' }];
      commit(presetId, next);
      return next;
    });
  };

  const handleRemoveOutcome = (index) => {
    setOutcomes((prev) => {
      const next = prev.filter((_, i) => i !== index);
      commit(presetId, next);
      return next;
    });
  };

  const isCustom = presetId === CUSTOM_PRESET_ID;

  return (
    <PanelGroup title="Исходы шага" defaultOpen>
      {/* Preset picker */}
      <PPEntry label="Пресет исходов">
        <div className="bio-properties-panel-select">
          <select
            value={presetId}
            onChange={(e) => handlePresetChange(e.target.value)}
          >
            {OUTCOME_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-3)' }}>
          {OUTCOME_PRESETS.find((p) => p.id === presetId)?.hint ?? ''}
        </p>
      </PPEntry>

      {/* Separation note */}
      <PPEntry>
        <p className="bio-properties-panel-description">
          Исход = ветку выбирает ЧЕЛОВЕК. DMN-шлюз (данные → ветка) настраивается отдельно на шлюзе.
        </p>
      </PPEntry>

      {/* Per-outcome rows */}
      {outcomes.length > 0 && (
        <PPEntry>
          <div style={{ width: '100%' }}>
            {outcomes.map((outcome, i) => (
              <OutcomeRow
                key={i}
                outcome={outcome}
                index={i}
                onChange={handleOutcomeChange}
                onRemove={handleRemoveOutcome}
                isCustom={isCustom}
              />
            ))}
          </div>
        </PPEntry>
      )}

      {/* Add outcome (custom only) */}
      {isCustom && (
        <PPEntry>
          <button
            type="button"
            onClick={handleAddOutcome}
            style={{
              fontSize: 'var(--chs-text-sm)',
              color: 'var(--chs-color-brand, #2563eb)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              textAlign: 'left',
            }}
          >
            + Добавить исход
          </button>
        </PPEntry>
      )}
    </PanelGroup>
  );
}

/* --------------------------------------------------------------------------
   SequenceFlowOutcomePanel — T-0353 [E16]

   When the user selects a SequenceFlow (connection between a UserTask and the
   next element), shows the «Имя ветки (исход)» field to set choros:outcomeName.

   This is the NAMED BRANCH — what gets emitted in the XML as:
     <sequenceFlow ... choros:outcomeName="Согласовать"/>

   The resolver reads this to match the human's chosen outcome to the flow.
   NEVER set DMN condition expressions here; that is a different dialog.
   -------------------------------------------------------------------------- */
function SequenceFlowOutcomePanel({ bo, modeler, element }) {
  const [outcomeName, setOutcomeName] = useState(
    () => bo.outcomeName ?? (bo.$attrs && bo.$attrs['choros:outcomeName']) ?? '',
  );

  const commit = useCallback((val) => {
    bo.outcomeName = val || undefined;
    if (!bo.$attrs) bo.$attrs = {};
    if (val) {
      bo.$attrs['choros:outcomeName'] = val;
    } else {
      delete bo.$attrs['choros:outcomeName'];
    }
    try {
      if (modeler) {
        const eventBus = modeler.get('eventBus');
        eventBus.fire('element.changed', { element });
      }
    } catch (_) { /* non-fatal */ }
  }, [bo, modeler, element]);

  const handleChange = (val) => {
    setOutcomeName(val);
    commit(val);
  };

  return (
    <PanelGroup title="Ветка исхода" defaultOpen>
      <PPEntry label="Имя исхода (choros:outcomeName)">
        <div className="bio-properties-panel-textfield">
          <input
            className="bio-properties-panel-input"
            value={outcomeName}
            placeholder="Согласовать"
            onChange={(e) => handleChange(e.target.value)}
          />
        </div>
        <p className="bio-properties-panel-description" style={{ marginTop: 'var(--chs-space-3)' }}>
          Семантическое имя исхода, который направляет поток по этой ветке.
          Не редактируйте условие DMN здесь — DMN настраивается на шлюзе.
        </p>
      </PPEntry>
    </PanelGroup>
  );
}

/* --------------------------------------------------------------------------
   EmptyState — shown when nothing is selected
   -------------------------------------------------------------------------- */
function EmptyState() {
  return (
    <div
      className="bio-properties-panel-container"
      style={{
        width: 260,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--chs-color-border)',
        overflow: 'hidden',
      }}
    >
      <div className="bio-properties-panel">
        <div className="bio-properties-panel-header" style={{ padding: 'var(--chs-space-6) var(--chs-space-7)' }}>
          <span className="bio-properties-panel-header-labels">
            <span className="bio-properties-panel-header-type">
              Панель свойств
            </span>
            <span className="bio-properties-panel-header-label" style={{ fontSize: 'var(--chs-text-sm)' }}>
              Выберите элемент
            </span>
          </span>
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'var(--chs-space-10)',
            color: 'var(--chs-color-text-faint)',
            fontSize: 'var(--chs-text-sm)',
            textAlign: 'center',
          }}
        >
          Нажмите на элемент диаграммы, чтобы увидеть его свойства
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   BpmnPropertiesPanel — main export
   -------------------------------------------------------------------------- */
export default function BpmnPropertiesPanel({ modeler }) {
  const [selected, setSelected] = useState(null); // { element, bo }
  // Tracks the current executor type — separate state so dropdown stays
  // in sync even when the element is the same object (mutations don't
  // trigger re-render automatically).
  const [execType, setExecType] = useState(null);
  // Element name (editable)
  const [elemName, setElemName] = useState('');

  // T-0325: assignment + BYO-LLM — controlled local state, written to moddle on change
  const [assignedRoleId, setAssignedRoleId] = useState('');
  const [byoEndpoint, setByoEndpoint] = useState('');
  const [byoModel, setByoModel] = useState('');

  // T-0325: real org roles from /api/org/tenant-state (fetched once on mount)
  const { roles, loading: rolesLoading, error: rolesError } = useRoles();

  /* ------------------------------------------------------------------
     Subscribe to modeler events once the modeler is available.
     Cleanup on unmount or modeler change.
     ------------------------------------------------------------------ */
  useEffect(() => {
    if (!modeler) return;

    const eventBus = modeler.get('eventBus');

    function onSelectionChanged(event) {
      const newElement = event.newSelection && event.newSelection[0];
      if (!newElement) {
        setSelected(null);
        setExecType(null);
        setElemName('');
        setAssignedRoleId('');
        setByoEndpoint('');
        setByoModel('');
        return;
      }

      const bo = newElement.businessObject;
      if (!bo) {
        setSelected(null);
        setExecType(null);
        setElemName('');
        setAssignedRoleId('');
        setByoEndpoint('');
        setByoModel('');
        return;
      }

      setSelected({ element: newElement, bo });
      setExecType(effectiveExecType(bo));
      setElemName(bo.name || '');
      // T-0325: read persisted assignment + BYO-LLM from bo (primary moddle
      // property first, $attrs fallback for compatibility with imported XML).
      setAssignedRoleId(
        bo.assignedRoleId
          ?? (bo.$attrs && bo.$attrs['choros:assignedRoleId'])
          ?? '',
      );
      setByoEndpoint(
        bo.byoEndpoint
          ?? (bo.$attrs && bo.$attrs['choros:byoEndpoint'])
          ?? '',
      );
      setByoModel(
        bo.byoModel
          ?? (bo.$attrs && bo.$attrs['choros:byoModel'])
          ?? '',
      );
    }

    function onElementChanged(event) {
      setSelected((prev) => {
        if (!prev) return prev;
        if (event.element === prev.element) {
          // Refresh exec type and name from potentially updated bo
          const bo = event.element.businessObject;
          setExecType(effectiveExecType(bo));
          setElemName(bo.name || '');
        }
        return prev;
      });
    }

    eventBus.on('selection.changed', onSelectionChanged);
    eventBus.on('element.changed', onElementChanged);

    return () => {
      eventBus.off('selection.changed', onSelectionChanged);
      eventBus.off('element.changed', onElementChanged);
    };
  }, [modeler]);

  /* ------------------------------------------------------------------
     Helper: write an attribute to both the registered moddle property
     (round-trip via saveXML) and the $attrs fallback (importXML compat).
     ------------------------------------------------------------------ */
  const writeBoAttr = useCallback((bo, propName, attrName, value) => {
    if (!bo.$attrs) bo.$attrs = {};
    if (value) {
      bo[propName] = value;
      bo.$attrs[attrName] = value;
    } else {
      // Clear: delete both so saveXML omits the attribute
      delete bo[propName];
      delete bo.$attrs[attrName];
    }
  }, []);

  /* ------------------------------------------------------------------
     Handle executor-type dropdown change.
     Writes choros:executorType to bo.$attrs AND triggers live recolor.
     ------------------------------------------------------------------ */
  const handleExecTypeChange = useCallback(
    (newType) => {
      if (!modeler || !selected) return;

      const { element, bo } = selected;

      // Ensure $attrs exists
      if (!bo.$attrs) bo.$attrs = {};

      // T-0099: write to the registered moddle property so saveXML serialises it
      // as choros:executorType="..." in the XML (round-trip guarantee).
      bo.executorType = newType;

      // T-0098 legacy path: also write $attrs so execMarkerFor() works without
      // relying on the moddle property name.
      bo.$attrs['choros:executorType'] = newType;

      // Live recolor: remove old chs-exec-* marker, add new one
      applyExecMarkerToElement(modeler, element);

      // Update local state
      setExecType(newType);

      // Notify bpmn-js that this element changed (triggers overlays / context-pad refresh)
      try {
        const eventBus = modeler.get('eventBus');
        eventBus.fire('element.changed', { element });
      } catch (_) {
        // Non-fatal — recolor already happened above
      }
    },
    [modeler, selected]
  );

  /* ------------------------------------------------------------------
     Handle name input change — uses bpmn-js modeling.updateLabel()
     so the change integrates with undo/redo history.
     ------------------------------------------------------------------ */
  const handleNameChange = useCallback(
    (newName) => {
      setElemName(newName);
      if (!modeler || !selected) return;
      try {
        const modeling = modeler.get('modeling');
        modeling.updateLabel(selected.element, newName);
      } catch (_) {
        // Fallback: direct bo write if modeling not available
        if (selected.bo) selected.bo.name = newName;
      }
    },
    [modeler, selected]
  );

  /* ------------------------------------------------------------------
     T-0325: Handle assigned role change — persists to moddle extension.
     ------------------------------------------------------------------ */
  const handleRoleChange = useCallback(
    (newRoleId) => {
      setAssignedRoleId(newRoleId);
      if (!selected) return;
      const { bo } = selected;
      writeBoAttr(bo, 'assignedRoleId', 'choros:assignedRoleId', newRoleId);
    },
    [selected, writeBoAttr],
  );

  /* ------------------------------------------------------------------
     T-0325: Handle BYO endpoint change — persists to moddle extension.
     ------------------------------------------------------------------ */
  const handleByoEndpointChange = useCallback(
    (val) => {
      setByoEndpoint(val);
      if (!selected) return;
      writeBoAttr(selected.bo, 'byoEndpoint', 'choros:byoEndpoint', val);
    },
    [selected, writeBoAttr],
  );

  /* ------------------------------------------------------------------
     T-0325: Handle BYO model change — persists to moddle extension.
     ------------------------------------------------------------------ */
  const handleByoModelChange = useCallback(
    (val) => {
      setByoModel(val);
      if (!selected) return;
      writeBoAttr(selected.bo, 'byoModel', 'choros:byoModel', val);
    },
    [selected, writeBoAttr],
  );

  /* ------------------------------------------------------------------
     Render
     ------------------------------------------------------------------ */
  if (!selected) return <EmptyState />;

  const { bo } = selected;
  const bpmnType = bo.$type;
  const typeLabel = BPMN_TYPE_LABELS[bpmnType] || bpmnType;
  const isTask = TASK_TYPES.has(bpmnType);
  const isUserTask = bpmnType === 'bpmn:UserTask';
  const isSequenceFlow = bpmnType === 'bpmn:SequenceFlow';
  const elemId = bo.id || '';

  // Choose displayed executor label for header
  const execOption = EXEC_OPTIONS.find((o) => o.value === execType);
  const execLabel = execOption ? execOption.label : typeLabel;

  // T-0325: role select options with sentinel "not assigned" entry
  const roleOptions = [
    { value: '', label: '— не назначено —' },
    ...roles,
  ];

  return (
    <div
      className="bio-properties-panel-container"
      style={{
        width: 260,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--chs-color-border)',
        overflow: 'hidden',
      }}
    >
      <div className="bio-properties-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

        {/* Header */}
        <div className="bio-properties-panel-header">
          <span className="bio-properties-panel-header-icon">
            <HeaderExecIcon type={execType} />
          </span>
          <span className="bio-properties-panel-header-labels">
            <span className="bio-properties-panel-header-type">
              {typeLabel}
            </span>
            <span className="bio-properties-panel-header-label">
              {execLabel}
            </span>
          </span>
        </div>

        {/* Scrollable content */}
        <div className="bio-properties-panel-scroll-container" style={{ flex: 1, overflowY: 'auto' }}>

          {/* General group */}
          <PanelGroup title="Общее" defaultOpen>
            <PPEntry label="ID элемента" mono>
              <div className="bio-properties-panel-textfield">
                <input
                  className="bio-properties-panel-input chs-mono"
                  value={elemId}
                  readOnly
                  style={{ cursor: 'default' }}
                />
              </div>
            </PPEntry>

            <PPEntry label="Имя шага">
              <div className="bio-properties-panel-textfield">
                <input
                  className="bio-properties-panel-input"
                  value={elemName}
                  onChange={(e) => handleNameChange(e.target.value)}
                />
              </div>
            </PPEntry>

            {/* Executor type selector — only for task elements */}
            {isTask && (
              <PPEntry label="Тип шага → исполнитель">
                <div className="bio-properties-panel-select" style={{ position: 'relative' }}>
                  {/* Colored dot inside select visual area */}
                  <span
                    style={{
                      position: 'absolute',
                      left: 'var(--chs-space-4)',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      pointerEvents: 'none',
                      zIndex: 1,
                    }}
                  >
                    <ExecDot type={execType} />
                  </span>
                  <select
                    value={execType || 'service'}
                    onChange={(e) => handleExecTypeChange(e.target.value)}
                    style={{ paddingLeft: 'var(--chs-space-9)' }}
                  >
                    {EXEC_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Inline note showing which BPMN type is used */}
                <p
                  className="bio-properties-panel-description"
                  style={{ marginTop: 'var(--chs-space-3)' }}
                >
                  {execType === 'human'   && 'bpmn:UserTask — исполнитель-человек'}
                  {execType === 'agent'   && 'bpmn:ServiceTask + choros:executorType="agent"'}
                  {execType === 'service' && 'bpmn:ServiceTask — внешний сервис/микросервис'}
                </p>
              </PPEntry>
            )}
          </PanelGroup>

          {/* T-0325: Agent-specific BYO LLM properties — wired to moddle (persisted) */}
          {isTask && execType === 'agent' && (
            <PanelGroup title="Модель — BYO LLM" defaultOpen>
              {/* kit Field: .chs-input / .chs-label / .chs-field — light-theme readable */}
              <PPEntry>
                <Field
                  label="Endpoint (BYO)"
                  mono
                  value={byoEndpoint}
                  placeholder="https://llm.internal/v1"
                  onChange={(e) => handleByoEndpointChange(e.target.value)}
                  aria-label="BYO LLM endpoint URL"
                />
              </PPEntry>
              <PPEntry>
                {/* Free-text model id so client can BYO any endpoint/model string */}
                <Field
                  label="Модель"
                  value={byoModel}
                  placeholder="qwen2.5-72b"
                  onChange={(e) => handleByoModelChange(e.target.value)}
                  aria-label="BYO LLM model identifier"
                />
              </PPEntry>
              <PPEntry>
                <p className="bio-properties-panel-description">
                  Клиент хостит LLM-эндпоинт самостоятельно (BYO). Endpoint и модель сохраняются вместе с процессом. Бюджет и автономия задаются на уровне агента в Оргструктуре.
                </p>
              </PPEntry>
            </PanelGroup>
          )}

          {/* T-0325: Executor assignment — real org roles from /api/org/tenant-state */}
          {isTask && (
            <PanelGroup title="Назначение" defaultOpen={false}>
              <PPEntry>
                {/* kit Select: .chs-input.chs-select / .chs-select-wrap / .chs-label */}
                {rolesLoading ? (
                  <p className="bio-properties-panel-description">Загрузка ролей…</p>
                ) : rolesError ? (
                  // T-0484: surface the REAL backend error here (not a vague
                  // "Ошибка загрузки ролей") and present it as a clear failure,
                  // so a 500/engine-unavailable never reads as an empty list.
                  <p
                    className="bio-properties-panel-description"
                    role="alert"
                    style={{ color: 'var(--chs-color-danger)' }}
                  >
                    {rolesError} — назначение недоступно. Повторите позже.
                  </p>
                ) : (
                  <Select
                    label="Назначенная роль"
                    options={roleOptions}
                    value={assignedRoleId}
                    onChange={(e) => handleRoleChange(e.target.value)}
                    aria-label="Назначенная роль"
                    hint={
                      roles.length === 0
                        ? 'Роли недоступны — проверьте доступ или создайте их в Оргструктуре'
                        : undefined
                    }
                  />
                )}
              </PPEntry>
              <PPEntry>
                <p className="bio-properties-panel-description">
                  Инструменты и видимые поля формы — производные от грантов роли, не задаются отдельными тумблерами.
                </p>
              </PPEntry>
            </PanelGroup>
          )}

          {/* T-0353 [E16]: Step outcomes — only for UserTask (human performer) */}
          {isUserTask && (
            <OutcomesPanel
              bo={bo}
              modeler={modeler}
              element={selected.element}
            />
          )}

          {/* T-0353 [E16]: Named branch for SequenceFlow — set choros:outcomeName */}
          {isSequenceFlow && (
            <SequenceFlowOutcomePanel
              bo={bo}
              modeler={modeler}
              element={selected.element}
            />
          )}

          {/* T-0434: Gateway condition panel — branch conditions for bpmn:ExclusiveGateway */}
          {bo.$type === 'bpmn:ExclusiveGateway' && (
            <GatewayConditionPanel
              bo={bo}
              modeler={modeler}
              element={selected.element}
            />
          )}

        </div>
      </div>
    </div>
  );
}
