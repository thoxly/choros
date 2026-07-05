/* ============================================================================
   CHOROS — screen-audit.jsx
   ЭКРАН «Аудит»: РЕАЛЬНЫЙ журнал событий контура (tenant-wide).
   T-0500: подключён к настоящему хэш-сцеплённому audit_log через GET /api/audit
   (заменил демо-заглушку «Счёт-агент»). Сервер отдаёт ТОЛЬКО редактированную
   проекцию (id/ts/actor/action/summary/target) — сырой payload не выходит за
   границу. Здесь: единый вертикальный поток событий, человеко-понятные подписи,
   пагинация «Загрузить ещё», честные состояния Загрузка/Ошибка/Пусто.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ExecGlyph, ActorChip, MonoId, Mono, Button, Field, Select,
  LoadingState, ErrorState, EmptyState,
} from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import { execTypeOf, fmtTs, humanError, buildAuditUrl } from './screen-audit.logic.js';

/**
 * T-0648 (D-064, UX-study §3): the actor used to render as a bare slug/UUID
 * string (`{ev.actor}`). GET /api/audit now attaches `actorDisplay` — the
 * T-0648 batch-resolved shape {id, name, type, deactivated, resolved} — so
 * this renders through ActorChip (name in the main text, raw id only in the
 * tooltip/technical-id chip). Falls back to the raw `ev.actor` string when
 * `actorDisplay` is absent (older cached response shape) — never worse than
 * before this change.
 */
function AuditEventRow({ ev }) {
  const type = execTypeOf(ev.action);
  const display = ev.actorDisplay;
  return (
    <div className="chs-ev">
      <div className="chs-ev__time">{fmtTs(ev.ts)}</div>
      <div className="chs-ev__rail">
        <div className={`chs-ev__node chs-ev__node--${type}`}><ExecGlyph type={type} size={8} /></div>
      </div>
      <div className="chs-ev__body">
        <div className="chs-ev__line">
          <ActorChip type={display?.type || type} name={display?.name || ev.actor} id={display?.id || ev.actor} />
          <span>{ev.summary || ev.action}</span>
          {ev.target && <MonoId chip>{ev.target}</MonoId>}
          <MonoId>{ev.action}</MonoId>
        </div>
      </div>
    </div>
  );
}

function AuditScreen() {
  const [events, setEvents] = useState(null);   // null = ещё не грузили
  const [nextCursor, setNextCursor] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Черновики фильтров (в инпутах) и применённые (в запросе).
  const [actorDraft, setActorDraft] = useState('');
  const [actionDraft, setActionDraft] = useState('');
  const [filters, setFilters] = useState({ actor: '', action: '' });

  // Первая страница (или перезагрузка при смене фильтров).
  const load = useCallback(async () => {
    setError(null);
    setEvents(null);
    setNextCursor(null);
    try {
      const res = await fetch(buildAuditUrl(filters, null), { headers: devHeaders() });
      if (!res.ok) {
        setError(humanError(res.status));
        setEvents([]);
        return;
      }
      const data = await res.json();
      setEvents(Array.isArray(data.events) ? data.events : []);
      setNextCursor(data.nextCursor ?? null);
    } catch (err) {
      setError(`Не удалось загрузить журнал аудита: ${err instanceof Error ? err.message : String(err)}`);
      setEvents([]);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(buildAuditUrl(filters, nextCursor), { headers: devHeaders() });
      if (!res.ok) {
        setError(humanError(res.status));
        return;
      }
      const data = await res.json();
      setEvents((prev) => [...(prev ?? []), ...(Array.isArray(data.events) ? data.events : [])]);
      setNextCursor(data.nextCursor ?? null);
    } catch (err) {
      setError(`Не удалось загрузить ещё: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  const applyFilters = (e) => {
    if (e) e.preventDefault();
    setFilters({ actor: actorDraft.trim(), action: actionDraft.trim() });
  };

  const clearFilters = () => {
    setActorDraft('');
    setActionDraft('');
    setFilters({ actor: '', action: '' });
  };

  const hasActiveFilters = !!(filters.actor || filters.action);

  return (
    <div className="chs-audit-screen">
      <div className="chs-inst">
        <div className="chs-inst__top">
          <div>
            <h1 className="chs-inst__title">Журнал аудита</h1>
            <div className="chs-inst__sub">
              <span>Все события контура — append-only, хэш-сцепленный журнал.</span>
            </div>
          </div>
        </div>

        {/* Фильтры */}
        <form className="chs-auditbar" onSubmit={applyFilters}>
          <Select
            label="Действие"
            className="chs-auditbar__field"
            value={actionDraft}
            onChange={(e) => setActionDraft(e.target.value)}
          >
            <option value="">Все действия</option>
            <option value="grant">Гранты прав</option>
            <option value="assignment">Назначения ролей</option>
            <option value="agent">События агентов</option>
            <option value="substitution">Замещения</option>
          </Select>
          <Field
            label="Актор"
            className="chs-auditbar__field"
            type="text"
            placeholder="slug или id актора"
            value={actorDraft}
            onChange={(e) => setActorDraft(e.target.value)}
          />
          <div className="chs-auditbar__actions">
            <Button variant="primary" size="sm" type="submit">Применить</Button>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" type="button" onClick={clearFilters}>Сбросить</Button>
            )}
          </div>
        </form>
      </div>

      {/* Тело: состояния + поток событий */}
      {error && (events === null || events.length === 0) ? (
        <div className="chs-trace">
          <ErrorState message={error} onRetry={load} />
        </div>
      ) : events === null ? (
        <div className="chs-trace">
          <LoadingState label="Загрузка журнала аудита…" />
        </div>
      ) : events.length === 0 ? (
        <div className="chs-trace">
          <EmptyState
            title={hasActiveFilters ? 'Ничего не найдено' : 'Журнал пуст'}
            description={
              hasActiveFilters
                ? 'По выбранным фильтрам событий нет. Измените или сбросьте фильтры.'
                : 'В этом контуре ещё не записано ни одного события аудита.'
            }
            action={hasActiveFilters ? <Button variant="secondary" size="sm" onClick={clearFilters}>Сбросить фильтры</Button> : undefined}
          />
        </div>
      ) : (
        <div className="chs-trace">
          {events.map((ev) => (
            <AuditEventRow key={ev.id} ev={ev} />
          ))}

          {/* Невыводящая баннер-ошибка для частичного провала «загрузить ещё» */}
          {error && <div className="chs-audit-loadmore__err">{error}</div>}

          <div className="chs-audit-loadmore">
            {nextCursor ? (
              <Button variant="secondary" size="sm" loading={loadingMore} onClick={loadMore}>
                {loadingMore ? 'Загрузка…' : 'Загрузить ещё'}
              </Button>
            ) : (
              <span className="chs-audit-loadmore__end"><Mono>конец журнала</Mono></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default AuditScreen;
