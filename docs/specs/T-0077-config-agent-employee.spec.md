# Spec · T-0077 — E11.6 · Системный config-агент = сотрудник

**Task:** T-0077 · E11.6 · build · parent = T-0070 (E11 named-binding / extensibility)
**Phase:** SPEC (analyst)
**Status:** ready
**Date:** 2026-06-11
**ADR источник:** `docs/design/extensibility-and-authoring.md` §4 (TWO-FLOOR) + §9 (day-1 гарды п.8)
**Migration slot:** 044 (зарезервирован)

---

## 0. Суть в одном абзаце

T-0077 устанавливает **governance-аппарат системного config-агента** — то, что ADR §4
называет «сотрудник в оргструктуре» (§3 CONCEPT): конкретную роль (`config-agent`),
набор MCP-инструментов authoring-класса, декларированных в `mcp_tool` с `resource_ops`
указывающими на `authoring_draft`, and budget-policy для ресурсного контроля. Сам агент
нанимается через существующий `POST /api/agents/hire` (T-0042), его toolset выбирается
через `resolveAgentToolset` (T-0043). Задача добавляет только то, чего нет: роль,
MCP-tool строки, DRAFT-boundary constraint, audit-event типы и migration 044 с
idempotent seed. Никакого нового authority-store, никакого нового права-subsystem.

**Граница «DRAFT-only»:** config-агент получает гранты с
`resource_type = 'authoring_draft'`, а не `authoring_published`. Promote из draft →
published — отдельный human-gate (не часть T-0077; scope-cut ниже).

---

## 1. Контекст и несущие инварианты (НЕ переопределяем)

| Уже построено | Где | T-0077 потребляет |
|---|---|---|
| `employee(kind='agent')` + `agent_card` | migrations/016, 032, T-0020 | hire-path; employee_id = identity |
| `mcp_tool(tenant_id, id, name, declares, resource_ops, …)` | migration/040, T-0043 | tool-rows для config-агента |
| `resolveAgentToolset(input, deps)` | src/core/mcp-tool-registry.ts | toolset = query по грантам |
| `agent hire POST /api/agents/hire` | src/http/agents.ts, T-0042 | config-агент нанимается через него |
| invoke-grant / `invoke_proposal` | migration/043, T-0024 | нотация грантов authoring_draft |
| `instance_budget` / `agent_budget` | migration/034, T-0023 | budget_policy_id на agent_card |
| `appendAuditEvent(tx, input)` | src/db/audit-writer.ts, T-0031 | аудит authoring-событий |
| grant-lattice / resolveFor | src/core/grant-lattice.ts, T-0018/T-0021 | права read/create/update на authoring_draft |

Ни один из файлов выше T-0077 **не редактирует логику**. Все изменения строго аддитивны:
новые строки в seed-миграции, новые `mcp_tool`-строки, новый role-row.

---

## 2. Функциональные требования

### FR-1 — Роль `config-agent` в dev-silo seed

В migration 044 должна быть idempotent-вставка строки в таблицу `choros.role`
(`ON CONFLICT DO NOTHING`), создающая роль с фиксированным dev-UUID
(`e0000000-0000-0000-0000-000000000003` — следующий свободный в namespace `e0`, где
`e0...001` = tenant-owner, `e0...002` = budget-approver из migration 019),
`slug = 'config-agent'`, `display_name = 'Config Agent'`,
`tenant_id = 'a0000000-0000-0000-0000-000000000001'` (DEV_TENANT_UUID).

### FR-2 — MCP-tool строки в `choros.mcp_tool` (7 инструментов day-1)

Migration 044 seed вставляет 7 строк `mcp_tool` (`ON CONFLICT DO NOTHING`) для
dev-tenant. Каждая строка: `declares = '[]'::jsonb` (чистые write-ops над внутренним
объектом; внешние effect-ресурсы не задействованы, `pure_compute = true`),
`resource_ops` = массив `{resourceType: 'authoring_draft', operation: <op>}` согласно
ADR §4.

| name | resource_ops.operation | Назначение |
|---|---|---|
| `emit_form_code` | `create` | Создать Floor-2 React-компонент в draft |
| `edit_jsonschema` | `update` | Обновить JSON Schema в draft |
| `author_dmn` | `create` | Создать/обновить DMN-таблицу в draft |
| `scaffold_external_worker` | `create` | Сгенерировать external-task worker в draft |
| `write_object_migration` | `create` | Создать объектную миграцию в draft |
| `open_draft_branch` | `create` | Открыть draft-ветку для правок |
| `request_promote` | `update` | Запросить promote draft → published (human-gated) |

Все 7 инструментов: `pure_compute = true` (нет external `effect_resource`-зависимостей);
`resource_ops` содержит только ресурс типа `authoring_draft` — агент физически не может
получить инструменты, достигающие `authoring_published`, через эти строки.

### FR-3 — Grant-строки для роли `config-agent` в dev-seed

Migration 044 вставляет в `choros."grant"` 7 строк: по одной на каждый `mcp_tool`
(resource_type = `'authoring_draft'`, operation = соответствующая из FR-2,
scope = `{kind:'node', hierarchy:'org', nodeId: '<root>', nodeLevel: 'org'}`,
`delegable = false`). Все гранты привязаны к роли `config-agent`.

> **Примечание:** `authoring_draft` — новое значение `resource_type`. Так же как
> T-0024 использует `'agent'` через существующий TEXT-столбец без правки TS-union,
> T-0077 пишет `'authoring_draft'` в DB. TS-union `ResourceType` (grant-lattice.ts)
> НЕ редактируется (frozen seam). Cast происходит на HTTP-boundary, тот же паттерн,
> что grants.ts L531.

### FR-4 — Гранты роли `config-agent` в `role_assignment` для dev-seed config-агента

Migration 044 создаёт одного seed-агента (`employee_id` с фиксированным
dev-UUID = `d0000000-0000-0000-0000-000000000013` — следующий свободный в namespace `d0`,
после `d0...012` = s-ocr из migration 016, `slug = 'config-agent-seed'`,
`kind = 'agent'`, `position_id = NULL`) и назначает ему роль `config-agent`
(`role_assignment` строка).

### FR-5 — `agent_card` seed-агента заполнен, `budget_policy_id` привязан

Migration 044 вставляет `agent_card` для seed-агента (`employee_id = d0...013`)
с `kc_client_id = 'agent-config'`;
`budget_policy_id` ссылается на существующую dev `instance_budget`
(`b0000000-0000-0000-0000-000000000001` из migration 034). Остальные LLM-поля — NULL
(dormant, per T-0020).

### FR-6 — DRAFT-boundary: ресурс `authoring_draft` ≠ `authoring_published`

Не существует ни одного гранта для роли `config-agent`, дающего доступ к
`resource_type = 'authoring_published'`. Это физическое, а не конфигурационное
ограничение: promote требует отдельного human-gate, который не является частью T-0077.
`resolveAgentToolset` для config-агента вернёт только инструменты с `authoring_draft`
в `resource_ops`.

### FR-7 — Audit-event types для authoring-действий config-агента

`appendAuditEvent` (канонический sink, T-0031) принимает `type` как free-form string.
Authoring-события config-агента используют типы `"authoring.form_code.emitted"`,
`"authoring.jsonschema.edited"`, `"authoring.dmn.authored"`, …, `"authoring.promote.requested"`.
**T-0077 не реализует логику самих MCP-tools** (как generate React-код) — это отдельные задачи E11.x. T-0077 только объявляет типы в ADR и contract как frozen seam.

### FR-8 — `resolveAgentToolset` возвращает 7 инструментов для seed-агента

Для seed config-агента (с role = `config-agent`, `role_assignment` = dev seed)
`resolveAgentToolset({tenantId, employeeId: config-agent-seed, nowMs})` возвращает
массив из 7 `McpToolRow`. Это верифицируется unit-тестом (AC-06).

### FR-9 — Ноль инструментов у свеженанятого config-агента без роли

Если нанять нового `employee(kind='agent')` без `role_assignment`, `resolveAgentToolset`
вернёт `[]`. Это уже гарантировано T-0043, но AC-07 добавляет assertion для
`authoring_draft` resource_ops специально.

### FR-10 — Аддитивность: заморожённые файлы не редактируются

`src/core/grant-lattice.ts`, `src/core/grant-resolver.ts`,
`src/core/mcp-tool-registry.ts`, `src/http/agents.ts`, `src/http/grants.ts`,
`src/db/audit-writer.ts` — **не редактируются** этой задачей. Любое изменение в них
= нарушение frozen-file invariant.

---

## 3. Нефункциональные требования

### NF-1 — Нет нового authority-store

T-0077 не добавляет новых таблиц для хранения прав config-агента. Гранты идут через
`choros."grant"` (T-0018), toolset — через `resolveAgentToolset` (T-0043),
audit — через `appendAuditEvent` (T-0031). Один control plane.

### NF-2 — Нет нового TS-модуля дня-1

T-0077 — чисто DDL + seed задача. Ноль новых `.ts` файлов в `src/`. Единственный
источник TS-кода — fitness/тесты в `__tests__/`.

### NF-3 — Идемпотентность seed

Каждый `INSERT` в migration 044 использует `ON CONFLICT DO NOTHING`. Двойной запуск
`migrations/run.mjs` не изменяет данные и завершается без ошибки.

### NF-4 — RLS-изоляция на mcp_tool и grant

Seed-строки `mcp_tool` и `grant` принадлежат dev-tenant и изолированы per FORCE RLS
(T-0013). Cross-tenant запрос из другого tenant возвращает 0 строк.

### NF-5 — Граница dormancy

Таблица `mcp_tool` была dormant в T-0043 (только DDL). T-0077 добавляет seed-данные
и unit-тест `resolveAgentToolset`. Runtime вызов `resolveAgentToolset` из HTTP-роутов
остаётся за пределами T-0077 (E11.x).

### NF-6 — Migration number discipline

T-0077 владеет только слотом **044**. Слоты 041/042/043 не трогаются.

---

## 4. Out of scope (с указанием будущих задач)

| Что НЕ входит | Почему | Где |
|---|---|---|
| Реализация `emit_form_code` как генератора React-кода | Это логика самого authoring-инструмента | E11.x (отдельные задачи) |
| Реализация `edit_jsonschema`, `author_dmn` и остальных tools | То же | E11.x |
| Promote draft → published (human-gate) | Separate human-gate workflow; вне E11.6 ADR | E11.y |
| BYO-LLM интеграция (llm_endpoint / secret_handle) | E5.5/T-0025 | T-0025 |
| Autonomy-threshold routing | E5.6/E5.7 | Stage-2 |
| HTTP-эндпоинт для authoring-invoke | Invoke stub exists (T-0024); live dispatch = out | T-0024 dispatch-phase |
| Production Keycloak client для config-агента | Founder-gated GT-4/RL-1 | T-0042 prod wire |
| `authoring_published` resource_type гранты | Human-only promote, вне T-0077 | E11.y |
| Физические draft-branch git-объекты | git-под-капотом Machine = Stage-2 | ADR §7 |
| T-0077 не создаёт real `authoring_draft` DB-table | Это content-tier, не tenant-table | E11.3+ |

---

## 5. Acceptance Criteria

### AC-01 — Роль `config-agent` существует в dev-silo после migration 044

**Verifiable:** fitness
```
SELECT slug FROM choros.role
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND id = 'e0000000-0000-0000-0000-000000000003';
-- должен вернуть одну строку slug='config-agent'
```

### AC-02 — 7 mcp_tool-строк существуют с правильными resource_ops

**Verifiable:** fitness
```
SELECT name FROM choros.mcp_tool
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND resource_ops @> '[{"resourceType":"authoring_draft"}]'::jsonb;
-- должен вернуть 7 строк: emit_form_code, edit_jsonschema, author_dmn,
-- scaffold_external_worker, write_object_migration, open_draft_branch, request_promote
```

### AC-03 — pure_compute = true для всех 7 инструментов

**Verifiable:** fitness
```
SELECT count(*) FROM choros.mcp_tool
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND resource_ops @> '[{"resourceType":"authoring_draft"}]'::jsonb
  AND pure_compute = false;
-- должен вернуть 0
```

### AC-04 — 7 grant-строк с resource_type='authoring_draft' привязаны к роли config-agent

**Verifiable:** fitness
```
SELECT count(*) FROM choros."grant"
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND resource_type = 'authoring_draft'
  AND role_id = 'e0000000-0000-0000-0000-000000000003';
-- должен вернуть 7
```

### AC-05 — Нет гранта с resource_type='authoring_published' для роли config-agent

**Verifiable:** fitness
```
SELECT count(*) FROM choros."grant"
WHERE tenant_id = 'a0000000-0000-0000-0000-000000000001'
  AND resource_type = 'authoring_published'
  AND role_id = 'e0000000-0000-0000-0000-000000000003';
-- должен вернуть 0
```

### AC-06 — `resolveAgentToolset` возвращает 7 инструментов для seed config-агента

**Verifiable:** test
Unit-тест `src/__tests__/config-agent-toolset.test.ts`:
Вызов `resolveAgentToolset({tenantId: 'a0000000-0000-0000-0000-000000000001',
employeeId: 'd0000000-0000-0000-0000-000000000013', nowMs})`
с grant-source и tool-source, заполненными seed-данными из migration 044, возвращает
массив длины 7. Каждый элемент — `McpToolRow` с `resourceOps[0].resourceType === 'authoring_draft'`.

### AC-07 — `resolveAgentToolset` возвращает [] для агента без роли

**Verifiable:** test
Unit-тест: `resolveAgentToolset` для fresh employee без role_assignment → `[]`.
Это уже верно из T-0043, но тест явно проверяет с `authoring_draft` resource_ops.

### AC-08 — Ни один инструмент config-агента не достигает authoring_published

**Verifiable:** test
Unit-тест: для toolset из AC-06 ни один `McpToolRow.resourceOps` не содержит
`{resourceType: 'authoring_published'}`.

### AC-09 — Migration 044 идемпотентна

**Verifiable:** fitness
`migrations/run.mjs` запускается дважды на чистой схеме: первый запуск применяет 044,
второй — «nothing to apply». Счёт строк в role/mcp_tool/grant остаётся прежним.

### AC-10 — Frozen files не изменены

**Verifiable:** fitness
```bash
git diff --exit-code <dev-base> -- \
  src/core/grant-lattice.ts \
  src/core/grant-resolver.ts \
  src/core/mcp-tool-registry.ts \
  src/http/agents.ts \
  src/http/grants.ts \
  src/db/audit-writer.ts
```
Выход 0.

### AC-11 — Ноль новых .ts файлов в src/ (не считая __tests__)

**Verifiable:** fitness
```bash
git diff --name-only <dev-base> -- 'src/**/*.ts' | grep -v '__tests__'
-- должен вернуть 0 строк (или только файлы в __tests__)
```

### AC-12 — RLS: cross-tenant запрос к mcp_tool с authoring_draft возвращает 0

**Verifiable:** test
Тест устанавливает `SET LOCAL choros.tenant_id = '<other-tenant>'` и делает
`SELECT * FROM choros.mcp_tool WHERE resource_ops @> '[{"resourceType":"authoring_draft"}]'::jsonb`
— возвращает 0 строк.

### AC-13 — `agent_card` seed-агента имеет budget_policy_id, ссылающийся на instance_budget

**Verifiable:** fitness
```sql
SELECT ac.budget_policy_id FROM choros.agent_card ac
JOIN choros.instance_budget ib ON (ac.tenant_id = ib.tenant_id AND ac.budget_policy_id = ib.id)
WHERE ac.employee_id = 'd0000000-0000-0000-0000-000000000013';
-- должен вернуть одну строку (не null)
```

### AC-14 — Migration number: только 044 затронут, 041/042/043 не изменены

**Verifiable:** fitness
```bash
git diff --name-only <dev-base> -- migrations/ | grep -E '^migrations/04[123]_'
-- должен вернуть 0 строк
ls migrations/044_*.sql   # должен существовать ровно один файл
```

### AC-15 — Audit-event types задокументированы в ADR (frozen seam)

**Verifiable:** manual
ADR (`docs/design/extensibility-and-authoring.md` или этот spec) содержит список
`authoring.*` event-типов. Этот список используется E11.x tasks как contract.

---

## 6. Шов-контракт (migration 044)

**Файл:** `migrations/044_config_agent_seed.sql`

Порядок DDL/DML внутри одного транзакционного файла (`run.mjs` применяет как один блок):

1. INSERT в `choros.role`: роль `config-agent`,
   `id = 'e0000000-0000-0000-0000-000000000003'`, dev-seed, `ON CONFLICT DO NOTHING`.
2. INSERT в `choros.employee`: seed config-агент
   `id = 'd0000000-0000-0000-0000-000000000013'`, `kind='agent'`, `position_id=NULL`
   (`ON CONFLICT DO NOTHING`).
3. INSERT в `choros.agent_card`: `employee_id = d0...013`, `kc_client_id='agent-config'`,
   `budget_policy_id = b0000000-0000-0000-0000-000000000001` (ref → instance_budget),
   LLM fields NULL (`ON CONFLICT DO NOTHING`).
4. INSERT в `choros.role_assignment`: роль `e0...003` → employee `d0...013`
   (`ON CONFLICT DO NOTHING`).
5. 7× INSERT в `choros.mcp_tool` (имена из FR-2, stable UUID-PKs с prefix `10...004`..`00a`
   — после существующих `10...001/002/003` из migration 040;
   `declares='[]'`, `pure_compute=true`,
   `resource_ops=[{resourceType:'authoring_draft', operation:'<op>'}]`)
   (`ON CONFLICT DO NOTHING`).
6. 7× INSERT в `choros."grant"` (resource_type='authoring_draft', одна строка на tool,
   `role_id = 'e0000000-0000-0000-0000-000000000003'`,
   scope = dev-root org node (паттерн из migration 026: `{kind:'node', hierarchy:'org',
   nodeId:'b0000000-0000-0000-0000-000000000001', nodeLevel:'department'}`),
   `delegable=false`, stable UUID-PKs с prefix `e2...001`..`007`)
   (`ON CONFLICT DO NOTHING`).

**Новые tenant-таблицы НЕ создаются.** `known_tenant_tables.txt` — не меняется.
Migration 044 — ТОЛЬКО data-seed поверх существующей схемы.

---

## 7. Открытые вопросы / не-блокирующие развилки

Нет BLOCKING-вопросов к фаундеру. Следующие точки отмечены как design-owned (архитектор
разрешает автономно):

1. **Stable UUID-prefix для `mcp_tool` и `grant` seed-строк.** Использовать `e0...001..007`
   для tools и `f0...001..007` для grants — архитектор фиксирует в ADR.
2. **Scope dev-root org node для грантов.** Нужен `nodeId` корневого org-узла dev-silo.
   Архитектор читает из migration 016/017 seed данных и использует без эскалации.
3. **`role_assignment` schema.** Нужна проверка точной сигнатуры таблицы
   `role_assignment(tenant_id, id, employee_id, role_id, …)` в migration 020 — архитектор
   читает и использует.

---

## 8. Граница задачи (scope-summary)

T-0077 = **governance-аппарат** (роль + гранты + mcp_tool-объявления + seed-агент +
budget-link). Он НЕ:
- не пишет authoring-логику (E11.x),
- не wire-ит HTTP вызов config-агента (T-0024 dispatch),
- не создаёт git-механику (ADR §7 инкрементально),
- не делает promote workflow (E11.y).

После T-0077 dev-сило содержит config-агента, который при вызове `resolveAgentToolset`
получит 7 authoring-инструментов, ограниченных `authoring_draft`. Любой produce-вызов
этих инструментов (реализация E11.x) будет governance-верифицирован через существующие
T-0043 / T-0021 механизмы без изменения их кода.
