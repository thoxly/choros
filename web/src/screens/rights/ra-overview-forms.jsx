/* ============================================================================
   CHOROS — ra-overview-forms.jsx  (T-0572, FR-2/FR-3/FR-4/FR-7)

   Выдача/отзыв роли сотруднику и выдача/отзыв гранта роли — из «Обзора ролей».
   НИКАКОГО нового write-эндпоинта: формы бьют СТРОГО в существующие
     POST /api/role-assignments(/:id/revoke)
     POST /api/grants(/:id/revoke)
   Scope формируется как ScopeElement JSON, принимаемый существующим
   parseScopeElement (src/http/grants.ts) — node (org-дерево)/tags/set день-1
   (FR-4; interval/record-level К1-сценарий вне периметра).

   Формы монтируются ТОЛЬКО когда canManage===true (FR-7): при false родитель
   (screen-rights.jsx) их вообще не рендерит — компонент отсутствует в DOM,
   а не просто задизейблен (AC-9).

   Честный semi-confirmed рендеринг (FR-5/NF-2, образец ra-criticality.jsx):
   ответ {state:"semi-confirmed"} НЕ показывается как активное право — тост
   сообщает «ждёт второго подтверждения» со ссылкой на существующий инбокс
   /rights/criticality. Ни один путь здесь не отключает dual-control — нет
   UI-флага, который звал бы POST с обходом dualControlDecision-гейта.
   ============================================================================ */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Select, StatusChip, ConfirmDialog, LoadingState } from '../../components/components.jsx';
import { useToastContext } from '../../app-shell/toast-context.jsx';
import { authHeaders } from '../../app-shell/dev-auth.js';
import { formatPersonName } from '../../lib/format.js';

// ---------------------------------------------------------------------------
// Write helpers — each hits exactly ONE existing endpoint (AC-4/AC-5/AC-6).
//
// `granted_by` is a PROVENANCE LABEL only — it confers no authority (the
// server derives the authoritative confirmed_by from the authenticated actor,
// never from the request body, R-AUTH). The tenant-state response does not
// (and need not) expose the caller's own slug for this purpose, so the UI
// stamps a fixed, honest label identifying the write's origin.
// ---------------------------------------------------------------------------

const UI_GRANTED_BY = 'ui:rights-overview';

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = json?.error?.code ?? `HTTP ${res.status}`;
    const message = json?.error?.message ?? code;
    throw new Error(message);
  }
  return json;
}

/** Assign a role to an employee — POST /api/role-assignments (AC-4). */
function assignRole({ employeeId, roleId, orgScope, grantedBy }) {
  return postJson('/api/role-assignments', {
    employee_id: employeeId,
    role_id: roleId,
    org_scope: orgScope,
    source: 'manual',
    granted_by: grantedBy,
  });
}

/** Revoke a role assignment — POST /api/role-assignments/:id/revoke (AC-6). */
function revokeAssignment(id) {
  return postJson(`/api/role-assignments/${encodeURIComponent(id)}/revoke`, {});
}

/** Grant a right to a role — POST /api/grants (AC-5). */
function grantRight({ roleId, resourceType, operation, scope, grantedBy }) {
  return postJson('/api/grants', {
    role_id: roleId,
    resource_type: resourceType,
    operation,
    scope,
    granted_by: grantedBy,
  });
}

/** Revoke a grant — POST /api/grants/:id/revoke (AC-6). */
function revokeGrant(id) {
  return postJson(`/api/grants/${encodeURIComponent(id)}/revoke`, {});
}

// ---------------------------------------------------------------------------
// Scope builder — day-1 palette: node (org tree) | tags | set (FR-4).
// Emits a ScopeElement JSON body accepted by the existing parseScopeElement
// (AC-14) — no parallel client-side scope format.
// ---------------------------------------------------------------------------

function ScopePicker({ dictionaries, value, onChange }) {
  const mode = value?.kind === 'tags' ? 'tags' : 'node';
  const orgTree = dictionaries?.orgTree ?? [];
  const scopeTags = dictionaries?.scopeTags ?? [];

  const setNode = (nodeId) => {
    if (!nodeId) { onChange(null); return; }
    onChange({ kind: 'node', hierarchy: 'org', nodeId, nodeLevel: 'department' });
  };
  const setTags = (tags) => {
    onChange({ kind: 'tags', tags });
  };

  return (
    <div className="chs-ov-scope">
      <Select
        label="Тип охвата"
        value={mode}
        onChange={(e) => {
          if (e.target.value === 'tags') setTags([]);
          else setNode('');
        }}
        options={[
          { value: 'node', label: 'Узел оргструктуры' },
          { value: 'tags', label: 'Теги' },
        ]}
      />
      {mode === 'node' && (
        <Select
          label="Узел"
          value={value?.nodeId ?? ''}
          onChange={(e) => setNode(e.target.value)}
          placeholder="Выберите узел…"
          options={orgTree.map((n) => ({ value: n.id, label: n.label }))}
          hint={orgTree.length === 0
            ? 'Дерево оргструктуры недоступно — выберите охват тегами или обновите страницу.'
            : undefined}
        />
      )}
      {mode === 'tags' && (
        <div className="chs-ov-scope__tags">
          {scopeTags.length === 0 && (
            <span className="chs-hint">Теги охвата не настроены — справочник пуст или недоступен.</span>
          )}
          {scopeTags.map((t) => {
            const checked = (value?.tags ?? []).includes(t.id);
            return (
              <label key={t.id} className="chs-ov-scope__tag">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const cur = value?.tags ?? [];
                    setTags(checked ? cur.filter((x) => x !== t.id) : [...cur, t.id]);
                  }}
                />
                {t.label}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AssignRoleForm (FR-2) — назначить роль сотруднику.
// ---------------------------------------------------------------------------

function AssignRoleForm({ roles, employees, dictionaries, sourcesLoading = false, onDone }) {
  const [employeeId, setEmployeeId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState(null);
  const [busy, setBusy] = useState(false);
  const { push: pushToast } = useToastContext();
  // T-0597 (находка №5): «Список сотрудников пуст» получает кликабельный выход
  // в «Оргструктуру» вместо тупика — путь /org уже используется тем же способом
  // на screen-overview.jsx (плитка «Оргструктура») и зарегистрирован в shell.jsx.
  const navigate = useNavigate();

  const canSubmit = employeeId && roleId && scope;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const result = await assignRole({ employeeId, roleId, orgScope: scope, grantedBy: UI_GRANTED_BY });
      if (result.state === 'semi-confirmed') {
        pushToast({
          tone: 'info',
          title: 'Назначение ждёт второго подтверждения',
          message: 'Критичное изменение требует ещё одного подтверждающего — см. вкладку «Критичность».',
        });
      } else {
        pushToast({ tone: 'success', message: 'Роль назначена.' });
      }
      setEmployeeId(''); setRoleId(''); setScope(null);
      onDone && onDone();
    } catch (err) {
      pushToast({ tone: 'error', message: err.message ?? 'Не удалось назначить роль.' });
    } finally {
      setBusy(false);
    }
  };

  // UX_REVIEW F-4: «ещё грузится» отличимо от «справочник пуст».
  if (sourcesLoading) {
    return <LoadingState compact label="Загрузка справочников…" />;
  }

  return (
    <form className="chs-ov-form" onSubmit={handleSubmit}>
      <Select
        label="Сотрудник"
        value={employeeId}
        onChange={(e) => setEmployeeId(e.target.value)}
        placeholder="Выберите сотрудника…"
        // T-0608 (пункт г): GET /api/org/tenant-state now selects display_name
        // (was id+slug only) — an employee whose slug happens to be a raw
        // Keycloak-user UUID (every KC-registered human: slug==sub) no longer
        // renders as that UUID when a real display_name exists. formatPersonName
        // falls back to «Без имени» (no secondary identifier is available at
        // this layer — employee carries no email column) rather than silently
        // showing nothing; the slug remains the LAST-resort fallback (never
        // hides the row entirely).
        options={(employees ?? []).map((e) => ({
          value: e.id,
          label: formatPersonName(e.display_name) || e.slug,
        }))}
        hint={(employees ?? []).length === 0
          ? (
            <>
              Список сотрудников пуст — заведите сотрудников в разделе «Оргструктура»
              или обновите страницу.{' '}
              <button
                type="button"
                className="chs-link-button"
                onClick={() => navigate('/org')}
                style={{
                  background: 'none', border: 'none', padding: 0, margin: 0,
                  font: 'inherit', color: 'var(--chs-color-accent)',
                  textDecoration: 'underline', cursor: 'pointer',
                }}
              >
                Открыть оргструктуру
              </button>
            </>
          )
          : undefined}
      />
      <Select
        label="Роль"
        value={roleId}
        onChange={(e) => setRoleId(e.target.value)}
        placeholder="Выберите роль…"
        options={(roles ?? []).map((r) => ({ value: r.id, label: r.name || r.slug }))}
      />
      <ScopePicker dictionaries={dictionaries} value={scope} onChange={setScope} />
      <Button type="submit" variant="primary" size="sm" disabled={!canSubmit} loading={busy}>
        Назначить роль
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// GrantRightForm (FR-3) — дать роли право.
// ---------------------------------------------------------------------------

function GrantRightForm({ roles, dictionaries, sourcesLoading = false, onDone }) {
  const [roleId, setRoleId] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [operation, setOperation] = useState('');
  const [scope, setScope] = useState(null);
  const [busy, setBusy] = useState(false);
  const { push: pushToast } = useToastContext();

  const resources = dictionaries?.resources ?? [];
  const operations = dictionaries?.operations ?? [];

  const canSubmit = roleId && resourceType && operation && scope;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const result = await grantRight({ roleId, resourceType, operation, scope, grantedBy: UI_GRANTED_BY });
      if (result.state === 'semi-confirmed') {
        pushToast({
          tone: 'info',
          title: 'Право ждёт второго подтверждения',
          message: 'Критичное изменение требует ещё одного подтверждающего — см. вкладку «Критичность».',
        });
      } else {
        pushToast({ tone: 'success', message: 'Право выдано.' });
      }
      setRoleId(''); setResourceType(''); setOperation(''); setScope(null);
      onDone && onDone();
    } catch (err) {
      pushToast({ tone: 'error', message: err.message ?? 'Не удалось выдать право.' });
    } finally {
      setBusy(false);
    }
  };

  // UX_REVIEW F-4: «ещё грузится» отличимо от «справочник пуст».
  if (sourcesLoading) {
    return <LoadingState compact label="Загрузка справочников…" />;
  }

  return (
    <form className="chs-ov-form" onSubmit={handleSubmit}>
      <Select
        label="Роль"
        value={roleId}
        onChange={(e) => setRoleId(e.target.value)}
        placeholder="Выберите роль…"
        options={(roles ?? []).map((r) => ({ value: r.id, label: r.name || r.slug }))}
      />
      <Select
        label="Ресурс"
        value={resourceType}
        onChange={(e) => setResourceType(e.target.value)}
        placeholder="Выберите ресурс…"
        options={resources.map((r) => ({ value: r.uri, label: r.name }))}
        hint={resources.length === 0
          ? 'Справочник ресурсов недоступен — обновите страницу.'
          : undefined}
      />
      <Select
        label="Операция"
        value={operation}
        onChange={(e) => setOperation(e.target.value)}
        placeholder="Выберите операцию…"
        options={operations.map((op) => ({ value: op, label: op }))}
        hint={operations.length === 0
          ? 'Справочник операций недоступен — обновите страницу.'
          : undefined}
      />
      <ScopePicker dictionaries={dictionaries} value={scope} onChange={setScope} />
      <Button type="submit" variant="primary" size="sm" disabled={!canSubmit} loading={busy}>
        Выдать право
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// RevokeAssignmentButton / RevokeGrantButton — FR-2/FR-3 revoke path.
// UX_REVIEW F-3 (principles §4: опасное действие = осознанное подтверждение):
// отзыв деструктивен — клик открывает kit ConfirmDialog (образец
// screen-org.jsx pendingDelete), НЕ window.confirm и НЕ одноклик-revoke.
// ---------------------------------------------------------------------------

// T-0608 (F-1 fix, review+ux blocking): `id` (single) OR `ids` (array) of the
// role_assignment rows to revoke. Per the schema invariant (migrations/020_
// role_assignment.sql:29-32: NO UNIQUE(employee_id, role_id)), the caller
// (screen-rights.jsx dedupAssignments) groups ONLY TRUE duplicates (identical
// employee + org_scope + validity window) into one row — so `ids` here is
// exactly one SCOPE's worth of assignments (usually a single id; >1 only when
// the SAME scope was accidentally assigned twice). Differently-scoped
// assignments are SEPARATE holder rows with SEPARATE Revoke buttons, so this
// never revokes a scope the admin did not intend.
//
// `scopeLabel` (plain string from scopeText) names the exact scope in the
// ConfirmDialog — so «Отозвать» tells the admin WHICH scope goes, never a bare
// name that could hide that a person has other scopes still standing.
function RevokeAssignmentButton({ id, ids, subjectLabel = '', scopeLabel = '', onDone }) {
  const targetIds = ids && ids.length > 0 ? ids : (id ? [id] : []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { push: pushToast } = useToastContext();
  const handleConfirm = async () => {
    setBusy(true);
    try {
      // Sequential, not Promise.all: keeps the toast/error attributable to a
      // stable order and avoids concurrent writes against the same tenant tx
      // pool for the rare (>1) identical-scope-assigned-twice case.
      for (const targetId of targetIds) {
        await revokeAssignment(targetId);
      }
      pushToast({ tone: 'success', message: 'Назначение отозвано.' });
      setConfirmOpen(false);
      onDone && onDone();
    } catch (err) {
      pushToast({ tone: 'error', message: err.message ?? 'Не удалось отозвать назначение.' });
    } finally {
      setBusy(false);
    }
  };
  // Message names BOTH the person AND the scope — so the admin sees exactly
  // which assignment (which охват) is being revoked, and that other scopes of
  // the same person are untouched.
  const who = subjectLabel ? `у: ${subjectLabel}` : 'это назначение';
  const scopeClause = scopeLabel ? ` (охват: ${scopeLabel})` : '';
  const message = subjectLabel
    ? `Отозвать роль ${who}${scopeClause}? Доступ по этому назначению пропадёт сразу; другие охваты этого человека сохранятся.`
    : `Отозвать это назначение${scopeClause}? Доступ по нему пропадёт сразу.`;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>Отозвать</Button>
      <ConfirmDialog
        open={confirmOpen}
        tone="danger"
        title="Отозвать роль?"
        message={message}
        confirmLabel="Отозвать"
        cancelLabel="Отмена"
        loading={busy}
        onConfirm={handleConfirm}
        onClose={() => { if (!busy) setConfirmOpen(false); }}
      />
    </>
  );
}

function RevokeGrantButton({ id, subjectLabel = '', onDone }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { push: pushToast } = useToastContext();
  const handleConfirm = async () => {
    setBusy(true);
    try {
      await revokeGrant(id);
      pushToast({ tone: 'success', message: 'Право отозвано.' });
      setConfirmOpen(false);
      onDone && onDone();
    } catch (err) {
      pushToast({ tone: 'error', message: err.message ?? 'Не удалось отозвать право.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>Отозвать</Button>
      <ConfirmDialog
        open={confirmOpen}
        tone="danger"
        title="Отозвать право?"
        message={subjectLabel
          ? `Отозвать право «${subjectLabel}» у роли? Оно перестанет действовать сразу.`
          : 'Отозвать это право у роли? Оно перестанет действовать сразу.'}
        confirmLabel="Отозвать"
        cancelLabel="Отмена"
        loading={busy}
        onConfirm={handleConfirm}
        onClose={() => { if (!busy) setConfirmOpen(false); }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// PendingBadge — честный маркер «ждёт подтверждения» (AC-7/AC-8): рендерится
// в ОТДЕЛЬНОМ визуальном контейнере от действующих прав, никогда смешан с ними.
// ---------------------------------------------------------------------------

function PendingBadge() {
  return <StatusChip status="waiting" label="Ждёт подтверждения" />;
}

export {
  AssignRoleForm,
  GrantRightForm,
  RevokeAssignmentButton,
  RevokeGrantButton,
  PendingBadge,
  ScopePicker,
};
