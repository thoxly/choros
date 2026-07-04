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
import { useNavigate } from 'react-router-dom';
import {
  Button, MonoId, Mono, ExecutorBadge, StatusChip,
  Drawer, EmptyState, LoadingState, ErrorState, KitIcon,
} from '../components/components.jsx';
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
function InboxTaskForm({ processKey, stepKey, recordId, onSubmit, submitting }) {
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

  // Empty fields list — binding exists but nothing to fill in
  const fields = binding.fields || [];
  if (fields.length === 0) return null;

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
        {fields.map((f) => {
          // T-0579 (review M1): thread the CURRENT record's id onto file-contract
          // fields ONLY — same reasoning as screen-app-records.jsx's
          // fieldWithRecordId. recordId is undefined when this task's process
          // was not started on_create from a record; FileField surfaces that
          // honestly (no dead upload affordance) rather than silently no-op'ing.
          const { contractKind } = resolveFieldContract(f);
          const fieldWithRecordId = contractKind === 'file' ? { ...f, recordId } : f;
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
        })}
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

function TaskDetailPanel({ taskId, onClose, onActionDone }) {
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

              <span style={S.key}>Шаг</span>
              <Mono>{detail.item.step}</Mono>

              <span style={S.key}>Инстанс</span>
              <MonoId>{detail.item.inst}</MonoId>

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
                <span style={S.key}>Инстанс</span>
                <MonoId>{detail.projection.inst}</MonoId>

                <span style={S.key}>Ключ процесса</span>
                <Mono>{detail.projection.procKey}</Mono>

                <span style={S.key}>Текущий шаг</span>
                <span style={S.val}>{detail.projection.step}</span>

                <span style={S.key}>Состояние</span>
                <StatusChip status={detail.projection.status} label={STATUS_LABEL[detail.projection.status]} />

                <span style={S.key}>Запущен</span>
                <Mono style={S.muted}>
                  {new Date(detail.projection.startedAt).toLocaleString('ru-RU')}
                </Mono>
              </div>
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

  // T-0093: tabs/filters/sort are applied SERVER-SIDE. The query mirrors the API:
  // ?tab=...&exec=...&sort=sla. The server returns the filtered `items` plus full
  // per-tab `counts` (computed from the tenant-scoped base, not the filtered view).
  // T-0401: also passes ?page=N; response now includes page/totalPages/total.
  const load = async () => {
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (tab && tab !== "all") qs.set("tab", tab);
      if (exec) qs.set("exec", exec);
      if (sortSla) qs.set("sort", "sla");
      // Page 1 on initial/refresh load.
      qs.set("page", "1");
      // T-0608 (пункт е): fetchWithAuthRetry self-heals a mid-session-expired
      // token (silent refresh + one retry) instead of surfacing a dead "HTTP
      // 401" whose «Повторить» would just resend the same expired token.
      const res = await fetchWithAuthRetry(`/api/inbox?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items);
      setPage(data.page ?? 1);
      setTotalPages(data.totalPages ?? 1);
      if (data.counts) setCounts(data.counts);
    } catch (e) {
      setError(e.message);
    }
  };

  // T-0401: fetch the next page and append to the existing list.
  const loadMore = async () => {
    if (loadingMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams();
      if (tab && tab !== "all") qs.set("tab", tab);
      if (exec) qs.set("exec", exec);
      if (sortSla) qs.set("sort", "sla");
      qs.set("page", String(nextPage));
      const res = await fetchWithAuthRetry(`/api/inbox?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems((prev) => [...(prev || []), ...(data.items || [])]);
      setPage(data.page ?? nextPage);
      setTotalPages(data.totalPages ?? totalPages);
      // counts remain from the initial full-set response — don't overwrite.
    } catch (e) {
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

  // Re-fetch whenever the tab/filter/sort changes — semantics live on the server.
  // T-0401: also reset pagination so load-more starts fresh from page 1.
  useEffect(() => {
    setPage(1);
    setTotalPages(1);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, exec, sortSla]);

  // Server already applied tab/filter/sort; render the returned rows as-is.
  const rows = items || [];

  return (
    <>
    {/* T-0272: task detail side panel */}
    <TaskDetailPanel
      taskId={selectedTaskId}
      onClose={() => setSelectedTaskId(null)}
      onActionDone={() => { load(); setSelectedTaskId(null); }}
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
          <table className="chs-itable">
            <colgroup>
              <col style={{ width: "auto" }} />
              <col style={{ width: "108px" }} />
              <col style={{ width: "176px" }} />
              <col style={{ width: "132px" }} />
              <col style={{ width: "108px" }} />
              <col style={{ width: "132px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Задача</th>
                <th>Процесс</th>
                <th>Исполнитель</th>
                <th>SLA</th>
                <th>Дедлайн</th>
                <th className="chs-r">Действие</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                // Taken-state is server-truth: a claimed item comes back with claimedBy set
                // (pool cleared). The local `taken[t.id]` flag only bridges the brief optimistic
                // window before load() re-syncs, so the «взято» state never flickers back.
                const claimedByServer = !!t.claimedBy;
                const isTaken = claimedByServer || !!taken[t.id];
                const inPool = t.pool && !isTaken;
                // Who took it (server display name) + when — the «взято кем, когда».
                const takenName = t.execName || "—";
                const whenLabel = takenWhen(t.claimedAt);
                return (
                  <tr key={t.id} data-taken={isTaken ? "true" : undefined}>
                    <td>
                      <div className="chs-task">
                        <span className="chs-task__marker" style={{ background: MARKER_COLOR[t.status] }} />
                        <span className="chs-task__txt">
                          <span className="chs-task__name">{t.name}</span>
                          <span className="chs-task__step">{t.step}</span>
                        </span>
                      </div>
                    </td>
                    <td><MonoId>{t.inst}</MonoId></td>
                    <td>
                      {inPool ? (
                        <span className="chs-pool"><span className="chs-pool__glyph" /> в пуле</span>
                      ) : isTaken ? (
                        <ExecutorBadge type="human" name={takenName} />
                      ) : (
                        <ExecutorBadge type={t.execType} name={t.execName} />
                      )}
                    </td>
                    <td><SLACell sla={t.sla} deadline={t.deadline} /></td>
                    <td><Mono style={{ color: "var(--chs-color-text-muted)", fontSize: "var(--chs-text-sm)" }}>{t.due}</Mono></td>
                    <td className="chs-r">
                      {inPool ? (
                        <Button variant="secondary" size="sm" disabled={!!claiming[t.id]} onClick={() => claimTask(t.id)}>
                          {claiming[t.id] ? '…' : 'Взять'}
                        </Button>
                      ) : isTaken && t.mine && t.role === 'role-approver' ? (
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                          <Button variant="ghost" size="sm" onClick={() => setSelectedTaskId(t.id)}>Открыть</Button>
                          <Button variant="primary" size="sm" disabled={!!approving[t.id]} onClick={() => approveTask(t.id)}>
                            {approving[t.id] ? '…' : 'Согласовать'}
                          </Button>
                        </div>
                      ) : isTaken ? (
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', alignItems: 'center' }}>
                          <span className="chs-taken-tag" title={whenLabel ? `Взято ${takenName}, ${whenLabel}` : undefined}>
                            <Icon name="check" /> взято{t.mine ? " (мной)" : ""}{whenLabel ? ` · ${whenLabel}` : ""}
                          </span>
                          <Button variant="ghost" size="sm" onClick={() => setSelectedTaskId(t.id)}>Открыть</Button>
                        </div>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setSelectedTaskId(t.id)}>Открыть</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {/* T-0401: load-more control — shown only when there are more pages. */}
        {items !== null && items.length > 0 && page < totalPages && (
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
