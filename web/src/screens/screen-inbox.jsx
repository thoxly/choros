/* ============================================================================
   CHOROS — screen-inbox.jsx
   ЭКРАН 2: плотная таблица инбокса задач.
   Колонки: задача · процесс (MonoId) · тип исполнителя · SLA · дедлайн ·
   действие «взять из пула».

   T-0598 (находка №7): пустой инбокс на вкладке «Все» (без активного фильтра
   исполнителя, реальный tenant-wide ноль — counts.all===0) получает честный
   action-CTA «Открыть процессы» → /processes, вместо тупика. Остальные
   вкладки/фильтры (mine/pool/esc, либо «Все» с активным exec-фильтром)
   получают уточняющий текст БЕЗ action — иначе CTA обманула бы («задач
   вообще нет» vs «нет по этому фильтру»).
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button, MonoId, Mono, ExecutorBadge, ActorChip, ProcessRef, RecordRef, StepRef, StatusChip,
  Drawer, EmptyState, LoadingState, ErrorState, KitIcon,
  Badge, Popover,
} from '../components/components.jsx';
// T-0653 (W5-UX/§4): personal inbox view (columns + density) persists via the
// generic user_pref store (T-0651, migration 129) — the SAME primitive the
// sidebar collapse uses, a different key. Honest-degrade (never throws).
import { getAllUserPrefs, setUserPref } from '../app-shell/user-prefs-api.js';
// T-0687: deriveStepLabel — the SAME pure step-humanization the drawer's StepRef
// uses, applied to the list row's step subtitle so a raw BPMN node id
// ("legal_precheck") never surfaces as bare text in the main task list either.
import { deriveStepLabel } from '../components/components.jsx';
// T-0683: auth headers for the nested RecordRef fetch inside ProcessRef (resolves
// the source record's TITLE). Same helper the rest of this screen already uses.
import { authHeaders } from '../app-shell/dev-auth.js';
import { Icon } from '../app-shell/icon.jsx';
// T-0608 (пункт е): every fetch on this screen now goes through
// fetchWithAuthRetry (built on top of authHeaders internally) — direct
// authHeaders()/devHeaders() calls are no longer needed here.
import { fetchWithAuthRetry } from '../app-shell/dev-auth.js';
// T-0597 (находка №6): блокирующий alert-модал на claim/approve ошибках заменён на pushToast —
// тот же провайдер, что уже используют rights/assistant экраны (консистентный
// error-тон, duration:0/role=alert — не гаснет сам, но не блокирует поток).
import { useToastContext } from '../app-shell/toast-context.jsx';
// T-0399 [D7-K]: the inbox form field control is now the ONE unified renderer
// (web/src/forms/field-renderer.jsx), keyed off the binding-contract catalog —
// replacing the inline type→control map that silently dropped enum options.
// T-0579 (review M1): resolveFieldContract needed to detect file-contract
// fields so recordId can be threaded onto them specifically (mirrors the
// contractKind check screen-app-records.jsx already does for the same reason).
import { FieldControl, resolveFieldMode, resolveFieldContract } from '../forms/field-renderer.jsx';
// T-0665 (F5): the ONE form-document renderer (T-0481) — already used as the
// live preview inside FormDesigner.jsx. LIVE_PROOF T-0656 found that GET
// /api/forms/binding never carried `layout` and InboxTaskForm never looked
// for one, so a DnD-assembled (or agent-edited) layout could never reach the
// assignee's screen — it silently fell back to a flat FieldControl list
// regardless of how the form was actually arranged. Reusing the SAME
// renderer here (not a second tree-walker) means the assignee sees exactly
// what was built in the designer.
import FormDocumentRenderer from '../forms/FormDocumentRenderer.jsx';

// ---------------------------------------------------------------------------
// T-0376: InboxTaskForm — renders the bound form for a userTask in the inbox
// card. Fetches form binding via GET /api/forms/binding?processKey=...&stepKey=...
// then renders an inline form so the assignee can fill and submit it.
// Does NOT edit inbox.ts — uses the standalone /api/forms/binding endpoint from
// binding.ts. PD-9: form fields are derived from real app fields (registry_def),
// never invented here. G2/G5/G6: kit tokens only, plain copy, no hardcoded data.
// T-0399: field rendering delegated to the unified FieldControl (catalog-driven).
// ---------------------------------------------------------------------------

/**
 * hasBoundLayout — T-0665-e2e P0 fix: the ONE place that decides whether a
 * `binding` carries a structurally valid form-document layout (has a
 * `.root`). Pure, exported so both the render branch (`hasLayout` below) and
 * the no-content guard (`resolveInboxFormHasContent`) agree — no risk of the
 * two checks drifting apart the way the single inline expression and the
 * separate `fields.length === 0` guard drifted before this fix.
 */
export function hasBoundLayout(binding) {
  return !!(binding && binding.layout && typeof binding.layout === 'object' && binding.layout.root);
}

/**
 * resolveInboxFormHasContent — T-0665-e2e P0 fix (guard-order defect, LIVE_PROOF
 * finding #F5): pure decision "is there anything to render for this binding?".
 *
 * BEFORE this fix, InboxTaskForm returned null as soon as `fields.length === 0`
 * — BEFORE it ever looked at `binding.layout`. Every form assembled through the
 * FormDesigner drag-n-drop constructor saves `{layout}` WITHOUT `fields`
 * (persistLayout in web/src/forms/FormDesigner.jsx never sends a `fields` key),
 * and src/http/binding.ts's POST handler stores `fields = []` for that
 * layout-only save path (the column is NOT NULL). So EVERY DnD-built form
 * hit the empty-fields guard and rendered as "no form" for the assignee,
 * even though a perfectly valid, non-empty `layout.root` existed on the same
 * row — the `hasLayout` branch a few lines down was provably unreachable.
 *
 * The fix: there is content to render iff there is a non-empty `fields[]`
 * OR a structurally valid layout — never neither.
 *
 * @param {unknown[]} fields   binding.fields (may be [] for a layout-only save)
 * @param {boolean} hasLayout  hasBoundLayout(binding)
 * @returns {boolean} true when InboxTaskForm should render something.
 */
export function resolveInboxFormHasContent(fields, hasLayout) {
  return (Array.isArray(fields) && fields.length > 0) || !!hasLayout;
}

/**
 * InboxTaskForm — fetches and renders the form bound to a process step.
 * If no binding exists (404), renders nothing (transparent).
 * On submit: collects values and calls onSubmit(values).
 *
 * Props:
 *   processKey  — the process definition key (from detail.projection.procKey)
 *   stepKey     — the step name (from detail.item.step)
 *   recordId    — T-0579 (review M1): the originating business record's id
 *                 (detail.projection.recordId — present only when the process
 *                 was started via on_create on a record). Threaded onto file
 *                 contract fields so FileField can upload/list against the
 *                 record it belongs to. undefined for processes NOT bound to
 *                 a record (e.g. manually started) — FileField then shows its
 *                 honest "no record context" message rather than a dead
 *                 upload button that silently does nothing.
 *   onSubmit    — callback(values: Record<string,unknown>) when the user submits
 *   submitting  — bool: disable submit button while parent is completing the step
 */
export function InboxTaskForm({ processKey, stepKey, recordId, onSubmit, submitting }) {
  // null = loading; false = no binding (404); { fields } = loaded; 'error' = transient fetch error
  const [binding, setBinding] = useState(null);
  const [bindingError, setBindingError] = useState(null); // null | string
  const [values, setValues] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const loadBinding = useCallback(() => {
    if (!processKey || !stepKey) { setBinding(false); return; }
    setBinding(null);
    setBindingError(null);
    setValues({});
    setFieldErrors({});
    setFormError(null);

    fetchWithAuthRetry(
      `/api/forms/binding?processKey=${encodeURIComponent(processKey)}&stepKey=${encodeURIComponent(stepKey)}`,
    )
      .then((r) => {
        if (r.status === 404) { setBinding(false); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json().then((data) => {
          // Initialize values from fields (empty defaults)
          const init = {};
          for (const f of (data.fields || [])) {
            init[f.key] = f.type === 'boolean' ? false : '';
          }
          setValues(init);
          setBinding(data);
        });
      })
      .catch((err) => {
        // Distinguish transient network/server error from "no binding" (404).
        // Setting bindingError surfaces a retry path rather than silently
        // treating the task as having no form.
        setBindingError(String(err?.message || err));
        setBinding(false);
      });
  }, [processKey, stepKey]);

  useEffect(() => {
    loadBinding();
  }, [loadBinding]);

  const handleChange = useCallback((key, val) => {
    setValues((prev) => ({ ...prev, [key]: val }));
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
  }, []);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (!binding || !Array.isArray(binding.fields)) return;

    // Validate required fields. T-0404 [D7-9]: a field is required to advance the
    // step when its legacy `required` flag is set OR its per-step mode is
    // `required-to-advance`. Hidden fields are never asserted required (they are not
    // rendered) — skip them so a hidden field never blocks submit.
    const errs = {};
    for (const f of binding.fields) {
      const { hidden, required: modeRequired } = resolveFieldMode(f);
      if (hidden) continue;
      if (!f.required && !modeRequired) continue;
      const v = values[f.key];
      if (v === '' || v === null || v === undefined || (typeof v === 'string' && !v.trim())) {
        errs[f.key] = 'Обязательное поле';
      }
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      setFormError('Заполните обязательные поля');
      return;
    }
    setFormError(null);
    // T-0404 [D7-9]: never submit read-only/hidden fields — the user cannot edit
    // them at this step, and the server REJECTS any write to them
    // (form-submit-validator.ts). Omitting them client-side keeps a legitimate
    // submit from being rejected as a readonly_write / hidden_write. The remaining
    // (editable) keys are sent as before.
    const editableKeys = new Set(
      binding.fields
        .filter((f) => {
          const { hidden, readOnly } = resolveFieldMode(f);
          return !hidden && !readOnly;
        })
        .map((f) => f.key),
    );
    const payload = {};
    for (const [k, v] of Object.entries(values)) {
      if (editableKeys.has(k)) payload[k] = v;
    }
    if (onSubmit) onSubmit(payload);
  }, [binding, values, onSubmit]);

  // Loading — use kit LoadingState
  if (binding === null) {
    return <LoadingState label="Загрузка формы…" />;
  }

  // Transient fetch error — surface it with a retry, not silently as "no form"
  if (bindingError) {
    return (
      <ErrorState
        message={`Не удалось загрузить форму: ${bindingError}`}
        onRetry={loadBinding}
      />
    );
  }

  // No binding for this step — render nothing (task card works without a form)
  if (binding === false) return null;

  const fields = binding.fields || [];

  // T-0665 (F5): a binding may carry a `layout` (the form-document a human
  // assembled in FormDesigner OR an agent edited via document-ops, T-0656) —
  // when present and structurally valid (has a root), render it through the
  // SAME FormDocumentRenderer FormDesigner already uses as its live preview,
  // so the assignee sees the arrangement exactly as it was built. A binding
  // saved BEFORE layout existed (legacy, fields-only) has no `layout` key at
  // all (src/http/binding.ts omits it rather than sending null) — that path
  // renders EXACTLY as before, byte-for-byte (NF3 backward compatibility).
  const hasLayout = hasBoundLayout(binding);

  // Empty fields list AND no layout — binding exists but there is truly
  // nothing to render. LIVE_PROOF T-0665-e2e P0: this guard used to run
  // BEFORE hasLayout was computed (`fields.length === 0` short-circuited to
  // null), so EVERY layout FormDesigner ever persisted (persistLayout never
  // sends `fields` — src/http/binding.ts stores `fields=[]` for the
  // layout-only save path) rendered as "no form" to the assignee, even
  // though a valid, non-empty layout.root existed on the SAME binding. The
  // guard now fires only when there is NEITHER a fields list NOR a
  // structurally valid layout — matching resolveInboxFormHasContent's single
  // source of truth (below) so this branch and the render branch never
  // disagree about what counts as "something to show".
  if (!resolveInboxFormHasContent(fields, hasLayout)) return null;

  // T-0579 (review M1): thread the CURRENT record's id onto file-contract
  // fields ONLY — same reasoning as screen-app-records.jsx's
  // fieldWithRecordId. recordId is undefined when this task's process
  // was not started on_create from a record; FileField surfaces that
  // honestly (no dead upload affordance) rather than silently no-op'ing.
  const fieldsWithRecordId = fields.map((f) => {
    const { contractKind } = resolveFieldContract(f);
    return contractKind === 'file' ? { ...f, recordId } : f;
  });

  return (
    <section style={{ marginBottom: 'var(--chs-space-8)' }}>
      <h3 style={{
        margin: '0 0 var(--chs-space-5)',
        fontSize: 'var(--chs-text-xs)',
        fontWeight: 'var(--chs-weight-semibold)',
        letterSpacing: 'var(--chs-tracking-wide)',
        textTransform: 'uppercase',
        color: 'var(--chs-color-text-faint)',
      }}>
        Форма задачи
      </h3>
      <form onSubmit={handleSubmit} noValidate>
        {hasLayout ? (
          <FormDocumentRenderer
            document={binding.layout}
            fields={fieldsWithRecordId}
            values={values}
            onChange={handleChange}
            errors={fieldErrors}
          />
        ) : (
          fields.map((f) => {
            const fieldWithRecordId = fieldsWithRecordId.find((wf) => wf.key === f.key) || f;
            return (
              <FieldControl
                key={f.key}
                field={fieldWithRecordId}
                value={values[f.key]}
                onChange={handleChange}
                error={fieldErrors[f.key]}
                idPrefix="inbox-form-field"
              />
            );
          })
        )}
        {formError && (
          <div role="alert" style={{
            marginBottom: 'var(--chs-space-4)',
            fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-danger)',
          }}>
            {formError}
          </div>
        )}
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={submitting}
        >
          Готово
        </Button>
      </form>
    </section>
  );
}

const TABS = [
  { id: "all", label: "Все" },
  { id: "mine", label: "Мне" },
  { id: "pool", label: "Из пула" },
  { id: "esc", label: "Эскалации" },
];

// ---------------------------------------------------------------------------
// T-0653 (W5-UX/§4) — «настроить под себя»: personal inbox view.
//
// The columns/density a user chooses are stored per-actor via the user_pref
// store (T-0651) under this key. Honest-degrade: no persisted pref ⇒ every
// column visible, comfortable density (the current behaviour). The "action"
// column is NOT user-hideable (it carries «Взять»/«Согласовать» — hiding it
// would strand a task with no way to act on it).
// ---------------------------------------------------------------------------
const INBOX_VIEW_PREF_KEY = 'inbox.view';

// Toggleable columns (order matches the table header). `action` is intentionally
// absent — it is always shown (see above).
const INBOX_COLUMNS = [
  { key: 'name', label: 'Задача' },
  { key: 'process', label: 'Процесс' },
  { key: 'executor', label: 'Исполнитель' },
  { key: 'sla', label: 'SLA' },
  { key: 'deadline', label: 'Дедлайн' },
];

function defaultInboxView() {
  const columns = {};
  for (const c of INBOX_COLUMNS) columns[c.key] = true;
  return { columns, density: 'comfortable' };
}

/** Merge a persisted pref (possibly partial/garbage) onto the default, safely. */
function normalizeInboxView(raw) {
  const base = defaultInboxView();
  if (!raw || typeof raw !== 'object') return base;
  const columns = { ...base.columns };
  if (raw.columns && typeof raw.columns === 'object') {
    for (const c of INBOX_COLUMNS) {
      if (typeof raw.columns[c.key] === 'boolean') columns[c.key] = raw.columns[c.key];
    }
  }
  const density = raw.density === 'compact' ? 'compact' : 'comfortable';
  return { columns, density };
}

// ---------------------------------------------------------------------------
// T-0653 — agent signals (столп 4): fields already on the wire that the UI
// used to drop on the floor. Rendered as inline badges under the task name so
// the operator sees WHY a task landed on them / WHAT it is waiting for.
//   doubt_reason       (T-0221) — the agent declined to act autonomously
//   routed_to_fallback (T-0380) — the addressed role has no holder → routed to you
//   messageCatch       (T-0459) — instance parked on a message-catch, awaiting a signal
// Pure presentational, kit tokens only, no hardcoded color.
// ---------------------------------------------------------------------------
function AgentSignals({ item }) {
  const signals = [];
  if (item.doubt_reason) {
    signals.push(
      <Badge key="doubt" tone="warning" title={item.doubt_reason}>
        <KitIcon name="alert" /> Агент сомневается: {item.doubt_reason}
      </Badge>,
    );
  }
  if (item.routed_to_fallback === 'role_unfilled') {
    signals.push(
      <Badge key="fallback" tone="info" title="Роль задачи не заполнена — направлено вам">
        <KitIcon name="info" /> Роль не заполнена — вам
      </Badge>,
    );
  }
  if (item.messageCatch) {
    signals.push(
      <Badge key="msg" tone="neutral" title={item.messageName ? `Ожидает сообщение: ${item.messageName}` : 'Ожидает сообщения'}>
        <Icon name="bell" /> Ожидает сообщения{item.messageName ? `: ${item.messageName}` : ''}
      </Badge>,
    );
  }
  if (signals.length === 0) return null;
  return <span className="chs-task__signals">{signals}</span>;
}

const MARKER_COLOR = {
  running: "var(--chs-color-info)", done: "var(--chs-color-success)",
  failed: "var(--chs-color-danger)", waiting: "var(--chs-color-warning)", paused: "var(--chs-color-text-faint)",
};

/**
 * Render a claim timestamp (epoch-ms) as a compact «когда взято» label.
 * Relative for fresh claims (сейчас / N мин назад), absolute clock for older ones.
 * Tolerant of missing/invalid input — returns null so the caller can omit the «·» separator.
 */
function takenWhen(claimedAt) {
  if (typeof claimedAt !== "number" || !Number.isFinite(claimedAt)) return null;
  const diffMin = Math.floor((Date.now() - claimedAt) / 60000);
  if (diffMin <= 0) return "сейчас";
  if (diffMin < 60) return `${diffMin} мин назад`;
  const d = new Date(claimedAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/* ---------------------------------------------------------------------------
   SLA state model (T-0095) — kept in LOCKSTEP with src/http/sla.ts.
   The SERVER owns the deadline (epoch-ms, `item.deadline`); the client derives the
   live remaining time + warn/over state PURELY from (now, deadline, total-window).
   No deadlines are invented client-side. Pure functions so the boundaries are
   unit-testable with an injected `now` (do NOT read the wall clock here).
   --------------------------------------------------------------------------- */
const SLA_WARN_FRACTION = 0.25;
const SLA_WARN_FLOOR_MS = 5 * 60000;
const SLA_WARN_CEIL_MS = 60 * 60000;

export function warnWindowMs(totalMin) {
  const total = Number.isFinite(totalMin) && totalMin > 0 ? totalMin * 60000 : 0;
  const raw = total * SLA_WARN_FRACTION;
  return Math.min(SLA_WARN_CEIL_MS, Math.max(SLA_WARN_FLOOR_MS, raw));
}

/** "normal" | "warn" | "over" from injected `nowMs` + server `deadlineMs` + total window. */
export function slaState(nowMs, deadlineMs, totalMin) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs)) return "normal";
  if (nowMs >= deadlineMs) return "over";
  if (nowMs >= deadlineMs - warnWindowMs(totalMin)) return "warn";
  return "normal";
}

/** Whole minutes of headroom remaining (negative once past due). Rounds toward zero. */
export function remainingMin(nowMs, deadlineMs) {
  return Math.trunc((deadlineMs - nowMs) / 60000);
}

/**
 * Render the live SLA state for one item. Prefers the server deadline (epoch-ms) and
 * runs a 1-Hz tick so the countdown + warn/over state advance in real time; falls back
 * to the static `sla.left` snapshot when no deadline is present (legacy rows).
 */
function SLACell({ sla, deadline }) {
  const hasLive = typeof deadline === "number" && Number.isFinite(deadline);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasLive) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLive]);

  const left = hasLive ? remainingMin(now, deadline) : sla.left;
  const state = hasLive
    ? slaState(now, deadline, sla.min)
    : sla.left < 0
      ? "over"
      : (sla.left / sla.min) * 100 <= 25
        ? "warn"
        : "normal";

  const over = state === "over";
  const cls = over ? "over" : state === "warn" ? "warn" : "";
  // Bar fill: proportion of the SLA window still remaining (0 when overdue, full bar in red).
  const pct = over ? 100 : Math.max(0, Math.min(100, (left / sla.min) * 100));
  const txt = over ? `−${Math.abs(left)} мин` : `${left} мин`;
  const valueText = over
    ? `Просрочено на ${Math.abs(left)} мин`
    : `Осталось ${left} мин`;
  return (
    <span className="chs-sla">
      {/* T-0529: role=progressbar — conveys SLA urgency without colour-only meaning */}
      <span
        className="chs-sla__bar"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueText}
        aria-label="SLA"
      >
        <span className={`chs-sla__fill ${cls ? "chs-sla__fill--" + cls : ""}`} style={{ width: pct + "%" }} aria-hidden="true" />
      </span>
      <span className={`chs-sla__txt ${cls ? "chs-sla__txt--" + cls : ""}`}>{txt}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// T-0272: TaskDetailPanel — in-screen expandable panel for task detail.
// Opens when the user clicks «Открыть» on any inbox row.
// Shows: task info (name, step, inst, executor type, SLA) + optional instance
// projection (current process status, step, started-at).
// Allows completing a step: human/approver → POST /api/inbox/:id/action {action:'approve'}.
// Shows the outcome after the step completes: status=done and the transition label.
// ---------------------------------------------------------------------------

const STATUS_LABEL = {
  running: "Выполняется",
  waiting: "Ожидание решения",
  done: "Завершено",
  failed: "Ошибка",
  paused: "Пауза",
};

// T-0571 (amended after REVIEW F-1, orchestrator-sanctioned): typed engine-drive
// error codes surfaced by POST /api/inbox/:id/action (502 {error:{code,...}}) get a
// short, non-technical Russian message instead of the raw code — see ADR §2.3.
// Wording per UX_REVIEW / design-steward (D-062).
//
// T-0591 (F-2, ADR-T0591-drive-deadline §2.6): ENGINE_DRIVE_TIMEOUT means the
// product stopped WAITING for the engine within its shared deadline — it does
// NOT mean the action failed. completeUserTask may have already landed at the
// engine moments after the response was sent; reconcile-on-read (T-0522) will
// pick up the real state on the very next GET /api/inbox. The wording below
// deliberately says "могло примениться" (uncertain), not "не выполнено"
// (guaranteed failure), and points at refreshing rather than retrying blindly.
const ENGINE_DRIVE_ERROR_MESSAGE = {
  ENGINE_DRIVE_FAILED: "Не удалось выполнить действие в процессе — попробуйте ещё раз",
  ENGINE_TASK_NOT_FOUND: "Эта задача уже недоступна — обновите страницу",
  AMBIGUOUS_ACTIVE_TASK: "У шага несколько активных задач — обратитесь к администратору",
  // T-0591 UX_REVIEW F-1 (fca5227, applied 1-в-1): «движок» — внутренний жаргон,
  // пользователю неизвестный; заменено на «действие» с сохранением семантики
  // неопределённости («могло уже примениться») и совета обновить страницу.
  ENGINE_DRIVE_TIMEOUT: "Действие выполняется дольше обычного — оно могло уже примениться, обновите страницу, чтобы увидеть актуальное состояние",
};

// T-0605: human-readable messages for claim ("Взять") errors. The live-факт
// приёмки был: claim → 403 NOT_ELIGIBLE, показанный сырым кодом (а второй 403 —
// вообще молчаливо). Every claim error MUST surface as a toast with a human
// sentence — никогда сырой код, никогда молчаливый провал. NOT_ELIGIBLE тянет
// пользователя к действию: попросить администратора назначить роль.
const CLAIM_ERROR_MESSAGE = {
  NOT_ELIGIBLE:
    "Нет роли для этой задачи — попросите администратора назначить роль, которая может её взять",
  ALREADY_CLAIMED: "Задача уже взята другим пользователем",
  NOT_POOL_TASK: "Эту задачу нельзя взять из пула",
  NOT_FOUND: "Эта задача уже недоступна — обновите страницу",
};

/** Map a claim error code to a human sentence (fallback keeps the code visible). */
function claimErrorMessage(code) {
  return CLAIM_ERROR_MESSAGE[code] ?? `Не удалось взять задачу: ${code}`;
}

// T-0608 (пункт в): human-readable messages for the approve/complete action
// (POST /api/inbox/:id/action) error codes that are NOT already covered by
// ENGINE_DRIVE_ERROR_MESSAGE (the 502 engine-drive family). Before this map,
// approveTask's fallback surfaced ANY other code (NOT_ELIGIBLE, NOT_FOUND,
// VALIDATION, FORM_VALIDATION — all real 4xx codes the action route can
// return, see src/http/inbox.ts POST /api/inbox/:id/action) as a raw
// `Ошибка: ${code}` toast — the same class of defect T-0605 fixed for claim.
// handleComplete already special-cased NOT_ELIGIBLE inline; this map replaces
// that one-off with the same principle CLAIM_ERROR_MESSAGE established:
// every code the endpoint can emit gets a human sentence, never a bare code.
const ACTION_ERROR_MESSAGE = {
  NOT_ELIGIBLE: "Нет права на выполнение этого шага",
  NOT_FOUND: "Эта задача уже недоступна — обновите страницу",
  VALIDATION: "Не удалось отправить запрос — обновите страницу и попробуйте снова",
  FORM_VALIDATION: "Форма заполнена некорректно — проверьте значения полей",
  // T-0638 (F4): a defer (agent-escalation) task whose audit event carries no
  // live process instance — legacy row, nothing to route to. See
  // src/http/inbox.ts POST /api/inbox/:id/action defer-resolve branch.
  DEFER_NOT_ROUTABLE: "Эта отложенная задача не привязана к процессу — продвинуть её нельзя",
};

/**
 * Map an approve/complete action error code to a human sentence. Checks the
 * engine-drive family first (502 codes), then the action-route family above;
 * falls back to a sentence that still names the code (never silent, never a
 * bare `Ошибка: CODE` with no context) so an unmapped future code is still
 * legible while remaining diagnosable.
 */
function actionErrorMessage(code) {
  return (
    ENGINE_DRIVE_ERROR_MESSAGE[code] ??
    ACTION_ERROR_MESSAGE[code] ??
    `Не удалось выполнить действие: ${code}`
  );
}

function TaskDetailPanel({ taskId, onClose, onActionDone, onFilterByInstance }) {
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null); // { item, projection }
  const [fetchError, setFetchError] = useState(null);
  const [completing, setCompleting] = useState(false);
  const [outcome, setOutcome] = useState(null); // null | { status, instanceId, action }
  const [actionError, setActionError] = useState(null);
  // T-0376: form data collected from the bound form (if any)
  const [formData, setFormData] = useState(null); // null | Record<string,unknown>

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      // T-0608 (пункт е): fetchWithAuthRetry — a mid-session-expired token
      // self-heals here (silent refresh + retry) instead of surfacing a dead
      // "HTTP 401" that a click on «Повторить» would just repeat forever.
      const res = await fetchWithAuthRetry(`/api/inbox/${taskId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setDetail(data);
    } catch (e) {
      setFetchError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (taskId) loadDetail();
  }, [taskId, loadDetail]);

  const handleComplete = useCallback(async () => {
    if (!detail?.item || completing) return;
    setCompleting(true);
    setActionError(null);
    try {
      // T-0376: include collected form values in the approve body so the data
      // is actually forwarded. The action endpoint ignores unknown keys (no
      // strict validation — extra fields are accepted silently), so this is safe.
      const approveBody = { action: 'approve' };
      if (formData && Object.keys(formData).length > 0) {
        approveBody.formValues = formData;
      }
      // T-0608 (пункт е): fetchWithAuthRetry — a 401 here means the request
      // never reached the approve logic at all (auth rejected before any
      // mutation), so a single silent-refresh-and-retry is safe (no
      // double-submit risk) and beats surfacing a dead-token error.
      const res = await fetchWithAuthRetry(`/api/inbox/${taskId}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(approveBody),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = body?.error?.code ?? `HTTP ${res.status}`;
        // T-0571 (amended after REVIEW F-1): typed engine-drive 502 codes get a
        // human-readable message. T-0608 (пункт в): the one-off NOT_ELIGIBLE
        // ternary is replaced by actionErrorMessage — every code the action
        // route can return now maps to a human sentence, not just this one.
        throw new Error(actionErrorMessage(code));
      }
      setOutcome(body);
      // Notify parent to refresh the inbox list.
      if (onActionDone) onActionDone();
    } catch (e) {
      setActionError(String(e?.message || e));
    } finally {
      setCompleting(false);
    }
  }, [taskId, detail, completing, onActionDone]);

  if (!taskId) return null;

  // Tokenized inline styles — kept in this single in-scope screen file (no new CSS
  // file / app-shell edit). Every value references a --chs-* token; ZERO hardcoded
  // color/spacing (gate G6). The kit Drawer owns surface/scrim/shadow/border.
  const S = {
    section: { marginBottom: 'var(--chs-space-8)' },
    title: {
      margin: '0 0 var(--chs-space-5)', fontSize: 'var(--chs-text-xs)',
      fontWeight: 'var(--chs-weight-semibold)', letterSpacing: 'var(--chs-tracking-wide)',
      textTransform: 'uppercase', color: 'var(--chs-color-text-faint)',
    },
    grid: {
      display: 'grid', gridTemplateColumns: '100px 1fr',
      rowGap: 'var(--chs-space-4)', columnGap: 'var(--chs-space-5)',
      alignItems: 'center', fontSize: 'var(--chs-text-sm)',
    },
    key: { color: 'var(--chs-color-text-muted)' },
    val: { color: 'var(--chs-color-text)', fontWeight: 'var(--chs-weight-medium)' },
    muted: { color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-xs)' },
    notice: {
      marginBottom: 'var(--chs-space-6)', padding: 'var(--chs-space-5) var(--chs-space-6)',
      border: '1px solid transparent', borderRadius: 'var(--chs-radius-3)',
      fontSize: 'var(--chs-text-sm)', lineHeight: 'var(--chs-leading-normal)',
    },
    noticeSuccess: { background: 'var(--chs-color-success-soft)', borderColor: 'var(--chs-color-success)', color: 'var(--chs-color-text)' },
    noticeError: { background: 'var(--chs-color-danger-soft)', borderColor: 'var(--chs-color-danger)', color: 'var(--chs-color-text)' },
    noticeTitle: { fontWeight: 'var(--chs-weight-semibold)', marginBottom: 'var(--chs-space-2)' },
    noticeBody: { color: 'var(--chs-color-text-muted)' },
  };

  // Footer: complete-step action (or a single Close once the step is done).
  // Built outside the JSX tree so the kit Drawer owns the overlay/scrim, focus-trap,
  // Esc and scroll-lock — no hand-rolled fixed-inset modal (gate G6) and no hardcoded color.
  let footer = null;
  if (outcome) {
    footer = <Button variant="secondary" size="sm" onClick={onClose}>Закрыть</Button>;
  } else if (detail) {
    footer = (
      <>
        <Button variant="ghost" size="sm" onClick={onClose}>Закрыть</Button>
        {/* Show complete-step only when the task is still actionable (not done/failed) */}
        {detail.item.status !== 'done' && detail.item.status !== 'failed' && (
          <Button variant="primary" size="sm" disabled={completing} onClick={handleComplete}>
            {completing ? 'Выполнение…' : 'Выполнить шаг'}
          </Button>
        )}
      </>
    );
  }

  return (
    <Drawer open={!!taskId} onClose={onClose} title="Задача" side="right" footer={footer}>
      {loading ? (
        <LoadingState label="Загрузка задачи…" />
      ) : fetchError ? (
        <ErrorState message={`Не удалось загрузить: ${fetchError}`} onRetry={loadDetail} />
      ) : detail ? (
        <>
          {/* Task info */}
          <section style={S.section}>
            <h3 style={S.title}>Задача</h3>
            <div style={S.grid}>
              <span style={S.key}>Название</span>
              <span style={S.val}>{detail.item.name}</span>

              {/* T-0687 (capstone T-0647-A): «Шаг» led with a RAW BPMN node id
                  ("legal_precheck") as the primary value. StepRef renders a human
                  step name primary and DEMOTES the machine key to a mono chip —
                  the step-level sibling of ProcessRef/ActorChip. */}
              <span style={S.key}>Шаг</span>
              <StepRef step={detail.item.step} />

              {/* T-0687 (capstone T-0647-A): explicit «Запись» row — the source
                  record's TITLE + link (reuses RecordRef, T-0648) so the assignee
                  can see WHICH record this task belongs to (the capstone finding:
                  8× identical task names, indistinguishable without the record).
                  Only shown when the process was started on_create from a record. */}
              {(detail.item.recordId ?? detail.projection?.recordId) && (
                <>
                  <span style={S.key}>Запись</span>
                  <RecordRef
                    recordId={detail.item.recordId ?? detail.projection?.recordId}
                    headers={authHeaders()}
                  />
                </>
              )}

              {/* T-0683: process shown as a HUMAN name (+ source record) — the raw
                  instance-UUID is demoted inside ProcessRef, not the primary key. */}
              <span style={S.key}>Процесс</span>
              <ProcessRef
                processName={detail.item.processName}
                inst={detail.item.inst}
                recordId={detail.item.recordId ?? detail.projection?.recordId}
                stepFallback={detail.item.name || detail.item.step}
                headers={authHeaders()}
              />

              <span style={S.key}>Исполнитель</span>
              <ExecutorBadge type={detail.item.execType || 'human'} name={detail.item.execName} />

              <span style={S.key}>Статус</span>
              <StatusChip status={detail.item.status} />

              {detail.item.due && (
                <>
                  <span style={S.key}>Дедлайн</span>
                  <Mono>{detail.item.due}</Mono>
                </>
              )}
            </div>
          </section>

          {/* T-0376: Bound form for the current step (if any).
              Shown when the task is still actionable (waiting state) and a form
              binding exists for (procKey, step). The assignee fills the form and
              the data is attached to the complete-step action as context.
              Fetched via GET /api/forms/binding — does NOT touch inbox.ts. */}
          {!outcome && detail.item.status !== 'done' && detail.item.status !== 'failed' && detail.projection && (
            <InboxTaskForm
              processKey={detail.projection.procKey}
              stepKey={detail.item.step}
              recordId={detail.projection.recordId}
              onSubmit={(values) => setFormData(values)}
              submitting={completing}
            />
          )}

          {/* T-0376: Show collected form data summary if present */}
          {formData && !outcome && (
            <div style={{
              ...S.notice,
              background: 'var(--chs-color-info-soft, var(--chs-color-surface))',
              borderColor: 'var(--chs-color-info, var(--chs-color-border))',
              marginBottom: 'var(--chs-space-6)',
            }}>
              <div style={{ ...S.noticeTitle, color: 'var(--chs-color-text)' }}>Форма заполнена</div>
              <div style={S.noticeBody}>
                Данные будут переданы при завершении шага. Нажмите «Выполнить шаг».
              </div>
            </div>
          )}

          {/* Process/instance projection (if available) */}
          {detail.projection && (
            <section style={S.section}>
              <h3 style={S.title}>Процесс</h3>
              <div style={S.grid}>
                {/* T-0683: lead with the HUMAN process-definition name (деТЭЛ
                    T-0614) — never the raw procKey. */}
                <span style={S.key}>Процесс</span>
                <span style={S.val}>{detail.projection.definitionName || detail.projection.procKey}</span>

                {/* T-0687 (capstone T-0647-A): «Текущий шаг» led with the RAW
                    BPMN node id ("legal_precheck"). StepRef renders a human step
                    primary and demotes the machine key — same primitive as «Шаг»
                    above (single source of truth for step humanization). */}
                <span style={S.key}>Текущий шаг</span>
                <StepRef step={detail.projection.step} />

                <span style={S.key}>Состояние</span>
                <StatusChip status={detail.projection.status} label={STATUS_LABEL[detail.projection.status]} />

                <span style={S.key}>Запущен</span>
                <Mono style={S.muted}>
                  {new Date(detail.projection.startedAt).toLocaleString('ru-RU')}
                </Mono>

                {/* T-0687 (capstone T-0647-A): the raw engine instance-UUID and
                    the process definition KEY are pure machine identifiers —
                    DEMOTED to a single secondary «технические идентификаторы»
                    line (mono, muted), never leading rows the operator reads
                    first. The capstone found these surfaced as prominent, raw
                    «Инстанс» / «Ключ процесса» rows the operator could not read. */}
                <span style={S.key}>Идентификаторы</span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
                  <MonoId style={S.muted}>{detail.projection.inst}</MonoId>
                  <Mono style={S.muted}>{detail.projection.procKey}</Mono>
                </span>
              </div>
              {/* T-0653 (UX-study §4): «Связанные задачи» should FILTER the inbox
                  by THIS instance, not open the general inbox. This link sets the
                  inbox's process filter to the instance and closes the drawer. */}
              {onFilterByInstance && detail.projection.inst && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onFilterByInstance(detail.projection.inst)}
                >
                  <KitIcon name="search" /> Задачи этого процесса
                </Button>
              )}
            </section>
          )}

          {/* Outcome: shown after step completion */}
          {outcome && (
            <div style={{ ...S.notice, ...S.noticeSuccess }}>
              <div style={S.noticeTitle}>Шаг выполнен</div>
              <div style={S.noticeBody}>
                Процесс <strong>{outcome.instanceId}</strong> перешёл в состояние{' '}
                <strong>{STATUS_LABEL[outcome.status] ?? outcome.status}</strong>.
              </div>
            </div>
          )}

          {/* Action error */}
          {actionError && (
            <div style={{ ...S.notice, ...S.noticeError }}>
              {actionError}
            </div>
          )}
        </>
      ) : null}
    </Drawer>
  );
}

function InboxScreen() {
  // T-0598 (находка №7): honest CTA на пустом инбоксе вкладки «Все».
  const navigate = useNavigate();
  const [tab, setTab] = useState("all");
  const [exec, setExec] = useState(null); // executor-type filter: agent|human|service|null
  const [sortSla, setSortSla] = useState(false); // sort by SLA headroom ascending
  // T-0653 (UX-study §4): server-side search + filters + group + personal view.
  const [q, setQ] = useState("");                 // текстовый поиск (server q=)
  const [statusFilter, setStatusFilter] = useState(null); // running|waiting|failed|done|paused
  const [processFilter, setProcessFilter] = useState(null); // фильтр по процессу/инстансу
  // T-0735 [AC-D2]: instance scope seeded from the URL ?instance=<id> param — the
  // process-instance detail's «Задачи этого процесса» link deep-links here. Reuses
  // the server's precise ?instance= scope (T-0710). Clearable via the chip below.
  const [searchParams, setSearchParams] = useSearchParams();
  const [instanceScope, setInstanceScope] = useState(() => searchParams.get('instance') || null);
  const [groupByProcess, setGroupByProcess] = useState(false); // группировка по процессу
  const [groups, setGroups] = useState(null);     // свёртки [{key,label,count,...}]
  const [collapsedGroups, setCollapsedGroups] = useState(() => ({})); // key → true
  // Личный вид (колонки+плотность), персистится через user_pref (T-0651).
  const [view, setView] = useState(() => defaultInboxView());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [taken, setTaken] = useState(() => ({}));
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState({ all: 0, mine: 0, pool: 0, esc: 0 });
  const [error, setError] = useState(null);
  // T-0138: per-task claim inflight tracking (taskId → true)
  const [claiming, setClaiming] = useState(() => ({}));
  // T-0287: per-task approve inflight tracking (taskId → true)
  const [approving, setApproving] = useState(() => ({}));
  // T-0272: task detail panel (selectedTaskId → open; null → closed)
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  // T-0597 (находка №6): toast provider — заменяет блокирующий alert-модал на claim/approve ошибках.
  const { push: pushToast } = useToastContext();

  // T-0401: pagination state for load-more. `page` tracks the last fetched page;
  // `totalPages` caps the load-more button. Reset to page 1 on filter/tab change.
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  // T-0653 (fix-forward defect #1/б): grouped mode returns the whole filtered set
  // capped server-side; this flag surfaces the honest «показаны первые N» notice.
  const [groupTruncated, setGroupTruncated] = useState(null); // null | number (cap)

  // T-0653 (fix-forward defect #11 — closes #6 systemically): monotonic request
  // token. Two in-flight loads can race (the q-debounce effect + a tab/filter
  // change effect fire near-simultaneously); without this, whichever RESPONSE
  // lands last wins regardless of which is current. Each load() captures a fresh
  // token and only commits its result if it is still the latest — a stale
  // response is dropped, not rendered. This also makes a duplicated initial
  // fetch harmless: the second response simply supersedes the first, no flicker
  // of stale data.
  const loadSeq = React.useRef(0);

  // T-0093/T-0653: tab/exec/sort + q/status/group are applied SERVER-SIDE. The
  // query mirrors the API. The server returns filtered `items`, full per-tab
  // `counts`, and (when group=process) `groups` свёртки.
  // T-0401: also passes ?page=N; response includes page/totalPages/total.
  const buildQuery = (pageN) => {
    const qs = new URLSearchParams();
    if (tab && tab !== "all") qs.set("tab", tab);
    if (exec) qs.set("exec", exec);
    if (sortSla) qs.set("sort", "sla");
    const trimmedQ = q.trim();
    if (trimmedQ) qs.set("q", trimmedQ);
    if (statusFilter) qs.set("status", statusFilter);
    if (processFilter) qs.set("process", processFilter);
    // T-0735 [AC-D2]: the precise per-instance scope (server ?instance=, T-0710) —
    // seeded from the URL when the operator arrived via the detail's «Задачи этого
    // процесса» deep-link.
    if (instanceScope) qs.set("instance", instanceScope);
    if (groupByProcess) qs.set("group", "process");
    qs.set("page", String(pageN));
    return qs;
  };

  const load = async () => {
    // T-0653 (fix-forward defect #11): claim the next request token up-front and
    // ignore this response if a newer load() started before it resolved.
    const seq = ++loadSeq.current;
    setError(null);
    try {
      // T-0608 (пункт е): fetchWithAuthRetry self-heals a mid-session-expired
      // token (silent refresh + one retry) instead of surfacing a dead "HTTP
      // 401" whose «Повторить» would just resend the same expired token.
      const res = await fetchWithAuthRetry(`/api/inbox?${buildQuery(1).toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== loadSeq.current) return; // superseded by a newer load — drop.
      setItems(data.items);
      setGroups(Array.isArray(data.groups) ? data.groups : null);
      setGroupTruncated(data.groupTruncated ? (data.groupRowCap ?? true) : null);
      setPage(data.page ?? 1);
      setTotalPages(data.totalPages ?? 1);
      if (data.counts) setCounts(data.counts);
    } catch (e) {
      if (seq !== loadSeq.current) return; // stale error — a newer load is authoritative.
      setError(e.message);
    }
  };

  // T-0401: fetch the next page and append to the existing list. FLAT mode only —
  // grouped mode returns the whole (capped) set in one response, so «Показать
  // ещё» is never shown there (defect #2: appending page-2 rows without also
  // updating groups silently dropped the new process's rows from the grouped view).
  const loadMore = async () => {
    if (loadingMore) return;
    // Bind load-more to the CURRENT token: if a fresh full load() begins while
    // this append is in flight, discard the appended page (it would land on a
    // now-stale base list). load-more never advances the token itself.
    const seq = loadSeq.current;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const res = await fetchWithAuthRetry(`/api/inbox?${buildQuery(nextPage).toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== loadSeq.current) return; // a full reload superseded this append.
      setItems((prev) => [...(prev || []), ...(data.items || [])]);
      setPage(data.page ?? nextPage);
      setTotalPages(data.totalPages ?? totalPages);
      // counts remain from the initial full-set response — don't overwrite.
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  // T-0138: claim a pool task via POST /api/inbox/:id/claim
  const claimTask = async (taskId) => {
    if (claiming[taskId]) return; // inflight guard
    setClaiming((s) => ({ ...s, [taskId]: true }));
    try {
      // T-0608 (пункт е): a 401 here is auth-rejected before the claim logic
      // runs — a silent-refresh-and-retry is safe (no double-claim risk).
      const res = await fetchWithAuthRetry(`/api/inbox/${taskId}/claim`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = body?.error?.code ?? `HTTP ${res.status}`;
        // T-0605: human-readable message for EVERY claim error via
        // claimErrorMessage. Before, only ALREADY_CLAIMED had a sentence and
        // every other code (incl. NOT_ELIGIBLE) surfaced as a bare code — the
        // приёмки showed a raw code, then a repeat 403 showed nothing.
        throw new Error(claimErrorMessage(code));
      }
      // Optimistic local state + re-fetch to sync mine flag
      setTaken((s) => ({ ...s, [taskId]: true }));
      await load();
    } catch (e) {
      // T-0597 (находка №6): surface as a toast, not a blocking native modal —
      // task remains in pool for retry. T-0605: ALWAYS surface, human message.
      pushToast({ tone: 'error', message: e.message });
    } finally {
      setClaiming((s) => ({ ...s, [taskId]: false }));
    }
  };

  // T-0287: approve a claimed instance task via POST /api/inbox/:id/action {action:'approve'}
  const approveTask = async (taskId) => {
    if (approving[taskId]) return; // inflight guard
    setApproving((s) => ({ ...s, [taskId]: true }));
    try {
      // T-0608 (пункт е): 401 self-heals (refresh-once + retry-once) instead
      // of surfacing a raw error toast for a mid-session-expired token.
      const res = await fetchWithAuthRetry(`/api/inbox/${taskId}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = body?.error?.code ?? `HTTP ${res.status}`;
        // T-0571 (amended after REVIEW F-1): typed engine-drive 502 codes get a
        // human-readable message instead of the raw code. T-0608 (пункт в): the
        // fallback used to be a bare `Ошибка: ${code}` — this table-row quick-
        // approve path hit that fallback for NOT_ELIGIBLE/NOT_FOUND/VALIDATION
        // (only handleComplete had the NOT_ELIGIBLE special case). Now both
        // paths share the same actionErrorMessage map — no raw code anywhere.
        throw new Error(actionErrorMessage(code));
      }
      // Task approved → instance done; re-fetch to drop the task from the list.
      await load();
    } catch (e) {
      // T-0597 (находка №6): surface as a toast, not a blocking native modal —
      // same human-readable ENGINE_DRIVE_ERROR_MESSAGE-mapped text as before.
      pushToast({ tone: 'error', message: e.message });
    } finally {
      setApproving((s) => ({ ...s, [taskId]: false }));
    }
  };

  // Re-fetch whenever tab/exec/sort/status/group changes — semantics on server.
  // T-0401: also reset pagination so load-more starts fresh from page 1.
  useEffect(() => {
    setPage(1);
    setTotalPages(1);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, exec, sortSla, statusFilter, processFilter, groupByProcess, instanceScope]);

  // T-0735 [AC-D2]: keep instanceScope in sync with the URL ?instance= param, so
  // a deep-link into an already-mounted inbox (or a browser back/forward) re-seeds
  // the scope. Clearing the chip removes the param → this effect nulls the scope.
  useEffect(() => {
    setInstanceScope(searchParams.get('instance') || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // T-0653: debounce the text search (q) so keystrokes don't hammer the server.
  // Skip the initial mount run — the [tab,...] effect above already issues the
  // first load; without this guard the empty-q mount would fire a redundant
  // second request. The loadSeq token (defect #11) is the systemic backstop:
  // even if two loads ever race, only the latest response is committed, so a
  // stray double-fetch can never render stale data — this guard is now purely a
  // network-efficiency optimization, not a correctness dependency.
  const qDidMount = React.useRef(false);
  useEffect(() => {
    if (!qDidMount.current) { qDidMount.current = true; return undefined; }
    const h = setTimeout(() => {
      setPage(1);
      setTotalPages(1);
      load();
    }, 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // T-0653: load the personal inbox view (columns + density) once on mount.
  // Honest-degrade — a missing/failed pref leaves the default view intact.
  useEffect(() => {
    let cancelled = false;
    getAllUserPrefs().then((prefs) => {
      if (cancelled) return;
      if (prefs && prefs[INBOX_VIEW_PREF_KEY]) {
        setView(normalizeInboxView(prefs[INBOX_VIEW_PREF_KEY]));
      }
    });
    return () => { cancelled = true; };
  }, []);

  // T-0653 (fix-forward defect #7): prune stale collapsed-group keys whenever the
  // set of groups changes (filter/tab/search shifts the process set). Without
  // this, collapsedGroups accumulates keys for processes no longer present —
  // harmless to render but an unbounded stale map, and a process key that
  // reappears after a filter round-trip would wrongly restore its old collapsed
  // state. Keep ONLY keys that still correspond to a live group.
  useEffect(() => {
    if (!Array.isArray(groups)) return;
    const live = new Set(groups.map((g) => g.key));
    setCollapsedGroups((prev) => {
      const next = {};
      let changed = false;
      for (const k of Object.keys(prev)) {
        if (live.has(k)) next[k] = prev[k];
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [groups]);

  // T-0653: persist + apply a personal-view change (fire-and-forget PUT).
  const updateView = (next) => {
    setView(next);
    setUserPref(INBOX_VIEW_PREF_KEY, next);
  };
  const toggleColumn = (key) => {
    updateView({ ...view, columns: { ...view.columns, [key]: !view.columns[key] } });
  };
  const setDensity = (density) => updateView({ ...view, density });

  // Server already applied tab/filter/sort; render the returned rows as-is.
  const rows = items || [];

  const col = (key) => view.columns[key] !== false; // column visible?

  // T-0653: render ONE task row. Extracted so the flat table and the grouped
  // tables share identical row markup (no drift). The WHOLE row opens the detail
  // (AC-5.1) — nested interactive controls stopPropagation so a «Взять» click
  // does not also open the drawer.
  const renderTaskRow = (t) => {
    const claimedByServer = !!t.claimedBy;
    const isTaken = claimedByServer || !!taken[t.id];
    const inPool = t.pool && !isTaken;
    const takenName = t.execName || t.claimedBy || "—";
    const takenType = t.execType || "human";
    const whenLabel = takenWhen(t.claimedAt);
    const openDetail = () => setSelectedTaskId(t.id);
    const stop = (e) => e.stopPropagation();
    return (
      <tr
        key={t.id}
        data-taken={isTaken ? "true" : undefined}
        className="chs-itable__row--click"
        role="button"
        tabIndex={0}
        aria-label={`Открыть задачу: ${t.name}`}
        onClick={openDetail}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); }
        }}
      >
        {col('name') && (
          <td>
            <div className="chs-task">
              <span className="chs-task__marker" style={{ background: MARKER_COLOR[t.status] }} />
              <span className="chs-task__txt">
                {/* T-0687: name carries RECORD context (RecordRef) so identical
                    task names are distinguishable. RecordRef is a link → stop
                    the click from also opening the drawer. */}
                <span className="chs-task__name">
                  {t.name}
                  {t.recordId && (
                    <span className="chs-task__record" onClick={stop}>
                      {' — '}
                      <RecordRef recordId={t.recordId} headers={authHeaders()} />
                    </span>
                  )}
                </span>
                <span className="chs-task__step">{deriveStepLabel(t.step).label}</span>
                {/* T-0653: agent signals (doubt/fallback/messageCatch) — фактически
                    едут по wire, но UI их выбрасывал (столп 4). */}
                <AgentSignals item={t} />
              </span>
            </div>
          </td>
        )}
        {col('process') && (
          <td onClick={stop}>
            <ProcessRef
              processName={t.processName}
              inst={t.inst}
              recordId={t.recordId}
              stepFallback={t.name || t.step}
              headers={authHeaders()}
            />
          </td>
        )}
        {col('executor') && (
          <td>
            {inPool ? (
              <span className="chs-pool"><span className="chs-pool__glyph" /> в пуле</span>
            ) : isTaken ? (
              <ActorChip type={takenType} name={takenName} id={t.claimedBy} deactivated={t.execDeactivated} />
            ) : (
              <ActorChip type={t.execType} name={t.execName} id={t.claimedBy} deactivated={t.execDeactivated} />
            )}
          </td>
        )}
        {col('sla') && <td><SLACell sla={t.sla} deadline={t.deadline} /></td>}
        {col('deadline') && (
          <td><Mono style={{ color: "var(--chs-color-text-muted)", fontSize: "var(--chs-text-sm)" }}>{t.due}</Mono></td>
        )}
        <td className="chs-r" onClick={stop}>
          {inPool ? (
            <Button variant="secondary" size="sm" disabled={!!claiming[t.id]} onClick={() => claimTask(t.id)}>
              {claiming[t.id] ? '…' : 'Взять'}
            </Button>
          ) : isTaken && t.mine && t.canApprove ? (
            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
              <Button variant="ghost" size="sm" onClick={openDetail}>Открыть</Button>
              <Button variant="primary" size="sm" disabled={!!approving[t.id]} onClick={() => approveTask(t.id)}>
                {approving[t.id] ? '…' : 'Согласовать'}
              </Button>
            </div>
          ) : isTaken ? (
            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', alignItems: 'center' }}>
              <span className="chs-taken-tag" title={whenLabel ? `Взято ${takenName}, ${whenLabel}` : undefined}>
                <Icon name="check" /> взято{t.mine ? " (мной)" : ""}{whenLabel ? ` · ${whenLabel}` : ""}
              </span>
              <Button variant="ghost" size="sm" onClick={openDetail}>Открыть</Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={openDetail}>Открыть</Button>
          )}
        </td>
      </tr>
    );
  };

  // T-0653: table header cells honoring column visibility + density class.
  const tableHead = (
    <thead>
      <tr>
        {col('name') && <th>Задача</th>}
        {col('process') && <th>Процесс</th>}
        {col('executor') && <th>Исполнитель</th>}
        {col('sla') && <th>SLA</th>}
        {col('deadline') && <th>Дедлайн</th>}
        <th className="chs-r">Действие</th>
      </tr>
    </thead>
  );
  const tableClass = `chs-itable${view.density === 'compact' ? ' chs-itable--compact' : ''}`;

  return (
    <>
    {/* T-0272: task detail side panel */}
    <TaskDetailPanel
      taskId={selectedTaskId}
      onClose={() => setSelectedTaskId(null)}
      onActionDone={() => { load(); setSelectedTaskId(null); }}
      onFilterByInstance={(inst) => {
        // T-0653: «Задачи этого процесса» — filter the inbox to this instance
        // (process filter matches inst) instead of opening the general list.
        setSelectedTaskId(null);
        setQ("");
        setStatusFilter(null);
        setProcessFilter(inst);
      }}
    />
    <div className="chs-inbox">
      <div className="chs-inbox__bar">
        {/* T-0529: A4 — WAI-ARIA Tabs pattern: role=tablist/tab + roving tabindex + arrow keys */}
        <div className="chs-tabs" role="tablist" aria-label="Фильтр задач">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              id={`inbox-tab-${t.id}`}
              role="tab"
              className="chs-tab"
              aria-selected={tab === t.id}
              aria-controls={`inbox-tabpanel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') { e.preventDefault(); setTab(TABS[(i + 1) % TABS.length].id); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); setTab(TABS[(i - 1 + TABS.length) % TABS.length].id); }
                else if (e.key === 'Home') { e.preventDefault(); setTab(TABS[0].id); }
                else if (e.key === 'End') { e.preventDefault(); setTab(TABS[TABS.length - 1].id); }
              }}
            >
              {t.label}<span className="chs-tab__count">{counts[t.id]}</span>
            </button>
          ))}
        </div>
        <div className="chs-inbox__spacer" />
        {/* T-0653 (UX-study §4): server-side text search — «текстового поиска
            нет ни в UI, ни в API». Debounced; clears via the × affordance. */}
        <div className="chs-inbox__search">
          <Icon name="search" />
          <input
            type="search"
            className="chs-inbox__search-input"
            placeholder="Поиск по задачам…"
            aria-label="Поиск по задачам"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button
              type="button"
              className="chs-inbox__search-clear"
              aria-label="Очистить поиск"
              onClick={() => setQ("")}
            >
              <KitIcon name="close" />
            </button>
          )}
        </div>
        {/* T-0653: active process/instance filter chip (from «Задачи этого
            процесса» in the detail drawer) — visible + clearable. */}
        {processFilter && (
          <button
            type="button"
            className="chs-inbox__filter"
            aria-pressed="true"
            title={`Фильтр по процессу: ${processFilter}`}
            onClick={() => setProcessFilter(null)}
          >
            <Icon name="process" /> Процесс <KitIcon name="close" />
          </button>
        )}
        {/* T-0735 [AC-D2]: active instance-scope chip (from the process detail's
            «Задачи этого процесса» deep-link, ?instance=<id>) — visible + clearable.
            Clearing drops both the state and the URL param. */}
        {instanceScope && (
          <button
            type="button"
            className="chs-inbox__filter"
            aria-pressed="true"
            title="Показаны только задачи выбранного процесса"
            onClick={() => {
              setInstanceScope(null);
              const next = new URLSearchParams(searchParams);
              next.delete('instance');
              setSearchParams(next, { replace: true });
            }}
          >
            <Icon name="process" /> Задачи этого процесса <KitIcon name="close" />
          </button>
        )}
        {/* T-0653: status filter (was absent). Reuses kit <select> shape. */}
        <div className="chs-inbox__statusfilter">
          <label htmlFor="inbox-status" className="chs-sr-only">Статус</label>
          <select
            id="inbox-status"
            className="chs-input chs-select chs-inbox__statusfilter-select"
            value={statusFilter ?? ""}
            onChange={(e) => setStatusFilter(e.target.value || null)}
          >
            <option value="">Любой статус</option>
            <option value="running">Выполняется</option>
            <option value="waiting">Ожидает</option>
            <option value="failed">Ошибка</option>
            <option value="done">Завершено</option>
            <option value="paused">Приостановлено</option>
          </select>
        </div>
        <button
          className="chs-inbox__filter"
          aria-pressed={exec ? "true" : undefined}
          onClick={() => setExec((cur) => (cur === "agent" ? "human" : cur === "human" ? "service" : cur === "service" ? null : "agent"))}
        >
          <Icon name="filter" /> {exec ? `Тип: ${exec}` : "Тип исполнителя"}
        </button>
        <button
          className="chs-inbox__filter"
          aria-pressed={sortSla ? "true" : undefined}
          onClick={() => setSortSla((s) => !s)}
        >
          SLA <KitIcon name="arrow-up" />
        </button>
        {/* T-0653: group-by-process toggle (свёртки со счётчиками). */}
        <button
          className="chs-inbox__filter"
          aria-pressed={groupByProcess ? "true" : undefined}
          onClick={() => setGroupByProcess((g) => !g)}
        >
          <Icon name="process" /> По процессу
        </button>
        {/* T-0653: «настроить под себя» — personal columns + density popover. */}
        <Popover
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          placement="bottom"
          align="end"
          trigger={
            <button
              className="chs-inbox__filter"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((o) => !o)}
            >
              <Icon name="dots" /> Настроить
            </button>
          }
        >
          <div className="chs-inbox__settings" role="group" aria-label="Настройка вида инбокса">
            <div className="chs-inbox__settings-title">Колонки</div>
            {INBOX_COLUMNS.map((c) => (
              <label key={c.key} className="chs-inbox__settings-row">
                <input
                  type="checkbox"
                  checked={view.columns[c.key] !== false}
                  onChange={() => toggleColumn(c.key)}
                />
                {c.label}
              </label>
            ))}
            <div className="chs-inbox__settings-title">Плотность</div>
            <div className="chs-inbox__settings-density" role="radiogroup" aria-label="Плотность строк">
              <button
                type="button"
                className="chs-inbox__density-opt"
                role="radio"
                aria-checked={view.density === 'comfortable'}
                aria-pressed={view.density === 'comfortable'}
                onClick={() => setDensity('comfortable')}
              >
                Обычная
              </button>
              <button
                type="button"
                className="chs-inbox__density-opt"
                role="radio"
                aria-checked={view.density === 'compact'}
                aria-pressed={view.density === 'compact'}
                onClick={() => setDensity('compact')}
              >
                Плотная
              </button>
            </div>
          </div>
        </Popover>
      </div>

      {/* T-0529: tabpanel wraps the content area for proper Tabs WAI-ARIA pattern */}
      <div
        id={`inbox-tabpanel-${tab}`}
        role="tabpanel"
        aria-labelledby={`inbox-tab-${tab}`}
        className="chs-inbox__scroll"
      >
        {error ? (
          <ErrorState
            title="Не удалось загрузить задачи"
            message={error}
            onRetry={load}
          />
        ) : items === null ? (
          <LoadingState label="Загрузка задач…" />
        ) : items.length === 0 ? (
          // T-0598 (находка №7): различаем «вообще пусто у тенанта» (вкладка
          // «Все» без активного фильтра исполнителя, реальный tenant-wide
          // ноль по counts.all) от «пусто по этой вкладке/фильтру» — только
          // первое honest-CTA «Открыть процессы»; второе получает
          // уточняющий текст без action, чтобы не обещать несуществующий
          // выход из фильтра.
          tab === "all" && !exec && counts.all === 0 ? (
            <EmptyState
              icon={<Icon name="inbox" />}
              title="Задач нет"
              description="Задачи появляются, когда запускаются процессы."
              action={
                <Button variant="secondary" size="sm" onClick={() => navigate('/processes')}>
                  Открыть процессы
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Icon name="inbox" />}
              title="Нет задач в этой вкладке"
              description="Попробуйте другую вкладку или снимите фильтр по исполнителю."
            />
          )
        ) : (
          groupByProcess && groups ? (
            // T-0653: grouped-by-process view — свёртки со счётчиками (AC-3.1).
            // Each group is a collapsible section over its own table body so a
            // hundred tasks are navigable by process, not one flat wall.
            // fix-forward defect #1/б: in grouped mode the server returns the
            // WHOLE (capped) filtered set, so g.count and the rendered group body
            // always agree — no page-partial mismatch, no «Показать ещё».
            <div className="chs-inbox__groups">
              {groupTruncated && (
                <div role="status" className="chs-inbox__group-notice">
                  <KitIcon name="info" /> Показаны первые {typeof groupTruncated === 'number' ? groupTruncated : ''} задач — уточните поиск или фильтр, чтобы увидеть остальные.
                </div>
              )}
              {groups.map((g) => {
                const groupRows = rows.filter((t) => (t.procKey ?? t.inst ?? "—") === g.key);
                const collapsed = !!collapsedGroups[g.key];
                return (
                  <section key={g.key} className="chs-inbox__group">
                    <button
                      type="button"
                      className="chs-inbox__group-head"
                      aria-expanded={!collapsed}
                      onClick={() => setCollapsedGroups((s) => ({ ...s, [g.key]: !collapsed }))}
                    >
                      <KitIcon name={collapsed ? "chevron-down" : "chevron-up"} />
                      <span className="chs-inbox__group-label">{g.label}</span>
                      <span className="chs-tab__count">{g.count}</span>
                    </button>
                    {!collapsed && (
                      <table className={tableClass}>
                        {tableHead}
                        <tbody>{groupRows.map(renderTaskRow)}</tbody>
                      </table>
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <table className={tableClass}>
              {tableHead}
              <tbody>{rows.map(renderTaskRow)}</tbody>
            </table>
          )
        )}
        {/* T-0401: load-more control — shown only when there are more pages.
            fix-forward defect #2: never in grouped mode (the whole capped set is
            already loaded; appending a page there would desync group bodies from
            their counts). The server also reports totalPages:1 in grouped mode,
            but gate explicitly on !groupByProcess for clarity. */}
        {items !== null && items.length > 0 && !groupByProcess && page < totalPages && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--chs-space-5)' }}>
            <Button
              variant="secondary"
              size="sm"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? 'Загрузка…' : 'Показать ещё'}
            </Button>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

export default InboxScreen;
