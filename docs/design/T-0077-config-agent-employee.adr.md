# ADR · T-0077 — E11.6 · Системный config-агент = сотрудник

**Task:** T-0077 · E11.6 · build · parent = T-0070 · phase = DESIGN (architect)
**Status:** ready
**Date:** 2026-06-11
**Spec источник:** `docs/specs/T-0077-config-agent-employee.spec.md` (15 AC)
**ADR-родитель:** `docs/design/extensibility-and-authoring.md` §4 (TWO-FLOOR), §9.8 (day-1 гарды)
**Migration slot:** 044 (только data-seed; `known_tenant_tables.txt` НЕ меняется)

---

## 1. Decision (суть)

T-0077 материализует **governance-аппарат** системного config-агента как
первоклассного сотрудника (ADR §4: «сотрудник в оргструктуре») **исключительно
через data-seed migration 044** поверх уже построенной схемы. Ноль новых
TS-модулей в `src/`, ноль правок frozen-файлов, ноль новых таблиц.

Migration 044 в **одном транзакционном файле** (run.mjs применяет файл целиком
в одной транзакции) делает 6 идемпотентных шагов в порядке FK-зависимостей:

1. `role` — роль `config-agent`, `id = e0000000-…-000000000003`, dev-tenant
   `a0000000-…-000000000001` (namespace `e0`, после `e0…001` tenant-owner,
   `e0…002` budget-approver). ON CONFLICT DO NOTHING (idemp-ключ = PK или
   UNIQUE(tenant_id, slug)).
2. `employee` — seed config-агент, `id = d0000000-…-000000000013`, `kind='agent'`,
   `position_id=NULL`, `slug='config-agent-seed'`. ON CONFLICT DO NOTHING.
3. `agent_card` — `employee_id = d0…013`, `kc_client_id='agent-config'`,
   `budget_policy_id = b0000000-…-000000000001` (→ existing dev `instance_budget`,
   FK `agent_card_budget_policy_fk` из migration 034 §3.5), LLM-поля NULL (dormant).
   ON CONFLICT DO NOTHING.
4. `role_assignment` — связка `config-agent` (`e0…003`) → `d0…013`, `org_scope` =
   корневой org-узел dev-silo, **`confirmed_by` NOT NULL** (иначе assignment =
   «proposal» и НЕ даёт грантов — migration 020 контракт). ON CONFLICT DO NOTHING.
5. 7× `mcp_tool` — `declares='[]'::jsonb`, `pure_compute=true`,
   `resource_ops='[{"resourceType":"authoring_draft","operation":<op>}]'::jsonb`,
   фиксированные PK `10000000-…-000000000004`..`00a` (после `10…001/002/003` из 040).
   ON CONFLICT DO NOTHING.
6. 7× `"grant"` — `resource_type='authoring_draft'`, `operation` соответствует
   каждому tool, `role_id=e0…003`, `scope` = корневой org-узел, `delegable=false`,
   фиксированные PK `e2000000-…-000000000001`..`007`. ON CONFLICT DO NOTHING.

**DRAFT-граница — структурная, не конфигурационная.** Роль `config-agent` НЕ
получает НИ ОДНОГО гранта с `resource_type='authoring_published'`. `resolveAgentToolset`
вернёт только инструменты, чьи `resource_ops` целиком покрыты грантами
`authoring_draft`. Promote draft→published — отдельный human-gate (E11.y), вне T-0077.

7 инструментов и их операции (ADR §4 строка 139):

| mcp_tool name | operation | назначение |
|---|---|---|
| `emit_form_code` | `create` | Floor-2 React-компонент в draft |
| `edit_jsonschema` | `update` | JSON Schema в draft |
| `author_dmn` | `create` | DMN-таблица в draft |
| `scaffold_external_worker` | `create` | external-task worker в draft |
| `write_object_migration` | `create` | объектная миграция в draft |
| `open_draft_branch` | `create` | draft-ветка |
| `request_promote` | `update` | запрос promote (human-gated) |

**Audit event-типы (frozen seam для E11.x, FR-7, AC-15)** — `appendAuditEvent`
принимает `type` как free-form string; T-0077 фиксирует словарь, НЕ реализует логику:
`authoring.form_code.emitted`, `authoring.jsonschema.edited`, `authoring.dmn.authored`,
`authoring.external_worker.scaffolded`, `authoring.object_migration.written`,
`authoring.draft_branch.opened`, `authoring.promote.requested`.

---

## 2. Структурная совместимость seed ↔ runtime (authority-чувствительные проверки)

### 2.1 `resource_ops`/`declares` jsonb байт-в-байт совместимы с `resolveAgentToolset`

`src/core/mcp-tool-registry.ts` ожидает `McpToolRow.resourceOps: ResourceOp[]`, где
`ResourceOp = { resourceType, operation }` (camelCase ключи). DB-DAO (T-0053, ещё не
живой) маппит jsonb→строки; **существующий seed 040 уже использует ровно эти ключи**
(`'[{"resourceType":"effect_resource","operation":"invoke"}]'`). T-0077 пишет
`'[{"resourceType":"authoring_draft","operation":"create"}]'` — идентичная форма.
`isToolReachable` требует: для каждого `op` из `resourceOps` существует эффективный
грант с `g.resourceType === op.resourceType ∧ g.operation === op.operation`. Seed-гранты
несут `resource_type='authoring_draft'` и парный `operation` → покрытие 1:1, toolset не
пуст. CHECK `mcp_tool_pure_empty_chk` (declares='[]' ⇒ pure_compute=true) выполнен.

### 2.2 `authoring_draft` не ломает вокабуляр-fitness; widening-cast — как у T-0024 `'agent'`

`grant.resource_type` — `text NOT NULL` **без DB CHECK** (migration 008). Нет
fitness-чека, перечисляющего допустимые `resource_type` (вокабуляр пинится только для
`actor_event`/audit, не для grant). Поэтому `authoring_draft` admissible на DB-уровне
ровно как `mgmt_object:role` (026) и `effect_resource` (022). TS-union
`ResourceType` (grant-lattice.ts) НЕ редактируется — это frozen seam. Widening-cast
нужен ТОЛЬКО в TS-тесте (где конструируется `Grant`-объект): паттерн
`resourceType: "authoring_draft" as Grant["resourceType"]` — дословно как T-0024 строит
`resourceType: "agent" as Grant["resourceType"]` (`src/__tests__/invoke-grant.test.ts:83`).
В SQL никакого cast: это просто TEXT.

### 2.3 Тенант-скоуп и идемпотентность

Сид целиком в **dev-tenant `a0000000-…-000000000001`** — туда же, где живут роль,
employee, instance_budget, гранты genesis. (Замечание: seed 040 кладёт свои 3 demo-tool
в ДРУГОЙ тенант `00000000-…-001`; они RLS-изолированы и НЕ участвуют в toolset
config-агента — релевантны только строки `a0…001`.) Все 6 INSERT —
`ON CONFLICT DO NOTHING` (Check-3 grant-trail: сид ≥031 обязан быть идемпотентным).
run.mjs дополнительно пишет `version` в `schema_migrations` и пропускает применённые →
двойной прогон = «nothing to apply» (AC-09).

### 2.4 RLS под мигратором

run.mjs подключается ролью `choros_migrator` (владелец схемы / superuser-класс,
обходит FORCE RLS на INSERT) — как и все прошлые сид-миграции (019/020/026/032/034),
поэтому INSERT'ы проходят политики. Cross-tenant SELECT под `choros_app` (NOBYPASSRLS)
вернёт 0 строк (AC-12).

---

## 3. Rejected alternatives

| Опция | Почему отвергнута |
|---|---|
| Сид tool-строк в тенант `00000000-…-001` (как 040) | `resolveAgentToolset(tenantId)` читает гранты И tools по ОДНОМУ tenantId; гранты/employee живут в `a0…001`. Tools в другом тенанте → RLS-изоляция → toolset пуст → AC-02/06 провал в рантайме. Сидим в `a0…001`. |
| `authoring_published`-грант с флагом «draft-only» в constraint | Конфигурационная граница хрупка. ADR §4 требует ФИЗИЧЕСКОЙ границы: ноль грантов на published. Структурное отсутствие гранта неподделываемо. |
| Новая таблица `authoring_draft` / authority-store | NF-1: один control plane. authoring_draft — content-tier ресурс (E11.3+), не tenant-table; в T-0077 это лишь строковый дескриптор `resource_type`, как `effect_resource`. |
| Правка TS-union `ResourceType` под `authoring_draft` | grant-lattice.ts — frozen seam (FR-10/AC-10). T-0024 доказал: out-of-union resource_type живёт как TEXT в DB + widening-cast на границе. Правка union сломала бы AC-10. |
| `role_assignment` с `confirmed_by=NULL` | Migration 020: `confirmed_by IS NULL` ⇒ proposal ⇒ ZERO грантов резолверу. Seed обязан быть CONFIRMED, иначе AC-06 (7 инструментов) провалится. |
| Position для config-агента | Агенты могут быть без позиции (`employee.position_id` nullable). Системный config-агент не слотится в оргпозицию — `position_id=NULL` (паттерн genesis e-owner). |

---

## 4. Fitness functions (machine-verifiable)

Все fitness — аддитивны: новый bash-чек `ci/checks/config-agent-seed.sh` (статический
анализ migration 044 + frozen-guard), новый DB-тест `ci/checks/db/config-agent-seed.test.ts`
(SQL-факты + RLS), новый unit-тест `src/__tests__/config-agent-toolset.test.ts`
(resolveAgentToolset). Существующий `grant-trail-no-new-table.sh` покрывает no-new-table
+ ON CONFLICT для 044 без правок.

---

## 5. Открытые развилки

Нет BLOCKING-развилок к фаундеру. Design-owned точки (разрешены автономно, зафиксированы
выше): stable UUID-префиксы (`10…004..00a` tools, `e2…001..007` grants), корневой
org-узел скоупа (`b0000000-…-000000000001`, dept-узел из genesis 026), CONFIRMED
role_assignment. Все три — детерминированы из существующего seed, эскалация не требуется.

**Не-блокирующее наблюдение для оркестратора (не входит в scope T-0077):** demo-tool
seed migration 040 живёт в тенанте `00000000-…-001`, тогда как весь остальной dev-silo —
в `a0000000-…-001`. Это не мешает T-0077 (мы сидим в `a0…001`), но 3 demo-tool из 040
недостижимы для любого dev-агента. Кандидат на отдельную уборочную задачу.
