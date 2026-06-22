/* ============================================================================
   CHOROS — ra-sod.jsx
   ЭКРАН 3: РАЗДЕЛЕНИЕ ОБЯЗАННОСТЕЙ (SoD).

   T-0391 [D2-FU]: wired to the real SoD API.
     GET  /api/rights/sod-rules                — tenant SoD constraint registry
     GET  /api/rights/sod-check?subjectId=:id  — held roles + conflict report

   UX invariants:
     G2 — consumes design-system tokens only (no hardcoded colours).
     G5 — no dev-jargon in visible text.
     G6 — no new inline styles or raw colour literals.
   Honest states: loading / error / empty / list.

   Data-model note (T-0391):
     The `sod_constraint` table exists (migration 027) and holds static +
     dynamic constraint DECLARATIONS. There is no authoring UI yet — rules
     must be seeded via SQL. The sod-check endpoint reports static conflicts
     (role-pair violations) and surfaces dynamic constraints as informational
     notes (they are evaluated at action time, not statically here).
     Full SoD authoring UI (CRUD for sod_constraint rows) is a follow-up
     NEEDS-DESIGN task (T-0391-FU-sod-authoring).
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

// ---------------------------------------------------------------------------
// SoD rules table
// ---------------------------------------------------------------------------

function KindChip({ kind }) {
  const label = kind === 'static' ? 'Статическое' : 'Динамическое';
  const cls = kind === 'static' ? 'chs-sodsev--block' : 'chs-sodsev--warn';
  return <span className={`chs-sodsev ${cls}`}>{label}</span>;
}

function SodRuleRow({ rule }) {
  return (
    <div className="chs-sodrow">
      <div className="chs-sodrow__id">
        <span className="chs-mono" style={{ fontSize: 'var(--chs-text-2xs)', color: 'var(--chs-color-text-faint)' }}>
          {rule.id.slice(0, 8)}&hellip;
        </span>
      </div>
      <div className="chs-sodrow__pair">
        {rule.roleA && <span>{rule.roleA.name}</span>}
        {rule.roleA && rule.roleB && <span className="chs-sodrow__vs">&times;</span>}
        {rule.roleB && <span>{rule.roleB.name}</span>}
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
    </div>
  );
}

function SodRulesTable({ rules }) {
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
      </div>
      {rules.map((rule) => (
        <SodRuleRow key={rule.id} rule={rule} />
      ))}
    </div>
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

  const loadRules = useCallback(() => {
    setRulesState({ loading: true, error: null, data: null });
    fetchSodRules()
      .then((data) => setRulesState({ loading: false, error: null, data }))
      .catch((err) => setRulesState({ loading: false, error: err.message, data: null }));
  }, []);

  useEffect(() => { loadRules(); }, [loadRules]);

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
          <h2 style={{ fontSize: 'var(--chs-text-lg)', fontWeight: 'var(--chs-weight-semibold)', marginBottom: 'var(--chs-space-5)', color: 'var(--chs-color-text)' }}>
            Реестр правил
          </h2>
          {rulesState.loading && <LoadingState label="Загрузка правил…" compact />}
          {rulesState.error && (
            <ErrorState
              title="Не удалось загрузить правила"
              message={rulesState.error}
              onRetry={loadRules}
            />
          )}
          {rulesState.data && <SodRulesTable rules={rulesState.data.rules} />}
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
