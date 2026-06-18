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

   «Разделы»: в бэкенде НЕТ отдельной таблицы section — разделы = группировка
   реестров/отчётов под приложением (registry_def.application_id), владелец T-0263.
   Поэтому НИ ОДНОЙ мёртвой кнопки «Создать раздел» здесь нет — только то, что
   реально проваливается в API. Это и есть честность, ради которой строится E13.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, MonoId, Mono, StatusChip } from '../components/components.jsx';
import { devHeaders } from '../app-shell/dev-auth.js';
import { validateAppForm, mapCreateError } from './apps-validate.js';

// tier → StatusChip status (chip is purely visual; tier values are 'draft'|'published').
const TIER_CHIP = { draft: "waiting", published: "done" };

function fmtTs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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

  if (!open) return null;

  const inputStyle = (invalid) => ({
    width: '100%', boxSizing: 'border-box',
    padding: '8px 10px', marginTop: '4px',
    background: 'var(--chs-bg-primary, #14151a)',
    border: `1px solid ${invalid ? 'var(--chs-color-danger, #e53e3e)' : 'var(--chs-border, #30333d)'}`,
    borderRadius: '6px', color: 'inherit',
    fontSize: 'var(--chs-text-sm, 13px)', fontFamily: 'inherit',
  });
  const errStyle = { display: 'block', marginTop: '4px', fontSize: 'var(--chs-text-xs, 12px)', color: 'var(--chs-color-danger, #e53e3e)' };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Создать приложение"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: 'var(--chs-bg-secondary, #1e2028)',
          border: '1px solid var(--chs-border, #30333d)',
          borderRadius: '8px', padding: '28px 32px',
          minWidth: '400px', maxWidth: '520px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <h2 style={{ margin: '0 0 4px 0', fontSize: 'var(--chs-text-lg, 16px)', fontWeight: 600 }}>
          Создать приложение
        </h2>
        <p style={{ margin: '0 0 20px 0', fontSize: 'var(--chs-text-sm, 13px)', color: 'var(--chs-color-text-muted, #888)' }}>
          Новое приложение конструктора. Создаётся в статусе «черновик».
        </p>

        <label style={{ display: 'block', marginBottom: '14px' }}>
          <span style={{ fontSize: 'var(--chs-text-sm, 13px)', fontWeight: 500 }}>Слаг</span>
          <input
            className="chs-input chs-input--mono"
            style={inputStyle(Boolean(fieldErrors.slug))}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-app"
            autoFocus
            aria-invalid={Boolean(fieldErrors.slug)}
          />
          {fieldErrors.slug
            ? <span style={errStyle}>{fieldErrors.slug}</span>
            : <span style={{ ...errStyle, color: 'var(--chs-color-text-faint, #666)' }}>строчные латинские, цифры, дефис · 1–64</span>}
        </label>

        <label style={{ display: 'block', marginBottom: '14px' }}>
          <span style={{ fontSize: 'var(--chs-text-sm, 13px)', fontWeight: 500 }}>Название</span>
          <input
            className="chs-input"
            style={inputStyle(Boolean(fieldErrors.display_name))}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Моё приложение"
            aria-invalid={Boolean(fieldErrors.display_name)}
          />
          {fieldErrors.display_name && <span style={errStyle}>{fieldErrors.display_name}</span>}
        </label>

        <label style={{ display: 'block', marginBottom: '18px' }}>
          <span style={{ fontSize: 'var(--chs-text-sm, 13px)', fontWeight: 500 }}>Описание <span style={{ color: 'var(--chs-color-text-faint, #666)' }}>(опц.)</span></span>
          <textarea
            className="chs-input"
            style={{ ...inputStyle(Boolean(fieldErrors.description)), minHeight: '64px', resize: 'vertical' }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Для чего это приложение"
          />
          {fieldErrors.description && <span style={errStyle}>{fieldErrors.description}</span>}
        </label>

        {submitErr && (
          <div style={{
            marginBottom: '16px', padding: '10px 14px',
            background: 'var(--chs-bg-danger-subtle, rgba(229,62,62,0.12))',
            border: '1px solid var(--chs-color-danger, #e53e3e)',
            borderRadius: '6px', fontSize: 'var(--chs-text-sm, 13px)',
          }}>
            {submitErr}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>Отмена</Button>
          <Button type="submit" variant="primary" size="sm" disabled={submitting}>
            {submitting ? 'Создание…' : 'Создать'}
          </Button>
        </div>
      </form>
    </div>
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
          padding: 'var(--chs-space-3, 12px) var(--chs-space-4, 16px)',
          borderBottom: '1px solid var(--chs-border, #30333d)',
        }}>
          <span style={{ fontSize: 'var(--chs-text-sm, 13px)', color: 'var(--chs-color-text-muted, #888)' }}>
            Приложения тенанта{apps !== null ? ` · ${list.length}` : ''}
          </span>
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            Создать приложение
          </Button>
        </div>

        <div className="chs-inbox__scroll">
          {error ? (
            <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
              <p style={{ marginBottom: "var(--chs-space-3)" }}>Не удалось загрузить приложения: {error}</p>
              <Button onClick={load}>Повторить</Button>
            </div>
          ) : apps === null ? (
            <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
              Загрузка приложений…
            </div>
          ) : list.length === 0 ? (
            <div style={{ padding: "var(--chs-space-5)", textAlign: "center" }}>
              <p style={{ marginBottom: "var(--chs-space-3)", color: "var(--chs-color-text-muted, #888)" }}>
                Пока нет ни одного приложения. Создайте первое — это центр конструктора.
              </p>
              <Button variant="primary" onClick={() => setCreateOpen(true)}>Создать приложение</Button>
            </div>
          ) : (
            <table className="chs-itable">
              <colgroup>
                <col style={{ width: "auto" }} />
                <col style={{ width: "180px" }} />
                <col style={{ width: "120px" }} />
                <col style={{ width: "160px" }} />
                <col style={{ width: "220px" }} />
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
                    style={app.id === highlightId ? { background: 'var(--chs-bg-success-subtle, rgba(56,161,105,0.12))' } : undefined}
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
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {/* T-0266: jump into the field-constructor for this app */}
                      <Button variant="secondary" size="sm" onClick={() => navigate(`/app-schema/${app.id}`)}>
                        Настроить поля
                      </Button>
                      {/* T-0267: jump into the records list + create-record form */}
                      <Button variant="ghost" size="sm" onClick={() => navigate(`/app-records/${app.id}`)}>
                        Записи
                      </Button>
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
