/* ============================================================================
   web/src/screens/kanban-board.jsx — T-0582 (kanban view) board component.

   Second display MODE alongside the autogen table (screen-app-records.jsx):
   when the active view's type === 'kanban', <KanbanBoard> renders the SAME
   records array (fetched by the existing GET /api/records?view_id= — no new
   read path, FF-K-4) grouped into columns client-side (buildKanbanColumns,
   kanban-board.js — PD-20: hundreds of records, client grouping is proportionate).

   Move (drag OR keyboard) -> PUT /api/records/:id { data: <FULL data, one
   field changed> } — the SAME record-write path as the record editor (parity
   T-0620): tenant-membership + field write-mask guard, full assertDataValid.
   Optimistic move with ROLLBACK on any non-2xx (FR-6/AC-6) — the board never
   shows an unsaved move as saved.

   ACCESSIBILITY (FR-8/AC-7, WCAG 2.1.1): every card carries a focusable
   "Колонка" <Select> listing the group_by field's enum values — changing it
   fires the SAME onMove path as a drag drop. This is not a "nice to have"
   fallback; it is a first-class, always-visible control (no drag-only dead
   affordance, ADR rejected-alternative).

   ARIA: the board is a list of columns (role="list"), each column a group
   (role="group" + aria-label with name + count), cards are listItems with a
   readable label. Empty columns render explicitly (header + count 0 + honest
   EmptyState) — never disappear (FR-3/AC-9).

   OBLIK (G1-G7): kit Card/Badge/Button/Select + --chs-* tokens only; no
   drag-and-drop library (native HTML5 DnD, NF-6); honest Loading/Empty/Error;
   no dev jargon in visible text (group_by/enum -> «поле»/«значения»).

   ANTI-CASE (D-064): fully generic — column values are tenant enum data, never
   platform constants.
   ============================================================================ */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Card, Badge, EmptyState, LoadingState, ErrorState,
} from '../components/components.jsx';
import { formatCellValue, computeComputedFieldValue, deriveRecordLabel } from './records-form.js';
import { buildKanbanColumns, buildMovePayload, isFieldRequired, resolveCardLabel } from './kanban-board.js';

// ---------------------------------------------------------------------------
// KanbanCard — one record rendered as a kit <Card>, with the keyboard-operable
// column-move <Select> (FR-8/AC-7) and native HTML5 drag source (mouse path).
// ---------------------------------------------------------------------------

function KanbanCard({
  record, cardFields, fieldMetaByKey, columnValues, currentValue, moving, onMove, onDragStart, onDragEnd, dragging,
}) {
  const data = record && typeof record.data === 'object' && record.data !== null ? record.data : {};
  const fields = Array.isArray(cardFields) ? cardFields : [];

  const handleMoveSelect = useCallback((e) => {
    const raw = e.target.value;
    const nextValue = raw === '' ? null : raw;
    if (nextValue === currentValue) return;
    onMove(record, nextValue);
  }, [record, currentValue, onMove]);

  // T-0626: label derivation lives in the pure resolveCardLabel (kanban-board.js)
  // so the fallback contract (empty card_fields -> deriveRecordLabel, never a
  // raw UUID) is unit-testable without React/hooks — see kanban-card-label.test.js.
  const cardLabel = resolveCardLabel(
    record, fields, fieldMetaByKey, formatCellValue, computeComputedFieldValue, deriveRecordLabel,
  );

  return (
    <li
      role="listitem"
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', record.id); onDragStart(record); }}
      onDragEnd={onDragEnd}
      style={{ opacity: dragging ? 0.5 : 1 }}
    >
      <Card
        role="group"
        aria-label={cardLabel}
        className="chs-kanban-card"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
          {fields.length === 0 ? (
            <span style={{ color: 'var(--chs-color-text-muted)', fontStyle: 'italic', fontSize: 'var(--chs-text-sm)' }}>
              Поля для карточки не выбраны
            </span>
          ) : fields.map((key) => {
            const meta = fieldMetaByKey.get(key);
            const rawVal = meta && meta.type === 'computed' ? computeComputedFieldValue(meta, data) : data[key];
            const rendered = formatCellValue(rawVal, meta ? meta.type : 'string');
            const displayVal = typeof rendered === 'string' ? rendered : '—';
            return (
              <div key={key} style={{ fontSize: 'var(--chs-text-sm)' }}>
                <span style={{ color: 'var(--chs-color-text-muted)', marginRight: 'var(--chs-space-2)' }}>
                  {meta ? meta.label : key}:
                </span>
                <span style={{ color: 'var(--chs-color-text)' }}>{displayVal}</span>
              </div>
            );
          })}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-1)', marginTop: 'var(--chs-space-2)' }}>
            <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>Колонка</span>
            <select
              className="chs-input chs-select"
              value={currentValue ?? ''}
              onChange={handleMoveSelect}
              disabled={moving}
              aria-label={`Переместить «${cardLabel}» в колонку`}
            >
              {columnValues.map((cv) => (
                <option key={cv.value ?? '__none__'} value={cv.value ?? ''}>{cv.label}</option>
              ))}
            </select>
          </label>
        </div>
      </Card>
    </li>
  );
}

// ---------------------------------------------------------------------------
// KanbanColumnView — one column: header (name + count) + card list + native
// drop target (mouse path) + honest empty state when 0 cards.
// ---------------------------------------------------------------------------

function KanbanColumnView({
  column, cardFields, fieldMetaByKey, columnValues, movingId, onMove, dragOverValue, onDragOver, onDragLeave, onDrop, draggingId,
}) {
  const isDragOver = dragOverValue !== undefined && dragOverValue === column.value;
  return (
    <div
      role="group"
      aria-label={`${column.label} · ${column.cards.length}`}
      className="chs-kanban-column"
      onDragOver={(e) => { e.preventDefault(); onDragOver(column.value); }}
      onDragLeave={() => onDragLeave(column.value)}
      onDrop={(e) => { e.preventDefault(); onDrop(column.value); }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: '260px',
        maxWidth: '320px',
        flex: '0 0 auto',
        background: 'var(--chs-color-surface)',
        border: `1px solid ${isDragOver ? 'var(--chs-color-accent)' : 'var(--chs-color-border)'}`,
        borderRadius: 'var(--chs-radius-3)',
        padding: 'var(--chs-space-3)',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 'var(--chs-space-3)',
      }}>
        <span style={{ fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
          {column.label}
        </span>
        <Badge tone="neutral">{column.cards.length}</Badge>
      </div>

      {column.cards.length === 0 ? (
        <EmptyState compact title="Пока нет записей" />
      ) : (
        <ul
          role="list"
          style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-3)' }}
        >
          {column.cards.map((rec) => (
            <KanbanCard
              key={rec.id}
              record={rec}
              cardFields={cardFields}
              fieldMetaByKey={fieldMetaByKey}
              columnValues={columnValues}
              currentValue={column.value}
              moving={movingId === rec.id}
              dragging={draggingId === rec.id}
              onMove={onMove}
              onDragStart={(r) => onDragOver(undefined, r.id)}
              onDragEnd={() => onDragOver(undefined, undefined)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KanbanBoard — top-level component. Owns optimistic move + rollback.
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   records: Array<{id,data}>|null,      // null=loading, [] = empty, [...] = list
 *   recordsError: string|null,
 *   onRetry: () => void,
 *   groupByField: string,
 *   groupByRequired: boolean,
 *   enumValues: string[],                 // record_schema.properties[groupByField].enum
 *   columnsOrder: string[]|undefined,
 *   cardFields: string[],
 *   fieldMetaByKey: Map<string,{key,label,type}>,
 *   onMoveRecord: (recordId:string, nextData:object) => Promise<{ok:boolean, error?:string}>,
 *   onLocalUpdate: (recordId:string, nextData:object) => void,  // optimistic local patch
 * }} props
 */
export function KanbanBoard({
  records, recordsError, onRetry, groupByField, groupByRequired, enumValues, columnsOrder,
  cardFields, fieldMetaByKey, onMoveRecord, onLocalUpdate,
}) {
  const [movingId, setMovingId] = useState(null);
  const [moveError, setMoveError] = useState(null);
  const [dragOverValue, setDragOverValue] = useState(undefined);
  const [draggingId, setDraggingId] = useState(undefined);

  const columns = useMemo(
    () => buildKanbanColumns(records || [], groupByField, enumValues, columnsOrder),
    [records, groupByField, enumValues, columnsOrder],
  );

  // The list of {value,label} options offered by every card's keyboard "Колонка"
  // select: every real column value + the "Без значения" pseudo-column — UNLESS
  // groupByField is required (AC-8), in which case "Без значения" is a dead-end
  // option (buildMovePayload always rejects it) and is hidden rather than
  // offered-then-refused.
  const columnValues = useMemo(
    () => columns
      .filter((c) => !(groupByRequired && c.value === null))
      .map((c) => ({ value: c.value, label: c.label })),
    [columns, groupByRequired],
  );

  const handleDragOverTrack = useCallback((value, cardId) => {
    if (cardId !== undefined) { setDraggingId(cardId); return; }
    setDragOverValue(value);
  }, []);

  const handleMove = useCallback(async (record, newValue) => {
    setMoveError(null);
    const payload = buildMovePayload(record, groupByField, newValue, groupByRequired);
    if (!payload.ok) {
      setMoveError(payload.error);
      return;
    }
    // Optimistic: apply locally FIRST so the card visually jumps immediately.
    const previousData = record.data;
    onLocalUpdate(record.id, payload.data);
    setMovingId(record.id);
    try {
      const result = await onMoveRecord(record.id, payload.data);
      if (!result.ok) {
        // FR-6/AC-6: rollback — restore the record to its previous data so the
        // board reflects the REAL (unsaved) server state, never a silent
        // "looks moved but wasn't" lie.
        onLocalUpdate(record.id, previousData);
        setMoveError(result.error || 'Не удалось перенести запись');
      }
    } finally {
      setMovingId(null);
    }
  }, [groupByField, groupByRequired, onMoveRecord, onLocalUpdate]);

  const handleDrop = useCallback((targetValue) => {
    const draggedId = draggingId;
    setDraggingId(undefined);
    setDragOverValue(undefined);
    if (!draggedId) return;
    const rec = (records || []).find((r) => r.id === draggedId);
    if (!rec) return;
    handleMove(rec, targetValue);
  }, [draggingId, records, handleMove]);

  if (recordsError) {
    return <ErrorState message={`Не удалось загрузить записи: ${recordsError}`} onRetry={onRetry} />;
  }
  if (records === null) {
    return <LoadingState label="Загрузка записей…" />;
  }
  if (!groupByField) {
    return (
      <EmptyState
        title="Не выбрано поле группировки"
        description="Настройте канбан: выберите поле со списком значений, по которому раскладывать записи на доске."
      />
    );
  }
  if (enumValues.length === 0) {
    return (
      <EmptyState
        title="У выбранного поля нет значений"
        description="Добавьте значения выбранному полю в конструкторе полей, чтобы на доске появились колонки."
      />
    );
  }

  return (
    <div>
      {moveError && (
        <div
          role="alert"
          style={{
            marginBottom: 'var(--chs-space-3)',
            padding: 'var(--chs-space-3) var(--chs-space-4)',
            background: 'var(--chs-color-danger-soft)',
            border: '1px solid var(--chs-color-danger)',
            borderRadius: 'var(--chs-radius-3)',
            fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
          }}
        >
          {moveError}
        </div>
      )}
      <div
        role="list"
        aria-label="Колонки доски"
        style={{ display: 'flex', gap: 'var(--chs-space-4)', overflowX: 'auto', paddingBottom: 'var(--chs-space-3)' }}
      >
        {columns.map((col) => (
          <KanbanColumnView
            key={col.value ?? '__none__'}
            column={col}
            cardFields={cardFields}
            fieldMetaByKey={fieldMetaByKey}
            columnValues={columnValues}
            movingId={movingId}
            onMove={handleMove}
            dragOverValue={dragOverValue}
            onDragOver={handleDragOverTrack}
            onDragLeave={() => setDragOverValue(undefined)}
            onDrop={handleDrop}
            draggingId={draggingId}
          />
        ))}
      </div>
    </div>
  );
}

export { isFieldRequired };
