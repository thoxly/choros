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
  Button, MonoId, Mono, StatusChip, Modal, Field, Popover,
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

// Per-row actions: keep BOTH "Настроить поля" and "Записи" reachable without
// horizontal scroll (audit #2) via a "…" Popover menu anchored to the row.
function AppActions({ app, navigate }) {
  const [open, setOpen] = useState(false);
  return (
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
          onClick={() => setOpen((v) => !v)}
        >
          …
        </Button>
      }
    >
      <div role="menu" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-2)', minWidth: '160px' }}>
        <Button
          variant="ghost" size="sm" role="menuitem"
          style={{ justifyContent: 'flex-start', width: '100%' }}
          onClick={() => { setOpen(false); navigate(`/app-schema/${app.id}`); }}
        >
          Настроить поля
        </Button>
        <Button
          variant="ghost" size="sm" role="menuitem"
          style={{ justifyContent: 'flex-start', width: '100%' }}
          onClick={() => { setOpen(false); navigate(`/app-records/${app.id}`); }}
        >
          Записи
        </Button>
      </div>
    </Popover>
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
                <col style={{ width: "180px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "160px" }} />
                <col style={{ width: "56px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Приложение</th>
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
                    style={app.id === highlightId ? { background: 'var(--chs-color-success-soft)' } : undefined}
                  >
                    <td>
                      <div className="chs-task">
                        <span className="chs-task__txt">
                          <span className="chs-task__name">{app.display_name}</span>
                          {app.description && <span className="chs-task__step">{app.description}</span>}
                        </span>
                      </div>
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
                      <AppActions app={app} navigate={navigate} />
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
