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
import { Button, MonoId, Modal, StatusChip, EmptyState, LoadingState, ErrorState, Tooltip, Field, Select, ConfirmDialog } from '../components/components.jsx';
import { Icon } from '../app-shell/icon.jsx';
import { authHeaders } from '../app-shell/dev-auth.js';
import { getActiveTenantId } from '../app-shell/active-tenant.js';
import { useToastContext } from '../app-shell/toast-context.jsx';
import { ConsequenceSummary, useDestructiveConfirm } from '../util/confirm-helpers.jsx';
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
function AccountRow({ account, onToggleActive, busy, canWrite }) {
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
          {/* T-0652 (§6.4): учётки до миграции 126 (KC-backed, login=NULL) раньше
              светили сырой KC-UUID как «логин». Сервер теперь отдаёт login=null +
              login_missing → показываем честную метку, а НЕ UUID. */}
          {account.login_missing || !account.login
            ? <span style={{ fontStyle: 'italic' }}>логин не задан</span>
            : <MonoId>{account.login}</MonoId>}
          {` · ${orgPlace}`}
        </div>
      </div>
      <Tooltip label={account.active ? 'Может войти в систему' : 'Вход заблокирован'}>
        <StatusChip status={meta.chip} label={meta.label} />
      </Tooltip>
      {/* T-0628: деактивация/реактивация — контрол записи, скрыт для не-владельца
          (canWrite=false) по паттерну screen-org.jsx; сервер всё равно честно
          403-ит POST/PATCH — это чисто косметическая деградация. */}
      {canWrite && (
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
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Модал: создать учётку
   --------------------------------------------------------------------------- */
function CreateUserModal({ positions, onClose, onDone }) {
  const [values, setValues] = useState({ login: '', email: '', password: '', display_name: '', position_id: '' });
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
            type="text"
            value={values.login}
            onChange={set('login')}
            placeholder="ivan.petrov"
            invalid={!!fieldErrors.login}
            hint={fieldErrors.login || 'используется для входа в систему'}
            autoFocus
          />

          <Field
            label="Email"
            type="email"
            value={values.email}
            onChange={set('email')}
            placeholder="ivanov@company.ru"
            invalid={!!fieldErrors.email}
            hint={fieldErrors.email || undefined}
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
            placeholder="Иван Петров"
            invalid={!!fieldErrors.display_name}
            hint={fieldErrors.display_name || 'имя и фамилия — так учётка сразу готова ко входу, без лишнего шага «заполните профиль»'}
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
  // T-0628 (минор — /users прямым URL рядовому): canWrite mirrors the
  // screen-org.jsx pattern — GET /api/org/tenant-state is owner/covering-grant
  // gated (200 ⇒ can write, 403 ⇒ read-only). This screen already calls that
  // endpoint for the position dropdown, so no new request is introduced; a
  // non-owner sees the account list but the write controls degrade to a
  // banner, same as OrgTree does. The SERVER 403 on POST/PATCH stays the real
  // gate (T-0469) — this is a cosmetic client-side degrade only.
  const [canWrite, setCanWrite] = useState(false);
  // T-0775: «Деактивировать» was the only unconfirmed consequential action on
  // this screen (fired instantly, no undo, no toast) — inconsistent with
  // «Уволить» on rights/ra-intents.jsx, which gates behind ConfirmDialog +
  // ConsequenceSummary (§confirm-helpers.jsx). Reuse the SAME two-phase
  // open/confirm hook + component here (no bespoke dialog). Реактивация
  // остаётся мгновенной — она не деструктивна (просто разрешает вход обратно).
  const dc = useDestructiveConfirm();
  const { push: pushToast } = useToastContext();

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
      if (res.status === 200) {
        const data = await res.json();
        setPositions(positionOptions(data.positions));
        setCanWrite(true);
        return;
      }
      // 403 (not owner / no covering grant) or any other failure ⇒ read-only
      // degrade — no fabricated write capability (mirrors screen-org.jsx).
      setPositions([]);
      setCanWrite(false);
    } catch {
      setPositions([]);
      setCanWrite(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); loadPositions(); }, [loadAccounts, loadPositions]);

  // T-0775: the actual PATCH — unchanged contract, just renamed so the two
  // call sites (instant reactivate vs. confirm-gated deactivate) are clear.
  const performToggle = async (account, nextActive) => {
    setToggleErr(null);
    setBusyId(account.employee_id);
    try {
      const res = await fetch(`/api/users/${account.employee_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ active: nextActive }),
      });
      if (res.ok) {
        await loadAccounts();
        if (!nextActive) {
          pushToast({ tone: 'success', message: `Учётка «${account.display_name}» деактивирована.` });
        }
        return;
      }
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

  // T-0775: click-through — «Реактивировать» stays instant (safe/reversible-
  // by-nature, no confirm needed), «Деактивировать» opens ConfirmDialog first
  // (matches «Уволить» gating in rights/ra-intents.jsx). The PATCH itself only
  // fires from dc.confirm below, never from this handler directly.
  const toggleActive = (account, nextActive) => {
    if (nextActive) { performToggle(account, nextActive); return; }
    dc.request(account);
  };

  const deactivateTargetName = dc.target?.display_name || 'Выбранная учётка';

  const hasAccounts = Array.isArray(accounts) && accounts.length > 0;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--chs-space-6)', gap: 'var(--chs-space-6)' }}>
        <p style={{ fontSize: 'var(--chs-text-sm)', color: 'var(--chs-color-text-muted)', margin: 0, maxWidth: '88ch' }}>
          Учётки-пользователи тенанта. Каждая — логин и пароль для входа; создав учётку, сразу
          выдаётся право читать записи. Деактивация блокирует вход без удаления истории.
        </p>
        {canWrite && (
          <Button
            variant="primary" size="sm"
            glyph={<Icon name="plus" className="chs-btn__glyph" />}
            onClick={() => setCreateOpen(true)}
          >
            Создать учётку
          </Button>
        )}
      </div>

      {/* T-0628 (минор — /users прямым URL рядовому): не-владелец видит список
          (честное чтение), но контрол создания скрыт и заменён поясняющим
          баннером — тот же паттерн, что screen-org.jsx использует для
          create/delete-панели оргструктуры (T-0538/T-0409 admin zone). */}
      {!canWrite && (
        <div style={{ ...bannerErrStyle, background: 'var(--chs-color-surface-muted, var(--chs-color-surface))', borderColor: 'var(--chs-color-border)', color: 'var(--chs-color-text-muted)' }}>
          Создание и деактивация учёток доступны владельцу тенанта (или администратору с
          соответствующим грантом). Список ниже — только для чтения.
        </div>
      )}

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
          action={canWrite ? (
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              Создать учётку
            </Button>
          ) : undefined}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--chs-space-4)' }}>
          {accounts.map((a) => (
            <AccountRow
              key={a.employee_id}
              account={a}
              onToggleActive={toggleActive}
              busy={busyId === a.employee_id}
              canWrite={canWrite}
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

      {/* T-0775: same ConfirmDialog+ConsequenceSummary pattern as «Уволить»
          (rights/ra-intents.jsx) — «Деактивировать» is consequential (blocks
          login) so it now gets the same confirm gate, no bespoke dialog. */}
      <ConfirmDialog
        open={dc.open}
        tone="danger"
        title="Деактивировать учётку?"
        message={
          <ConsequenceSummary
            who={deactivateTargetName}
            what="Вход в систему будет заблокирован. Данные и история учётки сохраняются без изменений."
            reversibility="Обратимо — учётку можно реактивировать в любой момент кнопкой «Реактивировать»."
          />
        }
        confirmLabel="Деактивировать"
        loading={dc.loading}
        onConfirm={() => dc.confirm((account) => performToggle(account, false))}
        onClose={dc.cancel}
      />
    </div>
  );
}
