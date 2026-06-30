/* ============================================================================
   CHOROS — screen-apps.jsx
   ЭКРАН: КОНСТРУКТОР · Приложения.
   Первый РЕАЛЬНЫЙ create-экран продукта (E13, T-0265). До него деплой был
   read-only витриной без единой кнопки «Создать». Здесь:
     • список приложений тенанта — GET /api/applications (live, T-0262);
     • кнопка «Создать приложение» → модалка с формой (slug · название · описание);
     • submit → POST /api/applications → 201 → обновляем список и подсвечиваем новое;
     • ошибки честно: 409 «слаг занят» на поле slug, 400 VALIDATION inline, 401 — войти.

   Fetch-контракт (FROZEN, src/http/applications.ts T-0262):
     POST /api/applications  body { slug, display_name, description? }
       → 201 { id, slug, display_name, description, tier, created_at, updated_at }
       → 400 VALIDATION · 401 UNAUTHENTICATED · 409 CONFLICT
     GET  /api/applications  → 200 { applications: [...] }  (только тенант актора)

   Авторизация — через devHeaders() (X-Dev-User), как у остальных экранов.

   OBLIK (T-0302): экран потребляет KIT — модалка через <Modal>, поля через
   <Field> (видимый ввод в ОБЕИХ темах: фон/текст/граница из реальных
   --chs-color-* токенов, без несуществующих --chs-bg-primary/--chs-border).
   Ноль хардкода цвета (UX-гейт G6).
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, MonoId, Mono, StatusChip, Modal, Field, Select, Popover,
  EmptyState, ErrorState, LoadingState, KitIcon,
} from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import { validateAppForm, mapCreateError } from './apps-validate.js';

// tier → StatusChip status (chip is purely visual; tier values are 'draft'|'published').
const TIER_CHIP = { draft: "waiting", published: "done" };

// Anything at/below this is a seed/unset created_at, not a real date. Render a
// dash instead of fabricating "1970-01-01" (principles.md §3, audit #7).
const EPOCH_FLOOR_MS = 24 * 60 * 60 * 1000; // ~1970-01-02

function fmtTs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < EPOCH_FLOOR_MS) return "—";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Inline-error line shown under a Field (token-only colors; layout via tokens).
const fieldErrStyle = {
  display: 'block', marginTop: 'var(--chs-space-2)',
  fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-danger)',
};

/**
 * CreateAppModal — форма создания приложения.
 * Контролируемые поля slug/display_name/description; клиентская валидация
 * (apps-validate.js, точное зеркало серверного SLUG_RE) — UX-подсказка, но
 * источник истины = сервер (повторно проверяет, отдаёт 400/409).
 * T-0551: свободный ввод «Раздел» убран (РЕВЕРС T-0540) — раздел назначается после
 * создания через «Изменить раздел» (выбор из сущностей), нет опечаток-призраков.
 */
function CreateAppModal({ open, onClose, onCreated }) {
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [fieldErrors, setFieldErrors] = useState({}); // { slug?, display_name?, description? }
  const [submitErr, setSubmitErr] = useState(null);    // general (non-field) error message
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => {
    setSlug(""); setDisplayName(""); setDescription("");
    setFieldErrors({}); setSubmitErr(null); setSubmitting(false);
  }, []);

  const handleClose = useCallback(() => { reset(); onClose(); }, [reset, onClose]);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSubmitErr(null);
    const fields = { slug, display_name: displayName, description: description || undefined };
    const { valid, errors } = validateAppForm(fields);
    setFieldErrors(errors);
    if (!valid) return;

    setSubmitting(true);
    try {
      const body = { slug, display_name: displayName };
      if (description.trim().length > 0) body.description = description;
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const created = await res.json();
        reset();
        onCreated(created);
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* ignore parse error */ }
      const mapped = mapCreateError(res.status, parsed);
      if (mapped.field === 'slug') {
        setFieldErrors((prev) => ({ ...prev, slug: mapped.message }));
      } else {
        setSubmitErr(mapped.message);
      }
    } catch (err) {
      setSubmitErr(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }, [slug, displayName, description, reset, onCreated]);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Создать приложение"
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>Отмена</Button>
          <Button type="submit" form="create-app-form" variant="primary" size="sm" loading={submitting}>
            {submitting ? 'Создание…' : 'Создать'}
          </Button>
        </>
      }
    >
      <form id="create-app-form" onSubmit={handleSubmit}>
        <p style={{ margin: '0 0 var(--chs-space-6) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Новое приложение конструктора. Создаётся в статусе «черновик».
        </p>

        <div style={{ marginBottom: 'var(--chs-space-6)' }}>
          <Field
            label="Слаг"
            mono
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-app"
            autoFocus
            invalid={Boolean(fieldErrors.slug)}
            hint={fieldErrors.slug ? undefined : 'строчные латинские, цифры, дефис · 1–64'}
          />
          {fieldErrors.slug && <span style={fieldErrStyle}>{fieldErrors.slug}</span>}
        </div>

        <div style={{ marginBottom: 'var(--chs-space-6)' }}>
          <Field
            label="Название"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Моё приложение"
            invalid={Boolean(fieldErrors.display_name)}
          />
          {fieldErrors.display_name && <span style={fieldErrStyle}>{fieldErrors.display_name}</span>}
        </div>

        <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
          <label className="chs-label" htmlFor="create-app-desc">Описание (опц.)</label>
          <textarea
            id="create-app-desc"
            className={`chs-input ${fieldErrors.description ? 'chs-input--invalid' : ''}`}
            style={{ height: 'auto', minHeight: '64px', paddingTop: 'var(--chs-space-3)', paddingBottom: 'var(--chs-space-3)', resize: 'vertical' }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Для чего это приложение"
            aria-invalid={Boolean(fieldErrors.description) || undefined}
          />
          {fieldErrors.description && <span style={fieldErrStyle}>{fieldErrors.description}</span>}
        </div>

        {submitErr && (
          <div role="alert" style={{
            marginTop: 'var(--chs-space-5)', padding: 'var(--chs-space-4) var(--chs-space-5)',
            background: 'var(--chs-color-danger-soft)',
            border: '1px solid var(--chs-color-danger)',
            borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
          }}>
            {submitErr}
          </div>
        )}
      </form>
    </Modal>
  );
}

/**
 * T-0551: модалка «Изменить раздел» — раздел теперь СУЩНОСТЬ (РЕВЕРС T-0540 строки).
 * Выбор из существующих разделов (GET /api/sections) + инлайн «＋ Создать новый раздел»
 * (POST /api/sections, затем выбрать). PATCH /api/applications/:id { section_id }.
 * Свободный текстовый ввод убран → нет опечаток-призраков.
 */
function SetSectionModal({ open, app, onClose, onUpdated }) {
  const [sections, setSections] = useState(null); // null=loading, [...]=loaded
  const [sectionId, setSectionId] = useState(app.section_id || ""); // "" = «Без раздела»
  const [creating, setCreating] = useState(false); // inline create mode
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState(null);

  // Load sections + sync the current value when the modal opens / app changes.
  React.useEffect(() => {
    if (!open) return;
    setSectionId(app.section_id || "");
    setCreating(false); setNewName(""); setSubmitErr(null); setSections(null);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/sections', { headers: devHeaders() });
        if (!res.ok || cancelled) { if (!cancelled) setSections([]); return; }
        const data = await res.json();
        if (!cancelled) setSections(Array.isArray(data.sections) ? data.sections : []);
      } catch { if (!cancelled) setSections([]); }
    })();
    return () => { cancelled = true; };
  }, [open, app.section_id]);

  const handleClose = useCallback(() => { setSubmitErr(null); onClose(); }, [onClose]);

  // Inline-create a section, then select it.
  const handleCreateSection = useCallback(async () => {
    const name = newName.trim();
    if (name.length === 0) { setSubmitErr('Введите название раздела'); return; }
    setSubmitErr(null); setSubmitting(true);
    try {
      const res = await fetch('/api/sections', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify({ name }),
      });
      if (res.status === 201) {
        const created = await res.json();
        setSections((prev) => ([...(prev || []), created]).sort(
          (a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, 'ru'),
        ));
        setSectionId(created.id);
        setCreating(false); setNewName("");
        return;
      }
      let parsed = null; try { parsed = await res.json(); } catch { /* ignore */ }
      setSubmitErr(res.status === 409 ? 'Раздел с таким названием уже есть' : (parsed?.message || `Ошибка ${res.status}`));
    } catch (err) {
      setSubmitErr(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }, [newName]);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSubmitErr(null);
    setSubmitting(true);
    try {
      const newSectionId = sectionId.length > 0 ? sectionId : null;
      const res = await fetch(`/api/applications/${app.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...devHeaders() },
        body: JSON.stringify({ section_id: newSectionId }),
      });
      if (res.ok) {
        const updated = await res.json();
        onUpdated(updated);
        handleClose();
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* ignore */ }
      setSubmitErr(parsed?.message || `Ошибка ${res.status}`);
    } catch (err) {
      setSubmitErr(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }, [app.id, sectionId, onUpdated, handleClose]);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Раздел · ${app.display_name}`}
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>Отмена</Button>
          <Button type="submit" form="set-section-form" variant="primary" size="sm" loading={submitting} disabled={creating}>
            {submitting ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </>
      }
    >
      <form id="set-section-form" onSubmit={handleSubmit}>
        <p style={{ margin: '0 0 var(--chs-space-6) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Раздел группирует приложение в боковой панели «Работа». «Без раздела» — приложение видно без папки.
        </p>

        {sections === null ? (
          <LoadingState label="Загрузка разделов…" />
        ) : creating ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-3)' }}>
            <Field
              label="Новый раздел"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Финансы, HR, Продажи…"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateSection(); } }}
            />
            <div style={{ display: 'flex', gap: 'var(--chs-space-2)' }}>
              <Button type="button" variant="primary" size="sm" loading={submitting} onClick={handleCreateSection}>
                Создать и выбрать
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setCreating(false); setNewName(""); setSubmitErr(null); }}>
                Отмена
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Select
              label="Раздел"
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
            >
              <option value="">Без раздела</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
            <div style={{ marginTop: 'var(--chs-space-3)' }}>
              <Button type="button" variant="ghost" size="sm" glyph={<KitIcon name="plus" />} onClick={() => { setCreating(true); setSubmitErr(null); }}>
                Создать новый раздел
              </Button>
            </div>
          </>
        )}

        {submitErr && (
          <div role="alert" style={{
            marginTop: 'var(--chs-space-5)', padding: 'var(--chs-space-4) var(--chs-space-5)',
            background: 'var(--chs-color-danger-soft)',
            border: '1px solid var(--chs-color-danger)',
            borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)',
            color: 'var(--chs-color-text)',
          }}>
            {submitErr}
          </div>
        )}
      </form>
    </Modal>
  );
}

// Per-row actions: keep BOTH "Настроить поля" and "Записи" reachable without
// horizontal scroll (audit #2) via a "…" Popover menu anchored to the row.
// T-0540: добавлено действие «Изменить раздел» → PATCH /api/applications/:id { section }.
function AppActions({ app, navigate, onAppUpdated }) {
  const [open, setOpen] = useState(false);
  const [sectionModalOpen, setSectionModalOpen] = useState(false);
  return (
    <>
      <SetSectionModal
        open={sectionModalOpen}
        app={app}
        onClose={() => setSectionModalOpen(false)}
        onUpdated={(updated) => { setSectionModalOpen(false); if (onAppUpdated) onAppUpdated(updated); }}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom"
        align="end"
        trigger={
          <Button
            variant="ghost"
            size="sm"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Действия · ${app.display_name}`}
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          >
            <KitIcon name="more-horizontal" />
          </Button>
        }
      >
        <div role="menu" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)', minWidth: '160px' }}>
          <Button
            variant="ghost" size="sm" role="menuitem"
            style={{ justifyContent: 'flex-start', width: '100%' }}
            onClick={(e) => { e.stopPropagation(); setOpen(false); navigate(`/app-schema/${app.id}`); }}
          >
            Настроить поля
          </Button>
          <Button
            variant="ghost" size="sm" role="menuitem"
            style={{ justifyContent: 'flex-start', width: '100%' }}
            onClick={(e) => { e.stopPropagation(); setOpen(false); navigate(`/app-records/${app.id}`); }}
          >
            Записи
          </Button>
          {/* T-0540: управление разделом — PATCH /api/applications/:id { section } */}
          <Button
            variant="ghost" size="sm" role="menuitem"
            style={{ justifyContent: 'flex-start', width: '100%' }}
            onClick={(e) => { e.stopPropagation(); setOpen(false); setSectionModalOpen(true); }}
          >
            Изменить раздел
          </Button>
        </div>
      </Popover>
    </>
  );
}

function AppsScreen() {
  const navigate = useNavigate();
  const [apps, setApps] = useState(null);     // null = loading, [] = empty, [...] = list
  const [error, setError] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [highlightId, setHighlightId] = useState(null); // id of just-created app

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/applications', { headers: devHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setApps(Array.isArray(data.applications) ? data.applications : []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreated = useCallback((created) => {
    setCreateOpen(false);
    if (created && created.id) setHighlightId(created.id);
    load();
  }, [load]);

  // T-0540: обновление приложения (после PATCH section) — обновляем строку in-place.
  const handleAppUpdated = useCallback((updated) => {
    if (!updated || !updated.id) return;
    setApps((prev) => prev ? prev.map((a) => a.id === updated.id ? { ...a, ...updated } : a) : prev);
  }, []);

  const list = apps || [];

  return (
    <>
      <CreateAppModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <div className="chs-inbox">
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: 'var(--chs-space-5) var(--chs-space-6)',
          borderBottom: '1px solid var(--chs-color-border)',
        }}>
          <span style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
            Приложения тенанта{apps !== null ? ` · ${list.length}` : ''}
          </span>
          <Button variant="primary" size="sm" glyph={<KitIcon name="plus" />} onClick={() => setCreateOpen(true)}>
            Создать приложение
          </Button>
        </div>

        <div className="chs-inbox__scroll">
          {error ? (
            <ErrorState message={`Не удалось загрузить приложения: ${error}`} onRetry={load} />
          ) : apps === null ? (
            <LoadingState label="Загрузка приложений…" />
          ) : list.length === 0 ? (
            <EmptyState
              icon={<KitIcon name="inbox" size={28} />}
              title="Пока нет ни одного приложения"
              description="Создайте первое — это центр конструктора."
              action={
                <Button variant="primary" glyph={<KitIcon name="plus" />} onClick={() => setCreateOpen(true)}>
                  Создать приложение
                </Button>
              }
            />
          ) : (
            <table className="chs-itable">
              <colgroup>
                <col style={{ width: "auto" }} />
                <col style={{ width: "140px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "160px" }} />
                <col style={{ width: "56px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Приложение</th>
                  <th>Раздел</th>
                  <th>Слаг</th>
                  <th>Статус</th>
                  <th>Создано</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((app) => (
                  <tr
                    key={app.id}
                    style={{ cursor: 'pointer', ...(app.id === highlightId ? { background: 'var(--chs-color-success-soft)' } : {}) }}
                    onClick={() => navigate(`/app-records/${app.id}`)}
                  >
                    <td>
                      {/* T-0529: primary affordance as link — keyboard users can tab to it */}
                      <a href={`/app-records/${app.id}`} className="chs-task chs-link" style={{ display: 'flex', textDecoration: 'none', color: 'inherit' }} onClick={(e) => { e.preventDefault(); navigate(`/app-records/${app.id}`); }}>
                        <span className="chs-task__txt">
                          <span className="chs-task__name">{app.display_name}</span>
                          {app.description && <span className="chs-task__step">{app.description}</span>}
                        </span>
                      </a>
                    </td>
                    {/* T-0551: раздел-сущность (section_name) — группировка в нав РАБОТА */}
                    <td>
                      {app.section_name ? (
                        <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
                          {app.section_name}
                        </span>
                      ) : (
                        <span style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-disabled)' }}>—</span>
                      )}
                    </td>
                    <td><MonoId>{app.slug}</MonoId></td>
                    <td><StatusChip status={TIER_CHIP[app.tier] || "waiting"} label={app.tier} /></td>
                    <td>
                      <Mono style={{ fontSize: "var(--chs-text-xs)", color: "var(--chs-color-text-muted)" }}>
                        {fmtTs(app.created_at)}
                      </Mono>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {/* T-0266/T-0267 actions: field-constructor + records, behind a "…" menu */}
                      {/* T-0540: добавлено «Изменить раздел» */}
                      <AppActions app={app} navigate={navigate} onAppUpdated={handleAppUpdated} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

export default AppsScreen;
