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
  Button, Field, Select, KitIcon, Drawer, EmptyState, ErrorState, Notice,
} from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import {
  buildFieldCatalog, draftFromConfig, configFromDraft,
  moveColumn, toggleColumnVisible, setColumnWidth,
  addFilterRow, removeFilterRow, updateFilterRow, validateFilterRow,
  addSortRow, removeSortRow, updateSortRow,
  availableFilterFields, availableSortFields,
  operatorsForFieldType, OP_LABELS,
  validateViewName,
} from './list-view-panel.js';

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

  const load = useCallback(async () => {
    if (!registryDefId) { setViews(null); setDefaultView(null); return; }
    setError(null);
    setViews(null);
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
    }
  }, [registryDefId]);

  useEffect(() => { load(); }, [load]);

  const saveView = useCallback(async ({ id, name, config, isDefault }) => {
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
          body: JSON.stringify({ ...body, registry_def_id: registryDefId, application_id: applicationId }),
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

  return { views, defaultView, error, reload: load, saveView, deleteView };
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
 *   reloadViews: () => Promise<void>,
 *   saveView: (args) => Promise<{ok,error?,view?}>,
 *   deleteView: (id) => Promise<{ok,error?}>,
 * }} props
 */
export function ListViewPanel({
  open, onClose, schemaColumns, activeView, defaultViewConfig,
  onApply, views, viewsError, saveView, deleteView,
}) {
  const fieldCatalog = useMemo(() => buildFieldCatalog(schemaColumns), [schemaColumns]);
  const typeByKey = useMemo(() => new Map(fieldCatalog.map((f) => [f.key, f.type])), [fieldCatalog]);
  const fieldLabelByKey = useMemo(() => new Map(fieldCatalog.map((f) => [f.key, f.label])), [fieldCatalog]);

  const sourceConfig = (activeView && activeView.config) || defaultViewConfig;
  const [draft, setDraft] = useState(() => draftFromConfig(sourceConfig, fieldCatalog));
  const [name, setName] = useState(activeView ? activeView.name : '');
  const [markDefault, setMarkDefault] = useState(activeView ? Boolean(activeView.is_default) : false);
  const [nameError, setNameError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Re-seed the draft whenever the panel opens or the active view changes —
  // so re-opening always starts from the currently-applied source of truth.
  useEffect(() => {
    if (!open) return;
    setDraft(draftFromConfig(sourceConfig, fieldCatalog));
    setName(activeView ? activeView.name : '');
    setMarkDefault(activeView ? Boolean(activeView.is_default) : false);
    setNameError(null);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeView && activeView.id]);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    const err = validateViewName(name);
    setNameError(err);
    if (err) return;
    setSaving(true);
    try {
      const config = configFromDraft(draft);
      const result = await saveView({
        id: activeView ? activeView.id : undefined,
        name,
        config,
        isDefault: markDefault,
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
  }, [name, draft, markDefault, activeView, saveView, onApply, onClose]);

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

  const canEdit = fieldCatalog.length > 0;

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
            onChange={(e) => { setName(e.target.value); setNameError(null); }}
            placeholder="Например: Мой активный список"
            invalid={Boolean(nameError)}
            hint={nameError || undefined}
          />

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--chs-space-2)', margin: 'var(--chs-space-2) 0 var(--chs-space-5) 0', fontSize: 'var(--chs-text-sm)' }}>
            <input type="checkbox" checked={markDefault} onChange={(e) => setMarkDefault(e.target.checked)} />
            Открывать это представление по умолчанию
          </label>

          <section style={{ marginBottom: 'var(--chs-space-6)' }}>
            <h3 style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>Колонки</h3>
            <ColumnsEditor columns={draft.columns} fieldLabelByKey={fieldLabelByKey} onChange={(columns) => setDraft((d) => ({ ...d, columns }))} />
          </section>

          <section style={{ marginBottom: 'var(--chs-space-6)' }}>
            <h3 style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>Фильтры</h3>
            <FiltersEditor filters={draft.filters} fieldCatalog={fieldCatalog} typeByKey={typeByKey} onChange={(filters) => setDraft((d) => ({ ...d, filters }))} />
          </section>

          <section style={{ marginBottom: 'var(--chs-space-6)' }}>
            <h3 style={{ margin: '0 0 var(--chs-space-3) 0', fontSize: 'var(--chs-text-sm)', fontWeight: 'var(--chs-weight-semibold)' }}>Сортировка</h3>
            <SortEditor sort={draft.sort} fieldCatalog={fieldCatalog} onChange={(sort) => setDraft((d) => ({ ...d, sort }))} />
          </section>

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
