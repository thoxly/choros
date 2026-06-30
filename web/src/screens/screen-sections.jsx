/* ============================================================================
   CHOROS — screen-sections.jsx
   ЭКРАН: КОНСТРУКТОР · Разделы (T-0551, E-NAV-IA).
   Управление разделами-сущностями (ELMA-папки) рабочего пространства:
     • список разделов тенанта — GET /api/sections (sort_order, name);
     • создать — POST /api/sections { name };
     • переименовать инлайн — PATCH /api/sections/:id { name };
     • переупорядочить (вверх/вниз) — PATCH /api/sections/:id { sort_order };
     • удалить (мягко, с подтверждением «N приложений переедут в Без раздела») —
       DELETE /api/sections/:id → приложения НЕ удаляются (section_id → NULL).

   РЕВЕРС T-0540 (раздел=строка). Источник истины — сервер; UI зеркалит RLS-scoped
   ответы. Авторизация — devHeaders() (X-Dev-User), как у соседних экранов.
   OBLIK: KIT (Button/Field/Modal/ConfirmDialog/Empty/Loading/Error), токен-цвета.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Field, Modal, ConfirmDialog,
  EmptyState, ErrorState, LoadingState, KitIcon,
} from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';

const fieldErrStyle = {
  display: 'block', marginTop: 'var(--chs-space-2)',
  fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)',
};

const SECTION_NAME_MAX = 128;

/** CreateSectionModal — POST /api/sections { name }. */
function CreateSectionModal({ open, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => { setName(''); setErr(null); setSubmitting(false); }, []);
  const handleClose = useCallback(() => { reset(); onClose(); }, [reset, onClose]);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setErr(null);
    const trimmed = name.trim();
    if (trimmed.length === 0) { setErr('Введите название раздела'); return; }
    if (trimmed.length > SECTION_NAME_MAX) { setErr(`Не более ${SECTION_NAME_MAX} символов`); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/sections', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.status === 201) {
        const created = await res.json();
        reset();
        onCreated(created);
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* ignore */ }
      if (res.status === 409) setErr('Раздел с таким названием уже есть');
      else setErr(parsed?.message || `Ошибка ${res.status}`);
    } catch (ex) {
      setErr(String(ex?.message || ex));
    } finally {
      setSubmitting(false);
    }
  }, [name, reset, onCreated]);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Создать раздел"
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>Отмена</Button>
          <Button type="submit" form="create-section-form" variant="primary" size="sm" loading={submitting}>
            {submitting ? 'Создание…' : 'Создать'}
          </Button>
        </>
      }
    >
      <form id="create-section-form" onSubmit={handleSubmit}>
        <p style={{ margin: '0 0 var(--chs-space-6) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Раздел — папка боковой панели «Работа». Группирует приложения; порядок задаётся стрелками в списке.
        </p>
        <Field
          label="Название"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Финансы, HR, Продажи…"
          autoFocus
          invalid={Boolean(err)}
        />
        {err && <span style={fieldErrStyle}>{err}</span>}
      </form>
    </Modal>
  );
}

/** Одна строка раздела: инлайн-переименование + стрелки порядка + удаление. */
function SectionRow({ section, isFirst, isLast, appsCount, onRename, onMove, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.name);
  const [saving, setSaving] = useState(false);
  const [rowErr, setRowErr] = useState(null);

  useEffect(() => { setDraft(section.name); }, [section.name]);

  const commit = useCallback(async () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) { setRowErr('Название не может быть пустым'); return; }
    if (trimmed === section.name) { setEditing(false); setRowErr(null); return; }
    setSaving(true); setRowErr(null);
    const ok = await onRename(section.id, trimmed);
    setSaving(false);
    if (ok) { setEditing(false); } else { setRowErr('Не удалось сохранить (имя занято?)'); }
  }, [draft, section.id, section.name, onRename]);

  return (
    <tr>
      <td>
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)' }}>
            <Field
              label={null}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { setEditing(false); setDraft(section.name); setRowErr(null); }
              }}
            />
            {rowErr && <span style={fieldErrStyle}>{rowErr}</span>}
          </div>
        ) : (
          <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)' }}>{section.name}</span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
          {appsCount} прил.
        </span>
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {editing ? (
          <>
            <Button variant="primary" size="sm" loading={saving} onClick={commit}>Сохранить</Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setDraft(section.name); setRowErr(null); }}>Отмена</Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost" size="sm" aria-label="Вверх"
              disabled={isFirst} onClick={() => onMove(section, -1)}
            >
              <KitIcon name="chevron-up" />
            </Button>
            <Button
              variant="ghost" size="sm" aria-label="Вниз"
              disabled={isLast} onClick={() => onMove(section, +1)}
            >
              <KitIcon name="chevron-down" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Переименовать</Button>
            <Button variant="ghost" size="sm" onClick={() => onDelete(section)}>Удалить</Button>
          </>
        )}
      </td>
    </tr>
  );
}

function SectionsScreen() {
  const [sections, setSections] = useState(null); // null=loading, []=empty, [...]=list
  const [appsCountById, setAppsCountById] = useState({}); // section_id → app count
  const [error, setError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [toDelete, setToDelete] = useState(null); // section pending confirm-delete
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [secRes, appRes] = await Promise.all([
        fetch('/api/sections', { headers: devHeaders() }),
        fetch('/api/applications', { headers: devHeaders() }),
      ]);
      if (!secRes.ok) throw new Error(`HTTP ${secRes.status}`);
      const secData = await secRes.json();
      const list = Array.isArray(secData.sections) ? secData.sections : [];
      setSections(list);
      // Count apps per section (best-effort; if apps fetch fails → 0 counts).
      const counts = {};
      if (appRes.ok) {
        const appData = await appRes.json();
        for (const a of (appData.applications || [])) {
          if (a.section_id) counts[a.section_id] = (counts[a.section_id] || 0) + 1;
        }
      }
      setAppsCountById(counts);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreated = useCallback(() => { setCreateOpen(false); load(); }, [load]);

  // Rename — PATCH /api/sections/:id { name }. Returns true on success.
  const handleRename = useCallback(async (id, name) => {
    try {
      const res = await fetch(`/api/sections/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify({ name }),
      });
      if (res.ok) { await load(); return true; }
      return false;
    } catch { return false; }
  }, [load]);

  // Reorder by swapping sort_order with the adjacent row, then persist both.
  const handleMove = useCallback(async (section, dir) => {
    if (!Array.isArray(sections)) return;
    const idx = sections.findIndex((s) => s.id === section.id);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sections.length) return;
    const other = sections[swapIdx];
    // Normalize: use index-based ordering so ties never deadlock the swap.
    const aOrder = swapIdx; // section moves to other's slot
    const bOrder = idx;     // other moves to section's slot
    try {
      await Promise.all([
        fetch(`/api/sections/${section.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...devHeaders() },
          body: JSON.stringify({ sort_order: aOrder }),
        }),
        fetch(`/api/sections/${other.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...devHeaders() },
          body: JSON.stringify({ sort_order: bOrder }),
        }),
      ]);
      await load();
    } catch { /* non-fatal: reload reflects server truth */ }
  }, [sections, load]);

  const confirmDelete = useCallback(async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/sections/${toDelete.id}`, {
        method: 'DELETE',
        headers: devHeaders(),
      });
      // 204 = deleted; 404 already-gone — both resolve to "reload".
      setToDelete(null);
      await load();
    } catch { /* non-fatal */ }
    finally { setDeleting(false); }
  }, [toDelete, load]);

  const list = sections || [];

  return (
    <>
      <CreateSectionModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <ConfirmDialog
        open={Boolean(toDelete)}
        title="Удалить раздел?"
        message={
          toDelete
            ? `Раздел «${toDelete.name}» будет удалён. ${appsCountById[toDelete.id] || 0} приложений переедут в «Без раздела» (не удалятся).`
            : ''
        }
        confirmLabel="Удалить"
        tone="danger"
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
      <div className="chs-inbox">
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: 'var(--chs-space-5) var(--chs-space-6)',
          borderBottom: '1px solid var(--chs-color-border)',
        }}>
          <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            Разделы{sections !== null ? ` · ${list.length}` : ''}
          </span>
          <Button variant="primary" size="sm" glyph={<KitIcon name="plus" />} onClick={() => setCreateOpen(true)}>
            Создать раздел
          </Button>
        </div>

        <div className="chs-inbox__scroll">
          {error ? (
            <ErrorState message={`Не удалось загрузить разделы: ${error}`} onRetry={load} />
          ) : sections === null ? (
            <LoadingState label="Загрузка разделов…" />
          ) : list.length === 0 ? (
            <EmptyState
              icon={<KitIcon name="inbox" size={28} />}
              title="Пока нет ни одного раздела"
              description="Раздел — папка боковой панели «Работа». Создайте первый и положите в него приложения."
              action={
                <Button variant="primary" glyph={<KitIcon name="plus" />} onClick={() => setCreateOpen(true)}>
                  Создать раздел
                </Button>
              }
            />
          ) : (
            <table className="chs-itable">
              <colgroup>
                <col style={{ width: 'auto' }} />
                <col style={{ width: '120px' }} />
                <col style={{ width: '320px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Раздел</th>
                  <th style={{ textAlign: 'right' }}>Приложений</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((s, i) => (
                  <SectionRow
                    key={s.id}
                    section={s}
                    isFirst={i === 0}
                    isLast={i === list.length - 1}
                    appsCount={appsCountById[s.id] || 0}
                    onRename={handleRename}
                    onMove={handleMove}
                    onDelete={setToDelete}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

export default SectionsScreen;
