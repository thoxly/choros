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
import { Button, Field, Select, KitIcon, ConfirmDialog, ErrorState } from '../../components/components.jsx';
import { SectionHead } from './ra-data.jsx';
import { authHeaders } from '../../app-shell/dev-auth.js';
import { getActiveTenantId } from '../../app-shell/active-tenant.js';
import { formatError, formatDate } from '../../lib/format.js';
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
    <Select label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </Select>
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

function ResultBanner({ result, tier }) {
  if (!result || result === 'loading') return null;
  if (result.ok) {
    return (
      <div
        className="chs-intent__result chs-intent__result--ok"
        style={{ color: 'var(--chs-color-success, green)', marginTop: 'var(--chs-space-3)', fontSize: 'var(--chs-text-sm)' }}
        {...(tier != null ? { 'data-tier': String(tier) } : {})}
      >
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
        <Select label="Тип" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="human">Человек</option>
          <option value="agent">Агент</option>
        </Select>
        <OrgPicker label="Роль (должность)" value={roleId} onChange={setRoleId}
          options={dir.roles} dirError={dir.error} placeholder="— выбрать роль —"
          fallbackPlaceholder="UUID роли" />
        <Select label="Пресет-роль" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
          <option value="">— выбрать пресет —</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.label}{p.critical ? ' (критично)' : ''}</option>
          ))}
        </Select>
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

/**
 * useSubstitutionCoverage — T-0745 (design: docs/tasks/T-0745.spec.md §2/§3).
 * Pre-submit READ: whenever BOTH `roleId` and `substituteId` are chosen,
 * asks GET /api/rights/intents/substitution-coverage whether the nominated
 * stand-in already holds that role (server reuses T-0744's
 * substituteProvidesCoverage — the SAME invariant the router/claim-gate/
 * owner-claim share; this hook does not re-derive "holds the role" client-
 * side, it only renders the server's answer). Returns:
 *   null  — unknown (incomplete selection, still loading, or the read
 *           failed — advisory only, never treated as "does not hold").
 *   true  — the stand-in personally holds the role now (no warning).
 *   false — the stand-in does NOT hold it (drives the warning banner).
 * Never blocks the form — a failed/slow read just means no banner shows.
 */
function useSubstitutionCoverage(roleId, substituteId) {
  const [providesCoverage, setProvidesCoverage] = useState(null);
  useEffect(() => {
    let alive = true;
    setProvidesCoverage(null);
    if (!roleId || !substituteId) return undefined;
    const qs = new URLSearchParams({ role_id: roleId, substitute_employee_id: substituteId });
    fetch(`/api/rights/intents/substitution-coverage?${qs.toString()}`, { headers: { ...authHeaders() } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(formatError(r.status)))))
      .then((d) => { if (alive) setProvidesCoverage(d?.provides_coverage === false ? false : true); })
      .catch(() => { if (alive) setProvidesCoverage(null); });
    return () => { alive = false; };
  }, [roleId, substituteId]);
  return providesCoverage;
}

/**
 * substituteCoverageWarning — T-0745, pure (design: T-0729.assessment.md §3
 * variant б, §4 wording discipline; T-0745.spec.md §4). Given the server's
 * `providesCoverage` signal (useSubstitutionCoverage above) and a human role
 * label, returns the warning banner text, or null when there is nothing to
 * warn about — coverage true, OR the signal is not yet known (advisory:
 * never renders a false "does not hold" while unresolved).
 *
 * Text reflects the REAL post-T-0744 behaviour: when the covering pool
 * empties, the orphaned task goes to the tenant owner (owner-claim,
 * T-0744 §3-в2) — NOT to this stand-in — unless `force_tier2` is checked
 * (the checkbox below this banner in both forms), which mints a scoped
 * temporary grant right away. Same no-"Tier-N"-jargon discipline as
 * substituteResultMessage/selfAbsenceResultMessage.
 */
export function substituteCoverageWarning({ providesCoverage, roleLabel }) {
  if (providesCoverage !== false) return null;
  const role = roleLabel ? `«${roleLabel}»` : 'выбранную роль';
  return `Замещающий сейчас не держит ${role} — пока роль покрыта другими держателями, `
    + 'подмена сработает в рамках его собственных прав. Если все держатели станут '
    + 'недоступны, задачи роли уйдут не к нему, а владельцу тенанта (роль будет '
    + 'считаться незаполненной). Чтобы доступ получил именно этот сотрудник — '
    + 'включите ниже «выдать собственный временный доступ».';
}

/**
 * Обязательность полей (T-0639): все 5 полей ниже требуются сервером
 * (POST /api/rights/intents/substitute 400 VALIDATION без любого из них) —
 * кнопка была молча disabled без объяснения, какое поле не хватает (чаще
 * всего пропускали «Орг-узел (отдел)», у него нет своей формы/пресета).
 * missingSubstituteFields — чистая функция (тестируема без DOM), список
 * человеко-читаемых названий недостающих полей в порядке формы.
 */
export function missingSubstituteFields({ absentId, substituteId, roleId, until, orgNodeId }) {
  const missing = [];
  if (!absentId) missing.push('Отсутствует');
  if (!substituteId) missing.push('Замещает');
  if (!roleId) missing.push('Роль');
  if (!orgNodeId) missing.push('Орг-узел (отдел)');
  if (!until) missing.push('До (дата/время)');
  return missing;
}

/**
 * Честный пост-сабмит фидбек (T-0639, спека docs/specs/T-0588-substitution-escalation.spec.md
 * §1.3/FR-6): сервер уже различает режим срабатывания в ответе — `tier: 1`
 * (роль покрыта другим держателем — правило создано, но НЕ меняет ничего
 * прямо сейчас: временный доступ замещающему не выпускается, задачи
 * перенаправляются ему только в рамках ЕГО СОБСТВЕННЫХ прав) vs `tier: 2`
 * (единственный держатель — временный грант выпущен немедленно, заместитель
 * сразу видит задачи роли). До этой правки UI показывал одно и то же
 * «Подмена объявлена» в обоих случаях — вводило в заблуждение при tier 1.
 * Жаргон «Tier-N» не выводится пользователю (только в data-tier для
 * тестов/дебага) — только человеческие формулировки режима.
 *
 * T-0731 (follow-up из ревью B1 T-0720, эпик T-0585): tier1-ветка раньше
 * обещала «подмена вступит в силу автоматически, если этот держатель станет
 * недоступен» — тот же overpromise, что судья заблокировал в
 * selfAbsenceResultMessage (см. ниже). Снято тем же способом и тем же
 * языком, для консистентности между двумя формами.
 */
export function substituteResultMessage(data) {
  const tier = data?.tier;
  if (tier === 1) {
    // T-0731 (B1-зеркало T-0720): НЕ обещать авто-эскалацию tier1→tier2 —
    // такого механизма в системе НЕТ (в tier1 ttl_grant_id остаётся NULL
    // навсегда, тот же код-путь registerSubstitute/registerSelfAbsence,
    // src/http/rights-intents.ts; серверный тест s5 в
    // rights-intents.self-absence.authz.test.ts доказывает это для общей
    // ветки; claim-гейт inbox.ts resolveTier2SubstitutionClaim фильтрует
    // r.ttlGrantId !== null — tier1-правило НЕ даёт заместителю без
    // собственной роли claim-eligibility → 403 NOT_ELIGIBLE). Говорим только
    // то, что система реально делает: правило создано, грант не выпускался,
    // замещающий действует в рамках СВОИХ прав.
    return 'Правило подмены создано. Роль сейчас покрыта другими держателями — '
      + 'временный доступ замещающему не выпускался. Задачи будут '
      + 'перенаправляться замещающему в рамках его собственных прав.';
  }
  if (tier === 2) {
    return 'Подмена объявлена и активна: заместитель получил временный доступ '
      + 'и увидит задачи этой роли в своём инбоксе.';
  }
  // Оборонительный fallback — если бек когда-то не пришлёт tier (контракт не
  // должен ломаться), не терять сигнал полностью: прежнее различение по
  // наличию временного гранта.
  return `Подмена объявлена${data?.ttl_grant_id ? ' (с временным грантом)' : ''}`;
}

/**
 * Честный пост-сабмит фидбек для SelfAbsenceForm (T-0720, follow-up ревью
 * T-0697 R-3). registerSelfAbsence (src/http/rights-intents.ts:1284-1393) уже
 * возвращает `tier: "tier1" | "tier2"` в теле ответа — тот же сигнал, что
 * substituteResultMessage потребляет для SubstituteForm, только строкой
 * ("tier1"/"tier2"), а не числом (1/2), т.к. это два независимых роута;
 * сервер не расширялся под эту задачу. tier1 = роль покрыта другим
 * держателем (не считая самого отсутствующего и замещающего) — правило
 * создано, временный доступ замещающему НЕ выпускался. tier2 = держателя
 * кроме вас и замещающего нет — замещающему сразу выпущен ограниченный
 * (не шире ваших прав) временный доступ до конца окна отсутствия. Как и в
 * substituteResultMessage, жаргон «Tier-N» в текст не выводится — только в
 * data-tier для тестов/дебага.
 */
export function selfAbsenceResultMessage(data) {
  const tier = data?.tier;
  if (tier === 'tier1') {
    // B1 (судейский блок T-0720): НЕ обещать авто-эскалацию tier1→tier2 —
    // такого механизма в системе НЕТ (в tier1 ttl_grant_id остаётся NULL
    // навсегда, серверный тест s5 в rights-intents.self-absence.authz.test.ts;
    // claim-гейт inbox.ts отсеивает tier1-замещающего без собственной роли →
    // 403 NOT_ELIGIBLE). Говорим только то, что система реально делает:
    // правило создано, грант не выпускался, замещающий действует в рамках
    // СВОИХ прав.
    return 'Отсутствие объявлено. Роль сейчас покрыта другими держателями — '
      + 'временный доступ замещающему не выпускался. Задачи будут '
      + 'перенаправляться замещающему в рамках его собственных прав.';
  }
  if (tier === 'tier2') {
    const until = data?.valid_until ? formatDate(data.valid_until) : null;
    return 'Отсутствие объявлено. Замещающему выпущен ограниченный временный '
      + `доступ (не шире ваших прав)${until ? ` до ${until}` : ''} — он увидит `
      + 'ваши задачи в своём инбоксе.';
  }
  // Оборонительный fallback — тот же принцип, что substituteResultMessage:
  // контракт не должен ломаться, если tier когда-то не придёт.
  return `Отсутствие объявлено${data?.ttl_grant_id ? ' (с временным грантом для замещающего)' : ''} — маршрутизатор перенаправит ваши задачи замещающему.`;
}

/**
 * SubstitutionCoverageHint — T-0745. Shared presentational block used by BOTH
 * SubstituteForm and SelfAbsenceForm, so the two forms stay textually
 * identical for the same concept (no jargon drift, matching the project's
 * established R-1/R-2 discipline for the two forms' other static notes):
 *   - the coverage warning banner (substituteCoverageWarning, above) —
 *     rendered ONLY when non-null, never blocks submit (advisory);
 *   - the `force_tier2` opt-in checkbox (T-0745 §1.2) — pipes the ALREADY
 *     EXISTING API param (rights-intents.ts registerSubstitute:744,
 *     registerSelfAbsence:1231) into the form; rendered unconditionally once
 *     a substitute is picked (a deliberate opt-in for immediate access is a
 *     legitimate choice even without the warning, e.g. an admin who wants a
 *     stand-in ready ahead of time).
 */
function SubstitutionCoverageHint({ warning, forceTier2, onForceTier2Change }) {
  return (
    <>
      {warning && (
        <p className="chs-hint chs-hint--warning" role="status" data-testid="coverage-warning">
          <KitIcon name="alert" /> {warning}
        </p>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)' }}>
        <input type="checkbox" checked={forceTier2} onChange={(e) => onForceTier2Change(e.target.checked)} />
        Выдать замещающему собственный временный доступ сразу
      </label>
      <p className="chs-section2__note">
        Замещающий получит ограниченный временный грант (не шире прав замещаемой роли) немедленно — независимо от того, есть ли другие держатели роли.
      </p>
    </>
  );
}

export function SubstituteForm({ dir }) {
  const [absentId, setAbsentId] = useState('');
  const [substituteId, setSubstituteId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [until, setUntil] = useState('');
  const [orgNodeId, setOrgNodeId] = useState('');
  const [forceTier2, setForceTier2] = useState(false);
  const [result, setResult] = useState(null);

  const missing = missingSubstituteFields({ absentId, substituteId, roleId, until, orgNodeId });
  const canSubmit = missing.length === 0;

  // T-0745: pre-submit coverage signal for the "stand-in does not hold the
  // role" warning (see useSubstitutionCoverage/substituteCoverageWarning
  // above) — server-decided, client only renders it.
  const providesCoverage = useSubstitutionCoverage(roleId, substituteId);
  const roleLabel = dir.roles.find((r) => r.id === roleId)?.label;
  const coverageWarning = substituteCoverageWarning({ providesCoverage, roleLabel });

  const submit = async () => {
    setResult('loading');
    const validUntil = until ? new Date(until).getTime() : null;
    const r = await postIntent('/api/rights/intents/substitute', {
      absent_employee_id: absentId,
      substitute_employee_id: substituteId,
      role_id: roleId,
      valid_until: validUntil,
      org_scope: { kind: 'node', hierarchy: 'org', nodeId: orgNodeId, nodeLevel: 'department' },
      force_tier2: forceTier2,
    });
    setResult(r.ok ? { ...r, message: substituteResultMessage(r.data), tier: r.data?.tier } : r);
  };
  return (
    <section className="chs-section2 chs-intent">
      <SectionHead title="Подмена" aux="X покрывает Y до даты · делегированное подмножество (⊆ замещаемого)" />
      <p className="chs-section2__note">Поля, отмеченные «*», обязательны для заполнения.</p>
      <div className="chs-intent__grid">
        <OrgPicker label="Отсутствует *" value={absentId} onChange={setAbsentId}
          options={dir.employees} dirError={dir.error} placeholder="— кого замещают —"
          fallbackPlaceholder="UUID отсутствующего" />
        <OrgPicker label="Замещает *" value={substituteId} onChange={setSubstituteId}
          options={dir.employees} dirError={dir.error} placeholder="— кто замещает —"
          fallbackPlaceholder="UUID замещающего" />
        <OrgPicker label="Роль *" value={roleId} onChange={setRoleId}
          options={dir.roles} dirError={dir.error} placeholder="— роль подмены —"
          fallbackPlaceholder="UUID роли" />
        <OrgPicker label="Орг-узел (отдел) *" value={orgNodeId} onChange={setOrgNodeId}
          options={dir.departments} dirError={dir.error} placeholder="— отдел (орг-охват) —"
          fallbackPlaceholder="UUID отдела"
          hint="Обязательно: без орг-охвата подмену объявить нельзя." />
        <Field label="До (дата/время) *" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
      </div>
      <p className="chs-section2__note">
        Права замещающего не шире прав замещаемой роли — попытка расширить будет отклонена сервером.
        Если замещение покрывается пулом (есть держатель, отличный от замещаемого и от самого замещающего), временный грант не выпускается; иначе замещающему выпускается ограниченный временный грант.
      </p>
      {substituteId && (
        <SubstitutionCoverageHint warning={coverageWarning} forceTier2={forceTier2} onForceTier2Change={setForceTier2} />
      )}
      <div className="chs-intent__bar">
        <Button variant="primary" size="sm" loading={result === 'loading'} disabled={result === 'loading' || !canSubmit} onClick={submit}>
          Объявить подмену
        </Button>
      </div>
      {!canSubmit && result !== 'loading' && (
        <p className="chs-hint" role="status" aria-live="polite">
          Заполните обязательные поля: {missing.join(', ')}.
        </p>
      )}
      <ResultBanner result={result} tier={result?.tier} />
    </section>
  );
}

/* ---- Я в отпуске: самостоятельное объявление отсутствия (T-0429) ---- */
/**
 * Self-service absence form: the current user declares THEIR OWN absence
 * and nominates a substitute. Unlike SubstituteForm (admin path), the
 * actor IS the absent employee — no "absent" picker needed.
 *
 * Calls POST /api/rights/intents/self-absence.
 * on_behalf_of semantics: when the substitute later acts on a task,
 *   performed_by = substitute, on_behalf_of = absent actor.
 *   The resolver emits kind: "substitution" { absentSlug, substituteSlug }
 *   which maps to these two distinct provenance fields in the audit trail.
 */
function SelfAbsenceForm({ dir }) {
  const [substituteId, setSubstituteId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [orgNodeId, setOrgNodeId] = useState('');
  const [forceTier2, setForceTier2] = useState(false);
  const [result, setResult] = useState(null);

  // T-0745: same pre-submit coverage signal as SubstituteForm (see
  // useSubstitutionCoverage/substituteCoverageWarning above) — here roleId is
  // the role the ABSENT actor (self) holds, and we ask whether the nominated
  // substitute ALSO already holds it (identical check, identical endpoint).
  const providesCoverage = useSubstitutionCoverage(roleId, substituteId);
  const roleLabel = dir.roles.find((r) => r.id === roleId)?.label;
  const coverageWarning = substituteCoverageWarning({ providesCoverage, roleLabel });

  const submit = async () => {
    setResult('loading');
    const validFrom = from ? new Date(from).getTime() : undefined;
    const validUntil = until ? new Date(until).getTime() : null;
    const r = await postIntent('/api/rights/intents/self-absence', {
      substitute_employee_id: substituteId,
      role_id: roleId,
      ...(validFrom ? { valid_from: validFrom } : {}),
      valid_until: validUntil,
      org_scope: { kind: 'node', hierarchy: 'org', nodeId: orgNodeId, nodeLevel: 'department' },
      force_tier2: forceTier2,
    });
    setResult(r.ok ? { ...r, message: selfAbsenceResultMessage(r.data), tier: r.data?.tier } : r);
  };

  return (
    <section className="chs-section2 chs-intent">
      <SectionHead
        title="Я в отпуске"
        aux="Самостоятельное объявление отсутствия · замещающий получит ваши задачи (T-0429)"
      />
      <p className="chs-section2__note" style={{ marginBottom: '0.75rem' }}>
        Назначьте замещающего и укажите период. Задачи по выбранной роли будут автоматически
        перенаправлены замещающему, пока вы отсутствуете.
        Замещающий действует <b>от вашего имени</b> (<i>on_behalf_of</i>), а не как самостоятельный
        исполнитель — аудиторский след сохраняет оба поля: исполнитель и доверитель.
      </p>
      <div className="chs-intent__grid">
        <OrgPicker label="Замещающий (кто будет покрывать вас)" value={substituteId} onChange={setSubstituteId}
          options={dir.employees} dirError={dir.error} placeholder="— выберите замещающего —"
          fallbackPlaceholder="UUID замещающего" />
        <OrgPicker label="Роль (по какой роли вы отсутствуете)" value={roleId} onChange={setRoleId}
          options={dir.roles} dirError={dir.error} placeholder="— роль отсутствия —"
          fallbackPlaceholder="UUID роли" />
        <OrgPicker label="Орг-узел (охват замещения)" value={orgNodeId} onChange={setOrgNodeId}
          options={dir.departments} dirError={dir.error} placeholder="— отдел (орг-охват) —"
          fallbackPlaceholder="UUID отдела" />
        <Field label="С (начало отсутствия, необязательно)" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="До (конец отсутствия)" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
      </div>
      {/*
        T-0697 (follow-up из T-0639, эпик T-0585): та же честная переформулировка
        Tier-N-жаргона на человеческий русский, что T-0639 применил к аналогичной
        статичной подсказке в SubstituteForm — те же термины («временный грант не
        выпускается», «выпускается ограниченный временный грант»). Это СТАТИЧНОЕ
        объяснение механики (обе ветки сразу), не пост-сабмит-фидбек конкретного
        результата.
        T-0720 (follow-up из ревью T-0697, R-1/R-2): полировка обеих статичных
        подсказок (эта + SubstituteForm) — «строго ограничены подмножеством / …
        отклоняется сервером» → «не шире / попытка расширить будет отклонена»
        (R-1, человечнее); «есть другие активные держатели» → явно назван
        держатель, отличный от вас И от самого замещающего (R-2, сервер
        (src/http/rights-intents.ts registerSelfAbsence, poolRows-запрос)
        исключает из пула оба employee_id — отсутствующего и замещающего —
        прежний текст этого не говорил). ТАКЖЕ: server уже возвращает
        tier: "tier1"|"tier2" — ResultBanner теперь читает его через
        selfAbsenceResultMessage (см. выше), закрывая R-3.
      */}
      <p className="chs-section2__note">
        Права замещающего не шире ваших прав — попытка расширить будет отклонена сервером.
        Если роль покрывается пулом (есть держатель, отличный от вас и от самого замещающего), временный грант не выпускается; иначе замещающему выпускается ограниченный временный грант.
      </p>
      {substituteId && (
        <SubstitutionCoverageHint warning={coverageWarning} forceTier2={forceTier2} onForceTier2Change={setForceTier2} />
      )}
      <div className="chs-intent__bar">
        <Button
          variant="primary"
          size="sm"
          loading={result === 'loading'}
          disabled={result === 'loading' || !substituteId || !roleId || !until || !orgNodeId}
          onClick={submit}
        >
          Объявить отсутствие
        </Button>
      </div>
      <ResultBanner result={result} tier={result?.tier} />
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
        <Select label="Тип принципала" value={principalKind} onChange={(e) => setPrincipalKind(e.target.value)}>
          <option value="human">Человек</option>
          <option value="agent">Агент</option>
        </Select>
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
          <SelfAbsenceForm dir={dir} />
          <UrgentRevokeForm />
        </div>
      </div>
    </div>
  );
}

export default IntentsScreen;
