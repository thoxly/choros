/* ============================================================================
   CHOROS — screen-users.jsx  (T-0583)
   Экран «Пользователи»: список учёток тенанта + создание логина/пароля +
   деактивация/реактивация. «Человека нанять не сложнее, чем ИИ-агента»:
   агент = /agents (POST /api/agents/hire, KC client), человек = этот экран
   (POST /api/users, KC user) — оба через один KC-admin-порт (ADR-T0583).

   ЖИВЫЕ контракты (никаких мёртвых кнопок):
     GET   /api/users/accounts       — список учёток тенанта (kind='human')
     POST  /api/users                — «Создать учётку» (логин+пароль, без email-верификации)
     PATCH /api/users/:employee_id   — деактивация/реактивация ({active:boolean})
     GET   /api/org/tenant-state?tenant_id=… — UUID должностей для формы создания

   БЕЗОПАСНОСТЬ: поле пароля — type="password", autoComplete="off". Пароль
   отправляется ОДИН РАЗ в теле создания и никогда не возвращается сервером
   (список/ответы не несут пароль) — форма не хранит его после отправки.
   ============================================================================ */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, MonoId, Modal, StatusChip, EmptyState, LoadingState, ErrorState, Tooltip, Field, Select } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { getActiveTenantId } from '../app-shell/active-tenant.js';
import {
  validateCreateUser, buildCreateUserPayload,
  mapUserError, accountStatusMeta, positionOptions,
} from './users-form.js';

// ---- Token-only styles (OBLIK: consume --chs-* only, no hardcoded color) -----
const bannerErrStyle = {
  marginBottom: 'var(--chs-space-5)', padding: 'var(--chs-space-4) var(--chs-space-5)',
  background: 'var(--chs-color-danger-soft)', border: '1px solid var(--chs-color-danger)',
  borderRadius: 'var(--chs-radius-3)', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text)',
};
const cardStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--chs-space-5)',
  padding: 'var(--chs-space-4) var(--chs-space-5)',
  background: 'var(--chs-color-surface)', border: '1px solid var(--chs-color-border)',
  borderRadius: 'var(--chs-radius-3)', color: 'var(--chs-color-text)',
};
const fieldGap = { display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-6)' };

/* ---------------------------------------------------------------------------
   Строка учётки — карточка читаема в ОБЕИХ темах (токены surface/text/muted).
   Кнопка деактивации/реактивации переключается по текущему active.
   --------------------------------------------------------------------------- */
function AccountRow({ account, onToggleActive, busy }) {
  const meta = accountStatusMeta(account.active);
  const orgPlace = account.position
    ? `${account.position}${account.department ? ` · ${account.department}` : ''}`
    : 'вне оргструктуры';

  return (
    <div style={cardStyle}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chs-space-3)' }}>
          <span style={{ fontWeight: 'var(--chs-weight-semibold)', color: 'var(--chs-color-text)' }}>
            {account.display_name}
          </span>
        </div>
        <div style={{ fontSize: 'var(--chs-text-xs)', color: 'var(--chs-color-text-muted)', marginTop: 'var(--chs-space-2)' }}>
          <MonoId>{account.login}</MonoId>
          {` · ${orgPlace}`}
        </div>
      </div>
      <Tooltip label={account.active ? 'Может войти в систему' : 'Вход заблокирован'}>
        <StatusChip status={meta.chip} label={meta.label} />
      </Tooltip>
      <Button
        variant={account.active ? 'secondary' : 'primary'}
        size="sm"
        disabled={busy}
        loading={busy}
        onClick={() => onToggleActive(account, !account.active)}
        title={account.active ? 'Деактивировать учётку (заблокировать вход)' : 'Реактивировать учётку (разрешить вход)'}
      >
        {account.active ? 'Деактивировать' : 'Реактивировать'}
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Модал: создать учётку
   --------------------------------------------------------------------------- */
function CreateUserModal({ positions, onClose, onDone }) {
  const [values, setValues] = useState({ login: '', password: '', display_name: '', position_id: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitErr, setSubmitErr] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setSubmitErr(null);
    const { valid, errors } = validateCreateUser(values);
    setFieldErrors(errors);
    if (!valid) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(buildCreateUserPayload(getActiveTenantId(), values)),
      });
      if (res.status === 201) { onDone(); return; }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON */ }
      const mapped = mapUserError(res.status, parsed, 'создание учётки');
      if (mapped.field) setFieldErrors((fe) => ({ ...fe, [mapped.field]: mapped.message }));
      else setSubmitErr(mapped.message);
    } catch {
      setSubmitErr('Сетевая ошибка — не удалось создать учётку.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open title="Создать учётку" onClose={onClose} size="sm">
      <form onSubmit={submit}>
        <p style={{ margin: '0 0 var(--chs-space-7) 0', fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)' }}>
          Учётка — логин и пароль для входа в систему. Письмо-подтверждение не отправляется;
          сообщите пароль пользователю лично. Сразу после создания учётка видит записи тенанта.
        </p>

        <div style={fieldGap}>
          <Field
            label="Логин"
            type="email"
            value={values.login}
            onChange={set('login')}
            placeholder="ivanov@company.ru"
            invalid={!!fieldErrors.login}
            hint={fieldErrors.login || 'email-адрес — используется как логин для входа'}
            autoFocus
          />

          <Field
            label="Пароль"
            type="password"
            autoComplete="off"
            value={values.password}
            onChange={set('password')}
            invalid={!!fieldErrors.password}
            hint={fieldErrors.password || 'не короче 8 символов'}
          />

          <Field
            label="Отображаемое имя"
            value={values.display_name}
            onChange={set('display_name')}
            placeholder="Иванов Иван"
            invalid={!!fieldErrors.display_name}
            hint={fieldErrors.display_name || undefined}
          />

          <Select
            label="Должность (опц.)"
            value={values.position_id}
            onChange={set('position_id')}
            hint={positions.length === 0 ? 'Должности не загружены. Создайте должность в «Оргструктуре», если нужна.' : undefined}
          >
            <option value="">— без должности —</option>
            {positions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </div>

        {submitErr && <div style={bannerErrStyle}>{submitErr}</div>}

        <div style={{ display: 'flex', gap: 'var(--chs-space-5)', justifyContent: 'flex-end', marginTop: 'var(--chs-space-7)' }}>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" size="sm" disabled={submitting} loading={submitting}>
            {submitting ? 'Создаю…' : 'Создать'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   Экран
   --------------------------------------------------------------------------- */
export default function UsersScreen() {
  const [accounts, setAccounts] = useState(null); // null=loading
  const [error, setError] = useState(null);
  const [positions, setPositions] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [toggleErr, setToggleErr] = useState(null);

  const loadAccounts = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/users/accounts', { headers: authHeaders() });
      if (res.status === 401) { setError('Войдите в систему, чтобы увидеть пользователей.'); setAccounts([]); return; }
      if (!res.ok) { setError(`Ошибка загрузки пользователей (HTTP ${res.status}).`); setAccounts([]); return; }
      const data = await res.json();
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
    } catch {
      setError('Сетевая ошибка — не удалось загрузить пользователей.');
      setAccounts([]);
    }
  }, []);

  const loadPositions = useCallback(async () => {
    try {
      const res = await fetch(`/api/org/tenant-state?tenant_id=${getActiveTenantId()}`, { headers: authHeaders() });
      if (!res.ok) { setPositions([]); return; }
      const data = await res.json();
      setPositions(positionOptions(data.positions));
    } catch {
      setPositions([]);
    }
  }, []);

  useEffect(() => { loadAccounts(); loadPositions(); }, [loadAccounts, loadPositions]);

  const toggleActive = async (account, nextActive) => {
    setToggleErr(null);
    setBusyId(account.employee_id);
    try {
      const res = await fetch(`/api/users/${account.employee_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ active: nextActive }),
      });
      if (res.ok) { await loadAccounts(); return; }
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON */ }
      const mapped = mapUserError(res.status, parsed, nextActive ? 'реактивацию' : 'деактивацию');
      setToggleErr(mapped.message);
    } catch {
      setToggleErr('Сетевая ошибка — не удалось изменить статус учётки.');
    } finally {
      setBusyId(null);
    }
  };

  const hasAccounts = Array.isArray(accounts) && accounts.length > 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--chs-space-6)', gap: 'var(--chs-space-6)' }}>
        <p style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', margin: 0, maxWidth: '88ch' }}>
          Учётки-пользователи тенанта. Каждая — логин и пароль для входа; создав учётку, сразу
          выдаётся право читать записи. Деактивация блокирует вход без удаления истории.
        </p>
        <Button
          variant="primary" size="sm"
          glyph={<Icon name="plus" className="chs-btn__glyph" />}
          onClick={() => setCreateOpen(true)}
        >
          Создать учётку
        </Button>
      </div>

      {toggleErr && <div style={bannerErrStyle}>{toggleErr}</div>}

      {accounts === null ? (
        <LoadingState label="Загрузка пользователей…" />
      ) : error ? (
        <ErrorState
          title="Не удалось загрузить пользователей"
          message={error}
          onRetry={loadAccounts}
        />
      ) : !hasAccounts ? (
        <EmptyState
          title="Пользователей пока нет"
          description="Создайте первую учётку — логин и пароль для входа в систему."
          action={
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              Создать учётку
            </Button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-4)' }}>
          {accounts.map((a) => (
            <AccountRow
              key={a.employee_id}
              account={a}
              onToggleActive={toggleActive}
              busy={busyId === a.employee_id}
            />
          ))}
        </div>
      )}

      {createOpen && (
        <CreateUserModal
          positions={positions}
          onClose={() => setCreateOpen(false)}
          onDone={() => { setCreateOpen(false); loadAccounts(); }}
        />
      )}
    </div>
  );
}
