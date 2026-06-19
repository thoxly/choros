/* ============================================================================
   CHOROS — screen-org.jsx
   ЭКРАН 1: дерево «подразделение → должность → сотрудник».
   Сотрудник = человек ИЛИ агент (одна сущность employee + маркер типа).
   Справа — КАРТОЧКА ИСПОЛНИТЕЛЯ (read):
     • роли как НАЗНАЧЕНИЯ (роль · орг-охват · срок) — не тумблеры инструментов;
     • агент: своя LLM (BYO — клиент хостит) + бюджет с РЕЗЕРВИРОВАНИЕМ
       (две крыши: на инстанс процесса и на агента) + порог автономии/эскалация;
     • гранты здесь НЕ редактируются — кнопка «Права и доступ» ведёт в П1R.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ExecutorBadge, ExecGlyph, MonoId, Mono, Button, Field, Select, Modal, ConfirmDialog,
  RoleAssignment, ReservationMeter, BudgetMeter,
  EmptyState, LoadingState, ErrorState, ToastViewport, useToasts, KitIcon,
} from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders, getDevUser } from '../app-shell/dev-auth.js';
import {
  validateDepartment, validatePosition, validateEmployee, validateRole, validateAssignment,
  buildDepartmentPayload, buildPositionPayload, buildEmployeePayload, buildRolePayload, buildAssignmentPayload,
  mapOrgError, indexBySlug, EMPLOYEE_KINDS,
} from './org-crud.js';

// Dev tenant UUID — the silo every write endpoint scopes to (server-side DEV_TENANT_ID).
const DEV_TENANT_ID = 'a0000000-0000-0000-0000-000000000001';

/* ----------------------------------------------------------------------------
   CRUD over the EXISTING org write endpoints (T-0269). Genuinely live:
     POST /api/departments | /api/positions | /api/employees | /api/roles
     POST /api/role-assignments        (grants.ts)
     DELETE /api/{departments|positions|employees|roles}/:id
   All require X-Dev-User = genesis owner (403 NOT_OWNER otherwise).
   The org tree (GET /api/org) only exposes slugs; the UUIDs the write routes
   need come from GET /api/org/tenant-state (genesis-owner gated). We load both.
   No dead buttons: every control here POSTs/DELETEs to a real endpoint. There is
   NO update/PATCH route for any org entity, so we expose create + delete only —
   no edit stub (would be a dead control). DELETE is real and verified on the live
   stack: it succeeds (200) for an UNREFERENCED entity. If the entity is still
   referenced (no ON DELETE CASCADE), the backend now maps the pg 23503 FK violation
   to an honest 409 FK_IN_USE (T-0292). mapOrgError handles this with an actionable hint.
   ---------------------------------------------------------------------------- */

const ENTITY_LABEL = {
  department: 'подразделение',
  position: 'должность',
  employee: 'сотрудника',
  role: 'роль',
  assignment: 'назначение роли',
};

/* ---- Карточки исполнителей ----
   roles → assignments (read); грант-атомы живут в П1R (screen-rights).
   NOTE: detail panel remains mock — /api/org exposes only the tree; rich executor detail is a future slice. */
const EXEC_DETAIL = {
  "a-invoice": {
    type: "agent", name: "Счёт-агент", position: "Согласующий счетов", dept: "Финансы",
    id: "AG-0042", autonomyLevel: "L2 — частичная автономия",
    state: { "Статус": "Активен", "В очереди": "4 задачи", "Подчинён": "Е. Ларина · человек", "Активен с": "11.03.2026" },
    llm: {
      endpoint: "https://llm.fin.choros.internal/v1",
      model: "claude-sonnet-4", build: "invoice-v4",
      ctx: "200K токенов", region: "ru-central-1a", billing: "по токенам",
    },
    assignments: [
      { roleId: "role-fin-approve-50", role: "Согласующий счетов ≤ ₽50 000", scope: "Финансы · Согласование счёта", validity: "до 31.12.2026" },
      { roleId: "role-fin-recon", role: "Сверка платежей", scope: "Финансы · Закрытие месяца", validity: "бессрочно" },
    ],
    reservation: [
      { label: "Токены LLM", used: 148920, instanceCap: 250000, agentCap: 2000000, unit: "ткн" },
      { label: "Стоимость вывода", used: 11800, instanceCap: 12480, agentCap: 80000, unit: "₽", money: true },
      { label: "Вызовы инструментов", used: 142, instanceCap: 300, agentCap: 4000, unit: "" },
    ],
    autonomy: { auto: 50, review: 80, autoLabel: "Автономно", reviewLabel: "Соглас. человеком", blockLabel: "Блок", t1: "₽0", t2: "₽50 000", t3: "₽250 000", esc: "А. Кравцова → Е. Ларина", escType: "human" },
  },
  "e-kravtsova": {
    type: "human", name: "А. Кравцова", position: "Контролёр расчётов", dept: "Финансы",
    id: "HU-0118", autonomyLevel: "Полные права в роли",
    state: { "Статус": "На смене", "В работе": "3 задачи", "Руководитель": "Е. Ларина", "Часовой пояс": "MSK (UTC+3)" },
    assignments: [
      { roleId: "role-fin-control", role: "Контролёр расчётов", scope: "Финансы", validity: "бессрочно" },
      { roleId: "role-fin-approve-250", role: "Согласование ≤ ₽250 000", scope: "Финансы · Согласование счёта", validity: "до 30.06.2026", expiring: true },
      { roleId: "role-fin-escrcv", role: "Приёмник эскалаций агентов", scope: "Финансы", validity: "бессрочно" },
    ],
    limits: [
      { label: "Согласований / сутки", used: 23, total: 60, unit: "" },
      { label: "Лимит согласования", used: 184000, total: 250000, unit: "₽", money: true },
    ],
    autonomy: { auto: 70, review: 100, autoLabel: "Утверждает сама", reviewLabel: "Совет директоров", blockLabel: "", t1: "₽0", t2: "₽250 000", t3: "₽1 000 000", esc: "Совет директоров", escType: "human" },
  },
  "a-triage": {
    type: "agent", name: "Триаж-агент", position: "Линия поддержки L1", dept: "Клиентский сервис",
    id: "AG-0017", autonomyLevel: "L1 — узкая автономия",
    state: { "Статус": "Активен", "В очереди": "12 обращений", "Подчинён": "И. Петров · человек", "Активен с": "02.01.2026" },
    llm: {
      endpoint: "https://llm.cs.choros.internal/v1",
      model: "claude-haiku-4", build: "triage-v2",
      ctx: "100K токенов", region: "ru-central-1a", billing: "по токенам",
    },
    assignments: [
      { roleId: "role-cs-l1", role: "Линия поддержки L1", scope: "Клиентский сервис · Поддержка", validity: "бессрочно" },
    ],
    reservation: [
      { label: "Токены LLM", used: 38400, instanceCap: 60000, agentCap: 1500000, unit: "ткн" },
      { label: "Стоимость вывода", used: 640, instanceCap: 1200, agentCap: 24000, unit: "₽", money: true },
      { label: "Авто-ответы", used: 7, instanceCap: 12, agentCap: 900, unit: "" },
    ],
    autonomy: { auto: 60, review: 100, autoLabel: "Авто-ответ", reviewLabel: "Эскалация L2", blockLabel: "", t1: "FAQ", t2: "Стандарт", t3: "Спор / возврат", esc: "И. Петров (L2)", escType: "human" },
  },
  "s-ledger": {
    type: "service", name: "ledger-sync", position: "Сервисный коннектор", dept: "Платформа",
    id: "SV-0003", autonomyLevel: "Детерминированный — без автономии",
    state: { "Статус": "Здоров", "Аптайм": "99.98%", "Владелец": "С. Белов", "Регион": "ru-central-1" },
    assignments: [
      { roleId: "role-plat-ledger", role: "Коннектор реестра", scope: "Платформа", validity: "бессрочно" },
    ],
    limits: [
      { label: "RPS, средний", used: 42, total: 200, unit: "rps" },
      { label: "Бюджет ошибок / сутки", used: 3, total: 50, unit: "" },
    ],
    autonomy: { auto: 100, review: 100, autoLabel: "Детерминированный — порог не применяется", reviewLabel: "", blockLabel: "", t1: "", t2: "", t3: "", esc: "Дежурный платформы (при сбое)", escType: "human" },
  },
};

/* ---- CRUD modal (shared) ----
   Migrated to the kit (T-0312): the modal surface is the kit <Modal> (tokenised
   overlay/panel, focus-trap, Esc/scrim close) and each field is the kit <Field>
   (text/slug) or a token-classed <select className="chs-input"> (no hand-rolled
   input style, no broken `--chs-bg-primary` fallback — that token never existed,
   so the old input fell to `color: inherit` on no background and was invisible in
   the light theme). Colours/spacing come from --chs-color-* only. */

/**
 * OrgFormField — one controlled field. kind: "text" | "slug" | "select".
 * All three render via the kit: text/slug → <Field> (label↔input wired,
 * aria-invalid, hint/error via aria-describedby); select → <Select> (token
 * select with the same label/validation/density contract). No hand-rolled
 * input/label/select markup — consistent surface in both themes.
 */
function OrgFormField({ field, value, onChange, error }) {
  const invalid = Boolean(error);
  const labelNode = (
    <>{field.label}{field.optional ? <span className="chs-org__optional"> (опц.)</span> : null}</>
  );
  if (field.kind === 'select') {
    return (
      <div className="chs-org__modalfield">
        <Select
          label={labelNode}
          options={field.options || []}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          invalid={invalid}
          hint={error || field.hint || undefined}
        >
          <option value="">{field.placeholder || '— выберите —'}</option>
          {(field.options || []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      </div>
    );
  }
  return (
    <div className="chs-org__modalfield">
      <Field
        label={labelNode}
        mono={field.kind === 'slug'}
        invalid={invalid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        hint={error || field.hint || undefined}
      />
    </div>
  );
}

/**
 * OrgCrudModal — generic create modal driven by `config`:
 *   { title, subtitle, fields[], validate(values), buildPayload(values),
 *     endpoint, entity }
 * On 201 calls onCreated(parsedBody). Honest error surfacing via mapOrgError:
 * field errors land on the named input, others in a banner. Surface = kit <Modal>.
 */
function OrgCrudModal({ open, config, onClose, onCreated }) {
  const initial = () => Object.fromEntries((config?.fields || []).map((f) => [f.key, f.default || '']));
  const [values, setValues] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitErr, setSubmitErr] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Reset whenever a different modal config opens.
    if (open) { setValues(initial()); setFieldErrors({}); setSubmitErr(null); setSubmitting(false); }
  }, [open, config]);

  const setField = useCallback((key, v) => setValues((s) => ({ ...s, [key]: v })), []);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setSubmitErr(null);
    const { valid, errors } = config.validate(values);
    setFieldErrors(errors);
    if (!valid) return;

    setSubmitting(true);
    try {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(config.buildPayload(values)),
      });
      if (res.status === 201) {
        const created = await res.json().catch(() => ({}));
        onCreated(created);
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* ignore */ }
      const mapped = mapOrgError(res.status, parsed, config.entity);
      if (mapped.field && (config.fields || []).some((f) => f.key === mapped.field)) {
        setFieldErrors((prev) => ({ ...prev, [mapped.field]: mapped.message }));
      } else {
        setSubmitErr(mapped.message);
      }
    } catch (err) {
      setSubmitErr(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }, [config, values, onCreated]);

  if (!open || !config) return null;

  return (
    <Modal open={open} onClose={onClose} title={config.title} size="sm">
      <form onSubmit={handleSubmit} className="chs-org__modalform">
        {config.subtitle && <p className="chs-org__modalsub">{config.subtitle}</p>}
        {(config.fields || []).map((f) => (
          <OrgFormField key={f.key} field={{ ...f, label: f.label }} value={values[f.key] ?? ''} onChange={(v) => setField(f.key, v)} error={fieldErrors[f.key]} />
        ))}
        {submitErr && (
          <div className="chs-org__formbanner chs-org__formbanner--err" role="alert">{submitErr}</div>
        )}
        <div className="chs-org__modalbar">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" size="sm" disabled={submitting}>
            {submitting ? 'Сохранение…' : 'Создать'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const SLUG_HINT = 'строчные латинские, цифры, дефис · 1–64';

/**
 * makeCrudConfig — assemble the OrgCrudModal config for an entity kind, given the
 * current tenant-state UUID indices + actor id. Returns null for unknown kinds.
 */
function makeCrudConfig(kind, state, actorId) {
  const deptOptions = (state.departments || []).map((d) => ({ value: d.id, label: `${d.slug} · ${d.display_name || ''}`.trim() }));
  const posOptions = (state.positions || []).map((p) => ({ value: p.id, label: `${p.slug}` }));
  const empOptions = (state.employees || []).map((e) => ({ value: e.id, label: `${e.slug}` }));
  const roleOptions = (state.roles || []).map((r) => ({ value: r.id, label: `${r.slug}` }));

  if (kind === 'department') {
    return {
      title: 'Добавить подразделение', subtitle: 'Корневое подразделение тенанта.', entity: ENTITY_LABEL.department,
      endpoint: '/api/departments', validate: validateDepartment, buildPayload: (v) => buildDepartmentPayload(DEV_TENANT_ID, v),
      fields: [
        { key: 'slug', label: 'Слаг', kind: 'slug', placeholder: 'sales', hint: SLUG_HINT },
        { key: 'display_name', label: 'Название', kind: 'text', placeholder: 'Продажи' },
      ],
    };
  }
  if (kind === 'position') {
    return {
      title: 'Добавить должность', subtitle: 'Должность внутри подразделения.', entity: ENTITY_LABEL.position,
      endpoint: '/api/positions', validate: validatePosition, buildPayload: (v) => buildPositionPayload(DEV_TENANT_ID, v),
      fields: [
        { key: 'department_id', label: 'Подразделение', kind: 'select', options: deptOptions, placeholder: '— подразделение —' },
        { key: 'slug', label: 'Слаг', kind: 'slug', placeholder: 'lead', hint: SLUG_HINT },
        { key: 'title', label: 'Название должности', kind: 'text', placeholder: 'Ведущий специалист' },
      ],
    };
  }
  if (kind === 'employee') {
    return {
      title: 'Добавить сотрудника', subtitle: 'Человек или агент. Должность — опционально.', entity: ENTITY_LABEL.employee,
      endpoint: '/api/employees', validate: validateEmployee, buildPayload: (v) => buildEmployeePayload(DEV_TENANT_ID, v),
      fields: [
        { key: 'kind', label: 'Тип', kind: 'select', default: 'human', placeholder: '— тип —',
          options: EMPLOYEE_KINDS.map((k) => ({ value: k, label: k === 'human' ? 'человек' : 'агент' })) },
        { key: 'slug', label: 'Слаг', kind: 'slug', placeholder: 'j-doe', hint: SLUG_HINT },
        { key: 'display_name', label: 'Имя', kind: 'text', placeholder: 'Дж. Доу' },
        { key: 'position_id', label: 'Должность', kind: 'select', optional: true, options: posOptions, placeholder: '— без должности —' },
      ],
    };
  }
  if (kind === 'role') {
    return {
      title: 'Добавить роль', subtitle: 'Роль тенанта. Гранты роли настраиваются в «Права и доступ».', entity: ENTITY_LABEL.role,
      endpoint: '/api/roles', validate: validateRole, buildPayload: (v) => buildRolePayload(DEV_TENANT_ID, v),
      fields: [
        { key: 'slug', label: 'Слаг', kind: 'slug', placeholder: 'approver', hint: SLUG_HINT },
        { key: 'display_name', label: 'Название роли', kind: 'text', placeholder: 'Согласующий' },
        { key: 'description', label: 'Описание', kind: 'text', optional: true, placeholder: 'Назначение роли' },
      ],
    };
  }
  if (kind === 'assignment') {
    return {
      title: 'Назначить роль', subtitle: 'Привязка сотрудника к роли с орг-охватом (подразделение).', entity: ENTITY_LABEL.assignment,
      endpoint: '/api/role-assignments', validate: validateAssignment, buildPayload: (v) => buildAssignmentPayload(v, actorId || ''),
      fields: [
        { key: 'employee_id', label: 'Сотрудник', kind: 'select', options: empOptions, placeholder: '— сотрудник —' },
        { key: 'role_id', label: 'Роль', kind: 'select', options: roleOptions, placeholder: '— роль —' },
        { key: 'department_id', label: 'Орг-охват (подразделение)', kind: 'select', options: deptOptions, placeholder: '— подразделение —',
          hint: 'охват назначения = выбранное подразделение' },
      ],
    };
  }
  return null;
}

function TreeRow({ depth, type, kind, label, count, vacancy, open, selected, onToggle, onSelect, hasChildren, onDelete }) {
  return (
    <button
      className={`chs-trow chs-trow--${kind}`}
      style={{ paddingLeft: `calc(${depth} * var(--chs-space-7) + var(--chs-space-3))` }}
      aria-selected={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span
        className={`chs-trow__twist ${open ? "chs-trow__twist--open" : ""} ${hasChildren ? "" : "chs-trow__twist--leaf"}`}
        onClick={(e) => { if (hasChildren) { e.stopPropagation(); onToggle(); } }}
      >
        <Icon name="chevron" />
      </span>
      {kind === "dept" && <span className="chs-trow__deptglyph" />}
      {kind === "emp" && <ExecGlyph type={type} size={9} />}
      <span className="chs-trow__label">{label}</span>
      {vacancy ? <span className="chs-trow__vac">вакансия</span> : null}
      {count != null && <span className="chs-trow__count">{count}</span>}
      {onDelete && (
        <span
          role="button"
          tabIndex={0}
          className="chs-trow__del"
          title="Удалить"
          aria-label="Удалить"
          style={{ marginLeft: 'auto', padding: '0 var(--chs-space-2)', color: 'var(--chs-color-text-faint)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onDelete(); } }}
        ><KitIcon name="close" size={14} /></span>
      )}
    </button>
  );
}

function OrgTree({ org, selectedId, onSelect, canWrite, idMaps, onCreate, onDelete }) {
  const [open, setOpen] = useState(() => ({ fin: true, "fin-appr": true, cs: true, "cs-l1": true, plat: false }));
  const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  // The tree (GET /api/org) keys entities by slug. Delete needs the UUID — resolve
  // it from tenant-state idMaps (slug→uuid). If a slug isn't in the map (e.g. tenant-state
  // failed to load) we omit the delete affordance rather than send a guessed id.
  const deptUuid = (slug) => idMaps?.departments?.[slug];
  const posUuid = (slug) => idMaps?.positions?.[slug];
  const empUuid = (slug) => idMaps?.employees?.[slug];

  const rows = [];
  org.forEach((dept) => {
    const headcount = dept.positions.reduce((n, p) => n + p.people.length, 0);
    const dUuid = deptUuid(dept.id);
    rows.push(
      <TreeRow key={dept.id} depth={0} kind="dept" label={dept.name} count={headcount}
        open={open[dept.id]} hasChildren onToggle={() => toggle(dept.id)} onSelect={() => toggle(dept.id)}
        onDelete={canWrite && dUuid ? () => onDelete('department', dUuid, dept.name) : undefined} />
    );
    if (!open[dept.id]) return;
    dept.positions.forEach((pos) => {
      const pUuid = posUuid(pos.id);
      rows.push(
        <TreeRow key={pos.id} depth={1} kind="pos" label={pos.title} count={pos.people.length} vacancy={pos.vacancy}
          open={open[pos.id]} hasChildren onToggle={() => toggle(pos.id)} onSelect={() => toggle(pos.id)}
          onDelete={canWrite && pUuid ? () => onDelete('position', pUuid, pos.title) : undefined} />
      );
      if (!open[pos.id]) return;
      pos.people.forEach((person) => {
        const eUuid = empUuid(person.id);
        rows.push(
          <TreeRow key={person.id} depth={2} kind="emp" type={person.type} label={person.name}
            selected={selectedId === person.id} hasChildren={false}
            onSelect={() => onSelect(person.id)}
            onDelete={canWrite && eUuid ? () => onDelete('employee', eUuid, person.name) : undefined} />
        );
      });
    });
  });

  return (
    <div className="chs-org__tree">
      <div className="chs-org__treehead">
        <span>Оргструктура</span>
      </div>
      {canWrite ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--chs-space-2)', padding: 'var(--chs-space-3) var(--chs-space-4)', borderBottom: '1px solid var(--chs-color-border)' }}>
          <Button variant="primary" size="sm" onClick={() => onCreate('department')}>+ Подразделение</Button>
          <Button variant="secondary" size="sm" onClick={() => onCreate('position')}>+ Должность</Button>
          <Button variant="secondary" size="sm" onClick={() => onCreate('employee')}>+ Сотрудник</Button>
          <Button variant="secondary" size="sm" onClick={() => onCreate('role')}>+ Роль</Button>
          <Button variant="secondary" size="sm" onClick={() => onCreate('assignment')}>Назначить роль</Button>
        </div>
      ) : (
        <div style={{ padding: 'var(--chs-space-3) var(--chs-space-4)', borderBottom: '1px solid var(--chs-color-border)', fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)' }}>
          Создание/удаление доступно владельцу тенанта (genesis owner). Войдите как владелец, чтобы редактировать оргструктуру.
        </div>
      )}
      <div className="chs-tree">{rows}</div>
    </div>
  );
}

function fmtRu(n) { return n.toLocaleString("ru-RU"); }
const moneyFmt = (n) => "₽" + fmtRu(n);

/* ---- Explain-PDP в карточке сотрудника (T-0223 · инвариант I-3) ----
   «Почему Вася не видит X» = трасса PDP, ВСТРОЕНА в карточку, ЗА mgmt-грантом.
   Сам эндпойнт POST /api/pdp/explain (T-0136) проверяет авторизацию:
   самоопрос ИЛИ admin с delegable mgmt_object:grant — иначе 403 без подробностей
   (запрос чужих прав не раскрывается). UI лишь показывает вердикт/трассу и честно сообщает 403.
   Скрытые поля (drop-маска) эндпойнт не раскрывает даже при самоопросе. */
function ExplainPanel({ subjectSlug }) {
  const [resourceType, setResourceType] = useState("mcp://ledger.invoices");
  const [operation, setOperation] = useState("read");
  const [recordId, setRecordId] = useState("");
  const [result, setResult] = useState(null); // null | "loading" | {verdict,reason,steps} | {forbidden} | {error}

  const run = async () => {
    setResult("loading");
    // tenantId фиксирован dev-силом на сервере; UI передаёт согласованный плейсхолдер.
    const TENANT = "a0000000-0000-0000-0000-000000000001";
    const ref = recordId
      ? { kind: "record", tenantId: TENANT, registryId: resourceType, recordId }
      : { kind: "registry", tenantId: TENANT, applicationId: resourceType, registryId: resourceType };
    try {
      const resp = await fetch("/api/pdp/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          subject: { tenantId: TENANT, subjectId: subjectSlug },
          handle: { ref, tenantId: TENANT },
          operation,
        }),
      });
      if (resp.status === 403) {
        // Без раскрытия: не-admin о чужом субъекте — без деталей (инвариант I-3).
        setResult({ forbidden: true });
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setResult({ error: data?.error?.code || data?.error?.message || `HTTP ${resp.status}` });
        return;
      }
      setResult(data);
    } catch (e) {
      setResult({ error: String(e?.message || e) });
    }
  };

  return (
    <section className="chs-section2">
      <div className="chs-section2__head">
        <h3 className="chs-section2__title">Почему видит / не видит — explain-PDP</h3>
        <span className="chs-section2__aux">за mgmt-грантом · без раскрытия чужих прав</span>
      </div>
      <div style={{ display: "flex", gap: "var(--chs-space-3)", flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 14ch" }}>
          <Field label="Ресурс" mono value={resourceType} onChange={(e) => setResourceType(e.target.value)} />
        </div>
        <Select
          label="Операция"
          options={["read", "create", "update", "delete"]}
          value={operation}
          onChange={(e) => setOperation(e.target.value)}
        />
        <Field label="ID записи (опц.)" mono value={recordId} onChange={(e) => setRecordId(e.target.value)} placeholder="—" />
        <Button variant="secondary" size="sm" disabled={result === "loading"} onClick={run}>
          {result === "loading" ? "Трасса…" : "Объяснить"}
        </Button>
      </div>
      {result && result !== "loading" && (
        <div style={{ marginTop: "var(--chs-space-3)", fontSize: "var(--chs-text-sm)" }}>
          {result.forbidden ? (
            <span style={{ color: "var(--chs-color-danger)" }}>
              403 — нет mgmt-гранта на просмотр прав этого субъекта: подробности скрыты, нет прав на просмотр.
            </span>
          ) : result.error ? (
            <span style={{ color: "var(--chs-color-danger)" }}>Ошибка: {result.error}</span>
          ) : (
            <>
              <div>
                Вердикт:{" "}
                <b style={{ color: result.verdict === "allow" ? "var(--chs-color-success)" : "var(--chs-color-danger)" }}>
                  {result.verdict === "allow" ? "ДОСТУП" : "ОТКАЗ"}
                </b>
                {result.reason && <> · <Mono>{result.reason}</Mono></>}
              </div>
              {Array.isArray(result.steps) && (
                <ol style={{ marginTop: "var(--chs-space-2)", paddingLeft: "var(--chs-space-5)" }}>
                  {result.steps.map((s, i) => (
                    <li key={i}>
                      <Mono>{s.step}</Mono> — {s.ok ? "ok" : "fail"}{s.reason ? ` (${s.reason})` : ""}{s.note ? ` · ${s.note}` : ""}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ExecutorDetail({ data, onOpenRights, subjectSlug }) {
  const isAgent = data.type === "agent";
  const isService = data.type === "service";
  const primaryRole = data.assignments[0]?.roleId;
  return (
    <div className="chs-org__detail">
      <div className="chs-detail">
        {/* HONESTY (T-0269): this rich executor card is illustrative — /api/org exposes
            only the tree; per-executor LLM/budget/autonomy detail is a future slice. */}
        <div style={{
          margin: '0 0 var(--chs-space-4) 0', padding: 'var(--chs-space-3) var(--chs-space-4)',
          background: 'var(--chs-color-warning-soft)',
          border: '1px solid var(--chs-color-border)', borderRadius: 'var(--chs-radius-3)',
          fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)',
        }}>
          Карточка исполнителя — иллюстративные данные. Реальны: дерево, создание/удаление и назначение ролей (слева).
        </div>
        <div className="chs-detail__head">
          <div className={`chs-detail__avatar chs-detail__avatar--${data.type}`}>
            <ExecGlyph type={data.type} size={22} />
          </div>
          <div className="chs-detail__headmain">
            <h2 className="chs-detail__name">
              {data.name}
              <ExecutorBadge type={data.type} />
            </h2>
            <div className="chs-detail__meta">
              <span>{data.position}</span>
              <span className="chs-crumbs__sep">/</span>
              <span>{data.dept}</span>
              <span className="chs-crumbs__sep">/</span>
              <MonoId>{data.id}</MonoId>
            </div>
          </div>
          <div className="chs-detail__headactions">
            <Button variant="ghost" size="sm" disabled title="Журнал событий исполнителя — следующий слой (API ещё не подключён)">Журнал</Button>
            <Button variant="secondary" size="sm" onClick={() => onOpenRights && onOpenRights(primaryRole)}
              glyph={<Icon name="rights" className="chs-btn__glyph" />}>Права и доступ</Button>
          </div>
        </div>

        {/* Состояние */}
        <div className="chs-detail__statline">
          {Object.entries(data.state).map(([k, v]) => (
            <div className="chs-statcell" key={k}>
              <span className="chs-statcell__k">{k}</span>
              <span className="chs-statcell__v">{v}</span>
            </div>
          ))}
        </div>

        {/* Назначения ролей (read) */}
        <section className="chs-section2">
          <div className="chs-section2__head">
            <h3 className="chs-section2__title">Назначенные роли</h3>
            <span className="chs-section2__aux">{data.assignments.length} назначено · права от роли</span>
          </div>
          <div className="chs-asgns">
            <div className="chs-asgns__colhead">
              <span>Роль</span><span>Орг-охват</span><span>Срок действия</span>
            </div>
            {data.assignments.map((a) => (
              <RoleAssignment key={a.roleId} role={a.role} scope={a.scope} validity={a.validity}
                expiring={a.expiring} onOpen={() => onOpenRights && onOpenRights(a.roleId)} />
            ))}
          </div>
          <p className="chs-section2__note">
            Доступные инструменты и видимые поля форм — <b>производные от грантов роли</b>.
            Гранты не редактируются здесь:&nbsp;
            <button className="chs-inlinelink" onClick={() => onOpenRights && onOpenRights(primaryRole)}>открыть «Права и доступ» →</button>
          </p>
        </section>

        {/* Своя модель (BYO) — только агент */}
        {isAgent && data.llm && (
          <section className="chs-section2">
            <div className="chs-section2__head">
              <h3 className="chs-section2__title">Своя модель (LLM)</h3>
              <span className="chs-byo">BYO · клиент хостит</span>
            </div>
            <div className="chs-llm">
              <div className="chs-llm__endpointrow">
                <span className="chs-llm__k">Эндпойнт</span>
                <Mono className="chs-llm__endpoint">{data.llm.endpoint}</Mono>
              </div>
              <div className="chs-llm__grid">
                <div className="chs-statcell"><span className="chs-statcell__k">Модель</span><span className="chs-statcell__v"><Mono>{data.llm.model}</Mono></span></div>
                <div className="chs-statcell"><span className="chs-statcell__k">Сборка</span><span className="chs-statcell__v"><Mono>{data.llm.build}</Mono></span></div>
                <div className="chs-statcell"><span className="chs-statcell__k">Контекст</span><span className="chs-statcell__v"><Mono>{data.llm.ctx}</Mono></span></div>
                <div className="chs-statcell"><span className="chs-statcell__k">Регион / тариф</span><span className="chs-statcell__v"><Mono>{data.llm.region}</Mono> · {data.llm.billing}</span></div>
              </div>
            </div>
          </section>
        )}

        {/* Бюджет с резервированием (агент) / Лимиты (человек, сервис) */}
        {isAgent ? (
          <section className="chs-section2">
            <div className="chs-section2__head">
              <h3 className="chs-section2__title">Бюджет и резервирование</h3>
              <span className="chs-section2__aux">две крыши: на инстанс · на агента</span>
            </div>
            <div className="chs-resvs">
              {data.reservation.map((b) => (
                <ReservationMeter key={b.label} label={b.label} used={b.used} instanceCap={b.instanceCap}
                  agentCap={b.agentCap} unit={b.unit} fmt={b.money ? moneyFmt : fmtRu} />
              ))}
            </div>
          </section>
        ) : (
          <section className="chs-section2">
            <div className="chs-section2__head">
              <h3 className="chs-section2__title">{isService ? "Сервисные лимиты" : "Лимиты в роли"}</h3>
              <span className="chs-section2__aux">сброс в 00:00 MSK</span>
            </div>
            <div className="chs-budgets">
              {data.limits.map((b) => (
                <BudgetMeter key={b.label} label={b.label} used={b.used} total={b.total} unit={b.unit}
                  fmt={b.money ? moneyFmt : fmtRu} />
              ))}
            </div>
          </section>
        )}

        {/* Автономия / эскалация */}
        <section className="chs-section2">
          <div className="chs-section2__head">
            <h3 className="chs-section2__title">Порог автономии и эскалации</h3>
            <span className="chs-section2__aux">{data.autonomyLevel}</span>
          </div>
          <div className="chs-autonomy">
            {isService ? (
              <div className="chs-autonomy__track">
                <div className="chs-autonomy__zone chs-autonomy__zone--auto" style={{ flex: 1 }}>{data.autonomy.autoLabel}</div>
              </div>
            ) : (
              <>
                <div className="chs-autonomy__track">
                  <div className="chs-autonomy__zone chs-autonomy__zone--auto" style={{ flex: data.autonomy.auto }}>{data.autonomy.autoLabel}</div>
                  <div className="chs-autonomy__zone chs-autonomy__zone--review" style={{ flex: data.autonomy.review - data.autonomy.auto }}>{data.autonomy.reviewLabel}</div>
                  {data.autonomy.blockLabel && (
                    <div className="chs-autonomy__zone chs-autonomy__zone--block" style={{ flex: Math.max(12, 100 - data.autonomy.review) }}>{data.autonomy.blockLabel}</div>
                  )}
                </div>
                <div className="chs-autonomy__ticks">
                  <span>{data.autonomy.t1}</span>
                  <span>{data.autonomy.t2}</span>
                  <span>{data.autonomy.t3}</span>
                </div>
              </>
            )}
            <div className="chs-autonomy__esc">
              <span>Эскалация:</span>
              <span className="chs-autonomy__arrow">→</span>
              <ExecutorBadge type={data.autonomy.escType} name={data.autonomy.esc} />
            </div>
          </div>
        </section>

        {/* Explain-PDP (T-0223 · I-3): встроен в карточку, за mgmt-грантом */}
        <ExplainPanel subjectSlug={subjectSlug} />
      </div>
    </div>
  );
}

// Honest minimal detail for an executor we have no rich (mock) card for — e.g. a
// freshly created employee. We never fabricate LLM/budget/autonomy data here.
function PlainExecutorDetail({ slug, onOpenRights }) {
  return (
    <div className="chs-org__detail">
      <div className="chs-detail">
        <div className="chs-detail__head">
          <div className="chs-detail__headmain">
            <h2 className="chs-detail__name"><MonoId>{slug}</MonoId></h2>
            <div className="chs-detail__meta"><span>Сотрудник оргструктуры</span></div>
          </div>
          <div className="chs-detail__headactions">
            <Button variant="secondary" size="sm" onClick={() => onOpenRights && onOpenRights(undefined)}
              glyph={<Icon name="rights" className="chs-btn__glyph" />}>Права и доступ</Button>
          </div>
        </div>
        <p style={{ padding: 'var(--chs-space-4)', color: 'var(--chs-color-text-muted)', fontSize: 'var(--chs-text-sm)' }}>
          Подробная карточка (модель, бюджет, автономия) для этого исполнителя ещё не подключена к API.
          Назначить роль и управлять оргструктурой можно слева; назначения ролей применяются реально.
        </p>
        <ExplainPanel subjectSlug={slug} />
      </div>
    </div>
  );
}

function OrgScreen({ onOpenRights }) {
  const [selected, setSelected] = useState(null);
  const [departments, setDepartments] = useState(null);
  const [error, setError] = useState(null);
  // tenant-state: { departments, positions, employees, roles } of UUID rows, OR
  // null=loading. canWrite reflects the genesis-owner gate on GET /api/org/tenant-state.
  const [state, setState] = useState(null);
  const [canWrite, setCanWrite] = useState(false);
  const [modalKind, setModalKind] = useState(null); // 'department'|'position'|… or null
  // pendingDelete: { kind, uuid, label } while the kit ConfirmDialog is open, or null.
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const { toasts, push, dismiss } = useToasts();

  const actorId = (getDevUser() || {}).id || '';

  const loadTree = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/org', { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDepartments(Array.isArray(data.departments) ? data.departments : []);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // tenant-state is genesis-owner gated; 200 ⇒ owner ⇒ CRUD enabled + we get UUIDs.
  // 403 ⇒ not owner ⇒ read-only tree (CRUD toolbar shows the honest reason). Other
  // failures ⇒ treat as read-only (no fabricated write capability).
  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`/api/org/tenant-state?tenant_id=${DEV_TENANT_ID}`, { headers: authHeaders() });
      if (res.status === 200) {
        const data = await res.json();
        setState(data);
        setCanWrite(true);
        return;
      }
      setCanWrite(false);
      setState(null);
    } catch {
      setCanWrite(false);
      setState(null);
    }
  }, []);

  const reload = useCallback(() => { loadTree(); loadState(); }, [loadTree, loadState]);

  useEffect(() => { reload(); }, [reload]);

  // slug→uuid maps used by the tree's delete affordance.
  const idMaps = state ? {
    departments: indexBySlug(state.departments),
    positions: indexBySlug(state.positions),
    employees: indexBySlug(state.employees),
    roles: indexBySlug(state.roles),
  } : null;

  const handleCreated = useCallback((created) => {
    setModalKind(null);
    push({ tone: 'success', message: `Создано · ${created?.slug || created?.id || 'ok'}` });
    reload();
  }, [reload, push]);

  // Open the kit ConfirmDialog (principles §4: deletion is a dangerous action = modal),
  // never the native window.confirm. The actual DELETE runs in confirmDelete on confirm.
  const requestDelete = useCallback((kind, uuid, label) => {
    setPendingDelete({ kind, uuid, label });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { kind, uuid, label } = pendingDelete;
    setDeleting(true);
    const path = { department: 'departments', position: 'positions', employee: 'employees', role: 'roles' }[kind];
    try {
      const res = await fetch(`/api/${path}/${uuid}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ tenant_id: DEV_TENANT_ID }),
      });
      if (res.ok) {
        push({ tone: 'success', message: `Удалено · ${label}` });
        if (selected) setSelected(null);
        reload();
        setPendingDelete(null);
        return;
      }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* ignore */ }
      push({ tone: 'error', message: mapOrgError(res.status, parsed, ENTITY_LABEL[kind]).message });
      setPendingDelete(null);
    } catch (e) {
      push({ tone: 'error', message: String(e?.message || e) });
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, reload, selected, push]);

  const data = selected ? EXEC_DETAIL[selected] : null;

  return (
    <div className="chs-org">
      <OrgCrudModal
        open={modalKind !== null}
        config={modalKind && state ? makeCrudConfig(modalKind, state, actorId) : null}
        onClose={() => setModalKind(null)}
        onCreated={handleCreated}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title="Удалить?"
        message={pendingDelete ? `Удалить ${ENTITY_LABEL[pendingDelete.kind]} «${pendingDelete.label}»? Действие необратимо.` : ''}
        confirmLabel="Удалить"
        cancelLabel="Отмена"
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => { if (!deleting) setPendingDelete(null); }}
      />
      <ToastViewport toasts={toasts} dismiss={dismiss} position="bottom-right" />
      {error ? (
        <ErrorState message={`Ошибка загрузки оргструктуры: ${error}`} onRetry={reload} />
      ) : departments === null ? (
        <LoadingState label="Загрузка оргструктуры…" />
      ) : (
        <>
          <OrgTree
            org={departments}
            selectedId={selected}
            onSelect={setSelected}
            canWrite={canWrite}
            idMaps={idMaps}
            onCreate={(kind) => setModalKind(kind)}
            onDelete={requestDelete}
          />
          {data
            ? <ExecutorDetail data={data} onOpenRights={onOpenRights} subjectSlug={selected} />
            : selected
              ? <PlainExecutorDetail slug={selected} onOpenRights={onOpenRights} />
              : (
                <div className="chs-org__detail">
                  {departments.length === 0 ? (
                    <EmptyState
                      title="Оргструктура пуста"
                      description={canWrite
                        ? 'Создайте первое подразделение слева.'
                        : 'Подразделений ещё нет. Создание доступно владельцу тенанта.'}
                    />
                  ) : (
                    <EmptyState
                      title="Исполнитель не выбран"
                      description="Выберите исполнителя в дереве слева, чтобы увидеть карточку."
                    />
                  )}
                </div>
              )}
        </>
      )}
    </div>
  );
}

export default OrgScreen;
