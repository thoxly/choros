/* ============================================================================
   CHOROS — screen-process-instance.jsx
   ЭКРАН: РАБОТА · Процесс (экземпляр) — read-only detail-вью (T-0556).

   Открывается по маршруту /processes/:instanceId (кнопка «Открыть» в списке
   /processes). Загружает один экземпляр через GET /api/processes/:id
   (src/http/processes.ts → ProcessInstance):
     { id, name, procId, status, node, nodes?, started, elapsed,
       progress: { done, total }, execs, recordId? }

   Рендерит (всё из проекции экземпляра + аудита, БЕЗ нового бэкенд-эндпоинта):
     - шапка: имя процесса + статус-чип, запущен, длительность;
     - текущие узлы (включая concurrent-ветки T-0456) + прогресс done/total;
     - история переходов — best-effort фильтр /api/audit по target == instanceId
       (переиспользует проекцию экрана «Аудит»; если событий нет — честная заметка);
     - связанные задачи инбокса — ссылка в /inbox;
     - запись-источник (recordId, если есть);
     - исполнители (human/agent/service).

   READ-ONLY: никаких мутирующих действий над экземпляром — согласование/выполнение
   шага остаются в /inbox (ADR T-0556 §3, «осмотреть» отдельно от «действовать»).
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Button, Mono, MonoId, StatusChip, ExecGlyph, ActorChip, RecordRef,
  LoadingState, ErrorState, EmptyState, KitIcon,
} from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { formatError } from '../lib/format.js';
import { fmtTs, execTypeOf } from './screen-audit.logic.js';
import {
  currentNodes,
  progressLabel,
  progressFraction,
  filterInstanceHistory,
  hasSourceRecord,
  hasDetailedHistory,
  formatHistoryTimestamp,
  deriveInstanceTitle,
  hasRenderableVariables,
  renderableVariables,
  formatVariableValue,
} from './process-instance.logic.js';

const EXEC_LABEL = { human: 'Человек', agent: 'Агент', service: 'Сервис' };

const labelStyle = {
  fontSize: 'var(--chs-text-xs)',
  color: 'var(--chs-color-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const fieldRowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--chs-space-2)',
  padding: 'var(--chs-space-4) 0',
  borderBottom: '1px solid var(--chs-color-border)',
};

const detailGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 2fr) minmax(220px, 1fr)',
  gap: 'var(--chs-space-7) var(--chs-space-9)',
  alignItems: 'start',
};

const metaSidebarStyle = {
  border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-4)',
  background: 'var(--chs-color-surface)',
  padding: 'var(--chs-space-3) var(--chs-space-6)',
};

const sectionTitleStyle = {
  fontSize: 'var(--chs-text-sm)',
  fontWeight: 'var(--chs-weight-semibold)',
  color: 'var(--chs-color-text)',
  margin: 'var(--chs-space-6) 0 var(--chs-space-3) 0',
};

/** Progress bar — token-only colors, decorative (label carries the number). */
function ProgressBar({ progress }) {
  const frac = progressFraction(progress);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)' }}>
      <div
        aria-hidden="true"
        style={{
          flex: 1,
          height: 6,
          borderRadius: 'var(--chs-radius-2, 3px)',
          background: 'var(--chs-color-border)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.round(frac * 100)}%`,
            height: '100%',
            background: 'var(--chs-color-accent, var(--chs-color-info))',
          }}
        />
      </div>
      <Mono style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
        {progressLabel(progress)}
      </Mono>
    </div>
  );
}

/**
 * One history row, mirroring the Audit screen's event line (redacted
 * projection). T-0648: the actor renders through ActorChip. GET /api/audit
 * attaches `actorDisplay` (the T-0648 batch-resolved shape {id, name, type,
 * deactivated, resolved}) alongside the raw `actor` slug/UUID — this prefers
 * actorDisplay and falls back to the raw string (both as name and id) when
 * the field is absent (older cached response shape), same pattern as
 * screen-audit.jsx's AuditEventRow.
 */
function HistoryRow({ ev }) {
  const type = execTypeOf(ev.action);
  const display = ev.actorDisplay;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--chs-space-3)', padding: 'var(--chs-space-2) 0' }}>
      <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', flexShrink: 0 }}>
        {fmtTs(ev.ts)}
      </Mono>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)', flexWrap: 'wrap' }}>
        <ActorChip type={display?.type || type} name={display?.name || ev.actor} id={display?.id || ev.actor} deactivated={display?.deactivated} />
        <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          {ev.summary || ev.action}
        </span>
      </span>
    </div>
  );
}

/**
 * T-0609: one row of the ENGINE-SOURCED detailed history (startEvent/userTask/
 * gateway/endEvent) — distinct from HistoryRow above, which renders the OLD
 * best-effort audit-projection filter. Shown only when the backend reports
 * historyAvailable:true (hasDetailedHistory).
 *
 * T-0648: `step.step` is already best-effort human-readable (backend prefers
 * the BPMN node's `name`, falling back to the technical activityId only when
 * the node has none — src/http/processes.ts fetchInstanceHistoryDetail). The
 * raw `completedBy` slug is shown through ActorChip, preferring the backend's
 * resolved `completedByName` (T-0648 batch resolver) and falling back to the
 * raw slug honestly when unresolved (never worse than before this change).
 *
 * T-0648 FIX-2/FIX-3: a userTask can be completed by an AGENT — take the
 * backend-resolved `completedByType` (never hardcode "human", which would draw
 * an agent-completed step with a human glyph and undermine столп 4) and the
 * `completedByDeactivated` marker; both degrade to the pre-resolve default
 * ("human" / not-deactivated) when the backend could not resolve the slug.
 */
function HistoryStepRow({ step }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--chs-space-3)', padding: 'var(--chs-space-2) 0', flexWrap: 'wrap' }}>
      <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', flexShrink: 0 }}>
        {formatHistoryTimestamp(step.startedAt)}
      </Mono>
      <span style={{ fontSize: 'var(--chs-text-sm)' }}>{step.step}</span>
      <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
        {step.kind}
      </span>
      {step.endedAt ? (
        <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
          → {formatHistoryTimestamp(step.endedAt)}
        </span>
      ) : (
        <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-accent, var(--chs-color-info))' }}>
          в процессе
        </span>
      )}
      {step.completedBy && (
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          · <ActorChip
              type={step.completedByType || 'human'}
              name={step.completedByName}
              id={step.completedBy}
              deactivated={step.completedByDeactivated}
            />
        </span>
      )}
    </div>
  );
}

/** T-0609: one name/value row of the process-variables table.
 *  T-0684 [capstone T-0647 P1]: value formatting is delegated to formatVariableValue
 *  (the pure logic module) so a null/undefined/empty value renders the honest «—»,
 *  never the JS literal "undefined" (the live capstone finding: `undefined`×3). The
 *  name likewise never renders empty — falls back to «—» so no blank mono cell. */
function VariableRow({ variable }) {
  const displayValue = formatVariableValue(variable.value);
  const displayName = typeof variable.name === 'string' && variable.name.trim() ? variable.name : '—';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--chs-space-3)', padding: 'var(--chs-space-2) 0' }}>
      <Mono style={{ fontSize: 'var(--chs-text-sm)', flexShrink: 0, minWidth: 160 }}>
        {displayName}
      </Mono>
      <Mono style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', wordBreak: 'break-all' }}>
        {displayValue}
      </Mono>
    </div>
  );
}

function ProcessInstanceScreen() {
  const { instanceId } = useParams();
  const navigate = useNavigate();

  const [instance, setInstance] = useState(null); // null = loading
  const [error, setError] = useState(null);        // string | { notFound: true }
  const [history, setHistory] = useState(null);    // null = not yet loaded; [] = none

  const loadInstance = useCallback(async () => {
    if (!instanceId) { setError('Не указан идентификатор экземпляра'); return; }
    setError(null);
    setInstance(null);
    try {
      const res = await fetch(`/api/processes/${encodeURIComponent(instanceId)}`, {
        headers: authHeaders(),
      });
      if (res.status === 404) { setError({ notFound: true }); return; }
      if (!res.ok) {
        let detail = formatError(res.status);
        try { const j = await res.json(); detail = j?.message || detail; } catch { /* ignore */ }
        setError(detail);
        return;
      }
      const data = await res.json();
      setInstance(data);
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [instanceId]);

  useEffect(() => { loadInstance(); }, [loadInstance]);

  // Best-effort history: filter the /api/audit redacted projection by target ==
  // instanceId (pre-T-0609 path, ADR T-0556 §3). T-0609: skipped entirely when
  // the backend already reports historyAvailable:true (engine-sourced detailed
  // history) — no point issuing a second, admin-gated /api/audit fetch (and for
  // a non-owner it would just 403 unused) when the detailed section already has
  // what it needs. Runs once the instance resolves.
  useEffect(() => {
    if (!instance || !instanceId) return;
    if (hasDetailedHistory(instance)) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/audit', { headers: authHeaders() });
        if (cancelled) return;
        if (!res.ok) { setHistory([]); return; }
        const data = await res.json();
        const events = Array.isArray(data.events) ? data.events : [];
        if (!cancelled) setHistory(filterInstanceHistory(events, instanceId));
      } catch {
        if (!cancelled) setHistory([]);
      }
    })();
    return () => { cancelled = true; };
  }, [instance, instanceId]);

  const nodes = currentNodes(instance);

  return (
    <div className="chs-inbox">
      {/* Header bar — back to the process list */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--chs-space-5)',
        padding: 'var(--chs-space-3) var(--chs-space-4)',
        borderBottom: '1px solid var(--chs-color-border)',
      }}>
        <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Экземпляр процесса
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/processes')}
          glyph={<KitIcon name="arrow-left" className="chs-btn__glyph" />}
        >
          К списку процессов
        </Button>
      </div>

      <div className="chs-inbox__scroll" style={{ padding: 'var(--chs-space-4, 16px) var(--chs-space-5, 20px)' }}>
        {/* Loading */}
        {!error && instance === null && (
          <LoadingState label="Загрузка экземпляра…" />
        )}

        {/* Not found */}
        {error && typeof error === 'object' && error.notFound && (
          <EmptyState
            icon={<KitIcon name="inbox" size={28} />}
            title="Экземпляр не найден"
            description="Экземпляр процесса не найден или у вас нет к нему доступа."
            action={
              <Button variant="primary" onClick={() => navigate('/processes')}>
                Вернуться к процессам
              </Button>
            }
          />
        )}

        {/* Generic error */}
        {error && typeof error === 'string' && (
          <ErrorState
            message={`Не удалось загрузить экземпляр: ${error}`}
            onRetry={loadInstance}
          />
        )}

        {/* Detail */}
        {instance && !error && (
          <div style={detailGridStyle}>
            {/* Main column */}
            <div style={{ minWidth: 0 }}>
              {/* Title + status.
                  T-0684 [capstone T-0647 P1]: the title is the definition's HUMAN name,
                  never the raw machine key (telLinear). deriveInstanceTitle promotes a
                  real name and demotes the process key to the mono meta line below;
                  when only the key is known it shows the honest generic «Процесс». */}
              {(() => {
                const { title, keyDemoted } = deriveInstanceTitle(instance);
                return (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-4)', flexWrap: 'wrap', marginBottom: 'var(--chs-space-2)' }}>
                      <h1 style={{ margin: 0, fontSize: 'var(--chs-text-lg)', fontWeight: 'var(--chs-weight-semibold)' }}>
                        {title}
                      </h1>
                      <StatusChip status={instance.status} />
                    </div>
                    <div style={{ marginBottom: 'var(--chs-space-6)', display: 'flex', gap: 'var(--chs-space-4)', flexWrap: 'wrap' }}>
                      <MonoId>{instance.id}</MonoId>
                      {keyDemoted && (
                        <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                          {keyDemoted}
                        </Mono>
                      )}
                    </div>
                  </>
                );
              })()}

              {/* Current nodes (incl. concurrent branches) */}
              <h2 style={sectionTitleStyle}>Текущий шаг</h2>
              {nodes.length === 0 ? (
                <p style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
                  {instance.status === 'done' ? 'Процесс завершён.' : '—'}
                </p>
              ) : nodes.length === 1 ? (
                <Mono style={{ fontSize: 'var(--chs-text-sm)' }}>{nodes[0]}</Mono>
              ) : (
                <div data-testid="concurrent-branches" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
                  {nodes.map((n, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)' }}>
                      <span
                        aria-hidden="true"
                        title="Параллельная ветка"
                        style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--chs-color-accent, var(--chs-color-text-muted))', flexShrink: 0 }}
                      />
                      <Mono style={{ fontSize: 'var(--chs-text-sm)' }}>{n}</Mono>
                    </div>
                  ))}
                </div>
              )}

              {/* Progress */}
              <h2 style={sectionTitleStyle}>Прогресс</h2>
              <ProgressBar progress={instance.progress} />

              {/* T-0609: process variables (name/value) — best-effort from the engine's
                  historic-variable-instances read (GET /api/processes/:id). Rendered
                  only when non-empty (not every process carries variables).
                  T-0684 [capstone T-0647 P1]: gate + rows now go through
                  hasRenderableVariables/renderableVariables so a payload of only
                  phantom (nameless+valueless) rows renders NO section, and no row ever
                  prints the literal "undefined" (VariableRow → formatVariableValue). */}
              {hasRenderableVariables(instance) && (
                <>
                  <h2 style={sectionTitleStyle}>Переменные процесса</h2>
                  <div>
                    {renderableVariables(instance).map((v, i) => <VariableRow key={v.name || i} variable={v} />)}
                  </div>
                </>
              )}

              {/* Related inbox tasks — link to /inbox (action stays there). */}
              <h2 style={sectionTitleStyle}>Связанные задачи</h2>
              <p style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', marginBottom: 'var(--chs-space-3)' }}>
                Согласование и выполнение шагов этого процесса — в ваших задачах.
              </p>
              <Link
                to="/inbox"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)', color: 'var(--chs-color-accent)', textDecoration: 'none', fontSize: 'var(--chs-text-sm)' }}
              >
                <KitIcon name="inbox" size={14} />
                Открыть «Мои задачи»
              </Link>

              {/* History / timeline. T-0609: when the backend reports
                  historyAvailable:true (engine-sourced historic-activity-instances
                  read succeeded), render the DETAILED step-by-step history —
                  otherwise fall back UNCHANGED to the pre-T-0609 best-effort
                  audit-projection filter (regression-safety for no-DB/no-engine
                  deployments, where this field is simply absent). */}
              <h2 style={sectionTitleStyle}>История переходов</h2>
              {hasDetailedHistory(instance) ? (
                instance.history.length === 0 ? (
                  <p style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
                    Движок процессов пока не зафиксировал ни одного шага для этого экземпляра.
                  </p>
                ) : (
                  <div>
                    {instance.history.map((step, i) => (
                      <HistoryStepRow key={`${step.step}-${i}`} step={step} />
                    ))}
                  </div>
                )
              ) : history === null ? (
                <LoadingState label="Загрузка истории…" compact />
              ) : history.length === 0 ? (
                <p style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
                  Детальная история переходов по этому экземпляру пока недоступна.
                  Текущее состояние — выше; полный журнал контура — в разделе «Аудит».
                </p>
              ) : (
                <div>
                  {history.map((ev, i) => <HistoryRow key={ev.id || i} ev={ev} />)}
                </div>
              )}
            </div>

            {/* Metadata sidebar */}
            <aside style={metaSidebarStyle} aria-label="Метаданные экземпляра">
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Запущен</span>
                <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text)' }}>
                  {instance.started || '—'}
                </Mono>
              </div>
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Длительность</span>
                <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text)' }}>
                  {instance.elapsed || '—'}
                </Mono>
              </div>
              <div style={fieldRowStyle}>
                <span style={labelStyle}>Исполнители</span>
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--chs-space-3)' }}>
                  {Array.isArray(instance.execs) && instance.execs.length > 0 ? (
                    instance.execs.map((execType, idx) => (
                      <span key={idx} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-1)', fontSize: 'var(--chs-text-xs)' }}>
                        <ExecGlyph type={execType} size={9} filled={true} />
                        {EXEC_LABEL[execType] || execType}
                      </span>
                    ))
                  ) : (
                    <span style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-xs)' }}>—</span>
                  )}
                </span>
              </div>
              {hasSourceRecord(instance) && (
                <div style={{ ...fieldRowStyle, borderBottom: 'none' }}>
                  <span style={labelStyle}>Запись-источник</span>
                  <RecordRef recordId={instance.recordId} headers={authHeaders()} />
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

export default ProcessInstanceScreen;
