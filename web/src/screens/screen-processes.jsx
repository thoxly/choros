/* ============================================================================
   CHOROS — screen-processes.jsx
   ЭКРАН: плотная таблица процессов (инстансов).
   Колонки: Процесс · Инстанс · Статус · Узел · Прогресс · Запущен · Исполнители · Действие.

   T-0374 (B17/B18): generic hardcoded «Запустить процесс» launcher removed.
   Processes start from real business entry points configured via process↔app
   bindings (trigger_type: on_create / record_action / launcher / auto). The
   runtime screen now shows an honest empty state when no instances are running,
   with a CTA to the process modeler so an admin can design new flows.
   ============================================================================ */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Mono, StatusChip, ActorChip, RecordRef, EmptyState, LoadingState, ErrorState, KitIcon } from '../components/components.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { getAllUserPrefs, setUserPref } from '../app-shell/user-prefs-api.js';
import {
  PROCESSES_VIEW_PREF_KEY,
  PROCESSES_COLUMNS,
  PROCESSES_PAGE_SIZE,
  defaultProcessesView,
  normalizeProcessesView,
  buildProcessesQuery,
  hasActiveProcessFilter,
  definitionFilterOptions,
  instanceStepNodes,
} from './screen-processes.logic.js';

const MARKER_COLOR = {
  running: "var(--chs-color-info)", done: "var(--chs-color-success)",
  failed: "var(--chs-color-danger)", waiting: "var(--chs-color-warning)",
};

/**
 * T-0735 (T-0654-b) — «Текущий шаг» cell: the instance's concurrent active
 * node(s). One node → a single mono line; an AND-split's parallel branches
 * (T-0456) → each on its own line with a "parallel" marker. Extracted so the
 * grid row stays readable.
 */
function StepCell({ inst }) {
  const nodes = instanceStepNodes(inst);
  if (nodes.length === 0) {
    return <span style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>—</span>;
  }
  if (nodes.length === 1) {
    return <Mono style={{ fontSize: 'var(--chs-text-sm)' }}>{nodes[0]}</Mono>;
  }
  return (
    <div data-testid="concurrent-branches" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-1)' }}>
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
  );
}

/**
 * T-0735 (T-0654-b) — «Процессы» = operator grid over live instances.
 *
 * Replaces the pre-T-0735 "25 instances in a one-row scroll slit" (UX-study §5.1)
 * with a full server-filtered grid consuming part A (T-0654): the toolbar controls
 * (search / definition / status / date range / «мои») map 1:1 onto the GET
 * /api/processes query params, and pagination reads {total,limit,offset}. The
 * starter is rendered by NAME through <ActorChip> (not just a type glyph), and the
 * raw instance UUID is NOT shown in the grid — the operator finds their process by
 * the заявка name (RecordRef disambiguator), never a machine key (D-064 anti-case;
 * anti-uuid-actor-render gate).
 *
 * T-0742 (T-0654-c): the Каталог/связи section that used to hang below the grid is
 * GONE — it moved to its own «Конструктор»-zone screen (screen-process-catalog.jsx,
 * route /process-catalog), which owns definitions, trigger-binding, branch-rules and
 * process creation. This screen is now ONLY the operator grid. The catalog's
 * instance-count deep-links back here via ?definition=<procKey>, which the grid seeds
 * as its definition filter below (AC-C3).
 */
function ProcessesScreen() {
  const navigate = useNavigate();
  // T-0742 [AC-C3]: definition filter seeded from the URL ?definition=<procKey> — the
  // «Каталог процессов» instance-count deep-links here pre-filtered by definition. The
  // <select value={definition}> then shows it as an active filter (honest affordance).
  const [searchParams] = useSearchParams();

  // Filter state (each maps onto a part-A query param).
  const [q, setQ] = useState('');
  const [definition, setDefinition] = useState(() => searchParams.get('definition') || '');
  const [status, setStatus] = useState('');
  const [startedFrom, setStartedFrom] = useState('');
  const [startedTo, setStartedTo] = useState('');
  const [mine, setMine] = useState(false);

  // Data + pagination (reads {total,limit,offset} from the response).
  const [instances, setInstances] = useState(null); // null = loading
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Definition dropdown options (human names) + personal density view.
  const [definitions, setDefinitions] = useState([]);
  const [view, setView] = useState(() => defaultProcessesView());

  // Monotonic request token (mirrors the inbox T-0653 defect-#11 fix): two
  // in-flight loads (the q-debounce + a filter-change) can race — only the
  // latest response is committed, a stale one is dropped.
  const loadSeq = useRef(0);

  const filterState = { q, definition, status, startedFrom, startedTo, mine };

  const fetchPage = useCallback(async (pageOffset) => {
    const qs = buildProcessesQuery({ q, definition, status, startedFrom, startedTo, mine, limit: PROCESSES_PAGE_SIZE, offset: pageOffset });
    const res = await fetch(`/api/processes?${qs.toString()}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, [q, definition, status, startedFrom, startedTo, mine]);

  // Fresh load — always page 0. Shows the Loading state (instances=null).
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setInstances(null);
    setError(null);
    try {
      const data = await fetchPage(0);
      if (seq !== loadSeq.current) return; // superseded — drop.
      setInstances(Array.isArray(data.instances) ? data.instances : []);
      setTotal(typeof data.total === 'number' ? data.total : (data.instances || []).length);
      setOffset(typeof data.offset === 'number' ? data.offset : 0);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e.message);
    }
  }, [fetchPage]);

  // Append the next page (does NOT advance the token — a fresh full load()
  // that begins mid-append supersedes it and this result is dropped).
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    const seq = loadSeq.current;
    const nextOffset = offset + PROCESSES_PAGE_SIZE;
    setLoadingMore(true);
    try {
      const data = await fetchPage(nextOffset);
      if (seq !== loadSeq.current) return;
      setInstances((prev) => [...(prev || []), ...(Array.isArray(data.instances) ? data.instances : [])]);
      setOffset(typeof data.offset === 'number' ? data.offset : nextOffset);
      if (typeof data.total === 'number') setTotal(data.total);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, offset, fetchPage]);

  // Immediate reload on any non-text filter change (definition/status/date/mine).
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition, status, startedFrom, startedTo, mine]);

  // Debounce the text search so keystrokes don't hammer the server. Skip the
  // initial mount (the effect above already fires the first load); the loadSeq
  // token is the systemic backstop against any residual race.
  const qDidMount = useRef(false);
  useEffect(() => {
    if (!qDidMount.current) { qDidMount.current = true; return undefined; }
    const h = setTimeout(() => { load(); }, 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Definition dropdown options — full tenant definition list (human names), so
  // the operator filters by a real NAME, not a raw procKey. Best-effort: a
  // failure just leaves the dropdown at «Любое определение».
  useEffect(() => {
    let cancelled = false;
    fetch('/api/process-catalog', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { definitions: [] }))
      .then((d) => { if (!cancelled) setDefinitions(Array.isArray(d.definitions) ? d.definitions : []); })
      .catch(() => { if (!cancelled) setDefinitions([]); });
    return () => { cancelled = true; };
  }, []);

  // Personal density view (comfortable|compact) via the generic user_pref store
  // (the SAME primitive the sidebar collapse + inbox personal view use). Honest-
  // degrade — a missing/failed pref leaves the comfortable default intact.
  useEffect(() => {
    let cancelled = false;
    getAllUserPrefs().then((prefs) => {
      if (cancelled) return;
      if (prefs && prefs[PROCESSES_VIEW_PREF_KEY]) setView(normalizeProcessesView(prefs[PROCESSES_VIEW_PREF_KEY]));
    });
    return () => { cancelled = true; };
  }, []);

  const setDensity = (density) => {
    const next = { ...view, density };
    setView(next);
    setUserPref(PROCESSES_VIEW_PREF_KEY, next); // fire-and-forget
  };

  const clearFilters = () => {
    setQ(''); setDefinition(''); setStatus(''); setStartedFrom(''); setStartedTo(''); setMine(false);
  };

  const defOptions = definitionFilterOptions(definitions);
  const list = instances || [];
  const filtered = hasActiveProcessFilter(filterState);
  const hasMore = list.length < total;
  const tableClass = `chs-itable${view.density === 'compact' ? ' chs-itable--compact' : ''}`;

  return (
    <div className="chs-inbox">
      {/* Toolbar: server-side controls → part-A query params. */}
      <div className="chs-inbox__bar">
        <div className="chs-inbox__search">
          <KitIcon name="search" />
          <input
            type="search"
            className="chs-inbox__search-input"
            placeholder="Поиск по процессам…"
            aria-label="Поиск по процессам"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button type="button" className="chs-inbox__search-clear" aria-label="Очистить поиск" onClick={() => setQ('')}>
              <KitIcon name="close" />
            </button>
          )}
        </div>
        <div className="chs-inbox__spacer" />

        <div className="chs-inbox__statusfilter">
          <label htmlFor="proc-definition" className="chs-sr-only">Определение процесса</label>
          <select
            id="proc-definition"
            className="chs-input chs-select chs-inbox__statusfilter-select"
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
          >
            <option value="">Любое определение</option>
            {defOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div className="chs-inbox__statusfilter">
          <label htmlFor="proc-status" className="chs-sr-only">Статус процесса</label>
          <select
            id="proc-status"
            className="chs-input chs-select chs-inbox__statusfilter-select"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Любой статус</option>
            <option value="running">Выполняется</option>
            <option value="waiting">Ожидает</option>
            <option value="done">Завершено</option>
            <option value="failed">Ошибка</option>
          </select>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-2)' }}>
          <KitIcon name="calendar" />
          <label htmlFor="proc-from" className="chs-sr-only">Запущен с</label>
          <input
            id="proc-from"
            type="date"
            className="chs-input"
            aria-label="Запущен с"
            value={startedFrom}
            max={startedTo || undefined}
            onChange={(e) => setStartedFrom(e.target.value)}
            style={{ width: '150px' }}
          />
          <span style={{ color: 'var(--chs-color-text-muted)' }}>—</span>
          <label htmlFor="proc-to" className="chs-sr-only">Запущен по</label>
          <input
            id="proc-to"
            type="date"
            className="chs-input"
            aria-label="Запущен по"
            value={startedTo}
            min={startedFrom || undefined}
            onChange={(e) => setStartedTo(e.target.value)}
            style={{ width: '150px' }}
          />
        </div>

        <button
          type="button"
          className="chs-inbox__filter"
          aria-pressed={mine ? 'true' : undefined}
          onClick={() => setMine((m) => !m)}
        >
          {mine ? 'Только мои' : 'Мои процессы'}
        </button>

        <button
          type="button"
          className="chs-inbox__filter"
          aria-pressed={view.density === 'compact' ? 'true' : undefined}
          title="Плотность строк"
          onClick={() => setDensity(view.density === 'compact' ? 'comfortable' : 'compact')}
        >
          {view.density === 'compact' ? 'Плотная' : 'Обычная'}
        </button>
      </div>

      <div className="chs-inbox__scroll">
        {error ? (
          <ErrorState
            title="Не удалось загрузить процессы"
            message={error}
            onRetry={load}
          />
        ) : instances === null ? (
          <LoadingState label="Загрузка процессов…" />
        ) : list.length === 0 ? (
          filtered ? (
            <EmptyState
              title="Ничего не найдено"
              description="По вашему запросу нет процессов. Измените поиск, фильтр по определению/статусу или диапазон дат."
              action={
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Сбросить фильтры
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="Нет активных процессов"
              description="Процессы запускаются автоматически при создании объектов или по действию на карточке. Спроектируйте процесс в конструкторе и свяжите его с приложением — тогда он будет запускаться самостоятельно."
              action={
                <Button variant="secondary" size="sm" onClick={() => navigate('/processes/new/edit')}>
                  Открыть конструктор
                </Button>
              }
            />
          )
        ) : (
          <>
            <table className={tableClass}>
              <colgroup>
                <col style={{ width: 'auto' }} />
                <col style={{ width: '200px' }} />
                <col style={{ width: '150px' }} />
                <col style={{ width: '160px' }} />
                <col style={{ width: '200px' }} />
                <col style={{ width: '100px' }} />
              </colgroup>
              <thead>
                <tr>
                  {PROCESSES_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
                  <th className="chs-r">Действие</th>
                </tr>
              </thead>
              <tbody>
                {list.map((inst) => (
                  <tr key={inst.id}>
                    {/* name: human definition name + запись-источник (RecordRef →
                        resolves the record TITLE, a link) — the disambiguator the
                        operator scans by. NEVER the raw instance UUID.
                        T-0735 (live-proof anti-uuid finding): this grid uses the
                        FETCH path (no server projection). When the source record
                        404s under the viewing actor's PDP, RecordRef itself now
                        degrades to the «Запись недоступна» sentinel (fixed once in
                        the primitive, components.jsx deriveRecordRefDisplay) —
                        never the raw record-source UUID. */}
                    <td>
                      <div className="chs-task">
                        <span className="chs-task__marker" style={{ background: MARKER_COLOR[inst.status] }} />
                        <span className="chs-task__txt">
                          <span className="chs-task__name">{inst.name}</span>
                          {inst.recordId && (
                            <span className="chs-task__step">
                              <RecordRef recordId={inst.recordId} headers={authHeaders()} />
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    {/* process → current step (concurrent branches T-0456) */}
                    <td><StepCell inst={inst} /></td>
                    {/* status */}
                    <td><StatusChip status={inst.status} /></td>
                    {/* started */}
                    <td>
                      <Mono style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                        {inst.started}
                      </Mono>
                    </td>
                    {/* actor → starter BY NAME (T-0654 part A + T-0648): ActorChip
                        resolves a human name, keeps the raw id secondary; degrades
                        to the type label (агент/человек/сервис) when no name — never
                        a bare glyph, never a UUID. Rendered only when the starter
                        identity is known (DB-mode); seed/pack fixtures carry none →
                        honest «—», not a fabricated «Человек». */}
                    <td>
                      {(inst.starterType || inst.starterId) ? (
                        <ActorChip type={inst.starterType || 'human'} name={inst.starterName} id={inst.starterId} />
                      ) : (
                        <span style={{ color: 'var(--chs-color-text-muted)' }}>—</span>
                      )}
                    </td>
                    {/* action — always present (can't be hidden: no way to open the row otherwise) */}
                    <td className="chs-r">
                      <Button variant="ghost" size="sm" onClick={() => navigate(`/processes/${inst.id}`)}>Открыть</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Pagination: honest count + load-more (reads total/limit/offset). */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--chs-space-4)',
              padding: 'var(--chs-space-5)',
            }}>
              <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
                Показано {list.length} из {total}
              </span>
              {hasMore && (
                <Button variant="secondary" size="sm" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? 'Загрузка…' : 'Показать ещё'}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
      {/* T-0742 [AC-C8]: the Каталог/связи section moved to screen-process-catalog.jsx
          (route /process-catalog, «Конструктор» zone) — this screen is the operator
          grid only. Definitions, trigger-binding, branch-rules and process creation
          all live in the catalog now, so nothing is orphaned by its removal. */}
    </div>
  );
}

export default ProcessesScreen;
