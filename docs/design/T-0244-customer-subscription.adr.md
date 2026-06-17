# ADR · T-0244 — Dogfood: управление B2B-клиентами и подписками как решение на самом Choros

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-17
**Product:** choros · **Type:** architecture · **Branch:** `task/T-0244` (от dev)
**Spec:** `docs/specs/T-0244-customer-subscription.spec.md` (status ready, AC-1..AC-15)
**adr_artifact_path:** `docs/design/T-0244-customer-subscription.adr.md`
**Директива:** `choros-customer-subscription-mgmt.md` (фаундер 2026-06-17) — dogfooding из примитивов.

**Foundation (do NOT contradict — проверено по коду на dev):**

| Опора | Статус | Доказательство |
|---|---|---|
| Трёхуровневая модель `application`→`registry_def`→`record` (JSONB record_schema) | **ЖИВЫЕ ТАБЛИЦЫ, dormant write-path** | `migrations/003_application.sql`, `004_registry_def.sql`, `005_record.sql`; T-0014 ADR. **НЕТ** REST/app-layer write-path к этим трём таблицам в `src/` (grep: нет `api/(applications\|registries\|records)`, нет `validateRecordData`/`createRecord` impl). Запись существует ТОЛЬКО через migration-seed (как `056_external_participant_directory_seed.sql`). |
| Tenant isolation / RLS / `withTenant` | **ЖИВОЙ** | T-0013; все три таблицы — tenant-owned, FORCE RLS, в `known_tenant_tables` (T-0014 FF-1). |
| Guarded transition / `actor_event` ledger | **ЖИВОЙ** | `src/core/actor-event.ts`, `src/core/actor-event-store.ts`; `appendActorEvent` writer; vocab pinned. |
| PDP `resolveFor` (единый authority) | **ЖИВОЙ** | `src/core/grant-resolver.ts::resolveFor(deps, handle, subject, op, …)`; deny-форма `{denied,reason}`. |
| Audit floor `audit_event` (open-vocab type) | **ЖИВОЙ** | `src/db/audit-writer.ts::appendAuditEvent`; `migrations/006` без CHECK на `type`. |
| Card actions примитив + `defaultCardActions` | **ЖИВОЙ** | `src/core/card-action.ts:610` `defaultCardActions(handle, availableTransitions, boundInstance)`; closed Operation enum; PDP-арбитр. |
| Roles & assignments + genesis-owner seam | **ЖИВОЙ** | T-0022; `migrations/026` genesis-owner `e-owner`/`tenant-owner`; `loadAdminContext`/`validateAdminDelegation` (`src/http/grants.ts`). |
| BPMN engine bridge (Flowable) | **ЧАСТИЧНО** | `src/core/flowable-client.ts` экспортирует ТОЛЬКО `deployBpmn`/`startInstance`/`fetchAndLock`/`completeTask`/`failTask` (T-0058). НЕТ terminate/message — для линейного процесса T-0244 они НЕ нужны. |
| Seed-pack механизм (T-0140) | **ЖИВОЙ для org-плоскости** | `seed/importer.ts` + 5 endpoints (`POST /api/{tenants,departments,positions,employees,roles}`), slug-idempotent. **НЕ покрывает** application/registry_def/record (нет endpoints) → registry-content идёт migration-seed-плоскостью (документированное исключение I-1, §6). |
| Инъектируемый порт-паттерн (LlmPort) | **ЖИВОЙ образец** | `src/core/llm-port.ts` (PURE type + `dormantLlmPort` + бросающий стаб; T-0233). T-0244 повторяет этот паттерн для `EntitlementPort`. |
| `activation.ts` / `verifyKey` (consumer-сторона ключа) | **ЖИВОЙ** | T-0127/T-0198; consumer-путь ключа в ядре клиента — НЕ трогается (red-line NF-5). |

> Это **buildable** ADR: каждое «где живёт» привязано к реальному файлу. Решение **аддитивно**: НЕ трогает byte-frozen `grant-lattice.ts`/`object-handle.ts`, НЕ вводит таблиц вне T-0014-модели, НЕ открывает generic record-write-runtime, НЕ касается consumer-пути ключа в ядре клиента.

---

## 1. Decision (один абзац)

Решение «Управление клиентами и подписками» собирается **целиком из живых примитивов Choros** как **(а)** системный `application` slug=`vendor-crm` + системный `registry_def` slug=`customer-subscription` (`is_system=true`) в **tenant фаундера**, с `record_schema` (JSON Schema draft-07), куда **поле `status` встроено как enum внутри `record.data`** (статус — данные записи, не отдельная колонка, по T-0014-модели); **(б)** чистой **status-машиной** `customerStatusModel` (pure, `src/core/customer-subscription/status-model.ts`) — закрытый набор `{draft,trial,active,expired,custom,archived}` + функция `availableTransitions(currentStatus)`, которая кормит **живой** `defaultCardActions` (T-0125) → каждый переход = guarded transition под `resolveFor` (op=`transition`) + `actor_event` (T-0019) + `audit_event` (T-0016); **(в)** линейным **BPMN-процессом** `customer-onboarding` (4 User Task + 1 Service Task, без ветвления/terminate/message — целиком в живом surface T-0058), где шаг **«Выпустить ключ»** вызывает PRODUCER-сторону через **инъектируемый `EntitlementPort`** (по образцу `LlmPort`): интерфейс-порт в ядре + бросающий `dormantEntitlementPort` + тест-стаб, так что T-0244 строится и приёмается БЕЗ готового T-0242; **(г)** двумя ролями `vendor-admin`/`vendor-readonly` (T-0022), где запись `circuit_id`/`activation_key_issued_at` возможна ТОЛЬКО процессным актором (field-level grant), не прямым record-update; **(д)** seed-pack'ом-как-код (T-0140) для org-плоскости (роли/гранты/назначения через живой importer) **плюс** registry-content-плоскостью через **migration-seed** (idempotent, документированное I-1-исключение — endpoints для registry/record ещё не построены). Ключ **НЕ kill-switch** (NF-5): шаг «Выпустить ключ» пишет ТОЛЬКО `circuit_id`+`activation_key_issued_at` в свою запись и эмитит `audit_event(customer.key_issued)`; он структурно НЕ импортирует и НЕ влияет на consumer-путь `activation.ts` в ядре клиента (FF-7 grep-fence). Биллинг — **extension-point в BPMN** между «Проверить данные» и «Выпустить ключ» (§7, AC-15), не строится. `runtime_target = контейнер` (существующий choros dev-стек, доп. провижна нет).

---

## 2. Несущее напряжение и его разрешение (честный гейт)

**Напряжение 1 — нет write-path к registry/record.** Таблицы `application`/`registry_def`/`record` живут (migrations 003-005), но в `src/` НЕТ ни REST-endpoint, ни app-layer-функции записи в них (в отличие от org-таблиц, которым T-0140 дал 5 endpoints). Если бы спека требовала «фаундер создаёт запись через UI» day-1 — это потребовало бы построить весь record-CRUD-stack, что вне envelope T-0244.

**Разрешение (по образцу T-0140 §2.4 + T-0127 genesis-seam):** конфигурация решения (application def, registry_def со схемой, BPMN-deploy, роли/гранты) провижнируется как **код**: org-плоскость (роли `vendor-admin`/`vendor-readonly`, гранты, назначение genesis-owner) — через **живой seed-importer** (T-0140, public API, I-1 честно); registry-content (системные `application`+`registry_def` rows) — через **migration-seed** (idempotent `INSERT ... ON CONFLICT (tenant_id, slug) DO NOTHING`, образец `056_external_participant_directory_seed.sql`). Это **тот же документированный I-1-исключение-паттерн**, что T-0140 применил к display-плоскости: данные, для которых нет live write-API, провижнируются однонаправленно через migration-seed, а не имитируются несуществующим endpoint'ом. Создание **записей клиентов** (record rows) фаундером — это **отдельная build-задача record-CRUD** (вне T-0244); day-1 решение поставляет **готовый каркас** (application+registry+схема+статус-машина+процесс+роли), а реальные записи появляются либо демо-seed'ом (как `tel-scenario`), либо когда record-write-path построят. Эта граница зафиксирована в §9 (decomposition) и НЕ скрыта.

**Напряжение 2 — T-0242 (PRODUCER `issue_entitlement`) не готова.** Шаг «Выпустить ключ» зависит от T-0242 в runtime.

**Разрешение (образец LlmPort/T-0233):** шаг вызывает **инъектируемый `EntitlementPort`** (§3.4). Production-провод (real T-0242) — отдельная реализация порта (Stage-deploy); приёмка инжектит детерминированный **стаб**; default (T-0242 не сконфигурирована) = **`dormantEntitlementPort`**, который БРОСАЕТ при любом вызове → шаг остаётся открытым (AC-8), статус не меняется. Контракт-шов с T-0242 заморожен оркестратором (§3.4) и зафиксирован как тип-порт. T-0244 строится и приёмается на порту+стабе независимо от T-0242 (R-1/R-2 спеки разрешены).

---

## 3. Объектная модель и контракты

### 3.1 `customer-subscription` registry (T-0014 row — system, migration-seeded)

`registry_def` row: `slug="customer-subscription"`, `application_id`→`vendor-crm`, `is_system=true`, `record_schema` = JSON Schema draft-07 ниже. Запись (`record.data`) валидируется против неё app-layer при будущем write-path (T-0014 §4.3 `validateRecordData`).

`record.data` JSON Schema (поля FR-2 + встроенный `status`):

| Поле | Тип | Required | Семантика |
|---|---|---|---|
| `company_name` | `string` | да | Наименование компании-клиента |
| `contact_name` | `string` | да | Контактное лицо |
| `contact_email` | `string, format:email` | да | E-mail контакта |
| `plan` | `string, enum:["pilot","standard","enterprise"]` | да | Тариф (seed-набор; кастом — через `custom_terms`) |
| `not_after` | `string, format:date` | да | Дата окончания подписки (YYYY-MM-DD). **↔ T-0242 `valid_until`** (§3.4) |
| `status` | `string, enum:["draft","trial","active","expired","custom","archived"]` | да (default `draft`) | Статус-машина (§3.2). Запись статуса вне enum → JSON-Schema reject (AC-3) |
| `circuit_id` | `string` | нет | ID контура клиента. **ПИШЕТСЯ ТОЛЬКО шагом «Выпустить ключ»** (field-grant §3.5) |
| `activation_key_issued_at` | `string, format:date-time` | нет | Метка выпуска (ISO-8601). **ПИШЕТСЯ ТОЛЬКО шагом «Выпустить ключ»** |
| `custom_terms` | `string` | нет | Индивидуальные B2B-условия — текст БЕЗ автоматизации (NF-6) |
| `notes` | `string` | нет | Заметки фаундера |

> `additionalProperties: false` — структурный запрет на скрытые поля (защита от инъекции авторизатора).
> `status` — **поле данных**, не отдельная таблица/колонка: T-0014-модель хранит форму записи в `record.data` JSONB. Status-машина (§3.2) — pure-функция поверх этого поля, не новый store.

### 3.2 `customerStatusModel` — статус-машина (PURE, `src/core/customer-subscription/status-model.ts`)

Закрытый набор статусов + закрытая карта переходов (FR-3). Pure, IO-free.

```ts
export type CustomerStatus =
  | "draft" | "trial" | "active" | "expired" | "custom" | "archived";

/** Закрытая карта допустимых guarded transitions (FR-3). archived = терминальный. */
export const CUSTOMER_TRANSITIONS: Readonly<Record<CustomerStatus, readonly CustomerStatus[]>> = {
  draft:    ["trial", "active", "archived"],
  trial:    ["active", "expired", "custom", "archived"],
  active:   ["expired", "custom", "archived"],
  expired:  ["active", "custom", "archived"],   // expired→active = продление
  custom:   ["active", "expired", "archived"],
  archived: [],                                  // терминальный, односторонний (AC-5)
};

/** Доступные из текущего статуса переходы — кормит defaultCardActions (T-0125). */
export function availableTransitions(current: CustomerStatus): readonly AvailableTransition[];
//  → [{ id:`to_${target}`, label, bindings:[] }, …] для каждого target из CUSTOMER_TRANSITIONS[current].
//  archived ⇒ [] (FF-3: пустой набор; AC-5).

/** Тотальная проверка допустимости (используется guarded-transition writer'ом). */
export function isAllowedTransition(from: CustomerStatus, to: CustomerStatus): boolean;
//  → CUSTOMER_TRANSITIONS[from].includes(to). Недопустимый → false → PDP/writer reject (AC-4).
```

Карточка записи получает кнопки переходов через **живой** `defaultCardActions(recordHandle, availableTransitions(status), boundInstance)` (`card-action.ts:610`) — каждая видима/исполнима ТОЛЬКО если `resolveFor(subject, op=transition)` ≠ denied (NF-3). НИ нового механизма авторизации, НИ нового card-action-кода — переиспользуется примитив T-0125.

### 3.3 BPMN `customer-onboarding` (линейный, целиком в живом surface T-0058)

Файл `seed/vendor-crm/processes/customer-onboarding.bpmn` (Flowable BPMN 2.0). Линейный, без ветвления, без terminate/message (FR-4):

```
[Start]
  → [UserTask: Заполнить карточку клиента]      (assignee: role vendor-admin)
  → [UserTask: Проверить данные и согласовать]   (assignee: role vendor-admin)
  ── ⟦extension-point: BILLING (Stage-2, §7)⟧ ──
  → [UserTask: Выпустить активационный ключ]      (assignee: role vendor-admin) ← KEYSTONE
  → [ServiceTask: Уведомить (T-0120 notification)] (внутр. уведомление фаундеру)
  → [End]
```

Деплой через `deployBpmn` (T-0058), запуск через `startInstance` (card action «Запустить онбординг», FR-6), User Task появляются в инбоксе роли `vendor-admin` через `fetchAndLock`/`completeTask`. **Все используемые REST-пути ЖИВЫЕ** (T-0058) — нет dormant-зависимости от terminate/message (линейный процесс их не требует, в отличие от ТЭЛ T-0125 §6). Service Task уведомления = T-0120 notification (внутри системы, фаундеру; внешнее уведомление клиенту вне MVP — R-4 спеки).

### 3.4 `EntitlementPort` — инъектируемый порт к PRODUCER-стороне (PURE TYPE, ядро)

**Где живёт:** `src/core/customer-subscription/entitlement-port.ts` — **только TYPE + dormant-стаб**, БЕЗ env/SDK/fetch/pg (зеркалит `LlmPort` из T-0233). Production-адаптер (мост к T-0242) — `src/adapters/t0242-entitlement-port.ts` (Stage-deploy, единственное место, где живёт реальный вызов T-0242). Тест-стаб — `src/core/customer-subscription/__tests__/stub-entitlement-port.ts`.

**🔒 КОНТРАКТ-ШОВ С T-0242 (заморожен оркестратором — НЕ переопределяется):**

```ts
// src/core/customer-subscription/entitlement-port.ts — PURE: no pg/http/fetch/env/SDK

/** Запрос на выпуск ключа. РОВНО замороженная оркестратором сигнатура. */
export interface IssueEntitlementInput {
  readonly circuit_id: string;
  readonly plan: string;          // из record.data.plan
  readonly valid_from: string;    // ISO/date — начало действия
  readonly valid_until: string;   // ↔ record.data.not_after (поле записи)
  readonly source: string;        // напр. "pilot"
  readonly notes?: string;
}

/** LicenseRecord — ЗОНА T-0242 (внутренности подписи/refresh/revoke НЕ проектируются здесь).
 *  T-0244 обращается ТОЛЬКО к двум полям моста: circuit_id (эхо) и issued_at-метке. */
export interface LicenseRecord {
  readonly circuit_id: string;
  readonly issued_at: string;     // ISO-8601 → пишется в record.data.activation_key_issued_at
  // прочие поля (подпись/срок/handle) — owned T-0242, T-0244 их не читает/не хранит.
}

export interface EntitlementPort {
  /** Единственный метод = замороженная ручка. Production-адаптер зовёт T-0242;
   *  стаб — детерминированную фикстуру; dormant — БРОСАЕТ. */
  issueEntitlement(input: IssueEntitlementInput): Promise<LicenseRecord>;
}

/** Dormant-by-default: бросает при ЛЮБОМ вызове (T-0242 не готова). Default до Stage-deploy. */
export const dormantEntitlementPort: EntitlementPort; // → throw new EntitlementDormantError(...)
export class EntitlementDormantError extends Error {}  // → шаг остаётся открытым (AC-8)
```

> **Маппинг полей шага → ручки (зафиксирован):** `circuit_id` = ввод фаундера/из карточки; `plan` = `record.data.plan`; `valid_from` = дата старта (день выпуска); `valid_until` = `record.data.not_after` (поле `not_after` ↔ `valid_until`); `source = "pilot"`. **Внутренности ручки (подпись/хранение LicenseRecord/refresh/revoke) — зона T-0242, НЕ проектируются.**

### 3.5 Field-level write-restriction для `circuit_id` / `activation_key_issued_at` (FR-2 note, AC-9)

`circuit_id` и `activation_key_issued_at` пишутся ТОЛЬКО шагом процесса «Выпустить ключ» (системный актор онбординга), НЕ прямым record-update от `vendor-admin`. Механизм — **существующий `resourceFacet` field-masking T-0021/T-0033** (грант несёт имена полей; `grant-resolver.ts:305,321`): грант `vendor-admin` на `(op=update, resource=record:customer-subscription)` несёт `resourceFacet` с **исключением** этих двух полей (write-mask); грант системного процессного актора несёт их в write-set. Прямой update этих полей от `vendor-admin` → PDP denied + `audit_event(denied)` (AC-9). **Ни нового механизма** — переиспользуется живой field-mask из PDP.

### 3.6 Шаг «Выпустить ключ» — оркестратор (тонкая граница)

**Где живёт:** `src/runtime/customer-onboarding/issue-key.ts` (новый узкий runtime-путь). Контракт:

```ts
export interface IssueKeyDeps {
  entitlement: EntitlementPort;   // инжектится: prod-адаптер | стаб | dormantEntitlementPort
  resolverDeps: ResolverDeps;     // T-0021 — единственный PDP
  auditWriter: AuditWriter;       // T-0016 — единственный audit-sink
  liveEnabled: boolean;           // false ⇒ принудительно dormantEntitlementPort
}
/** Один прогон шага под tenant-tx. Возвращает исход; пишет ровно один audit_event. */
export async function runIssueKey(
  tx: PgClientLike, deps: IssueKeyDeps,
  args: { tenantId: string; recordHandle: ObjectHandle; subject: ResolveSubject;
          circuitId: string; nowMs: number },
): Promise<IssueKeyOutcome>;
```

Поток (FR-5):
```
runIssueKey:
  1. PDP (T-0021): resolveFor(deps.resolverDeps, recordHandle, subject, "update", …)
       denied ⇒ audit_event(card_action.denied / customer.key_blocked, reason) → шаг открыт → return
  2. Live-калитка: port = (deps.liveEnabled) ? deps.entitlement : dormantEntitlementPort
  3. Прочитать record.data → собрать IssueEntitlementInput {circuit_id, plan, valid_from=today,
       valid_until=not_after, source:"pilot", notes?}  (маппинг §3.4)
  4. try license = await port.issueEntitlement(input)
       catch (EntitlementDormantError | network | error):
          → НЕ менять статус, НЕ писать circuit_id/issued_at; шаг ОСТАЁТСЯ открытым (AC-8);
            audit_event(customer.key_issue_failed, reason); return  (фаундер видит причину, повторит)
  5. success:
       → update record.data: circuit_id, activation_key_issued_at=license.issued_at
            (через системного процессного актора — field-grant §3.5)
       → guarded transition → "active" (isAllowedTransition, §3.2) → actor_event (T-0019)
       → audit_event(type="customer.key_issued", {circuit_id, not_after, actor, tenant_id})  (NF-4, AC-11)
```

**Red-line (NF-5):** `runIssueKey` пишет ТОЛЬКО в свою `record.data` + audit; **НЕ импортирует** `src/vendor/activation.ts` (consumer-путь ключа), **НЕ** создаёт механизм отзыва/блокировки ядра клиента. Истечение `not_after` = смена статуса записи (вендорская сторона) + невозможность получить новый ключ через T-0242 — ядро клиента работает в автономном режиме. Граница машинно-проверяема (FF-7).

---

## 4. Роли (vendor-side, T-0022) — org-плоскость seed

| Роль | Гранты (T-0018/T-0021 lattice) |
|---|---|
| `vendor-admin` | `(read,create,update,delete)` над `registry:customer-subscription` (update-грант несёт `resourceFacet` с write-mask на `circuit_id`/`activation_key_issued_at` — §3.5); `transition` над `record` (статус-переходы); `invoke`/process-start для `customer-onboarding`. |
| `vendor-readonly` | ТОЛЬКО `read` над `registry:customer-subscription`. `update`/`transition`/process-start → PDP denied (AC-12). |
| (системный процессный актор онбординга) | `update` над `record` с `resourceFacet`, ВКЛЮЧАЮЩИМ `circuit_id`/`activation_key_issued_at` (только этот актор их пишет, §3.5). |

Роли/гранты/назначения живут в **tenant фаундера** (NF-2; R-3 спеки разрешён: tenant фаундера, не выделенный vendor-tenant — соразмерно MVP). Провижн — через **живой seed-importer** (`POST /api/roles`, `POST /api/grants`, `POST /api/role-assignments`, T-0140), genesis-owner `e-owner` = актор записи (AC-14 idempotency).

---

## 5. Seed-pack как код (T-0140, NF-8, AC-14) — две плоскости

По образцу T-0140 §2.2 (две плоскости из-за разной доступности write-API):

| Плоскость | Содержимое | Путь провижна | I-1 статус |
|---|---|---|---|
| **Live (org)** | роли `vendor-admin`/`vendor-readonly`, гранты, назначение genesis-owner | `seed/vendor-crm/pack.json` → живой `seed/importer.ts` (`POST /api/{roles,grants,role-assignments}`), slug-idempotent | I-1 честно (через API) |
| **Registry-content (migration-seed)** | `application(vendor-crm)`, `registry_def(customer-subscription, record_schema, is_system=true)` | `migrations/0XX_vendor_crm_seed.sql` — `INSERT ... ON CONFLICT (tenant_id, slug) DO NOTHING` (idempotent, образец `056_external_participant_directory_seed.sql`) | **Документированное I-1-исключение** (нет registry/record write-endpoints — §2 напряжение 1) |
| **BPMN-deploy** | `customer-onboarding.bpmn` | `deployBpmn` (T-0058) при провижне; idempotent по process-key (Flowable versioned deploy) | live |

**Idempotency (AC-14):** org-плоскость — slug-UNIQUE 409-as-no-op (живой importer); registry-content — `ON CONFLICT DO NOTHING` на `(tenant_id, slug)`; BPMN — Flowable versioned deploy (повторный deploy = новая версия или no-op по дайджесту). Повторный прогон = no-op, без дублей, без потери данных.

> **Почему migration-seed для registry-content, а не endpoint:** строить полный record/registry-CRUD-stack (5+ endpoints + app-layer validate + RLS-write-path) — отдельная высокообъёмная задача вне envelope T-0244 (как T-0140 вынес record-CRUD за скоуп). Migration-seed — тот же однонаправленный genesis-паттерн, что `056_*` и T-0127 genesis-installer. Граница честная, не имитируется.

---

## 6. Биллинг extension-point (NF-7, AC-15) — Stage-2

**Где вставляется:** в BPMN `customer-onboarding` **между** `[UserTask: Проверить данные и согласовать]` и `[UserTask: Выпустить активационный ключ]` (§3.3, отмечено `⟦extension-point: BILLING⟧`).

**Как вставляется (Stage-2, НЕ строится сейчас):** новый `[ServiceTask: Биллинг]` (или `[UserTask: Подтвердить оплату]`) добавляется в линейную цепочку как ещё один sequenceFlow-узел — **без переписывания** существующих узлов: процесс линейный, вставка узла между двумя последовательными = две новые стрелки + один узел, остальные узлы и их assignee/PDP-гранты не меняются. Биллинг-шаг получит свой **инъектируемый порт** (по тому же паттерну `EntitlementPort` — `BillingPort`), dormant-by-default до Stage-2. Гейт «Выпустить ключ» останется ниже по потоку (ключ выпускается ПОСЛЕ оплаты, когда биллинг включён). **Это требование к дизайну (зафиксировано здесь), не к реализации MVP.**

---

## 7. Fitness-функции (машинно-проверяемые границы)

Все новые `*.sh` следуют паттерну `ci/checks/*.sh` + `--self-test`, регистрируются в `package.json` `fitness`. `static-now` (zero-runtime-dep), кроме AC-2/AC-3/AC-4/AC-7/AC-8 (vitest unit/integration).

| ID | Правило (нарушаемая граница) | ci_check | AC |
|---|---|---|---|
| **FF-1** | `customer-subscription` record_schema валидирует обязательные поля (`company_name`/`contact_name`/`contact_email`/`plan`/`not_after`); `additionalProperties:false`; невалидная запись reject, валидная accept. | `vitest`: `status-model`/schema unit-тест компилирует record_schema (draft-07 ajv-devDep), проверяет conformant/non-conformant payload. | AC-2 |
| **FF-2** | `status` enum = РОВНО `{draft,trial,active,expired,custom,archived}`; запись статуса вне набора → schema reject. | `vitest` unit над record_schema + grep: enum-литерал в schema-файле == enum в `status-model.ts` `CustomerStatus`. | AC-3 |
| **FF-3** | Status-машина: только допустимые переходы; `archived` терминальный (`availableTransitions("archived") === []`); `isAllowedTransition` тотальна. | `vitest`: golden-тест над `CUSTOMER_TRANSITIONS`/`availableTransitions`/`isAllowedTransition` — все допустимые true, недопустимые (напр. `archived→trial`) false, archived ⇒ []. | AC-4, AC-5 |
| **FF-4** | Card actions карточки выводятся из `defaultCardActions` (T-0125) + `availableTransitions`; видимость/исполнимость = `resolveFor` (PDP), не UI-флаг; нет нового card-action-кода/авторизатора. | `bash ci/checks/customer-subscription-pdp-arbiter.sh --self-test` — grep: vendor-CRM-путь использует `defaultCardActions`/`resolveFor`; запрет токенов `actionEnabled`/`canShow`/`allowedFlag`; нет дубль-card-action-модуля. | AC-4, NF-3 |
| **FF-5** | Шаг «Выпустить ключ» зовёт PRODUCER ТОЛЬКО через `EntitlementPort` (DI); НИ ОДНОГО прямого SDK/fetch/импорта T-0242-internals в `src/core/**`+`src/runtime/customer-onboarding/**`; `dormantEntitlementPort` бросает. | `bash ci/checks/entitlement-port-injectable.sh --self-test` — (a) `entitlement-port.ts` экспортирует `EntitlementPort`+`dormantEntitlementPort`; (b) сигнатура `issueEntitlement` РОВНО `{circuit_id,plan,valid_from,valid_until,source,notes?}` (grep полей); (c) нет `fetch(`/`http`/SDK в core+runtime-путях; (d) `runIssueKey` принимает `entitlement: EntitlementPort` в deps. | AC-7, AC-8 |
| **FF-6** | Ошибка `issueEntitlement` → шаг НЕ завершён, статус НЕ меняется, `circuit_id`/`activation_key_issued_at` НЕ пишутся; успех → пишутся + статус→active + `audit_event(customer.key_issued)`. | `vitest` integration с стабом: error-стаб ⇒ нет side-effects (запись/статус не тронуты, audit=key_issue_failed); success-стаб ⇒ поля + статус + `customer.key_issued` с {circuit_id,not_after,actor,tenant_id}. | AC-7, AC-8, AC-11 |
| **FF-7** | **Нет kill-switch:** ни один файл T-0244 не импортирует `src/vendor/activation.ts` (consumer-путь ключа); `src/core/**` не получает зависимости на статус ключа через это решение. | `bash ci/checks/no-killswitch-in-core.sh` (расширяется): grep — нет `import .*vendor/activation` / `from .*activation` в файлах T-0244-зоны (`src/core/customer-subscription/**`, `src/runtime/customer-onboarding/**`, `seed/vendor-crm/**`); `src/core/**` чист от reverse-dep на activation-статус. | AC-10, NF-5 |
| **FF-8** | Field-restriction: прямой record-update `circuit_id`/`activation_key_issued_at` от `vendor-admin` → PDP denied (write-mask `resourceFacet`); пишет их ТОЛЬКО процессный актор. | `vitest` integration: subject=vendor-admin, update этих полей через record-update → `resolveFor` denied + `audit_event(denied)`; процессный актор → allowed. (До record-write-path — unit над grant-resolver field-mask фикстурой.) | AC-9 |
| **FF-9** | `vendor-readonly`: `resolveFor(read)`=allowed, `resolveFor(update/transition)`=denied, process-start denied. | `vitest`: грант-фикстура vendor-readonly → read allow, update/transition/invoke deny. | AC-12 |
| **FF-10** | Tenant isolation: registry/record vendor-CRM — tenant-owned, RLS; cross-tenant read = пустой список, cross-tenant write невозможен. | `bash ci/checks/cross-tenant-fitness.sh` (расширяется кейсом customer-subscription) + registry/record уже в `known_tenant_tables` (T-0014 FF-1). | AC-1 |
| **FF-11** | Список по умолчанию скрывает `archived`; явный `status=archived` возвращает их. | `vitest` unit над list-проекцией: фильтр по умолчанию `status != archived`; explicit `status=archived` → включает. (list-path — часть record-read-проекции; до неё unit над фильтр-функцией.) | AC-13 |
| **FF-12** | Seed idempotent: org-плоскость 409-as-no-op; registry-seed `ON CONFLICT DO NOTHING`; BPMN versioned-deploy; повторный прогон = no-op без дублей. | `bash ci/checks/vendor-crm-seed-idempotent.sh --self-test` — grep migration-seed на `ON CONFLICT (tenant_id, slug) DO NOTHING`; importer-путь slug-идемпотентен (FF-наследует T-0140); double-run vitest/db-кейс. | AC-14 |
| **FF-13** | BPMN линейный, в живом surface T-0058: процесс деплоится/стартует (`deployBpmn`/`startInstance`); User Task в инбоксе vendor-admin; нет terminate/message-зависимости. | `vitest` integration (Flowable REST client T-0058): deploy success, startInstance 200, первый UserTask виден для роли vendor-admin; grep — BPMN не использует deleteProcessInstance/correlateMessage. | AC-6 |

> Byte-frozen `grant-lattice.ts`/`object-handle.ts`/`grant-resolver.ts` НЕ трогаются (решение аддитивно) — `frozen-checks-immutable.sh`/`grant-resolver-isolation.sh`/`object-handle-isolation.sh` остаются зелёными.

---

## 8. Реконсиляция seam: CREATE vs MODIFY

**CREATE (аддитивно):**
- `src/core/customer-subscription/status-model.ts` — `CustomerStatus`/`CUSTOMER_TRANSITIONS`/`availableTransitions`/`isAllowedTransition` (PURE).
- `src/core/customer-subscription/entitlement-port.ts` — `EntitlementPort` type + `dormantEntitlementPort` + `EntitlementDormantError` (PURE, замороженная сигнатура §3.4).
- `src/runtime/customer-onboarding/issue-key.ts` — оркестратор `runIssueKey` (новый узкий runtime-путь).
- `src/adapters/t0242-entitlement-port.ts` — production-адаптер (мост к T-0242; Stage-deploy, не в приёмке; dormant до готовности T-0242).
- `src/core/customer-subscription/__tests__/stub-entitlement-port.ts` + unit/integration-тесты (AC-2..AC-9).
- `seed/vendor-crm/pack.json` (org-плоскость: роли/гранты/назначения) + `seed/vendor-crm/processes/customer-onboarding.bpmn`.
- `migrations/0XX_vendor_crm_seed.sql` — idempotent seed `application(vendor-crm)`+`registry_def(customer-subscription)` (ON CONFLICT DO NOTHING).
- record_schema JSON-файл (`seed/vendor-crm/customer-subscription.schema.json`) — источник для migration-seed и для FF-1/FF-2.
- Новые `ci/checks/`: `customer-subscription-pdp-arbiter.sh`, `entitlement-port-injectable.sh`, `vendor-crm-seed-idempotent.sh` (+ `--self-test`).

**MODIFY (узко, аддитивно):**
- `ci/checks/no-killswitch-in-core.sh` — расширить glob на T-0244-зону (FF-7, AC-10).
- `ci/checks/cross-tenant-fitness.sh` — добавить кейс customer-subscription (FF-10).
- `package.json` `fitness` — новые чеки + их `--self-test`.

**НЕ ТРОГАЕТСЯ (byte-frozen / границы):** `src/core/grant-lattice.ts`, `src/core/object-handle.ts`, `src/core/grant-resolver.ts` (используется как есть для field-mask), `src/core/card-action.ts` (`defaultCardActions` используется как есть), `src/vendor/activation.ts` (consumer-путь ключа — red-line NF-5), `src/db/audit-writer.ts`, `constitution/`, `agents/`. **touches_frozen = false.**

---

## 9. Декомпозиция impl (для materialize → coder)

| # | Под-задача | Зависит от | Статус пути |
|---|---|---|---|
| **B-1** | record_schema (JSON-файл) + `status-model.ts` (pure) + FF-1/FF-2/FF-3 | T-0014 (ADR) | day-1 |
| **B-2** | `entitlement-port.ts` (type + dormant + замороженная сигнатура) + stub + FF-5 | образец LlmPort | day-1 |
| **B-3** | `runIssueKey` оркестратор (PDP + порт + field-write + transition + audit) + FF-6/FF-8 | B-1, B-2, T-0021/T-0016/T-0019 (ЖИВ) | day-1 |
| **B-4** | роли/гранты (vendor-admin/readonly + процессный актор field-grant) seed-pack org-плоскость + FF-9 | T-0022/T-0140 (ЖИВ) | day-1 |
| **B-5** | migration-seed application+registry_def (idempotent) + record_schema + FF-12 | T-0014 таблицы (ЖИВ), образец `056_*` | day-1 |
| **B-6** | BPMN `customer-onboarding.bpmn` линейный + deploy/start wiring (T-0058) + FF-13 | T-0058 (ЖИВ) | day-1 |
| **B-7** | card actions карточки = `defaultCardActions`+`availableTransitions` wiring + FF-4 | T-0125 (ЖИВ), B-1 | day-1 |
| **B-8** | list-проекция: фильтр archived-hidden + поиск company/email + FF-11 | record-read-path | **частично за гейтом record-read-path** |
| **B-9** | cross-tenant FF + no-killswitch FF расширение (FF-7/FF-10) | существующие чеки | day-1 |
| **B-10** | production-адаптер `t0242-entitlement-port.ts` (мост к T-0242) | **T-0242 (IN DESIGN)** | **за гейтом T-0242 + Stage-deploy** |
| **B-11** | record-CRUD write-path (создание записей клиентов фаундером) | — | **ОТДЕЛЬНАЯ задача вне T-0244** (§2 напряжение 1) |

> **Честная граница envelope:** B-1..B-7+B-9 = day-1 buildable. B-8 частично зависит от record-read-проекции (unit над фильтр-функцией строится day-1, integration — когда есть read-path). B-10 — за гейтом T-0242 (порт+стаб делают T-0244 независимым). B-11 (полный record-CRUD UI/API для ручного заведения записей) — **вне T-0244**; решение поставляет каркас, записи появляются демо-seed'ом или когда record-write-path построят отдельной задачей.

---

## 10. Runtime / deploy target

**Runtime:** `контейнер` — существующий choros dev-стек (single-Postgres T-0013 + node:http + Flowable T-0058) на home-сервере фаундера (`/srv/choros`, deploy founder-gated GT-4). Никакого нового внешнего ресурса: PDP/audit/actor_event/record = существующий Postgres; BPMN = существующий Flowable; всё в **tenant фаундера** (NF-2). **Приёмка** (стаб-порт) исполняется локально/в CI без T-0242 и без внешнего ресурса. **Live-провод к T-0242** (real `issueEntitlement`) — deploy-time действие после готовности T-0242 (config-gated, dormant-by-default = граница фаундера D-060). **Нет founder-gate на impl/приёмку.**

---

## 11. Rejected alternatives

| Опция | Почему нет |
|---|---|
| **`status` как отдельная колонка/таблица** | Нарушает T-0014-модель (форма записи живёт в `record.data` JSONB; нет per-registry колонок). Status — поле данных + pure status-машина поверх, не второй store/DDL. |
| **Свой card-action-механизм для переходов** | Дублирует живой примитив T-0125 (`defaultCardActions`+PDP-арбитр). Переиспользуем как есть — ни нового авторизатора, ни нового кода. NF-1/NF-3. |
| **Прямой SDK/вызов T-0242 в шаге** | Ломает независимость от T-0242 ($0-приёмка, детерминизм) и тестируемость. Инъектируемый `EntitlementPort` + DI (образец LlmPort) обязателен; default = бросающий dormant. |
| **REST-endpoints для registry/record day-1 (полный record-CRUD)** | Высокий объём (5+ endpoints + app-layer validate + RLS write-path) вне envelope T-0244 (как T-0140 вынес record-CRUD за скоуп). Registry-content = migration-seed (документированный genesis-паттерн `056_*`/T-0127); record-CRUD = отдельная задача B-11. |
| **Имитировать registry-write несуществующим endpoint'ом** | Нечестно (как T-0140 НЕ имитировал process-instance-write). Migration-seed — реальный однонаправленный путь, не фасад. |
| **Хранить/влиять на ключ в ядре клиента (kill-switch)** | Прямое нарушение NF-5/choros-licensing-model (red-line). Истёк ключ → автономный режим, ядро не блокируется. Шаг пишет ТОЛЬКО свою запись+audit; FF-7 grep-fence запрещает import activation-пути. |
| **Выделенный vendor-tenant** | Соразмерно MVP — CRM живёт в tenant фаундера (R-3 спеки разрешён). Отдельный tenant — speculative generality; ввести при реальной нужде. |
| **Автоматизация `custom_terms` (ветки процесса по содержимому)** | Запрещено NF-6: текст без автоматизации, читает только человек. Биллинг/индивидуальные условия = Stage-2. |
| **Ветвящийся BPMN (отказ/продление/повторный выпуск) day-1** | Спека FR-4: линейный, без ветвления на MVP. Ветки — будущая задача. Линейный процесс целиком в живом surface T-0058 (нет dormant terminate/message). |

---

## 12. Escalation

**`needs_founder` НЕ выставлен** (status: ready). Решение — dogfood-CRM, собранный из живых примитивов в рамках ратифицированных решений (T-0014/T-0013/T-0019/T-0021/T-0016/T-0125/T-0022/T-0058/T-0140/T-0233-паттерн) и продуктовой директивы фаундера (`choros-customer-subscription-mgmt.md`). Высоколеверажного продуктового форка не вводится: tenant-фаундера vs vendor-tenant (R-3), способ вызова T-0242 (R-2) и migration-seed-плоскость — инженерные развилки, разрешённые в рамках envelope. Контракт-шов с T-0242 заморожен оркестратором и зафиксирован как порт-тип (§3.4). Граница T-0242 (бюджет/секреты/Stage-deploy live-провода) = существующая граница фаундера D-060, impl/приёмку T-0244 не блокирует (порт+стаб). `escalation` пуст.
