/* ============================================================================
   CHOROS — ra-sod.jsx
   ЭКРАН 3: РАЗДЕЛЕНИЕ ОБЯЗАННОСТЕЙ (SoD).

   T-0391 [D2-FU]: wired to the real SoD read API.
   T-0386 [D6]: CRUD write surface for sod_constraint authoring.

   Read endpoints:
     GET  /api/rights/sod-rules                — tenant SoD constraint registry
     GET  /api/rights/sod-check?subjectId=:id  — held roles + conflict report

   Write endpoints (T-0386, genesis-owner gated):
     POST   /api/rights/sod-rules          — create a new SoD constraint
     PUT    /api/rights/sod-rules/:id      — update a constraint
     DELETE /api/rights/sod-rules/:id      — delete a constraint

   UX invariants:
     G2 — consumes design-system tokens only (no hardcoded colours).
     G5 — no dev-jargon in visible text.
     G6 — no new inline styles or raw colour literals.
   Honest states: loading / error / empty / list.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import {
  EmptyState,
  LoadingState,
  ErrorState,
} from '../../components/components.jsx';
import { Icon } from '../../app-shell/icon.jsx';
import { devHeaders } from '../../app-shell/dev-auth.js';

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchSodRules() {
  const res = await fetch('/api/rights/sod-rules', { headers: devHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchSodCheck(subjectId) {
  const params = subjectId ? `?subjectId=${encodeURIComponent(subjectId)}` : '';
  const res = await fetch(`/api/rights/sod-check${params}`, { headers: devHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function createSodRule(body) {
  const res = await fetch('/api/rights/sod-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...devHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

async function deleteSodRule(id) {
  const res = await fetch(`/api/rights/sod-rules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: devHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// SoD rules table
// ---------------------------------------------------------------------------

function KindChip({ kind }) {
  const label = kind === 'static' ? 'Статическое' : 'Динамическое';
  const cls = kind === 'static' ? 'chs-sodsev--block' : 'chs-sodsev--warn';
  return <span className={`chs-sodsev ${cls}`}>{label}</span>;
}

function SodRuleRow({ rule, onDelete }) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const handleDelete = useCallback(async () => {
    if (!window.confirm('Удалить правило разделения обязанностей?')) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(rule.id);
    } catch (err) {
      setDeleteError(err.message);
      setDeleting(false);
    }
  }, [rule.id, onDelete]);

  return (
    <div className="chs-sodrow">
      <div className="chs-sodrow__id">
        <span className="chs-mono" style={{ fontSize: 'var(--chs-text-2xs)', color: 'var(--chs-color-text-faint)' }}>
          {rule.id.slice(0, 8)}&hellip;
        </span>
      </div>
      <div className="chs-sodrow__pair">
        {rule.roleA && <span>{rule.roleA.name ?? rule.roleA.id}</span>}
        {rule.roleA && rule.roleB && <span className="chs-sodrow__vs">&times;</span>}
        {rule.roleB && <span>{rule.roleB.name ?? rule.roleB.id}</span>}
        {!rule.roleA && !rule.roleB && (
          <span style={{ color: 'var(--chs-color-text-faint)' }}>Все роли</span>
        )}
      </div>
      <div className="chs-sodrow__why">
        {rule.kind === 'dynamic' && rule.selfRecord
          ? 'Запрет самоподтверждения записи'
          : rule.kind === 'dynamic'
            ? 'Разделение этапов процесса'
            : 'Несовместимые роли'}
      </div>
      <KindChip kind={rule.kind} />
      <div className="chs-sodrow__actions">
        <button
          type="button"
          className="chs-btn chs-btn--ghost chs-btn--sm chs-btn--danger"
          onClick={handleDelete}
          disabled={deleting}
          aria-label="Удалить правило"
        >
          {deleting ? '…' : 'Удалить'}
        </button>
        {deleteError && (
          <span style={{ color: 'var(--chs-color-text-danger)', fontSize: 'var(--chs-text-xs)' }}>
            {deleteError}
          </span>
        )}
      </div>
    </div>
  );
}

function SodRulesTable({ rules, onDelete }) {
  if (rules.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="rights" />}
        title="Правила разделения обязанностей не настроены"
        description="После добавления правила будут автоматически применяться при назначении ролей и выполнении действий."
        compact
      />
    );
  }
  return (
    <div className="chs-sodtable">
      <div className="chs-sodtable__colhead">
        <span>ID</span>
        <span>Пара ролей</span>
        <span>Описание</span>
        <span>Тип</span>
        <span>Действия</span>
      </div>
      {rules.map((rule) => (
        <SodRuleRow key={rule.id} rule={rule} onDelete={onDelete} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create rule form
// ---------------------------------------------------------------------------

const EMPTY_SCOPE = { kind: 'set', members: [] };

function CreateRuleForm({ onCreated, onCancel }) {
  const [kind, setKind] = useState('static');
  const [roleA, setRoleA] = useState('');
  const [roleB, setRoleB] = useState('');
  const [selfRecord, setSelfRecord] = useState(false);
  const [scopeText, setScopeText] = useState(JSON.stringify(EMPTY_SCOPE));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    setError(null);

    let scope;
    try {
      scope = JSON.parse(scopeText);
    } catch {
      setError('Область применения (scope) должна быть корректным JSON.');
      return;
    }

    const body = {
      kind,
      scope,
      selfRecord,
      roleA: roleA.trim() || null,
      roleB: roleB.trim() || null,
    };

    setSaving(true);
    try {
      await createSodRule(body);
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [kind, roleA, roleB, selfRecord, scopeText, onCreated]);

  return (
    <form className="chs-sod-create-form" onSubmit={handleSubmit}>
      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label className="chs-field__label">Тип правила</label>
        <select
          className="chs-field__input"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="static">Статическое (несовместимые роли)</option>
          <option value="dynamic">Динамическое (разделение этапов)</option>
        </select>
      </div>

      {kind === 'static' && (
        <>
          <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
            <label className="chs-field__label">Роль A (UUID)</label>
            <input
              type="text"
              className="chs-field__input"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              value={roleA}
              onChange={(e) => setRoleA(e.target.value)}
              required={kind === 'static'}
            />
          </div>
          <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
            <label className="chs-field__label">Роль B (UUID)</label>
            <input
              type="text"
              className="chs-field__input"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              value={roleB}
              onChange={(e) => setRoleB(e.target.value)}
              required={kind === 'static'}
            />
          </div>
        </>
      )}

      {kind === 'dynamic' && (
        <div
          className="chs-field"
          style={{ marginBottom: 'var(--chs-space-4)', display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)' }}
        >
          <input
            type="checkbox"
            id="sod-self-record"
            checked={selfRecord}
            onChange={(e) => setSelfRecord(e.target.checked)}
          />
          <label htmlFor="sod-self-record" className="chs-field__label" style={{ marginBottom: 0 }}>
            Запрет самоподтверждения записи
          </label>
        </div>
      )}

      <div className="chs-field" style={{ marginBottom: 'var(--chs-space-4)' }}>
        <label className="chs-field__label">
          Область применения (scope, JSON)
        </label>
        <textarea
          className="chs-field__input"
          rows={3}
          value={scopeText}
          onChange={(e) => setScopeText(e.target.value)}
          style={{ fontFamily: 'var(--chs-font-mono)', fontSize: 'var(--chs-text-xs)' }}
        />
      </div>

      {error && (
        <p style={{ color: 'var(--chs-color-text-danger)', fontSize: 'var(--chs-text-sm)', marginBottom: 'var(--chs-space-4)' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: 'var(--chs-space-3)' }}>
        <button
          type="submit"
          className="chs-btn chs-btn--primary chs-btn--sm"
          disabled={saving}
        >
          {saving ? 'Сохранение…' : 'Добавить правило'}
        </button>
        <button
          type="button"
          className="chs-btn chs-btn--ghost chs-btn--sm"
          onClick={onCancel}
          disabled={saving}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Conflict panel
// ---------------------------------------------------------------------------

function ConflictItem({ conflict }) {
  const isStatic = conflict.kind === 'static';
  const cls = isStatic ? 'chs-conflict--block' : 'chs-conflict--warn';
  const title = isStatic ? 'Конфликт ролей' : 'Динамическое правило';

  return (
    <div className={`chs-conflict ${cls}`}>
      <div className="chs-conflict__head">
        <div className="chs-conflict__glyph" />
        <span className="chs-conflict__title">{title}</span>
        <span className={`chs-conflict__sev chs-conflict__sev--${isStatic ? 'block' : 'warn'}`}>
          {isStatic ? 'БЛОКИРОВКА' : 'ИНФОРМАЦИЯ'}
        </span>
      </div>
      {(conflict.roleA || conflict.roleB) && (
        <div className="chs-conflict__body">
          <div className="chs-conflict__pair">
            {conflict.roleA && <span className="chs-conflict__role">{conflict.roleA.name}</span>}
            {conflict.roleA && conflict.roleB && <span className="chs-conflict__x">&times;</span>}
            {conflict.roleB && <span className="chs-conflict__role">{conflict.roleB.name}</span>}
          </div>
        </div>
      )}
      {conflict.note && <p className="chs-conflict__why">{conflict.note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

function SoDScreen() {
  const [rulesState, setRulesState] = useState({ loading: true, error: null, data: null });
  const [checkState, setCheckState] = useState({ loading: false, error: null, data: null });
  const [subjectInput, setSubjectInput] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  const loadRules = useCallback(() => {
    setRulesState({ loading: true, error: null, data: null });
    fetchSodRules()
      .then((data) => setRulesState({ loading: false, error: null, data }))
      .catch((err) => setRulesState({ loading: false, error: err.message, data: null }));
  }, []);

  useEffect(() => { loadRules(); }, [loadRules]);

  const handleDelete = useCallback(async (id) => {
    await deleteSodRule(id);
    loadRules();
  }, [loadRules]);

  const handleCreated = useCallback(() => {
    setShowCreateForm(false);
    loadRules();
  }, [loadRules]);

  const runCheck = useCallback(() => {
    const slug = subjectInput.trim() || undefined;
    setCheckState({ loading: true, error: null, data: null });
    fetchSodCheck(slug)
      .then((data) => setCheckState({ loading: false, error: null, data }))
      .catch((err) => setCheckState({ loading: false, error: err.message, data: null }));
  }, [subjectInput]);

  return (
    <div className="chs-sod-screen">
      <div className="chs-sod-screen__inner">

        {/* ── Rules registry ── */}
        <section style={{ marginBottom: 'var(--chs-space-10)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 'var(--chs-space-5)' }}>
            <h2 style={{ fontSize: 'var(--chs-text-lg)', fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
              Реестр правил
            </h2>
            {!showCreateForm && (
              <button
                type="button"
                className="chs-btn chs-btn--primary chs-btn--sm"
                onClick={() => setShowCreateForm(true)}
              >
                + Добавить правило
              </button>
            )}
          </div>

          {showCreateForm && (
            <div style={{ marginBottom: 'var(--chs-space-6)', padding: 'var(--chs-space-5)', background: 'var(--chs-color-surface-raised)', borderRadius: 'var(--chs-radius-md)', border: '1px solid var(--chs-color-border)' }}>
              <h3 style={{ fontSize: 'var(--chs-text-base)', fontWeight: 'var(--chs-weight-semibold)', marginBottom: 'var(--chs-space-4)', color: 'var(--chs-color-text)' }}>
                Новое правило
              </h3>
              <CreateRuleForm
                onCreated={handleCreated}
                onCancel={() => setShowCreateForm(false)}
              />
            </div>
          )}

          {rulesState.loading && <LoadingState label="Загрузка правил…" compact />}
          {rulesState.error && (
            <ErrorState
              title="Не удалось загрузить правила"
              message={rulesState.error}
              onRetry={loadRules}
            />
          )}
          {rulesState.data && (
            <SodRulesTable rules={rulesState.data.rules} onDelete={handleDelete} />
          )}
        </section>

        {/* ── Conflict check ── */}
        <section>
          <h2 style={{ fontSize: 'var(--chs-text-lg)', fontWeight: 'var(--chs-weight-semibold)', marginBottom: 'var(--chs-space-5)', color: 'var(--chs-color-text)' }}>
            Проверка конфликтов
          </h2>
          <div className="chs-assignbox" style={{ marginBottom: 'var(--chs-space-6)' }}>
            <div className="chs-assignbox__subject">
              <span className="chs-assignbox__k">Сотрудник</span>
              <input
                type="text"
                className="chs-field__input"
                placeholder="Логин (пусто — текущий пользователь)"
                value={subjectInput}
                onChange={(e) => setSubjectInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runCheck(); }}
                style={{ flex: '1', minWidth: '180px', maxWidth: '320px' }}
              />
              <button
                type="button"
                className="chs-btn chs-btn--primary chs-btn--sm"
                onClick={runCheck}
                disabled={checkState.loading}
              >
                Проверить
              </button>
            </div>
          </div>

          {checkState.loading && <LoadingState label="Проверка конфликтов…" compact />}
          {checkState.error && (
            <ErrorState
              title="Не удалось выполнить проверку"
              message={checkState.error}
              onRetry={runCheck}
            />
          )}
          {checkState.data && (() => {
            const { heldRoles, conflicts, subjectId } = checkState.data;
            return (
              <div>
                <p style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-faint)', marginBottom: 'var(--chs-space-5)' }}>
                  Сотрудник: <strong>{subjectId}</strong>
                  {' · '}
                  Роли: {heldRoles.length === 0 ? 'нет' : heldRoles.map((r) => r.name).join(', ')}
                </p>
                {conflicts.length === 0 ? (
                  <div className="chs-conflict chs-conflict--ok">
                    <div className="chs-conflict__okglyph" />
                    <span>Конфликтов не обнаружено</span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-4)' }}>
                    {conflicts.map((c, i) => (
                      <ConflictItem key={`${c.constraintId}-${i}`} conflict={c} />
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {!checkState.loading && !checkState.error && !checkState.data && (
            <EmptyState
              icon={<Icon name="rights" />}
              title="Введите логин для проверки"
              description="Укажите логин сотрудника и нажмите «Проверить», чтобы увидеть текущие конфликты ролей."
              compact
            />
          )}
        </section>

      </div>
    </div>
  );
}

export default SoDScreen;
