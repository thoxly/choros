/* ============================================================================
   web/src/screens/list-view-panel.jsx — T-0581 (view registry) FR-4/AC-14/AC-15.

   The «Настроить список» panel: a kit <Drawer> that lets a user assemble a
   saved list_view (columns + filters + sort) WITHOUT code, consuming the
   already-approved backend (CRUD /api/list-views + GET /api/records?view_id=
   /?filter=/?sort=). Point of integration: screen-app-records.jsx renders
   <ListViewPanel> + <ViewSwitcher> alongside the existing autogen table (which
   itself IS the synthetic default view, ADR §3.3).

   FR-4 CONTRACT (spec):
     1. КОЛОНКИ — show/hide, reorder (up/down buttons — keyboard-operable by
        construction, no drag-and-drop required; mirrors the project's existing
        accessible-reorder precedent in screen-app-schema.jsx's FieldRow /
        FormBuilder.jsx's FieldConfigRow), width.
     2. ФИЛЬТРЫ — a builder whose operator choices are FILTERED BY FIELD TYPE
        (list-view-panel.js operatorsForFieldType) and rendered as Russian
        words ("равно"/"больше"/"пусто" — never "eq"/"gt"/"is_empty").
     3. СОРТИРОВКА — field + human direction ("по возрастанию"/"по убыванию").
     4. SAVE + is_default + a view switcher; the panel states views are
        tenant-shared (spec FR-10/§6) so nobody is surprised a teammate sees
        the same list.
     5. Honest Loading/Empty/Error states (kit LoadingState/EmptyState/ErrorState).

   OBLIK (G1-G7 / D-062): --chs-* tokens + kit components only (Drawer, Button,
   Field, Select, EmptyState/LoadingState/ErrorState, Notice) — no hand-rolled
   overlay/hardcoded color. No dev jargon in visible text (G5): "view" →
   «представление», "registry" → «набор полей», never "JSONB"/"view_id" in a
   label. Anti-case (D-064): zero business-domain vocabulary — this panel is
   generic over ANY application's fields.
   ============================================================================ */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Field, Select, KitIcon, Drawer, EmptyState, ErrorState, LoadingState, Notice,
} from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import {
  buildFieldCatalog, draftFromConfig, configFromDraft,
  moveColumn, toggleColumnVisible, setColumnWidth,
  addFilterRow, removeFilterRow, updateFilterRow, validateFilterRow,
  addSortRow, removeSortRow, updateSortRow,
  availableFilterFields, availableSortFields,
  operatorsForFieldType, OP_LABELS,
  validateViewName, allColumnsHidden,
} from './list-view-panel.js';
// T-0582 (kanban view): the panel's SECOND view-type mode — group_by_field +
// card_fields pickers, reusing the SAME FiltersEditor/SortEditor below (the
// kanban draft carries filters/sort with the identical row shape as 'list').
import {
  draftFromKanbanConfig, kanbanConfigFromDraft, availableGroupByFields,
} from './kanban-board.js';

// ---------------------------------------------------------------------------
// useListViews — fetch + CRUD hook for /api/list-views (a small data hook, kept
// alongside the panel since it has no reuse outside this feature).
// ---------------------------------------------------------------------------

/**
 * @param {string|null} registryDefId
 * @param {string|null} applicationId
 */
function useListViews(registryDefId, applicationId) {
  const [views, setViews] = useState(null);       // null=loading, []=none, [...]=list
  const [defaultView, setDefaultView] = useState(null);
  const [error, setError] = useState(null);
  // T-0581 UX-1 fix: explicit loading flag — `views === null` alone conflates
  // "still loading" with "no registryDefId chosen yet" (both leave views
  // null), which is not enough for the panel to know whether it is safe to
  // seed a draft from defaultView (which is also still null while in flight).
  const [loading, setLoading] = useState(Boolean(registryDefId));

  const load = useCallback(async () => {
    if (!registryDefId) { setViews(null); setDefaultView(null); setLoading(false); return; }
    setError(null);
    setViews(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/list-views?registry_def_id=${encodeURIComponent(registryDefId)}`,
        { headers: devHeaders() },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setViews(Array.isArray(data.views) ? data.views : []);
      setDefaultView(data.default_view || null);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [registryDefId]);

  useEffect(() => { load(); }, [load]);

  // T-0582: `type` ('list'|'kanban') is only meaningful on CREATE (POST) — the
  // server's patchView re-validates config against the EXISTING row's type
  // (list-views.ts) and has no field to change type on PUT, so it is only sent
  // when creating a brand-new view. Defaults to 'list' when omitted (unchanged
  // pre-T-0582 behaviour for the "Настроить список" list flow).
  const saveView = useCallback(async ({ id, name, config, isDefault, type }) => {
    const body = { name, config, is_default: Boolean(isDefault) };
    const res = id
      ? await fetch(`/api/list-views/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', ...devHeaders() },
          body: JSON.stringify(body),
        })
      : await fetch('/api/list-views', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...devHeaders() },
          body: JSON.stringify({ ...body, type: type || 'list', registry_def_id: registryDefId, application_id: applicationId }),
        });
    if (res.status === 200 || res.status === 201) {
      await load();
      return { ok: true, view: await res.json() };
    }
    let parsed = null;
    try { parsed = await res.json(); } catch { /* ignore parse error */ }
    if (res.status === 409) {
      return { ok: false, error: 'Представление с таким названием уже есть в этом наборе полей' };
    }
    if (res.status === 400) {
      return { ok: false, error: (parsed && parsed.message) || 'Настройка представления некорректна' };
    }
    return { ok: false, error: `Не удалось сохранить представление (HTTP ${res.status})` };
  }, [registryDefId, applicationId, load]);

  const deleteView = useCallback(async (id) => {
    const res = await fetch(`/api/list-views/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: devHeaders(),
    });
    if (res.status === 204 || res.status === 404) {
      await load();
      return { ok: true };
    }
    return { ok: false, error: `Не удалось удалить представление (HTTP ${res.status})` };
  }, [load]);

  return { views, defaultView, error, loading, reload: load, saveView, deleteView };
}

// ---------------------------------------------------------------------------
// ViewSwitcher — small toolbar control: pick among saved views + "по умолчанию".
// ---------------------------------------------------------------------------

/**
 * @param {{views: Array, activeViewId: string|null, onChange: (id:string|null)=>void}} props
 */
export function ViewSwitcher({ views, activeViewId, onChange }) {
  const list = views || [];
  if (list.length === 0) return null;
  return (
    <Select
      aria-label="Представление списка"
      value={activeViewId || ''}
      onChange={(e) => onChange(e.target.value || null)}
      style={{ width: 'auto' }}
    >
      <option value="">По умолчанию (все поля)</option>
      {list.map((v) => (
        <option key={v.id} value={v.id}>{v.name}{v.is_default ? ' · по умолчанию' : ''}</option>
      ))}
    </Select>
  );
}

// ---------------------------------------------------------------------------
// ColumnsEditor — visibility / reorder (up-down buttons, keyboard-operable
// by construction — no drag needed) / width.
// ---------------------------------------------------------------------------

function ColumnsEditor({ columns, fieldLabelByKey, onChange }) {
  const setColumns = (next) => onChange(next);

  if (columns.length === 0) {
    return (
      <EmptyState compact title="В этом наборе полей пока нет колонок" />
    );
  }

  return (
    <ul
      aria-label="Колонки списка: порядок и видимость"
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}
    >
      {columns.map((col, index) => {
        const label = fieldLabelByKey.get(col.field_key) || col.field_key;
        return (
          <li
            key={col.id}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto auto',
              alignItems: 'center',
              gap: 'var(--chs-space-3)',
              padding: 'var(--chs-space-2) var(--chs-space-3)',
              border: '1px solid var(--chs-color-border)',
              borderRadius: 'var(--chs-radius-2)',
              background: 'var(--chs-color-surface)',
            }}
          >
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)' }}>
              <input
                type="checkbox"
                checked={col.visible}
                onChange={() => setColumns(toggleColumnVisible(columns, col.id))}
                aria-label={`Показать колонку «${label}»`}
              />
            </label>
            <span
              style={{
                fontSize: 'var(--chs-text-sm)',
                color: col.visible ? 'var(--chs-color-text)' : 'var(--chs-color-text-muted)',
              }}
            >
              {label}
            </span>
            <input
              type="number"
              className="chs-input"
              placeholder="авто"
              value={col.width ?? ''}
              min={1}
              onChange={(e) => {
                const raw = e.target.value;
                setColumns(setColumnWidth(columns, col.id, raw === '' ? null : Number(raw)));
              }}
              aria-label={`Ширина колонки «${label}» (px)`}
              style={{ width: '76px' }}
            />
            {/* Reorder — up/down buttons ARE the keyboard-operable primitive
                (native <button disabled>, no drag-and-drop needed): mirrors
                screen-app-schema.jsx FieldRow / FormBuilder.jsx FieldConfigRow. */}
            <div style={{ display: 'flex', gap: 'var(--chs-space-1)' }}>
              <Button
                type="button" variant="ghost" size="sm"
                disabled={index === 0}
                onClick={() => setColumns(moveColumn(columns, index, index - 1))}
                title="Переместить выше"
                aria-label={`Переместить «${label}» выше`}
              >
                <KitIcon name="arrow-up" />
              </Button>
              <Button
                type="button" variant="ghost" size="sm"
                disabled={index === columns.length - 1}
                onClick={() => setColumns(moveColumn(columns, index, index + 1))}
                title="Переместить ниже"
                aria-label={`Переместить «${label}» ниже`}
              >
                <KitIcon name="arrow-down" />
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// FiltersEditor — per-field, operators filtered by field TYPE, Russian labels.
// ---------------------------------------------------------------------------

function FilterValueInput({ row, fieldType, onChange }) {
  const op = row.op;
  if (op === 'is_empty' || op === 'is_not_empty' || op === 'is_true' || op === 'is_false') {
    return null; // no value needed
  }
  if (op === 'between') {
    const [lo, hi] = Array.isArray(row.value) ? row.value : ['', ''];
    const numeric = fieldType === 'number' || fieldType === 'integer' || fieldType === 'money';
    const inputType = fieldType === 'date' ? 'date' : numeric ? 'number' : 'text';
    return (
      <div style={{ display: 'flex', gap: 'var(--chs-space-2)', alignItems: 'center' }}>
        <input
          type={inputType} className="chs-input" value={lo ?? ''}
          onChange={(e) => onChange([e.target.value, hi ?? ''])}
          aria-label="От"
          style={{ width: '120px' }}
        />
        <span style={{ color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-xs)' }}>и</span>
        <input
          type={inputType} className="chs-input" value={hi ?? ''}
          onChange={(e) => onChange([lo ?? '', e.target.value])}
          aria-label="До"
          style={{ width: '120px' }}
        />
      </div>
    );
  }
  if (op === 'in' || op === 'contains_any' || op === 'contains_all') {
    const listValue = Array.isArray(row.value) ? row.value.join(', ') : '';
    return (
      <input
        type="text" className="chs-input"
        placeholder="значение1, значение2…"
        value={listValue}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0))}
        aria-label="Значения через запятую"
        style={{ width: '220px' }}
      />
    );
  }
  const numeric = fieldType === 'number' || fieldType === 'integer' || fieldType === 'money';
  const inputType = fieldType === 'date' ? 'date' : numeric ? 'number' : 'text';
  return (
    <input
      type={inputType} className="chs-input"
      value={row.value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Значение"
      style={{ width: '160px' }}
    />
  );
}

function FiltersEditor({ filters, fieldCatalog, typeByKey, onChange }) {
  const filterableFields = useMemo(() => availableFilterFields(fieldCatalog), [fieldCatalog]);
  const [addFieldKey, setAddFieldKey] = useState('');

  const handleAdd = () => {
    if (!addFieldKey) return;
    const fieldType = typeByKey.get(addFieldKey);
    onChange(addFilterRow(filters, addFieldKey, fieldType));
    setAddFieldKey('');
  };

  return (
    <div>
      {filters.length === 0 ? (
        <p style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
          Фильтров пока нет — список показывает все записи.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: '0 0 var(--chs-space-3) 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-3)' }}>
          {filters.map((row) => {
            const fieldType = typeByKey.get(row.field_key);
            const label = fieldCatalog.find((f) => f.key === row.field_key)?.label || row.field_key;
            const ops = operatorsForFieldType(fieldType);
            const rowError = validateFilterRow(row, typeByKey);
            return (
              <li key={row.id} style={{ border: '1px solid var(--chs-color-border)', borderRadius: 'var(--chs-radius-2)', padding: 'var(--chs-space-3)' }}>
                <div style={{ display: 'flex', gap: 'var(--chs-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>{label}</span>
                  <select
                    className="chs-input chs-select"
                    value={row.op || ''}
                    onChange={(e) => onChange(updateFilterRow(filters, row.id, { op: e.target.value, value: '' }))}
                    aria-label={`Оператор для «${label}»`}
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>{OP_LABELS[op] || op}</option>
                    ))}
                  </select>
                  <FilterValueInput
                    row={row}
                    fieldType={fieldType}
                    onChange={(value) => onChange(updateFilterRow(filters, row.id, { value }))}
                  />
                  <Button
                    type="button" variant="ghost" size="sm"
                    onClick={() => onChange(removeFilterRow(filters, row.id))}
                    aria-label={`Удалить фильтр по «${label}»`}
                    title="Удалить фильтр"
                  >
                    <KitIcon name="close" />
                  </Button>
                </div>
                {rowError && (
                  <span style={{ display: 'block', marginTop: 'var(--chs-space-2)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)' }} role="alert">
                    {rowError}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 'var(--chs-space-2)', alignItems: 'center' }}>
        <select
          className="chs-input chs-select"
          value={addFieldKey}
          onChange={(e) => setAddFieldKey(e.target.value)}
          aria-label="Добавить фильтр по полю"
          style={{ minWidth: '180px' }}
        >
          <option value="">— выберите поле —</option>
          {filterableFields.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        <Button type="button" variant="secondary" size="sm" glyph={<KitIcon name="plus" />} onClick={handleAdd} disabled={!addFieldKey}>
          Добавить фильтр
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SortEditor — field + human direction ("по возрастанию"/"по убыванию").
// ---------------------------------------------------------------------------

function SortEditor({ sort, fieldCatalog, onChange }) {
  const sortableFields = useMemo(() => availableSortFields(fieldCatalog, sort), [fieldCatalog, sort]);
  const [addFieldKey, setAddFieldKey] = useState('');

  const handleAdd = () => {
    if (!addFieldKey) return;
    onChange(addSortRow(sort, addFieldKey));
    setAddFieldKey('');
  };

  return (
    <div>
      {sort.length === 0 ? (
        <p style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', fontStyle: 'italic' }}>
          Сортировка не задана — порядок по умолчанию (по дате создания, сначала новые).
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: '0 0 var(--chs-space-3) 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
          {sort.map((row) => {
            const label = fieldCatalog.find((f) => f.key === row.field_key)?.label || row.field_key;
            return (
              <li key={row.id} style={{ display: 'flex', gap: 'var(--chs-space-2)', alignItems: 'center' }}>
                <span style={{ fontSize: 'var(--chs-text-sm)', minWidth: '140px' }}>{label}</span>
                <select
                  className="chs-input chs-select"
                  value={row.dir}
                  onChange={(e) => onChange(updateSortRow(sort, row.id, { dir: e.target.value }))}
                  aria-label={`Направление сортировки по «${label}»`}
                >
                  <option value="asc">по возрастанию</option>
                  <option value="desc">по убыванию</option>
                </select>
                <Button
                  type="button" variant="ghost" size="sm"
                  onClick={() => onChange(removeSortRow(sort, row.id))}
                  aria-label={`Убрать сортировку по «${label}»`}
                  title="Убрать"
                >
                  <KitIcon name="close" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 'var(--chs-space-2)', alignItems: 'center' }}>
        <select
          className="chs-input chs-select"
          value={addFieldKey}
          onChange={(e) => setAddFieldKey(e.target.value)}
          aria-label="Добавить сортировку по полю"
          style={{ minWidth: '180px' }}
        >
          <option value="">— выберите поле —</option>
          {sortableFields.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        <Button type="button" variant="secondary" size="sm" glyph={<KitIcon name="plus" />} onClick={handleAdd} disabled={!addFieldKey}>
          Добавить сортировку
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KanbanConfigEditor — T-0582: group_by_field picker (select-typed fields
// only) + card_fields checkboxes (ordered, mirrors ColumnsEditor's field list
// styling). filters/sort for kanban mode are rendered by the SAME
// FiltersEditor/SortEditor as 'list' (identical row shape — reused, not
// duplicated, NF-2).
// ---------------------------------------------------------------------------

function KanbanConfigEditor({ kanbanDraft, groupByFields, fieldCatalog, fieldLabelByKey, onChange }) {
  const cardFieldsSet = useMemo(() => new Set(kanbanDraft.card_fields), [kanbanDraft.card_fields]);

  if (groupByFields.length === 0) {
    return (
      <EmptyState
        compact
        title="Нет подходящих полей"
        description="Для канбана нужно поле со списком значений (тип «Список»). Добавьте такое поле в конструкторе полей."
      />
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label className="chs-label" htmlFor="kanban-group-by-field">Группировать по полю</label>
        <select
          id="kanban-group-by-field"
          className="chs-input chs-select"
          value={kanbanDraft.group_by_field}
          onChange={(e) => onChange({ ...kanbanDraft, group_by_field: e.target.value })}
          aria-label="Поле группировки (значения этого поля станут колонками доски)"
        >
          <option value="">— выберите поле —</option>
          {groupByFields.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
      </div>

      <div>
        <span style={{ display: 'block', marginBottom: 'var(--chs-space-2)', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>
          Поля на карточке
        </span>
        {fieldCatalog.length === 0 ? (
          <EmptyState compact title="В этом наборе полей пока нет полей" />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
            {fieldCatalog.map((f) => {
              const checked = cardFieldsSet.has(f.key);
              return (
                <li key={f.key}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)', fontSize: 'var(--chs-text-sm)' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? kanbanDraft.card_fields.filter((k) => k !== f.key)
                          : [...kanbanDraft.card_fields, f.key];
                        onChange({ ...kanbanDraft, card_fields: next });
                      }}
                      aria-label={`Показать «${fieldLabelByKey.get(f.key) || f.key}» на карточке`}
                    />
                    {f.label}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ListViewPanel — the top-level Drawer. Owns the draft + save/apply flow.
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   registryDefId: string|null,
 *   applicationId: string|null,
 *   schemaColumns: Array<{key,label,type}>,   // schemaToColumns(recordSchema)
 *   activeView: object|null,                   // the currently-applied saved view row, or null (default)
 *   defaultViewConfig: object|null,             // the synthetic default (from GET /api/list-views)
 *   onApply: (viewIdOrNull: string|null) => void,  // switch the list to this view (reload records)
 *   views: Array,
 *   viewsError: string|null,
 *   viewsLoading: boolean,                      // T-0581 UX-1: true while GET /api/list-views is in flight
 *   reloadViews: () => Promise<void>,
 *   saveView: (args) => Promise<{ok,error?,view?}>,
 *   deleteView: (id) => Promise<{ok,error?}>,
 * }} props
 */
export function ListViewPanel({
  open, onClose, schemaColumns, activeView, defaultViewConfig,
  onApply, viewsError, viewsLoading, saveView, deleteView,
}) {
  const fieldCatalog = useMemo(() => buildFieldCatalog(schemaColumns), [schemaColumns]);
  const typeByKey = useMemo(() => new Map(fieldCatalog.map((f) => [f.key, f.type])), [fieldCatalog]);
  const fieldLabelByKey = useMemo(() => new Map(fieldCatalog.map((f) => [f.key, f.label])), [fieldCatalog]);
  const groupByFields = useMemo(() => availableGroupByFields(fieldCatalog), [fieldCatalog]);

  const sourceConfig = (activeView && activeView.config) || defaultViewConfig;
  // T-0581 UX-1: the synthetic default has not arrived yet (GET /api/list-views
  // still in flight) when there is no saved view active AND defaultViewConfig
  // is still null. Rendering an editable draft in this state is DISHONEST —
  // draftFromConfig(null, catalog) marks every column visible:false, which is
  // NOT the server's real default (all columns visible) — see list-view-panel.js
  // draftFromConfig. The panel must show a Loading state and refuse to edit
  // until the real default (or a real saved view) has arrived.
  const stillAwaitingDefault = !activeView && defaultViewConfig == null && viewsLoading !== false;
  const [draft, setDraft] = useState(() => draftFromConfig(sourceConfig, fieldCatalog));
  // T-0582: kanban mode has ITS OWN draft shape (group_by_field/card_fields/
  // columns_order + filters/sort) — kept alongside the 'list' draft rather
  // than replacing it, so switching the type picker back and forth in the SAME
  // editing session never loses either draft's in-progress edits.
  const [kanbanDraft, setKanbanDraft] = useState(() => draftFromKanbanConfig(
    activeView && activeView.type === 'kanban' ? activeView.config : null,
    fieldCatalog,
  ));
  // viewType: 'list' | 'kanban'. Only meaningful/changeable for a BRAND-NEW
  // view (activeView === null) — an EXISTING view's type is immutable (the
  // server has no field to change it on PUT, list-views.ts patchView
  // re-validates against existing.type), so editing a saved view locks the
  // picker to that view's own type.
  const [viewType, setViewType] = useState(activeView ? (activeView.type || 'list') : 'list');
  const [name, setName] = useState(activeView ? activeView.name : '');
  const [markDefault, setMarkDefault] = useState(activeView ? Boolean(activeView.is_default) : false);
  const [nameError, setNameError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Tracks whether the user has touched the draft since it was last (re-)seeded
  // — guards against the re-seed effect clobbering in-progress edits the
  // instant defaultViewConfig/sourceConfig resolves (variant "а" of the UX-1
  // fix: re-seed on the source-of-truth actually changing, not just on open/
  // activeView, but never overwrite a draft the user has already started
  // editing in this open session).
  const [dirty, setDirty] = useState(false);

  // Re-seed the draft whenever the panel opens, the active view changes, OR
  // the source config itself resolves/changes (T-0581 UX-1 fix, variant "а"):
  // sourceConfig is null while defaultViewConfig hasn't arrived yet, so once
  // it resolves this effect now re-runs and replaces the honest-but-provisional
  // "all hidden" draft with the real default — UNLESS the user has already
  // started editing (dirty), in which case we never clobber their work.
  useEffect(() => {
    if (!open) return;
    if (dirty) return;
    setDraft(draftFromConfig(sourceConfig, fieldCatalog));
    setKanbanDraft(draftFromKanbanConfig(
      activeView && activeView.type === 'kanban' ? activeView.config : null,
      fieldCatalog,
    ));
    setViewType(activeView ? (activeView.type || 'list') : 'list');
    setName(activeView ? activeView.name : '');
    setMarkDefault(activeView ? Boolean(activeView.is_default) : false);
    setNameError(null);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeView && activeView.id, sourceConfig, dirty]);

  // Reset the dirty flag + re-seed whenever the panel transitions closed→open
  // (a fresh editing session should always start clean, regardless of
  // whatever was dirty from a previous open).
  useEffect(() => {
    if (open) setDirty(false);
  }, [open]);

  const markDirty = useCallback(() => setDirty(true), []);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    const err = validateViewName(name);
    setNameError(err);
    if (err) return;
    if (viewType === 'kanban' && !kanbanDraft.group_by_field) {
      setSaveError('Выберите поле группировки (со списком значений)');
      return;
    }
    setSaving(true);
    try {
      const config = viewType === 'kanban' ? kanbanConfigFromDraft(kanbanDraft) : configFromDraft(draft);
      const result = await saveView({
        id: activeView ? activeView.id : undefined,
        name,
        config,
        isDefault: markDefault,
        type: activeView ? activeView.type : viewType,
      });
      if (result.ok) {
        onApply(result.view.id);
        onClose();
      } else {
        setSaveError(result.error);
      }
    } finally {
      setSaving(false);
    }
  }, [name, draft, kanbanDraft, viewType, markDefault, activeView, saveView, onApply, onClose]);

  const handleDelete = useCallback(async () => {
    if (!activeView) return;
    setDeleting(true);
    try {
      const result = await deleteView(activeView.id);
      if (result.ok) {
        onApply(null);
        onClose();
      } else {
        setSaveError(result.error);
      }
    } finally {
      setDeleting(false);
    }
  }, [activeView, deleteView, onApply, onClose]);

  // T-0581 UX-2: warn (not silently allow) saving a draft that hides every
  // column — the rendered list would fall back to "Создано" + row actions
  // only (screen-app-records.jsx columns memo). A warning, not a hard block —
  // this can be a deliberate choice (e.g. a list meant to be filtered/sorted
  // only, never displayed as a grid) — but the user must see it coming.
  const columnsAllHidden = useMemo(() => allColumnsHidden(draft.columns), [draft.columns]);

  // T-0581 UX-1: while the real default is still in flight, editing/saving is
  // disabled — canEdit additionally requires the source config to have
  // resolved (either a real saved view is active, or the synthetic default
  // has arrived), so the Save button can never commit the provisional
  // "all hidden" seed.
  const canEdit = fieldCatalog.length > 0 && !stillAwaitingDefault;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Настроить список"
      side="right"
      footer={
        <>
          {activeView && (
            <Button
              type="button" variant="ghost" size="sm"
              loading={deleting}
              onClick={handleDelete}
              style={{ marginRight: 'auto', color: 'var(--chs-color-danger)' }}
            >
              Удалить представление
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
          <Button type="button" variant="primary" size="sm" loading={saving} disabled={!canEdit} onClick={handleSave}>
            {saving ? 'Сохранение…' : 'Сохранить представление'}
          </Button>
        </>
      }
    >
      {viewsError ? (
        <ErrorState message={`Не удалось загрузить представления: ${viewsError}`} />
      ) : stillAwaitingDefault ? (
        // T-0581 UX-1 fix (variant "б"): honest Loading state — the synthetic
        // default (all columns visible) has not arrived yet, so there is
        // nothing truthful to render as an editable draft. Never let the user
        // edit/save the provisional "all hidden" seed (see stillAwaitingDefault
        // above + list-view-panel.js draftFromConfig).
        <LoadingState label="Загрузка представления…" />
      ) : !canEdit ? (
        <EmptyState
          title="В наборе полей нет колонок"
          description="Сначала определите поля — потом здесь можно будет настроить список."
        />
      ) : (
        <>
          <div style={{ marginBottom: 'var(--chs-space-3)' }}>
            <Notice
              tone="info"
              message="Представление общее для всех, у кого есть доступ к этому набору полей — оно не приватно лично для вас."
            />
          </div>

          <Field
            label="Название представления"
            value={name}
            onChange={(e) => { setName(e.target.value); setNameError(null); markDirty(); }}
            placeholder="Например: Мой активный список"
            invalid={Boolean(nameError)}
            hint={nameError || undefined}
          />

          {/* T-0582: view-TYPE picker — only changeable for a brand-new view
              (activeView === null). An existing view's type is fixed (the
              server has no PUT field to change it), so editing a saved view
              shows the type as a read-only label instead of a picker. */}
          <div style={{ marginBottom: 'var(--chs-space-4)' }}>
            <span className="chs-label" style={{ display: 'block', marginBottom: 'var(--chs-space-2)' }}>Тип представления</span>
            {activeView ? (
              <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
                {activeView.type === 'kanban' ? 'Канбан-доска' : 'Список'}
              </span>
            ) : (
              <select
                className="chs-input chs-select"
                value={viewType}
                onChange={(e) => { setViewType(e.target.value); markDirty(); }}
                aria-label="Тип представления"
              >
                <option value="list">Список</option>
                <option value="kanban">Канбан-доска</option>
              </select>
            )}
          </div>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)', margin: 'var(--chs-space-2) 0 var(--chs-space-5) 0', fontSize: 'var(--chs-text-sm)' }}>
            <input type="checkbox" checked={markDefault} onChange={(e) => { setMarkDefault(e.target.checked); markDirty(); }} />
            Открывать это представление по умолчанию
          </label>

          {viewType === 'kanban' ? (
            <>
              <section style={{ marginBottom: 'var(--chs-space-6)' }}>
                <h3 style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>Доска</h3>
                <KanbanConfigEditor
                  kanbanDraft={kanbanDraft}
                  groupByFields={groupByFields}
                  fieldCatalog={fieldCatalog}
                  fieldLabelByKey={fieldLabelByKey}
                  onChange={(next) => { markDirty(); setKanbanDraft(next); }}
                />
              </section>

              <section style={{ marginBottom: 'var(--chs-space-6)' }}>
                <h3 style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>Фильтры</h3>
                <FiltersEditor filters={kanbanDraft.filters} fieldCatalog={fieldCatalog} typeByKey={typeByKey} onChange={(filters) => { markDirty(); setKanbanDraft((d) => ({ ...d, filters })); }} />
              </section>

              <section style={{ marginBottom: 'var(--chs-space-6)' }}>
                <h3 style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>Сортировка внутри колонки</h3>
                <SortEditor sort={kanbanDraft.sort} fieldCatalog={fieldCatalog} onChange={(sort) => { markDirty(); setKanbanDraft((d) => ({ ...d, sort })); }} />
              </section>
            </>
          ) : (
            <>
              <section style={{ marginBottom: 'var(--chs-space-6)' }}>
                <h3 style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>Колонки</h3>
                <ColumnsEditor columns={draft.columns} fieldLabelByKey={fieldLabelByKey} onChange={(columns) => { markDirty(); setDraft((d) => ({ ...d, columns })); }} />
                {columnsAllHidden && (
                  <div style={{ marginTop: 'var(--chs-space-3)' }}>
                    <Notice
                      tone="warning"
                      message="Все колонки скрыты — список будет показывать только «Создано» и действия над записью."
                    />
                  </div>
                )}
              </section>

              <section style={{ marginBottom: 'var(--chs-space-6)' }}>
                <h3 style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>Фильтры</h3>
                <FiltersEditor filters={draft.filters} fieldCatalog={fieldCatalog} typeByKey={typeByKey} onChange={(filters) => { markDirty(); setDraft((d) => ({ ...d, filters })); }} />
              </section>

              <section style={{ marginBottom: 'var(--chs-space-6)' }}>
                <h3 style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>Сортировка</h3>
                <SortEditor sort={draft.sort} fieldCatalog={fieldCatalog} onChange={(sort) => { markDirty(); setDraft((d) => ({ ...d, sort })); }} />
              </section>
            </>
          )}

          {saveError && (
            <div role="alert" style={{
              padding: 'var(--chs-space-4) var(--chs-space-5)',
              background: 'var(--chs-color-danger-soft)',
              border: '1px solid var(--chs-color-danger)',
              borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)',
              color: 'var(--chs-color-text)',
            }}>
              {saveError}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

export { useListViews };
