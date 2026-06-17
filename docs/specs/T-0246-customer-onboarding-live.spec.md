# Spec · T-0246 — Customer onboarding: live wiring

**Phase:** SPEC · **Status:** ready · **Date:** 2026-06-17
**Product:** choros · **Type:** standard_code
**Branch:** `task/T-0246` (от dev e504408)
**spec_artifact_path:** `docs/specs/T-0246-customer-onboarding-live.spec.md`

---

## 0. Контекст и направление

T-0244 построил все dormant building blocks догфуд-онбординга: `EntitlementPort` type + `dormantEntitlementPort`, `runIssueKey` оркестратор, `T0242EntitlementPort` адаптер (кидает заглушку), `field-mask-guard.ts` (чистая функция), BPMN-процесс `customer-onboarding`, seed-pack, migration 073. T-0242 построил реальную producer-сторону: `issueEntitlement`/`signKey`/`FileLicenseStore` в `src/vendor/issuance.ts`.

T-0246 делает онбординг **функциональным на dev**: проводит три дормантных шва в live-режим. Задача — impl, не ре-дизайн.

**Директива фаундера:** dogfood customer-mgmt (choros-customer-subscription-mgmt.md).

---

## 1. Скоуп (три вертикали, соразмерно)

### V-1 (обязательная, приоритет): Живой `EntitlementPort`-адаптер

**Проблема:** `src/adapters/t0242-entitlement-port.ts::T0242EntitlementPort.issueEntitlement()` кидает `throw new Error(...)` — адаптер не подключён к `src/vendor/issuance.ts`.

**Решение:**
1. Переписать `T0242EntitlementPort` так, чтобы `issueEntitlement(input)` вызывал РЕАЛЬНЫЕ `issueEntitlement()` + `signKey()` из `src/vendor/issuance.ts`.
2. Конструктор принимает `{ store: LicenseStore, privKeyPem: string|Buffer }` — оба инъектируемые.
3. Env-гейт: `CUSTOMER_ONBOARDING_LIVE=true` → `liveEnabled=true` в `IssueKeyDeps` (существующий флаг в `runIssueKey`). По умолчанию (без env) → dormant fail-closed (существующий `dormantEntitlementPort`). На dev: `CUSTOMER_ONBOARDING_LIVE=true` + `VENDOR_PRIV_KEY_PATH=<path>` + `VENDOR_LEDGER_PATH=<path>`.
4. Composition root (или server.ts) при `CUSTOMER_ONBOARDING_LIVE=true` создаёт `FileLicenseStore(VENDOR_LEDGER_PATH)`, читает PEM из `VENDOR_PRIV_KEY_PATH`, конструирует `T0242EntitlementPort`, передаёт в `IssueKeyDeps`.
5. `runIssueKey` уже правильно возвращает `{circuit_id, issued_at}` из `LicenseRecord` — менять не нужно.
6. **Замечание по record-write (Step 5c):** `runIssueKey` в текущей реализации записывает намерение только через `audit_event` (Step 5c — «real field write happens when B-11 lands»). Это ограничение T-0244, T-0246 его НЕ меняет; e2e приёмка подтверждается через `audit_event(customer.key_issued)`.

**Fitness e2e против Flowable** (`fitness:flowable` + новый `flowable/customer-onboarding-smoke.sh`):
- Задеплоить `seed/vendor-crm/processes/customer-onboarding.bpmn` через `deployBpmn`.
- Запустить процесс через `startInstance`.
- Вызвать `runIssueKey` напрямую (не через Flowable UserTask completion, которой нет в HTTP-layer) с live-адаптером → ожидать `ok=true` + `audit_event(customer.key_issued)`.
- **Почему не через UserTask completion:** HTTP inbox не имеет endpoint `POST /api/inbox/:id/complete` к Flowable (задача in-memory, completeTask API не подключён). Flowable fitness e2e ограничивается deploy+startInstance (существующий паттерн smoke.sh). Полная UserTask→runIssueKey цепочка — integration-тест на уровне vitest с live адаптером против реального DB (fitness:db).

### V-2: Field-mask live в record-update PDP-пути

**Проблема:** `checkWriteMask` из `src/runtime/customer-onboarding/field-mask-guard.ts` — чистая функция, покрытая unit-тестами. Нет integration-теста, доказывающего, что при grant-resolver вызове для `vendor-admin` + попытке write `circuit_id` — PDP выдаёт denied.

**Решение (соразмерно — record-CRUD B-11 НЕ строится):**

Добавить `fitness:db` integration-тест (`ci/checks/db/field-mask-guard.test.ts`), который:
- Поднимает тестовый tenant в реальном Postgres.
- Создаёт грант `vendor-admin` с `resourceFacet` write-mask (без `circuit_id`/`activation_key_issued_at`).
- Вызывает `resolveFor` из `src/core/grant-resolver.ts` с этим грантом на `op=update`.
- Вызывает `checkWriteMask(grantWriteFacet, ["circuit_id"])` → утверждает `denied=true`.
- Документирует **hook point:** когда B-11 (record-write-path) приземлится, `PUT /api/records/:id` ОБЯЗАН вызвать `checkWriteMask(grantWriteFacet, requestedFields)` перед write → иначе FF-8 CI-check провалится.

**CI-check FF-8-hookpoint** (`ci/checks/field-mask-hookpoint.sh --self-test`):
- Статически проверяет: либо `checkWriteMask` вызывается в record-write-пути (`src/http/records.ts`, если файл существует), либо файл НЕ существует и check pass (gap документирован). Предотвращает B-11 от случайного пропуска wire-up.

### V-3: Record-CRUD endpoints — оценка соразмерности

**Оценка:** Для e2e онбординга в рамках этой задачи достаточно:
- Migration 073 уже provisionирует `application(vendor-crm)` + `registry_def(customer-subscription)`.
- Тест-рекорд создаётся в `fitness:db` integration-тесте напрямую через DB (вне record-CRUD HTTP, как demo-seed pattern).
- Нет новых REST-endpoint для record-CRUD.

**Вывод:** generic `POST/PUT/GET /api/records` — **out_of_scope как B-11**, не тащим в T-0246. Функциональный онбординг поток проверяется через unit+integration tests без HTTP record-CRUD.

---

## 2. Нефункциональные требования

- NF-1: `revoke ≠ halt` — T-0246 не вводит kill-switch (красная линия T-0127/choros-licensing-model).
- NF-2: vendor private key читается ТОЛЬКО из файла в composition root; `T0242EntitlementPort` принимает PEM-байты как аргумент. `ci/checks/vendor-priv-not-in-client-circuit.sh` остаётся зелёным.
- NF-3: Биллинг Stage-2 — НЕ трогается.
- NF-4: Прод go-live (deploy-гейт) — вне задачи.
- NF-5: `touches_frozen = false`. Byte-frozen файлы (`grant-lattice.ts`, `object-handle.ts`, `grant-resolver.ts`, `card-action.ts`) не модифицируются. `frozen-checks-immutable.sh` остаётся зелёным.
- NF-6: Аддитивность — существующие CI-чеки не ломаются; новые регистрируются в `package.json fitness`.
- NF-7: `vendor-priv-not-in-client-circuit.sh` и `vendor-private-not-committed.sh` зелёные (FF-T242-1, FF-T242-2).

---

## 3. Out of scope

- Record-CRUD REST endpoints (B-11) — отдельная follow-up задача.
- HTTP UserTask completion endpoint (`POST /api/inbox/:id/complete`) + Flowable UserTask→runIssueKey HTTP-цепочка — отдельная задача.
- Биллинг extension-point (Stage-2).
- Полный UI/CRM-экран для управления клиентами.
- Deploy (прод go-live, SSH-ключ, server provisioning).
- Revoke flow / refresh flow.
- Внешнее уведомление клиенту.

---

## 4. Критерии приёмки (machine-verifiable)

| ID | Текст | Verifiable as |
|---|---|---|
| AC-1 | `T0242EntitlementPort.issueEntitlement(input)` вызывает `issuance.issueEntitlement()` + `issuance.signKey()` из `src/vendor/issuance.ts` и возвращает `{circuit_id, issued_at}` без броска. | test |
| AC-2 | При `CUSTOMER_ONBOARDING_LIVE=false` (или переменная отсутствует), `runIssueKey` использует `dormantEntitlementPort` → возвращает `{ok:false, reason:"port_error"}`. При `CUSTOMER_ONBOARDING_LIVE=true` с live-адаптером → `{ok:true}`. | test |
| AC-3 | `T0242EntitlementPort` принимает `store: LicenseStore` + `privKeyPem: string|Buffer` в конструкторе; PEM не читается из файла внутри класса (NF-2). Проверяется `ci/checks/vendor-priv-not-in-client-circuit.sh` (FF-T242-2). | fitness |
| AC-4 | `T0242EntitlementPort.issueEntitlement()` → `LicenseRecord` с `status='active'` в `FileLicenseStore` (idempotent by `circuit_id`). Повторный вызов с тем же `circuit_id` не меняет `issued_at`. | test |
| AC-5 | Wire-string `"choros1.<...>"`, выданный через `signKey`, верифицируется `verifyKey` из `src/vendor/activation.ts` как `active` и в сроке — round-trip проходит. | test |
| AC-6 | При ошибке `T0242EntitlementPort` (например, неверный PEM) → `runIssueKey` возвращает `{ok:false, reason:"port_error"}`, `audit_event(customer.key_issue_failed)` в DB, статус записи не меняется, actor_event не пишется. | test |
| AC-7 | Успешный `runIssueKey` с live-адаптером → `audit_event(type="customer.key_issued", payload.circuit_id=<id>, payload.not_after=<date>)` в DB. | test |
| AC-8 | `ci/checks/flowable/customer-onboarding-smoke.sh`: `customer-onboarding.bpmn` деплоится в Flowable → HTTP 201. `startInstance("customer-onboarding")` → HTTP 201. | fitness |
| AC-9 | `field-mask-guard.ts` интеграция с PDP: `fitness:db` тест — `resolveFor` с грантом vendor-admin (write-facet без `circuit_id`) + `checkWriteMask(grantWriteFacet, ["circuit_id"])` → `{denied:true, reason:"system_field_write_blocked"}`. | test |
| AC-10 | `ci/checks/field-mask-hookpoint.sh`: если `src/http/records.ts` существует — `checkWriteMask` должен в нём вызываться; если файл НЕ существует — check pass (gap задокументирован). Предотвращает B-11 от пропуска wire-up. | fitness |
| AC-11 | `ci/checks/vendor-crm-seed-idempotent.sh` (FF-12, уже существует) остаётся зелёным. | fitness |
| AC-12 | `ci/checks/entitlement-port-injectable.sh` (FF-5, уже существует) остаётся зелёным после изменений адаптера. | fitness |
| AC-13 | `ci/checks/no-killswitch-in-crm.sh` (FF-7, уже существует) остаётся зелёным. | fitness |
| AC-14 | `ci/checks/vendor-priv-not-in-client-circuit.sh` (FF-T242-2, уже существует) остаётся зелёным. | fitness |

---

## 5. Декомпозиция impl (для coder)

| # | Под-задача | Зависит от | Путь |
|---|---|---|---|
| **B-1** | Переписать `T0242EntitlementPort`: конструктор `{store, privKeyPem}`, `issueEntitlement` → `issuance.issueEntitlement()` + `issuance.signKey()` | T-0242 `issuance.ts` (ЖИВОЙ) | day-1 |
| **B-2** | Composition root env-wire: `CUSTOMER_ONBOARDING_LIVE=true` → создать `FileLicenseStore` + `T0242EntitlementPort`, передать в `IssueKeyDeps.liveEnabled=true` | B-1 | day-1 |
| **B-3** | Vitest tests AC-1..AC-7: round-trip с `InMemoryLicenseStore` + реальным Ed25519 keypair | B-1 | day-1 |
| **B-4** | `ci/checks/flowable/customer-onboarding-smoke.sh` (AC-8): deploy + startInstance | BPMN существует | day-1 |
| **B-5** | `fitness:db` integration test `ci/checks/db/field-mask-guard.test.ts` (AC-9) | Postgres fixtures | day-1 |
| **B-6** | `ci/checks/field-mask-hookpoint.sh --self-test` (AC-10) | — | day-1 |
| **B-7** | Зарегистрировать B-4 и B-6 в `package.json fitness` | B-4, B-6 | day-1 |

---

## 6. Затронутые файлы

**MODIFY (аддитивно):**
- `src/adapters/t0242-entitlement-port.ts` — реализовать live adapter (B-1)
- `src/server.ts` или composition root — env-wire (B-2)
- `package.json` — зарегистрировать новые fitness checks (B-7)

**CREATE (аддитивно):**
- `src/adapters/__tests__/t0242-entitlement-port.test.ts` — unit + round-trip tests (B-3)
- `ci/checks/flowable/customer-onboarding-smoke.sh` (B-4)
- `ci/checks/db/field-mask-guard.test.ts` (B-5)
- `ci/checks/field-mask-hookpoint.sh` (B-6)

**НЕ ТРОГАЕТСЯ:**
- `src/runtime/customer-onboarding/entitlement-port.ts` (frozen port type)
- `src/runtime/customer-onboarding/issue-key.ts` (Step 5c dormant ограничение T-0244 остаётся)
- `src/runtime/customer-onboarding/field-mask-guard.ts`
- `src/core/customer-subscription/status-model.ts`
- `src/vendor/issuance.ts`, `src/vendor/activation.ts`
- `seed/vendor-crm/`, `migrations/073_vendor_crm_seed.sql`
- Byte-frozen: `grant-lattice.ts`, `object-handle.ts`, `grant-resolver.ts`, `card-action.ts`
- `constitution/`, `agents/`
