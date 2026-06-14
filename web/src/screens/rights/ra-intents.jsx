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

import React, { useState, useEffect } from 'react';
import { Button, Field } from '../../components/components.jsx';
import { SectionHead } from './ra-data.jsx';

const ACTOR_ID = 'e-owner'; // dev-silo genesis owner (confirmed by seed)

async function postIntent(path, body, actorId = ACTOR_ID) {
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dev-user': actorId },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return { ok: true, data };
    return { ok: false, status: resp.status, reason: data?.error?.reason || data?.error?.code || `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

function ResultBanner({ result }) {
  if (!result || result === 'loading') return null;
  if (result.ok) {
    return (
      <div className="chs-intent__result chs-intent__result--ok" style={{ color: 'var(--chs-color-success, green)', marginTop: 'var(--chs-space-3)', fontSize: 'var(--chs-text-sm)' }}>
        ✓ {result.message || 'Готово'}
        {result.data && <pre className="chs-intent__json" style={{ marginTop: 'var(--chs-space-2)' }}>{JSON.stringify(result.data, null, 2)}</pre>}
      </div>
    );
  }
  return (
    <div className="chs-intent__result chs-intent__result--err" style={{ color: 'var(--chs-color-danger, red)', marginTop: 'var(--chs-space-3)', fontSize: 'var(--chs-text-sm)' }}>
      ✕ {result.reason}
    </div>
  );
}

/* ---- Нанять: сотрудник → должность(пресет) ---- */
function HireForm({ presets }) {
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
        <Field label="UUID роли (должность)" value={roleId} onChange={(e) => setRoleId(e.target.value)} placeholder="e0000000-…" mono />
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
        <Button variant="primary" size="sm" disabled={result === 'loading' || !presetId || !roleId} onClick={submit}>
          {result === 'loading' ? 'Найм…' : 'Нанять'}
        </Button>
      </div>
      <ResultBanner result={result} />
    </section>
  );
}

/* ---- Уволить: отключить сотрудника (атомарный revoke) ---- */
function FireForm() {
  const [employeeId, setEmployeeId] = useState('');
  const [result, setResult] = useState(null);
  const submit = async () => {
    setResult('loading');
    const r = await postIntent('/api/rights/intents/fire', { employee_id: employeeId });
    setResult(r.ok ? { ...r, message: `Отозвано назначений: ${r.data.revoked_assignments}, грантов: ${r.data.revoked_sole_grants}. Задачи требуют переназначения.` } : r);
  };
  return (
    <section className="chs-section2 chs-intent">
      <SectionHead title="Уволить" aux="атомарный revoke всех прав · затем переназначение задач" />
      <div className="chs-intent__grid">
        <Field label="UUID сотрудника" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="d0000000-…" mono />
      </div>
      <p className="chs-section2__note">
        Все назначения и одиночные гранты сотрудника снимаются в одной транзакции — частичное увольнение невозможно.
        Активные задачи переназначаются/прерываются <b>после</b> фиксации revoke (порядок revoke→reassign).
      </p>
      <div className="chs-intent__bar">
        <Button variant="primary" size="sm" disabled={result === 'loading' || !employeeId} onClick={submit}>
          {result === 'loading' ? 'Увольнение…' : 'Отключить сотрудника'}
        </Button>
      </div>
      <ResultBanner result={result} />
    </section>
  );
}

/* ---- Подмена: X замещает Y до даты (делегированное подмножество) ---- */
function SubstituteForm() {
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
    setResult(r.ok ? { ...r, message: `Подмена объявлена (Tier-${r.data.tier})${r.data.ttl_grant_id ? ', выдан TTL-грант' : ''}` } : r);
  };
  return (
    <section className="chs-section2 chs-intent">
      <SectionHead title="Подмена" aux="X покрывает Y до даты · делегированное подмножество (⊆ замещаемого)" />
      <div className="chs-intent__grid">
        <Field label="Отсутствует (UUID)" value={absentId} onChange={(e) => setAbsentId(e.target.value)} placeholder="d0000000-…004" mono />
        <Field label="Замещает (UUID)" value={substituteId} onChange={(e) => setSubstituteId(e.target.value)} placeholder="d0000000-…002" mono />
        <Field label="UUID роли" value={roleId} onChange={(e) => setRoleId(e.target.value)} placeholder="e0000000-…002" mono />
        <Field label="Орг-узел (UUID отдела)" value={orgNodeId} onChange={(e) => setOrgNodeId(e.target.value)} placeholder="b0000000-…001" mono />
        <Field label="До (дата/время)" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
      </div>
      <p className="chs-section2__note">
        Tier-1 (есть пул-держатель) — грант не выпускается; Tier-2 — выпускается TTL-грант над <b>подмножеством</b> прав замещаемой роли,
        проверенным <code>validateNarrowing</code> до записи. Расширение прав отклоняется (422), <code>delegable=false</code>.
      </p>
      <div className="chs-intent__bar">
        <Button variant="primary" size="sm" disabled={result === 'loading' || !absentId || !substituteId || !roleId || !until || !orgNodeId} onClick={submit}>
          {result === 'loading' ? 'Объявление…' : 'Объявить подмену'}
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
  const submit = async () => {
    setResult('loading');
    const r = await postIntent('/api/rights/intents/urgent-revoke', { grant_id: grantId, principal_kind: principalKind });
    setResult(r.ok ? { ...r, message: `Право отозвано немедленно${r.data.halt_active_run ? ' · сигнал остановки активного прогона агента' : ''}` } : r);
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
        <Button variant="primary" size="sm" disabled={result === 'loading' || !grantId} onClick={submit}>
          {result === 'loading' ? 'Отзыв…' : 'Отозвать сейчас'}
        </Button>
      </div>
      <ResultBanner result={result} />
    </section>
  );
}

function IntentsScreen() {
  const [presets, setPresets] = useState([]);
  const [loadErr, setLoadErr] = useState(null);

  useEffect(() => {
    // Пресеты приходят из словарей (определения сидит T-0224). Этот экран НЕ
    // содержит пресет-данных — только ссылается по ключу.
    fetch('/api/rights/dictionaries')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
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
            <p className="chs-section2__note" style={{ color: 'var(--chs-color-danger, red)' }}>
              Пресеты не загружены ({loadErr}) — поля пресета будут пусты, пока сид T-0224 не применён.
            </p>
          )}
          <HireForm presets={presets} />
          <FireForm />
          <SubstituteForm />
          <UrgentRevokeForm />
        </div>
      </div>
    </div>
  );
}

export default IntentsScreen;
