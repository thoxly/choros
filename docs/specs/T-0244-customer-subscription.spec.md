# Spec · T-0244 — Dogfood: управление B2B-клиентами и подписками как решение на самом Choros

**Status:** ready (no blocking questions)
**Phase:** SPEC (analyst)
**Date:** 2026-06-17
**Task:** T-0244 (architecture) — «Dogfood: управление B2B-клиентами и подписками как решение на самом Choros»
**Task type:** architecture (дизайн-задача; downstream — architect пишет ADR)
**Директива:** choros-customer-subscription-mgmt.md (фаундер 2026-06-17)
**Шов с сестрой:** T-0242 (PRODUCER-сторона `issue_entitlement`) — зависимость § "Контракт-шов с T-0242"

---

## 0. Что строим (одно предложение)

Choros-решение «Управление клиентами и подписками» — это **application + registry + onboarding-процесс**, собранный из существующих примитивов самой платформы: тип записи «Клиент/Подписка» с JSON Schema, машина статусов (trial / active / expired / custom), BPMN-процесс онбординга с шагом «выпустить ключ» (вызывает `issue_entitlement` из T-0242/T-0127), поля индивидуальных B2B-условий — без автоматизации логики и без биллинга (Stage-2).

> Двойная польза: валидирует продукт на собственной реальной нужде + закрывает операционную потребность фаундера вести клиентов/подписки.

---

## 1. Контекст и границы

### 1.1 Используемые примитивы Choros (догфудинг — только ЖИВЫЕ)

| Примитив | Задача/ADR | Статус |
|---|---|---|
| Application / Registry / Record (трёхуровневая модель) | T-0014 | ЖИВОЙ |
| JSON Schema для `record_schema` | T-0014 FR-3 | ЖИВОЙ |
| Tenant isolation / RLS | T-0013 | ЖИВОЙ |
| Guarded transition (статусная машина) / actor_event | T-0019 | ЖИВОЙ |
| PDP `resolveFor` / grant-lattice | T-0021, T-0018 | ЖИВОЙ |
| Audit floor `audit_event` | T-0016 | ЖИВОЙ |
| Card actions (кнопки на карточке → PDP → transition/invoke) | T-0125 | ЖИВОЙ |
| Roles & assignments | T-0022 | ЖИВОЙ |
| BPMN-процесс (Flowable) + external task pattern | T-0058, T-0067 | ЖИВОЙ |
| Notifications | T-0120, T-0169–T-0173 | ЖИВОЙ |
| `activation.ts` / `verifyKey` (consumer-сторона ключа) | T-0127, T-0198 | ЖИВОЙ |

### 1.2 Что НЕ в скоупе этой спеки (явные не-цели)

- **Биллинг / автоматизация оплаты** — Stage-2 plug-in в тот же процесс.
- **Автоматизация логики индивидуальных B2B-условий** — поля хранятся, логика не автоматизируется.
- **PRODUCER-сторона `issue_entitlement`** — зона T-0242 / T-0127 (внутренности выпуска ключа сюда не входят; T-0244 только потребляет ручку).
- **Product-feature / seat-gating через ключ** — запрещено (противоречит «ключ = сервис, не заложник», choros-licensing-model).
- **Kill-switch** — ключ НИКОГДА не гейтит ядро; истёк → автономный режим.
- **Self-service клиентом** — MVP = фаундер заводит клиентов руками; нет UI для внешнего клиента.
- **Публичный/headless API** — закрыт (см. choros-product-direction-tel п.2).

### 1.3 Контракт-шов с T-0242 (зависимость)

Шаг «Выпустить ключ» в onboarding-процессе вызывает `issue_entitlement(tenant_id, plan, not_after, source)` — единственный chokepoint, определяемый T-0242/T-0127. Эта спека фиксирует **сигнатуру вызова** (входные поля), но НЕ проектирует его внутренности (signing, хранение license-записи, refresh/revoke). Зависимость T-0244 → T-0242 является **runtime-зависимостью шага процесса**, а не зависимостью типов данных: record «Клиент/Подписка» создаётся до T-0242, шаг просто вызывает ручку при onboarding.

---

## 2. Функциональные требования

### FR-1 — Application «Vendor / CRM»

Создаётся vendor-owned application с slug `vendor-crm` (или эквивалент) **в tenant фаундера** (vендорский контур Choros). Это системный application (`is_system=true` или эквивалентная маркировка), не создаётся клиентами-арендаторами.

### FR-2 — Registry «Клиент/Подписка»

Создаётся registry_def с slug `customer-subscription` в application `vendor-crm`. `record_schema` (JSON Schema) описывает запись Клиент/Подписка с полями:

| Поле | Тип | Обязательность | Семантика |
|---|---|---|---|
| `company_name` | `string` | required | Наименование компании-клиента |
| `contact_name` | `string` | required | Имя контактного лица |
| `contact_email` | `string, format: email` | required | E-mail контакта |
| `plan` | `string, enum: ["pilot","standard","enterprise"]` | required | Тарифный план (seed-набор; кастомные значения через `custom_terms`) |
| `not_after` | `string, format: date` | required | Дата окончания подписки (YYYY-MM-DD) |
| `circuit_id` | `string` | optional | ID контура клиента (заполняется при выпуске ключа) |
| `activation_key_issued_at` | `string, format: date-time` | optional | Метка выпуска ключа (ISO-8601) |
| `custom_terms` | `string` | optional | Индивидуальные B2B-условия — текстовое/структурированное поле, без автоматизации |
| `notes` | `string` | optional | Произвольные заметки фаундера |

> Поля `circuit_id` и `activation_key_issued_at` заполняются ТОЛЬКО шагом процесса «Выпустить ключ», не вручную через UI записи. Это обеспечивается ролевой моделью (грант на update этих полей — только у системного актора onboarding-процесса).

### FR-3 — Статусная машина

Запись Клиент/Подписка имеет статус из закрытого набора с guarded transitions (T-0019):

```
        ┌──────────────────────────────────────────────────┐
        │                                                  │
[draft] ──→ [trial] ──→ [active] ──→ [expired]           │
                │           │            │                 │
                └───────────┴────────────┴──→ [custom]   │
                                                           │
        [любой] ──→ [archived]  (финальный, односторонний)│
        └──────────────────────────────────────────────────┘
```

| Статус | Семантика |
|---|---|
| `draft` | Черновик — запись создана, данные не проверены |
| `trial` | Пилот/пробный период — ключ может быть выпущен или не выпущен |
| `active` | Активная подписка — ключ выпущен и действует |
| `expired` | Истёкшая подписка — срок `not_after` прошёл или статус выставлен вручную |
| `custom` | Индивидуальный режим — нестандартные условия, не вписывающиеся в другие статусы |
| `archived` | Финальный статус — запись убрана из активного вида |

Допустимые переходы (guarded, фиксируются в статусной модели T-0019):
- `draft → trial`, `draft → active`, `draft → archived`
- `trial → active`, `trial → expired`, `trial → custom`, `trial → archived`
- `active → expired`, `active → custom`, `active → archived`
- `expired → active` (продление), `expired → custom`, `expired → archived`
- `custom → active`, `custom → expired`, `custom → archived`
- Переход в `archived` финальный — из `archived` выход запрещён.

### FR-4 — BPMN Onboarding-процесс

Проектируется BPMN-процесс `customer-onboarding` (Flowable) с этапами:

```
[Start] → [User Task: Заполнить карточку клиента] 
        → [User Task: Проверить данные и согласовать] 
        → [User Task: Выпустить активационный ключ]  ← KEYSTONE STEP
        → [Service Task: Уведомить клиента]
        → [End]
```

Все User Task назначаются на роль `vendor-admin` (фаундер). Service Task уведомления использует T-0120 notification-механизм.

> Процесс — линейный, без ветвления на MVP. Ветки (отказ, продление, повторный выпуск) — вне MVP.

### FR-5 — Шаг «Выпустить активационный ключ» (KEYSTONE)

User Task «Выпустить активационный ключ» в процессе выполняет:

1. Фаундер вводит (или подтверждает из карточки): `circuit_id`, `plan`, `not_after`.
2. Шаг вызывает `issue_entitlement(circuit_id, plan, not_after, source="pilot")` — через invoke-effect (T-0024) или External Task (T-0067), в зависимости от того, как T-0242 экспонирует ручку.
3. При успехе: записывает `circuit_id` и `activation_key_issued_at` в record (update с грантом системного актора), переводит статус `→ active`.
4. При ошибке (T-0242 вернула ошибку): шаг остаётся открытым, фаундер видит причину, может повторить.
5. Ключ передаётся клиенту вне системы (email / мессенджер) — доставка вне скоупа MVP.

> **Red-line (из choros-licensing-model):** выпущенный ключ НЕ является kill-switch. Истечение `not_after` → клиент уходит в автономный режим, Choros-ядро не блокируется. Шаг «Выпустить ключ» НЕ ДОЛЖЕН ни сохранять ключ в ядре Choros-клиента, ни создавать механизм его отзыва, блокирующий ядро. Это ограничение проверяется при ревью шага и отражается в AC-10.

### FR-6 — Card actions на карточке Клиент/Подписка

Карточка записи имеет card actions (T-0125), генерируемые из статусной машины + ролевой модели:

- Кнопки-переходы по доступным statuses (из текущего статуса → допустимые, по PDP).
- Кнопка «Запустить онбординг» — запускает Flowable-процесс `customer-onboarding`, если не запущен.
- Кнопка «Просмотреть ключ» — показывает `activation_key_issued_at` и `circuit_id` (read-only), только если `activation_key_issued_at` заполнен.

### FR-7 — Ролевая модель (vendor-side)

| Роль | Права |
|---|---|
| `vendor-admin` | Полный доступ: create/read/update/delete записей, запуск процессов, просмотр всех полей |
| `vendor-readonly` | Только read-доступ к записям (для будущих ревью/аудита) |

Роли живут в **tenant фаундера** (не в тенантах клиентов). Поля `circuit_id` / `activation_key_issued_at` редактируемы только процессным актором (не через прямой UI update).

### FR-8 — Просмотр и поиск

Фаундер видит список записей Клиент/Подписка с фильтрацией по статусу. Поиск по `company_name` и `contact_email`. Записи в `archived` по умолчанию скрыты из активного вида (фильтр status != archived).

### FR-9 — Seed (начальная настройка)

Спроектированное решение должно быть провижнируемо как seed-pack (T-0140): application + registry_def + BPMN-файл + роли + гранты — как код, применяемый однократно в tenant фаундера.

---

## 3. Нефункциональные требования

### NF-1 — Только Choros-примитивы (dogfooding)

Решение строится ИСКЛЮЧИТЕЛЬНО из примитивов, перечисленных в §1.1. Запрещено вводить custom-таблицы вне registry/record модели T-0014, кастомные SQL-триггеры вне established patterns, внешние сервисы за пределами `issue_entitlement` (T-0242 контракт-шов).

### NF-2 — Tenant isolation (T-0013)

Все записи Клиент/Подписка принадлежат tenant фаундера. Cross-tenant доступ запрещён по RLS. Данные клиентов (клиентов-арендаторов) не смешиваются с этим registry.

### NF-3 — PDP-авторизация всех операций (T-0021)

Каждый переход статуса, каждое card action, каждый шаг процесса авторизован через `resolveFor`. Нет UI-флажков как авторизаторов. Fail-closed: нет гранта → denied + audit_event.

### NF-4 — Audit trail (T-0016, T-0019)

Каждый переход статуса пишет `actor_event` (T-0019). Каждое card action пишет `audit_event` (T-0016). Выпуск ключа — отдельный `audit_event` типа `customer.key_issued` с `circuit_id` и `not_after`.

### NF-5 — Ключ НЕ является kill-switch (choros-licensing-model)

Никакой механизм в этом решении не должен гейтить ядро Choros-клиента по статусу ключа. Истечение подписки = изменение статуса записи + невозможность получить новый ключ через `issue_entitlement` (logic в T-0242). Ядро клиента продолжает работать в автономном режиме.

### NF-6 — Индивидуальные условия = текст без автоматизации

Поле `custom_terms` хранится как текст/структура. Система НЕ интерпретирует его содержимое, НЕ строит по нему ветки в процессе, НЕ автоматизирует никакой логики. Чтение — только человеком.

### NF-7 — Биллинг-шов (Stage-2)

Архитектура BPMN-процесса должна допускать вставку шага «Биллинг» между «Проверить данные» и «Выпустить ключ» без переписывания процесса. Это требование к ДИЗАЙНУ (ADR), не к реализации. Architect фиксирует extension-point в ADR.

### NF-8 — Seed как код (T-0140)

Вся конфигурация решения (application, registry_def со схемой, роли, гранты, BPMN-файл) провижнируется через seed-pack механизм, не через ручные кнопки в UI. Повторный прогон seed = idempotent (no-op, если уже применён).

---

## 4. Приёмочные критерии

### AC-1 — Registry создан и защищён RLS
Registry `customer-subscription` существует в application `vendor-crm` tenant фаундера. Запрос из чужого tenant к registry возвращает пустой список (не ошибку), кросс-тенантная запись невозможна.
**Верифицируется:** test (unit/integration cross-tenant fitness, по образцу `ci/checks/cross-tenant-fitness.sh`)

### AC-2 — Record schema валидирует обязательные поля
Попытка создать запись без `company_name`, `contact_name`, `contact_email`, `plan`, `not_after` → 400 с перечислением нарушенных полей. Запись с корректными полями создаётся.
**Верифицируется:** test (unit, валидация JSON Schema)

### AC-3 — Statuses: полный набор определён
Record-schema содержит `status` с enum `{draft, trial, active, expired, custom, archived}`. Попытка записать статус вне этого набора → 400.
**Верифицируется:** test (unit)

### AC-4 — Guarded transitions: только допустимые
Переход `archived → trial` (недопустимый) через card action → PDP denied + `audit_event(denied)`. Переход `trial → active` (допустимый, при наличии гранта) → success + `actor_event` + `audit_event`.
**Верифицируется:** test (integration, через PDP + статусную модель T-0019)

### AC-5 — Archived — финальный статус
Из статуса `archived` ни одна card action с `semantics=transition` не становится visible/executable (PDP denied fail-closed, нет допустимых guarded transitions из `archived`).
**Верифицируется:** test (unit, `defaultCardActions` для `archived` status)

### AC-6 — BPMN-процесс разворачивается и стартует
BPMN `customer-onboarding` деплоится в Flowable (`deployBpmn` успех). Запуск экземпляра через `startInstance` → 200, инстанс виден в инбоксе фаундера. Шаг «Заполнить карточку» появляется в User Task инбокса для роли `vendor-admin`.
**Верифицируется:** test (integration, через Flowable REST client T-0058)

### AC-7 — Шаг «Выпустить ключ» вызывает `issue_entitlement`
При выполнении шага «Выпустить активационный ключ» система вызывает `issue_entitlement` с корректными параметрами (circuit_id, plan, not_after, source="pilot"). Успешный вызов → запись обновляется: `circuit_id` и `activation_key_issued_at` заполнены, статус → `active`.
**Верифицируется:** test (integration с mock/stub T-0242, проверяем вызов + side effects)

### AC-8 — Ошибка `issue_entitlement` → шаг не завершён, нет side effects
Если `issue_entitlement` вернула ошибку (mock) → шаг остаётся открытым (не completed), статус записи НЕ меняется, `activation_key_issued_at` НЕ заполнен.
**Верифицируется:** test (integration с mock)

### AC-9 — Поля `circuit_id` / `activation_key_issued_at` не редактируются напрямую
Попытка пользователя с ролью `vendor-admin` обновить `circuit_id` через стандартный record-update endpoint → PDP denied (поле защищено, грант на update этих полей — только у системного актора процесса).
**Верифицируется:** test (integration, role=vendor-admin, direct update → denied)

### AC-10 — Нет kill-switch механизма в решении
Статический анализ: ни один файл, добавленный T-0244, не импортирует `src/vendor/activation.ts` из пути, который исполняется в ядре клиента. `src/core/**` не получает зависимости на статус ключа через это решение.
**Верифицируется:** fitness (grep, по образцу `ci/checks/no-killswitch-in-core.sh`)

### AC-11 — Audit: выпуск ключа пишет `audit_event`
Успешное выполнение шага «Выпустить ключ» создаёт строку `audit_event` типа `customer.key_issued` с полями `circuit_id`, `not_after`, `actor` (фаундер), `tenant_id`.
**Верифицируется:** test (integration)

### AC-12 — Роль `vendor-readonly` видит записи, но не может их менять
Субъект с ролью `vendor-readonly` → `resolveFor(read)` = allowed, `resolveFor(update)` = denied. Попытка запустить процесс → denied.
**Верифицируется:** test (integration)

### AC-13 — Фильтр: `archived` скрыт по умолчанию
Запрос списка записей без явного фильтра по статусу → записи со статусом `archived` не входят в ответ. Запрос с `status=archived` явно → возвращает их.
**Верифицируется:** test (unit/integration)

### AC-14 — Seed idempotent
Повторный прогон seed-pack (application + registry_def + роли + BPMN) не создаёт дублей, не кидает ошибку, не теряет существующие данные.
**Верифицируется:** test (integration, double-run seed)

### AC-15 — Биллинг-шов задокументирован в ADR
ADR T-0244 содержит явный раздел «Extension point: billing» с описанием, куда и как вставляется шаг биллинга в BPMN-процесс в Stage-2. Это проверяется на review, не автоматически.
**Верифицируется:** manual (ревью ADR)

---

## 5. Риски и открытые вопросы (НЕ blocking)

### R-1 — T-0242 не завершена (зависимость)

T-0242 (PRODUCER-сторона `issue_entitlement`) идёт параллельно. Шаг «Выпустить ключ» в T-0244 зависит от T-0242 runtime. На время разработки T-0244 шаг реализуется с **stub/mock `issue_entitlement`** (аналог LlmPort в T-0233 и T-0234). Реальная интеграция = Phase 2 после T-0242 done.

AC-7 и AC-8 проверяются через mock. Это не blocking для спеки: архитектура шва зафиксирована, реализация ждёт T-0242.

### R-2 — Способ вызова `issue_entitlement` из шага процесса

T-0242 ещё не определила, как именно экспонирует ручку: через invoke-effect (T-0024) или как External Task (T-0067). Architect T-0244 должен выбрать контракт (или оставить dormant), согласовав с архитектом T-0242. Это зона ADR, не блокирует спеку.

### R-3 — Место хранения vendor-CRM: tenant фаундера vs выделенный vendor-tenant

MVP предполагает, что CRM живёт в **tenant фаундера** (Choros-организация вендора). Если архитект решит, что нужен отдельный vendor-только tenant — это его решение в ADR. Спека не предопределяет.

### R-4 — BPMN-уведомление клиенту о ключе

Ключ передаётся вне системы (MVP). Service Task «Уведомить клиента» — уведомление внутри системы (инбокс / email фаундеру). Уведомление самому клиенту (внешнее) — вне MVP. Architect фиксирует этот scope в ADR.

---

## 6. Зависимости

| Зависимость | Тип | Статус |
|---|---|---|
| T-0014 (registry/record model) | Платформенный примитив | DONE |
| T-0013 (tenant isolation RLS) | Платформенный примитив | DONE |
| T-0019 (actor-event, guarded transitions) | Платформенный примитив | DONE |
| T-0021 (PDP resolveFor) | Платформенный примитив | DONE |
| T-0016 (audit floor) | Платформенный примитив | DONE |
| T-0125 (card actions) | Платформенный примитив | DONE |
| T-0058 (Flowable engine bridge) | Платформенный примитив | DONE (partial) |
| T-0120 (notifications) | Платформенный примитив | DONE |
| T-0140 (seed-pack механизм) | Платформенный примитив | DONE |
| T-0127 / T-0198 (activation.ts consumer) | Платформенный примитив | DONE |
| **T-0242** (issue_entitlement PRODUCER) | **Контракт-шов (runtime)** | **IN DESIGN — stub до завершения** |

---

## 7. Зона записи (для architect/coder — ориентир)

Эта спека фиксирует ЧТО, не КАК. Architect пишет ADR с зонами записи. Ориентир:

- `seed/vendor-crm/` — application def, registry_def, grant-presets, роли
- `seed/vendor-crm/processes/customer-onboarding.bpmn` — BPMN-файл процесса
- `src/vendor/customer-subscription/` — логика шага «Выпустить ключ» (stub/live), bridge к T-0242
- Миграции: НЕ нужны отдельные таблицы (данные живут в registry/record T-0014)
- `ci/checks/no-killswitch-in-core.sh` — расширяется для нового кода (AC-10)

---

## 8. Прогон (сквозной сценарий)

> Используется для ручной приёмки MVP (AC-15-эквивалент по смыслу):

1. Фаундер создаёт запись «ООО Ромашка» в registry `customer-subscription`, статус `draft`.
2. Заполняет `company_name`, `contact_email`, `plan=pilot`, `not_after=2026-12-31`.
3. Через card action меняет статус `draft → trial`.
4. Запускает процесс «Онбординг» через card action «Запустить онбординг».
5. В инбоксе появляется задача «Заполнить карточку клиента» → выполняет (подтверждает данные).
6. Задача «Проверить данные» → выполняет.
7. Задача «Выпустить активационный ключ» → вводит `circuit_id`, подтверждает → система вызывает `issue_entitlement`, запись обновляется: `activation_key_issued_at` заполнен, статус → `active`.
8. Фаундер копирует ключ (из email / CLI / отдельного канала T-0242) и передаёт клиенту вне системы.
9. В audit log: `actor_event` (transition draft→trial, trial→active), `audit_event` (customer.key_issued).
10. Поле `circuit_id` недоступно для прямого редактирования через UI.

---

## 9. Явные не-цели (для downstream)

Architect и coder НЕ строят в рамках T-0244:
- Биллинг (Stage-2)
- Внутренности `issue_entitlement` (зона T-0242)
- Kill-switch или runtime-enforcement на стороне клиентов
- Self-service UI для клиентов
- Автоматическое продление / lifecycle по таймеру (можно задачей на будущее)
- Публичный API для создания клиентов извне
- Seat-gating через ключ
