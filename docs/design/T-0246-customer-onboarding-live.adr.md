# ADR · T-0246 — Customer onboarding: live wiring

**Phase:** DESIGN · **Status:** ready · **Date:** 2026-06-17
**Product:** choros · **Type:** standard_code
**Branch:** `task/T-0246` (от dev e504408)
**Spec:** `docs/specs/T-0246-customer-onboarding-live.spec.md`
**adr_artifact_path:** `docs/design/T-0246-customer-onboarding-live.adr.md`

---

## 1. Контекст

T-0244 построил dormant building blocks dogfood-онбординга; T-0242 — реальную
producer-сторону (`issueEntitlement`/`signKey`/`FileLicenseStore`/`verifyKey`).
Швы между ними дормантны. T-0246 проводит **два** дормантных шва в live-режим
(V-1 живой `EntitlementPort`-адаптер; V-2 field-mask в PDP-путь) и **явно
откладывает** третий (V-3 record-CRUD REST) как B-11 follow-up. Это **impl-проводка,
не ре-дизайн** — контракт-швы T-0244/T-0242 заморожены и не трогаются.

Ключевые факты из реального кода (прочитаны):

- `src/runtime/customer-onboarding/issue-key.ts::runIssueKey` уже корректно делает
  live-gate (`deps.liveEnabled ? deps.entitlement : dormantEntitlementPort`),
  catch-all на `port.issueEntitlement`, пишет `audit_event(customer.key_issued)` /
  `customer.key_issue_failed`, возвращает `{circuit_id, issued_at}`. **Не меняется.**
- `runIssueKey` сейчас **не имеет ни одного live-вызывающего** в non-test коде
  (HTTP UserTask-completion endpoint отсутствует — это B-11 граница). Значит
  «composition root» для live-проводки = отдельная env-читающая фабрика, а не
  врезка в `server.ts` (385 строк, не строит `IssueKeyDeps`).
- Контракт-шов `IssueEntitlementInput` (`plan: string`, `source: string`) ≠
  vendor `IssueParams` (`plan: PlanSpec`, `source: "pilot"|"billing"|"trial"|"saas"`).
  Маппинг строки-плана → `PlanSpec` пресет — обязанность адаптера.
- FF-5(c) (`entitlement-port-injectable.sh`) запрещает SDK/fetch/http импорты в
  `src/runtime/customer-onboarding/**` и `src/core/customer-subscription/**` —
  адаптер в `src/adapters/` ВНЕ этой зоны, а `issuance.ts` использует только
  `node:crypto` (нет fetch). Зелёный сохраняется автоматически.
- FF-7(2) (`no-killswitch-in-crm.sh`) запрещает импорт `src/vendor` в
  `issue-key.ts`. Адаптер в `src/adapters/` НЕ покрыт правилом (2); импорт
  `issuance.js` там разрешён. Адаптер по-прежнему НЕ импортирует `activation.ts`
  (FF-7(1) проверяет `t0242-entitlement-port.ts` явно — round-trip-тест из V-1
  импортирует `verifyKey` в ТЕСТЕ, не в адаптере).

---

## 2. Решение

### 2.1 V-1 — живой `T0242EntitlementPort` (B-1)

Переписать `src/adapters/t0242-entitlement-port.ts` так, чтобы класс был
тонким мостом порт→producer-API, со всеми зависимостями инъектированными:

```ts
// src/adapters/t0242-entitlement-port.ts  (MODIFY, аддитивно по смыслу)
import {
  issueEntitlement as vendorIssueEntitlement,
  signKey,
  PILOT_PLAN, PRO_PLAN,
  type LicenseStore, type IssueParams, type PlanSpec,
} from "../vendor/issuance.js";
import type {
  EntitlementPort, IssueEntitlementInput, LicenseRecord,
} from "../runtime/customer-onboarding/entitlement-port.js";

export interface T0242EntitlementPortDeps {
  readonly store: LicenseStore;          // инъекция (FileLicenseStore | InMemory)
  readonly privKeyPem: string | Buffer;  // PEM приходит АРГУМЕНТОМ (NF-2)
  readonly now?: () => Date;              // injectable clock (default () => new Date())
}

export class T0242EntitlementPort implements EntitlementPort {
  constructor(private readonly deps: T0242EntitlementPortDeps) {}

  async issueEntitlement(input: IssueEntitlementInput): Promise<LicenseRecord> {
    const now = (this.deps.now ?? (() => new Date()))();
    // (1) map порт-вход → vendor IssueParams
    const params: IssueParams = {
      circuit_id: input.circuit_id,
      plan: planSpecFor(input.plan),          // string → PlanSpec пресет
      valid_from: input.valid_from,
      valid_until: input.valid_until,
      source: vendorSourceFor(input.source),  // narrow к vendor union (fail-closed "pilot")
      notes: input.notes,
    };
    // (2) реальный producer-вызов: запись ledger (idempotent by circuit_id)
    const rec = vendorIssueEntitlement(params, this.deps.store, now);
    // (3) подпись wire-key (priv PEM — аргумент signKey, НЕ читается классом)
    void signKey(rec, this.deps.privKeyPem, now);  // round-trip-able; throws on revoked
    // (4) вернуть минимальную форму, которую читает T-0244 (circuit_id, issued_at)
    return rec as unknown as LicenseRecord;        // vendor LicenseRecord ⊇ port LicenseRecord
  }
}

function planSpecFor(plan: string): PlanSpec {
  return plan === "pro" ? PRO_PLAN : PILOT_PLAN;   // default pilot (fail-safe)
}
function vendorSourceFor(s: string): IssueParams["source"] {
  return (["pilot","billing","trial","saas"] as const).includes(s as never)
    ? (s as IssueParams["source"]) : "pilot";
}
```

Заметки:
- `signKey` вызывается, чтобы доказать round-trip-способность выданного ключа
  (AC-5 проверяет это в тесте через `verifyKey`); сам wire-string в текущей фазе
  не персистится в record (это B-11 / refresh-flow). Вызов держит signer-путь
  живым и кусается при revoked-record.
- vendor `LicenseRecord` структурно содержит `circuit_id` + `issued_at` + индекс-
  сигнатуру → присваиваемо к порт-`LicenseRecord` (T-0244 читает ТОЛЬКО эти два).
- PEM/store **никогда** не читаются внутри класса — приходят в конструктор.
  `vendor-priv-not-in-client-circuit.sh` (FF-T242-2) проверяет, что
  `createPrivateKey`/`readFileSync(*.pem)` НЕ появляются в адаптере — они и не
  появятся (createPrivateKey живёт в `issuance.ts`, чтение PEM — в composition root).

### 2.2 V-1 — composition root (B-2)

Live-проводка живёт в новом тонком модуле `src/composition/issue-key-live.ts`
(НЕ в `server.ts`, т.к. live-вызывающего runIssueKey пока нет — B-11 граница;
зеркалит паттерн `src/runtime/legal-precheck/demo-run.ts`).

```ts
// src/composition/issue-key-live.ts  (CREATE)
import { readFileSync } from "node:fs";
import { FileLicenseStore } from "../vendor/file-license-store.js";
import { T0242EntitlementPort } from "../adapters/t0242-entitlement-port.js";
import { dormantEntitlementPort, type EntitlementPort }
  from "../runtime/customer-onboarding/entitlement-port.js";

export interface LiveEntitlementWiring {
  readonly entitlement: EntitlementPort;
  readonly liveEnabled: boolean;
}

/** Reads env at composition time; live ⟺ CUSTOMER_ONBOARDING_LIVE==="true". */
export function makeEntitlementWiring(
  env: NodeJS.ProcessEnv = process.env,
): LiveEntitlementWiring {
  if (env["CUSTOMER_ONBOARDING_LIVE"] !== "true") {
    return { entitlement: dormantEntitlementPort, liveEnabled: false };
  }
  const ledgerPath = requireEnv(env, "VENDOR_LEDGER_PATH");
  const privKeyPath = requireEnv(env, "VENDOR_PRIV_KEY_PATH");
  const store = new FileLicenseStore(ledgerPath);
  const privKeyPem = readFileSync(privKeyPath, "utf8"); // PEM read ТОЛЬКО здесь
  return {
    entitlement: new T0242EntitlementPort({ store, privKeyPem }),
    liveEnabled: true,
  };
}
```

Важно по FF-T242-2 (с): чек `(c)` ловит `readFileSync` рядом со словом
`priv`/`.pem` ВНЕ `src/cli/issue-key.ts`. `readFileSync(privKeyPath, "utf8")`
где `privKeyPath` — переменная с `priv` в имени → **поймается** (FAIL). →
**Дизайн-решение:** composition root, который читает priv PEM из файла,
размещается в `src/cli/` (единственная разрешённая зона по FF-T242-2(c)), либо
переменная читается без `priv`/`.pem` в литерале. Каноничный вариант — **поместить
env-чтение PEM в `src/cli/issue-key-live.ts`** (расширяет уже-разрешённый
`src/cli/issue-key.ts` namespace), а `src/composition/issue-key-live.ts` принимает
уже-прочитанный PEM аргументом. См. §2.5 (двухслойная композиция) — это снимает
конфликт с FF-T242-2 без правки чужого чека (NF-7).

### 2.3 V-2 — field-mask live в PDP-путь (B-5, B-6)

`checkWriteMask` — чистая функция (T-0244), покрытая unit-тестами. T-0246
доказывает её интеграцию с реальным PDP и фиксирует hook-point для B-11:

- **fitness:db тест** (`ci/checks/db/field-mask-guard.test.ts`, AC-9):
  поднять test-tenant в Postgres; создать грант `vendor-admin` с `resourceFacet`
  write-mask без `circuit_id`/`activation_key_issued_at`; вызвать `resolveFor`
  (`op=update`) → allowed; извлечь write-facet (`grantFacetFields` shape
  `{fields:string[]}`); `checkWriteMask(writeFacet, ["circuit_id"])` →
  `{denied:true, reason:"system_field_write_blocked", blockedFields:["circuit_id"]}`.
  Зеркальная allow-проба: `checkWriteMask(writeFacet, ["plan"])` → `{denied:false}`
  (anti-test-theatre — гейт кусается обоими концами).

- **hook-point CI-check** (`ci/checks/field-mask-hookpoint.sh --self-test`, AC-10):
  статически — ЕСЛИ `src/http/records.ts` существует, в нём ОБЯЗАН встречаться
  вызов `checkWriteMask(`; иначе (файла нет) → PASS с задокументированным gap.
  `--self-test`: посадить временный `records.ts` БЕЗ вызова → check ловит (exit≠0
  в demo), затем С вызовом → проходит; убрать. Предотвращает B-11 от пропуска
  wire-up.

### 2.4 V-1 — fitness e2e против Flowable (B-4)

`ci/checks/flowable/customer-onboarding-smoke.sh` (AC-8), зеркалит `smoke.sh`:
1. deploy `seed/vendor-crm/processes/customer-onboarding.bpmn` через REST →
   assert HTTP 201.
2. `startInstance(processDefinitionKey="customer-onboarding")` → assert HTTP 201.
- НЕ гоняет UserTask-completion (HTTP endpoint отсутствует — out_of_scope §3);
  полная UserTask→runIssueKey цепочка покрыта vitest+fitness:db с live-адаптером.
Зарегистрировать B-4 в `fitness:flowable`, B-6 в `fitness` (B-7).

### 2.5 Двухслойная композиция (разрешает FF-T242-2(c) без правки чужого чека)

- **Слой env-чтения PEM** → `src/cli/issue-key-live.ts` (CREATE; namespace
  `src/cli/` уже разрешён FF-T242-2(c) для `readFileSync` priv-PEM). Экспортирует
  `loadVendorPrivPem(env)` → `string`.
- **Слой проводки портов** → `src/composition/issue-key-live.ts` (CREATE; НЕ читает
  файлы — принимает PEM + ledgerPath, строит `FileLicenseStore` +
  `T0242EntitlementPort`). `FileLicenseStore` сам делает `readFileSync` ledger-
  JSON, но без `priv`/`.pem` в литерале — FF-T242-2(c) не срабатывает (он скоупит
  на priv-контекст и `.pem`-расширение, не на любой readFileSync).
- **Адаптер** → `src/adapters/t0242-entitlement-port.ts` (MODIFY; PEM/store
  аргументы, ноль file-IO, ноль fetch).

Это держит ВСЕ frozen/red-line чеки зелёными аддитивно (NF-5/6/7) и не врезается
в `server.ts`.

---

## 3. Rejected alternatives

| Вариант | Почему нет |
|---|---|
| Врезать live-проводку прямо в `server.ts` | runIssueKey не имеет live-вызывающего (нет HTTP UserTask-completion — B-11 граница); врезка добавила бы мёртвый код в 385-строчный composition root и размазала env-чтение. Отдельная фабрика чище и тестируемее (паттерн legal-precheck/demo-run.ts). |
| Читать PEM/ledger ВНУТРИ `T0242EntitlementPort` | Нарушает NF-2 и FF-T242-2 (priv-key вне клиентского контура); сделало бы класс непокрываемым InMemory-стором в unit-тестах. PEM/store — инъекция. |
| Реализовать record-CRUD REST + HTTP UserTask-completion в T-0246 | Это B-11 — generic record-write-path + Flowable completeTask API. Несоразмерно: e2e онбординг доказывается unit+fitness:db+flowable-smoke без HTTP record-CRUD. Явный deferral (§5). |
| Физически писать `circuit_id` в record.data в runIssueKey (снять Step-5c ограничение) | Step-5c («real field write when B-11 lands») — ограничение T-0244, спека запрещает менять issue-key.ts. e2e приёмка через `audit_event(customer.key_issued)`. |
| Расширить FF-T242-2(c) allow-list под новый composition-файл | Правка чужого frozen-чека = frozen-thaw (нужна санкция). Двухслойная композиция (§2.5) кладёт PEM-чтение в уже-разрешённый `src/cli/` namespace — аддитивно, без правки предиката. |
| Маппинг plan-string→PlanSpec в issue-key.ts | issue-key.ts заморожен и не должен знать vendor PlanSpec; маппинг — обязанность адаптера (граница порт↔producer). |

---

## 4. Object model

(T-0246 не вводит новых таблиц/persisted-сущностей — это проводка. Модель ниже —
рантайм-конструкции/инъектируемые формы.)

- **T0242EntitlementPortDeps** (новая инъекция-форма): `store: LicenseStore`,
  `privKeyPem: string|Buffer`, `now?: () => Date`.
- **LiveEntitlementWiring** (новая фабрика-форма): `entitlement: EntitlementPort`,
  `liveEnabled: boolean`.
- **IssueEntitlementInput** (frozen, T-0244, не меняется): `circuit_id`, `plan`,
  `valid_from`, `valid_until`, `source`, `notes?`.
- **LicenseRecord** (vendor, T-0242, читается T-0244 как `{circuit_id, issued_at}`).

---

## 5. Out of scope (явные deferrals)

- **V-3 / B-11:** generic record-CRUD REST (`POST/PUT/GET /api/records`,
  `src/http/records.ts`) + HTTP UserTask-completion (`POST /api/inbox/:id/complete`
  → Flowable completeTask → runIssueKey). Hook-point для field-mask зарезервирован
  CI-чеком `field-mask-hookpoint.sh`. Физ-запись `circuit_id` в record.data
  (Step-5c) приземляется здесь.
- Биллинг extension-point (Stage-2); revoke/refresh flow; внешнее уведомление
  клиенту; прод go-live/deploy (SSH/server); UI/CRM-экран.

---

## 6. Traceability (AC → артефакт)

| AC | Покрывается |
|---|---|
| AC-1 | `T0242EntitlementPort.issueEntitlement` зовёт `issuance.issueEntitlement`+`signKey`, возвращает `{circuit_id, issued_at}` без броска (B-1; test FF-1). |
| AC-2 | live-gate в runIssueKey не меняется; `CUSTOMER_ONBOARDING_LIVE` env-гейт в `makeEntitlementWiring` → live vs dormant (B-2; test FF-2). |
| AC-3 | конструктор `{store, privKeyPem}`, PEM не читается в классе; `vendor-priv-not-in-client-circuit.sh` (FF-9). |
| AC-4 | idempotent by `circuit_id` (vendor `issueEntitlement` upsert preserves `issued_at`); повторный вызов не меняет `issued_at` (B-3; test FF-3). |
| AC-5 | `signKey`-выданный wire-string `verifyKey`-ится как `active` round-trip (B-3; test FF-4). |
| AC-6 | неверный PEM → adapter throws → runIssueKey `{ok:false, reason:"port_error"}` + `audit_event(customer.key_issue_failed)`, статус не меняется, actor_event не пишется (B-3; test FF-5). |
| AC-7 | успех → `audit_event(customer.key_issued, payload.circuit_id, payload.not_after)` (B-3; test FF-6). |
| AC-8 | `customer-onboarding-smoke.sh`: deploy 201 + startInstance 201 (B-4; FF-7). |
| AC-9 | fitness:db `field-mask-guard.test.ts`: resolveFor + checkWriteMask → `{denied:true}` + allow-проба (B-5; FF-8). |
| AC-10 | `field-mask-hookpoint.sh --self-test`: records.ts-есть⇒вызов обязателен / нет⇒pass (B-6; FF-10). |
| AC-11 | `vendor-crm-seed-idempotent.sh` остаётся зелёным (FF-11; не трогаем seed). |
| AC-12 | `entitlement-port-injectable.sh` остаётся зелёным после правки адаптера (FF-12; адаптер вне зоны (c), сигнатура порта не меняется). |
| AC-13 | `no-killswitch-in-crm.sh` остаётся зелёным (FF-13; адаптер не импортирует activation.ts; issue-key.ts не импортирует vendor). |
| AC-14 | `vendor-priv-not-in-client-circuit.sh` остаётся зелёным (FF-9; PEM-чтение только в src/cli/). |

---

## 7. Fitness functions

| ID | Rule | ci_check |
|---|---|---|
| FF-1 | adapter живой: `issueEntitlement` зовёт vendor `issueEntitlement`+`signKey`, возвращает `{circuit_id, issued_at}` без броска | `vitest run src/adapters/__tests__/t0242-entitlement-port.test.ts` (AC-1) |
| FF-2 | env-гейт: `CUSTOMER_ONBOARDING_LIVE!="true"`⇒dormant `{ok:false,"port_error"}`; `="true"`+live-adapter⇒`{ok:true}` | `vitest` (AC-2) |
| FF-3 | idempotent by circuit_id: повторный вызов сохраняет `issued_at` | `vitest` (AC-4) |
| FF-4 | round-trip: `signKey`-wire `verifyKey`-ится `active` в сроке | `vitest` (AC-5) |
| FF-5 | bad PEM⇒adapter throws⇒runIssueKey `{ok:false,"port_error"}`+`key_issue_failed`, без actor_event | `vitest` / `fitness:db` (AC-6) |
| FF-6 | успех⇒`audit_event(customer.key_issued, circuit_id, not_after)` | `fitness:db` (AC-7) |
| FF-7 | flowable e2e: deploy customer-onboarding.bpmn 201 + startInstance 201 | `bash ci/checks/flowable/customer-onboarding-smoke.sh` (AC-8) |
| FF-8 | PDP+mask: resolveFor(vendor-admin,update)+checkWriteMask(["circuit_id"])⇒denied; (["plan"])⇒allowed | `vitest run ci/checks/db/field-mask-guard.test.ts` (fitness:db, AC-9) |
| FF-9 | vendor priv-key вне клиентского контура (адаптер: no createPrivateKey/readFileSync .pem) | `bash ci/checks/vendor-priv-not-in-client-circuit.sh && --self-test` (AC-3/AC-14) |
| FF-10 | field-mask hook-point: records.ts⇒checkWriteMask обязателен; нет файла⇒pass(gap) | `bash ci/checks/field-mask-hookpoint.sh && --self-test` (AC-10) |
| FF-11 | vendor-crm seed idempotent (не регрессирует) | `bash ci/checks/vendor-crm-seed-idempotent.sh` (AC-11) |
| FF-12 | entitlement-port injectable (не регрессирует) | `bash ci/checks/entitlement-port-injectable.sh && --self-test` (AC-12) |
| FF-13 | no-killswitch-in-crm (не регрессирует) | `bash ci/checks/no-killswitch-in-crm.sh && --self-test` (AC-13) |

Регистрация (B-7): FF-7 → `fitness:flowable`; FF-10 → `fitness`; FF-1..6/FF-8 →
vitest/`fitness:db` (уже подхватываются `--dir ci/checks/db` и общим `vitest run`).

---

## 8. Границы (NF)

- NF-1 `revoke≠halt`: T-0246 не вводит kill-switch; revoke/refresh out_of_scope.
- NF-2/NF-7: vendor priv-key читается ТОЛЬКО в `src/cli/`; адаптер принимает PEM
  аргументом; `vendor-priv-not-in-client-circuit.sh` + `vendor-private-not-committed.sh`
  зелёные.
- NF-5 `touches_frozen=false`: byte-frozen (`grant-lattice.ts`, `object-handle.ts`,
  `grant-resolver.ts`, `card-action.ts`) и issue-key.ts/entitlement-port.ts/
  field-mask-guard.ts/issuance.ts/activation.ts не модифицируются;
  `frozen-checks-immutable.sh` зелёный.
- NF-6: новые чеки аддитивно регистрируются; чужие предикаты не правятся.

**runtime_target:** `src/adapters/t0242-entitlement-port.ts` (live adapter) +
`src/composition/issue-key-live.ts` + `src/cli/issue-key-live.ts` (composition root),
gated by `CUSTOMER_ONBOARDING_LIVE`; field-mask hook-point reserved for B-11
record-write-path.
