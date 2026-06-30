/* ============================================================================
   CHOROS — ra-intents.jsx  (T-0223 · D-2)
   БЫТОВЫЕ КЕЙСЫ ПРАВ как intent-операции.
   Админ выражает НАМЕРЕНИЕ (нанять / уволить / подмена / срочно отозвать);
   система разворачивает его в гранты ЧЕРЕЗ ПРЕСЕТЫ — не ручной редактор решётки.

   Инвариант I-1: пресеты выбираются по КЛЮЧУ; их определения сидит T-0224 и
   приходят сюда из GET /api/rights/dictionaries (этот экран НЕ хранит пресет-данные).
   Инвариант I-2: подмена ⊆ замещаемого — сервер режет расширение через
   validateNarrowing (422 SUBSTITUTION_WIDENS); UI лишь показывает вердикт.
   Инвариант I-3: «почему не видит X» = explain-PDP, встроен в карточку сотрудника
   (screen-org.jsx) за mgmt-грантом. Здесь — операции записи.
   Инвариант I-4: каждое намерение — событие аудита (сервер пишет в единый сток).
   ============================================================================ */

import React, { useState, useEffect, useId } from 'react';
import { Button, Field, KitIcon, ConfirmDialog, ErrorState } from '../../components/components.jsx';
import { SectionHead } from './ra-data.jsx';
import { authHeaders } from '../../app-shell/dev-auth.js';
import { getActiveTenantId } from '../../app-shell/active-tenant.js';
import { formatError } from '../../lib/format.js';
import { ConsequenceSummary, useDestructiveConfirm } from '../../util/confirm-helpers.jsx';

// Tenant id resolved at runtime from the caller's identity (see active-tenant.js).
// The tenant-state read is genesis-owner gated against the caller's OWN tenant.

/* ----------------------------------------------------------------------------
   Org directory (T-0312 · audit #10): the hire/substitute/revoke forms used to
   ask the admin to TYPE a raw role/employee/org-node UUID (placeholder
   `e0000000-…`) — a dev-jargon leak (principles.md §3) and an error trap. We now
   resolve those ids from GET /api/org/tenant-state (the same endpoint screen-org
   reads): it returns { departments, positions, employees, roles } as { id, slug }
   rows, scoped to the dev silo. The picker lists them by human slug → value=id,
   so the admin chooses a name and the underlying UUID is still what we submit.
   ---------------------------------------------------------------------------- */
function useOrgDirectory() {
  const [dir, setDir] = useState({ employees: [], roles: [], departments: [] });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch(`/api/org/tenant-state?tenant_id=${getActiveTenantId()}`, { headers: { ...authHeaders() } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(formatError(r.status)))))
      .then((d) => {
        if (!alive) return;
        const opt = (rows) => (Array.isArray(rows) ? rows : []).map((x) => ({ id: x.id, label: x.slug || x.id }));
        setDir({ employees: opt(d.employees), roles: opt(d.roles), departments: opt(d.departments) });
        setLoading(false);
      })
      .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    return () => { alive = false; };
  }, []);
  return { ...dir, error, loading };
}

/* OrgPicker — choose an entity by human name; the value submitted is its UUID.
   Kit-classed native <select> (the kit has no Select primitive; .chs-input
   carries the tokenised surface). If the directory failed to load we fall back
   to a kit <Field> raw-UUID input so the form is never dead-ended (honest
   degrade) — but the happy path never types a UUID. */
function OrgPicker({ label, value, onChange, options, placeholder = '— выбрать —', dirError, fallbackPlaceholder, hint }) {
  const autoId = useId();
  const selId = `org-pick-${autoId}`;
  if (dirError) {
    return (
      <Field
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fallbackPlaceholder || '— справочник недоступен, введите UUID —'}
        mono
        hint={hint || `справочник не загружен (${dirError})`}
      />
    );
  }
  return (
    <label className="chs-field" htmlFor={selId}>
      <span className="chs-label">{label}</span>
      <select id={selId} className="chs-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

async function postIntent(path, body) {
  try {
    // Mode-aware auth (dev → X-Dev-User from the picked dev identity; keycloak →
    // Authorization: Bearer — the actor then comes from the validated token).
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return { ok: true, data };
    return { ok: false, status: resp.status, reason: data?.error?.reason || (data?.error?.code ? formatError(data.error.code) : null) || formatError(resp.status) };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

function ResultBanner({ result }) {
  if (!result || result === 'loading') return null;
  if (result.ok) {
    return (
      <div className="chs-intent__result chs-intent__result--ok" style={{ color: 'var(--chs-color-success, green)', marginTop: 'var(--chs-space-3)', fontSize: 'var(--chs-text-sm)' }}>
        <KitIcon name="success" /> {result.message || 'Готово'}
        {result.data && <pre className="chs-intent__json" style={{ marginTop: 'var(--chs-space-2)' }}>{JSON.stringify(result.data, null, 2)}</pre>}
      </div>
    );
  }
  return (
    <div className="chs-intent__result chs-intent__result--err" style={{ color: 'var(--chs-color-danger, red)', marginTop: 'var(--chs-space-3)', fontSize: 'var(--chs-text-sm)' }}>
      <KitIcon name="close" /> {result.reason}
    </div>
  );
}

/* ---- Нанять: сотрудник → должность(пресет) ---- */
function HireForm({ presets, dir }) {
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [presetId, setPresetId] = useState('');
  const [kind, setKind] = useState('human');
  const [result, setResult] = useState(null);

  const submit = async () => {
    setResult('loading');
    const r = await postIntent('/api/rights/intents/hire', {
      preset_id: presetId, role_id: roleId, kind, slug, display_name: displayName,
    });
    setResult(r.ok ? { ...r, message: `Нанят: ${r.data.grants_issued} грант(ов), статус ${r.data.state}` } : r);
  };

  const selected = presets.find((p) => p.id === presetId);
  return (
    <section className="chs-section2 chs-intent">
      <SectionHead title="Нанять" aux="сотрудник → должность · пресет разворачивается в гранты" />
      <div className="chs-intent__grid">
        <Field label="Slug сотрудника" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e-petrov" mono />
        <Field label="Имя" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="П. Петров" />
        <label className="chs-field">
          <span className="chs-label">Тип</span>
          <select className="chs-input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="human">Человек</option>
            <option value="agent">Агент</option>
          </select>
        </label>
        <OrgPicker label="Роль (должность)" value={roleId} onChange={setRoleId}
          options={dir.roles} dirError={dir.error} placeholder="— выбрать роль —"
          fallbackPlaceholder="UUID роли" />
        <label className="chs-field">
          <span className="chs-label">Пресет-роль</span>
          <select className="chs-input" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
            <option value="">— выбрать пресет —</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.label}{p.critical ? ' (критично)' : ''}</option>
            ))}
          </select>
        </label>
      </div>
      {selected && (
        <p className="chs-section2__note">
          {selected.desc} · {selected.grants.length} грант-атом(ов){selected.critical && ' · критичный пресет → второй аппрувер (dual-control)'}
        </p>
      )}
      <div className="chs-intent__bar">
        <Button variant="primary" size="sm" loading={result === 'loading'} disabled={result === 'loading' || !presetId || !roleId} onClick={submit}>
          Нанять
        </Button>
      </div>
      <ResultBanner result={result} />
    </section>
  );
}

/* ---- Уволить: отключить сотрудника (атомарный revoke) ---- */
function FireForm({ dir }) {
  const [employeeId, setEmployeeId] = useState('');
  const [result, setResult] = useState(null);
  const dc = useDestructiveConfirm();
  const [reason, setReason] = useState('');

  const employeeLabel = dir.employees.find((e) => e.id === employeeId)?.label || employeeId;

  const submit = async () => {
    setResult('loading');
    const r = await postIntent('/api/rights/intents/fire', { employee_id: employeeId, reason });
    setResult(r.ok ? { ...r, message: `Отозвано назначений: ${r.data.revoked_assignments}, грантов: ${r.data.revoked_sole_grants}. Задачи требуют переназначения.` } : r);
    setReason('');
  };

  return (
    <section className="chs-section2 chs-intent">
      <SectionHead title="Уволить" aux="атомарный revoke всех прав · затем переназначение задач" />
      <div className="chs-intent__grid">
        <OrgPicker label="Сотрудник" value={employeeId} onChange={setEmployeeId}
          options={dir.employees} dirError={dir.error} placeholder="— выбрать сотрудника —"
          fallbackPlaceholder="UUID сотрудника" />
      </div>
      <p className="chs-section2__note">
        Все назначения и одиночные гранты сотрудника снимаются в одной транзакции — частичное увольнение невозможно.
        Активные задачи переназначаются/прерываются <b>после</b> фиксации revoke (порядок revoke→reassign).
      </p>
      <div className="chs-intent__bar">
        <Button variant="danger" size="sm" loading={result === 'loading'} disabled={result === 'loading' || !employeeId} onClick={() => dc.request(employeeId)}>
          Отключить сотрудника
        </Button>
      </div>
      <ResultBanner result={result} />

      <ConfirmDialog
        open={dc.open}
        tone="danger"
        title="Уволить сотрудника?"
        message={
          <ConsequenceSummary
            who={employeeLabel || 'Выбранный сотрудник'}
            what={`Отзыв всех назначений и грантов. Активные задачи переназначаются/прерываются.`}
            reversibility="Необратимо. Восстановление — ручное создание новых назначений."
          />
        }
        confirmLabel="Уволить"
        loading={dc.loading}
        reason={reason}
        onReasonChange={setReason}
        reasonRequired={true}
        reasonPlaceholder="Причина увольнения (обязательно)"
        onConfirm={() => dc.confirm(submit)}
        onClose={dc.cancel}
      />
    </section>
  );
}

/* ---- Подмена: X замещает Y до даты (делегированное подмножество) ---- */
function SubstituteForm({ dir }) {
  const [absentId, setAbsentId] = useState('');
  const [substituteId, setSubstituteId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [until, setUntil] = useState('');
  const [orgNodeId, setOrgNodeId] = useState('');
  const [result, setResult] = useState(null);

  const submit = async () => {
    setResult('loading');
    const validUntil = until ? new Date(until).getTime() : null;
    const r = await postIntent('/api/rights/intents/substitute', {
      absent_employee_id: absentId,
      substitute_employee_id: substituteId,
      role_id: roleId,
      valid_until: validUntil,
      org_scope: { kind: 'node', hierarchy: 'org', nodeId: orgNodeId, nodeLevel: 'department' },
    });
    setResult(r.ok ? { ...r, message: `Подмена объявлена${r.data.ttl_grant_id ? ' (с временным грантом)' : ''}` } : r);
  };
  return (
    <section className="chs-section2 chs-intent">
      <SectionHead title="Подмена" aux="X покрывает Y до даты · делегированное подмножество (⊆ замещаемого)" />
      <div className="chs-intent__grid">
        <OrgPicker label="Отсутствует" value={absentId} onChange={setAbsentId}
          options={dir.employees} dirError={dir.error} placeholder="— кого замещают —"
          fallbackPlaceholder="UUID отсутствующего" />
        <OrgPicker label="Замещает" value={substituteId} onChange={setSubstituteId}
          options={dir.employees} dirError={dir.error} placeholder="— кто замещает —"
          fallbackPlaceholder="UUID замещающего" />
        <OrgPicker label="Роль" value={roleId} onChange={setRoleId}
          options={dir.roles} dirError={dir.error} placeholder="— роль подмены —"
          fallbackPlaceholder="UUID роли" />
        <OrgPicker label="Орг-узел (отдел)" value={orgNodeId} onChange={setOrgNodeId}
          options={dir.departments} dirError={dir.error} placeholder="— отдел (орг-охват) —"
          fallbackPlaceholder="UUID отдела" />
        <Field label="До (дата/время)" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
      </div>
      <p className="chs-section2__note">
        Права замещающего строго ограничены подмножеством прав замещаемой роли — расширение прав невозможно и отклоняется сервером.
        Если замещение покрывается пулом, временный грант не выпускается; иначе выпускается ограниченный временный грант.
      </p>
      <div className="chs-intent__bar">
        <Button variant="primary" size="sm" loading={result === 'loading'} disabled={result === 'loading' || !absentId || !substituteId || !roleId || !until || !orgNodeId} onClick={submit}>
          Объявить подмену
        </Button>
      </div>
      <ResultBanner result={result} />
    </section>
  );
}

/* ---- Срочно отозвать: убрать право X сейчас ---- */
function UrgentRevokeForm() {
  const [grantId, setGrantId] = useState('');
  const [principalKind, setPrincipalKind] = useState('human');
  const [result, setResult] = useState(null);
  const dc = useDestructiveConfirm();
  const [reason, setReason] = useState('');

  const submit = async () => {
    setResult('loading');
    const r = await postIntent('/api/rights/intents/urgent-revoke', { grant_id: grantId, principal_kind: principalKind, reason });
    setResult(r.ok ? { ...r, message: `Право отозвано немедленно${r.data.halt_active_run ? ' · сигнал остановки активного прогона агента' : ''}` } : r);
    setReason('');
  };

  return (
    <section className="chs-section2 chs-intent">
      <SectionHead title="Срочно отозвать" aux="убрать право сейчас · для агента — остановка активных шагов (fail-closed)" />
      <div className="chs-intent__grid">
        <Field label="UUID гранта" value={grantId} onChange={(e) => setGrantId(e.target.value)} placeholder="g0000000-…" mono />
        <label className="chs-field">
          <span className="chs-label">Тип принципала</span>
          <select className="chs-input" value={principalKind} onChange={(e) => setPrincipalKind(e.target.value)}>
            <option value="human">Человек</option>
            <option value="agent">Агент</option>
          </select>
        </label>
      </div>
      <p className="chs-section2__note">
        Грант помечается <code>valid_until = now</code>; способность исчезает на <b>следующей</b> проверке PDP (без кэша).
        Для агента активный прогон обязан прерваться на границе следующего шага (fail-closed).
      </p>
      <div className="chs-intent__bar">
        <Button variant="danger" size="sm" loading={result === 'loading'} disabled={result === 'loading' || !grantId} onClick={() => dc.request(grantId)}>
          Отозвать сейчас
        </Button>
      </div>
      <ResultBanner result={result} />

      <ConfirmDialog
        open={dc.open}
        tone="danger"
        title="Срочно отозвать право?"
        message={
          <ConsequenceSummary
            who={`Грант ${(dc.target || '').slice(0, 8)}… (${principalKind === 'agent' ? 'Агент' : 'Человек'})`}
            what="Право немедленно отзывается. Для агента — активный прогон прерывается (fail-closed)."
            reversibility="Необратимо. Новый грант выдаётся через Rights Admin."
          />
        }
        confirmLabel="Отозвать"
        loading={dc.loading}
        reason={reason}
        onReasonChange={setReason}
        reasonRequired={true}
        reasonPlaceholder="Причина отзыва прав (обязательно)"
        onConfirm={() => dc.confirm(submit)}
        onClose={dc.cancel}
      />
    </section>
  );
}

function IntentsScreen() {
  const [presets, setPresets] = useState([]);
  const [loadErr, setLoadErr] = useState(null);
  const dir = useOrgDirectory(); // { employees, roles, departments, error, loading }

  useEffect(() => {
    // Пресеты приходят из словарей (определения сидит T-0224). Этот экран НЕ
    // содержит пресет-данных — только ссылается по ключу.
    fetch('/api/rights/dictionaries')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(formatError(r.status)))))
      .then((d) => setPresets(d.presets || []))
      .catch((e) => setLoadErr(e.message));
  }, []);

  return (
    <div className="chs-rights">
      <div className="chs-rights__main">
        <div className="chs-roledetail">
          <div className="chs-roledetail__head">
            <div className="chs-roledetail__titlewrap">
              <h2 className="chs-roledetail__title">Бытовые операции прав</h2>
              <div className="chs-roledetail__sub">
                Намерение → пресет → гранты. Решётку скоупов админ не собирает руками.
              </div>
            </div>
          </div>
          {loadErr && (
            <ErrorState
              compact
              title="Пресеты не загружены"
              message={`${loadErr} — поля пресета будут пусты, пока сид T-0224 не применён.`}
            />
          )}
          <HireForm presets={presets} dir={dir} />
          <FireForm dir={dir} />
          <SubstituteForm dir={dir} />
          <UrgentRevokeForm />
        </div>
      </div>
    </div>
  );
}

export default IntentsScreen;
