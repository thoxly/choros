# ADR · T-0163 — No process.env in src/core/ — full sweep

**Phase:** DESIGN
**Status:** ready
**Product:** Choros · Purity / composition root boundary
**Base:** dev (T-0143 merged) · branch `task/T-0163`
**Spec:** `docs/specs/T-0163-no-env-in-core.spec.md` (7 AC, ready) +
`docs/specs/T-0163.spec.contract.json`
**Born from:** T-0143 ADR §Amendment R-1 SCOPE NOTE — "full src/core/ sweep is a
separate task once flowable-client.ts env reads are removed"

---

## 1. Context

T-0143 established NF-1: `process.env` reads live exclusively in `src/main.ts`.
Its CI check (`keyed-digest-core-purity.sh`) was intentionally scoped to three
masking modules because `src/core/flowable-client.ts` legitimately read three env
vars at construction time (lines 264/269/274), making a full `src/core/` sweep
impossible. This task removes those violations and enforces the invariant over the
entire `src/core/` tree.

**Confirmed violations (code-grep, not comment):**

| File | Line | Variable |
|------|------|----------|
| `src/core/flowable-client.ts` | 264 | `FLOWABLE_BASE_URL` |
| `src/core/flowable-client.ts` | 269 | `FLOWABLE_REST_APP_ADMIN_USER_ID` |
| `src/core/flowable-client.ts` | 274 | `FLOWABLE_REST_APP_ADMIN_PASSWORD` |

All other `src/core/` files are clean: `keyed-digest.ts:11` and
`data-classification.ts:347` are comment-only mentions, confirmed by grep.

---

## 2. Decision

### 2.1 flowable-client.ts — remove env fallbacks, keep sane literal defaults

Three env-reads are removed from `makeFlowableClient`. Post-change:

- **`baseUrl`**: `config?.baseUrl ?? "http://flowable:8082/flowable-rest/service"` —
  literal default survives; env read removed. Callers that pass nothing get a
  sensible container address but no hidden env capture.
- **`adminUser`**: `config?.adminUser ?? "admin"` — literal default unchanged;
  env read removed. `"admin"` is a public Flowable default, not a secret.
- **`adminPassword`**: `config?.adminPassword` only; if absent, throws
  `Error("FLOWABLE_REST_APP_ADMIN_PASSWORD is required")` (error message unchanged,
  env read removed). Fail-loud on missing secret stays as-is.

**Sигнатура `makeFlowableClient(config?: Partial<FlowableClientConfig>)` не
меняется.** Интерфейс `FlowableClientConfig` не меняется. Изменение НЕ breaking
для любого вызова, передающего полный явный конфиг (lifecycle-bridge.ts). Вызовы
без аргументов (`bridge-runner.ts:44`, `bridge-smoke-runner.ts:76`) продолжат
выбрасывать на отсутствующем пароле — но теперь потому, что пароль не передан,
а не потому что env пуст. Семантика идентична при наличии/отсутствии пароля в env.

**Breaking-анализ:**
- Callers, передающие полный конфиг: ноль изменений.
- Callers без аргументов при НАЛИЧИИ `FLOWABLE_BASE_URL` и
  `FLOWABLE_REST_APP_ADMIN_USER_ID` в env: получат литеральный дефолт вместо
  env-значения. Оба файла (`bridge-runner.ts`, `bridge-smoke-runner.ts`) обновятся
  по §2.2 ниже — поэтому реальный breaking = 0.
- Тест `flowable-client.test.ts:298-309`: удаляет env-пароль, вызывает
  `makeFlowableClient({ baseUrl: "http://x", adminUser: "u" })`. До изменения
  throws потому что env пуст; после — throws потому что `adminPassword` не передан.
  Сообщение об ошибке идентично, тест не нужно менять.

### 2.2 bridge-runner.ts и bridge-smoke-runner.ts — явный конфиг

Оба файла заменяют `makeFlowableClient()` на `makeFlowableClient({ baseUrl, adminUser, adminPassword })`
с явным чтением env локально — по образцу `lifecycle-bridge.ts:190-211`.

`bridge-smoke-runner.ts` уже имеет готовые значения на строках 259-261:
```ts
const baseUrl = process.env["FLOWABLE_BASE_URL"] ?? "http://localhost:18085/flowable-rest/service";
const adminUser = process.env["FLOWABLE_REST_APP_ADMIN_USER_ID"] ?? "admin";
const adminPass = process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"] ?? "choros_flowable_dev_pw";
```
Строка 76 обновляется до `makeFlowableClient({ baseUrl, adminUser, adminPassword: adminPass })`.

`bridge-runner.ts` читает аналогичные переменные и строит конфиг на месте:
```ts
const baseUrl = process.env["FLOWABLE_BASE_URL"] ?? "http://flowable:8082/flowable-rest/service";
const adminUser = process.env["FLOWABLE_REST_APP_ADMIN_USER_ID"] ?? "admin";
const adminPassword = process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"];
// makeFlowableClient({ baseUrl, adminUser, adminPassword }) — выбросит если adminPassword undefined
```

`src/server/lifecycle-bridge.ts` — без изменений (уже корректен).

### 2.3 CI-чек — новый файл no-env-in-core.sh (НЕ расширение keyed-digest-core-purity.sh)

**Решение: новый файл `ci/checks/no-env-in-core.sh`.**

Причина: `keyed-digest-core-purity.sh` имеет заголовок `# T-0143 ·` — он
принадлежит задаче T-0143. `frozen-checks-immutable.sh` (T-0146) читает
владельца из BASE_REF (строка 2 файла) и запрещает правку чужого чека на
task-ветке. Модификация `keyed-digest-core-purity.sh` вызовет FF-FCI1 FAIL.
Новый файл — это FF-FCI4 (ADD, разрешено).

**Что делает новый чек:**
- Сканирует весь `src/core/` рекурсивно (не отдельные файлы).
- Стрипает comment-only строки (тот же паттерн `^[[:space:]]*(//|[*]|/[*)`)`.
- grep на `process\.env` по оставшимся code-строкам.
- Positive self-test: создаёт временный `.tmp.ts` в `src/core/`, проверяет
  что planted violation детектируется; на EXIT удаляет файл через `trap`.
- Negative self-test: comment-only строка не триггерит матч.
- Выходит 0 при PASS, 1 при нарушении, 2 если self-test сломан.

**package.json fitness**: добавить `&& bash ci/checks/no-env-in-core.sh` перед
`frozen-checks-immutable.sh`.

**Старый чек `keyed-digest-core-purity.sh`** остаётся без изменений (frozen;
его SCOPE NOTE про blocker станет исторически верным, но не сломает ничего —
он по-прежнему зелёный, т.к. три файла, которые он проверяет, пусты от env).

---

## 3. Отклонённые альтернативы

| Вариант | Причина отклонения |
|---------|--------------------|
| Расширить `keyed-digest-core-purity.sh` до full `src/core/` | Файл принадлежит T-0143; `frozen-checks-immutable.sh` заблокирует правку на task-ветке (FF-FCI1 FAIL). |
| Переименовать `keyed-digest-core-purity.sh` → `no-env-in-core.sh` | Rename = CDMRT diff-filter — frozen-guard видит это как modification чужого файла (FF-FCI5). |
| Вынести env-хелпер `makeFlowableClientFromEnv` в отдельный файл (`src/server/flowable-client-env.ts`) | Избыточно: bridge-runner и bridge-smoke-runner уже читают env локально. Дополнительный файл — лишний слой без пользы. Spec §2.1 прямо говорит: читать env inline. |
| Удалить literal default для `baseUrl` (сделать обязательным полем) | Breaking для composition root при отсутствии env — более инвазивно. Спека явно сохраняет литеральный дефолт. |
| Оставить `adminUser` env-читалкой (единственный non-secret) | `"admin"` — это публичный Flowable default, не секрет. Env-читалка в core нарушает инвариант NF-1 даже для не-секретных переменных. Литерал семантически точнее. |

---

## 4. Object model (изменяемые единицы)

| Сущность | Изменение |
|----------|-----------|
| `src/core/flowable-client.ts` | Удалить 3 `process.env` reads (строки 264/269/274); ввести literal defaults для baseUrl и adminUser; adminPassword: throw если не передан |
| `src/bridge-runner.ts` | Строка 44: `makeFlowableClient()` → `makeFlowableClient({ baseUrl, adminUser, adminPassword })` + локальный env-read |
| `src/bridge-smoke-runner.ts` | Строка 76: `makeFlowableClient()` → `makeFlowableClient({ baseUrl, adminUser, adminPassword: adminPass })` (переменные 259-261 уже есть) |
| `ci/checks/no-env-in-core.sh` (NEW) | Новый fitness-чек, T-0163 owner. Полный src/core/ sweep с self-tests |
| `package.json` (scripts.fitness) | Добавить `&& bash ci/checks/no-env-in-core.sh` |

---

## 5. Contracts

- `makeFlowableClient(config?: Partial<FlowableClientConfig>): FlowableClient` —
  сигнатура неизменна. При полном конфиге поведение идентично. При zero-args
  выбрасывает `Error("FLOWABLE_REST_APP_ADMIN_PASSWORD is required")` (env не
  читается).
- `bridge-runner.ts:44` — передаёт полный конфиг явно; `process.env` читается
  локально в `src/` scope.
- `bridge-smoke-runner.ts:76` — то же; использует уже существующие локальные
  переменные `baseUrl/adminUser/adminPass`.
- `ci/checks/no-env-in-core.sh` — owner T-0163; header строка 2 = `# T-0163 ·`;
  добавлен в `npm run fitness`.
- `keyed-digest-core-purity.sh` — не трогается; остаётся зелёным (три
  masking-модуля пусты от env — это не менялось).

---

## 6. Fitness-функции

### FF-T163-1 — makeFlowableClient с полным конфигом неизменен (AC-1)
**Правило:** вызов с явным `{baseUrl, adminUser, adminPassword, ...}` возвращает
тот же клиент, тот же `auth`-заголовок, тот же `extJobUrl`.
**CI:** `vitest src/__tests__/flowable-client.test.ts` и
`flowable-client.adversarial.test.ts` — зелёные без изменений.

### FF-T163-2 — zero-args throws на отсутствующем пароле (AC-2)
**Правило:** `makeFlowableClient()` (ноль аргументов) выбрасывает
`Error("FLOWABLE_REST_APP_ADMIN_PASSWORD is required")`. Env не читается.
**CI:** юнит-тест `expect(() => makeFlowableClient()).toThrow(...)` — новый кейс
в `flowable-client.test.ts`; existing тест 299-309 остаётся зелёным.

### FF-T163-3 — полный no-env sweep src/core/ (AC-3)
**Правило:** `grep -rn "process\.env" src/core/` — ноль code-line matches.
**CI:** `ci/checks/no-env-in-core.sh` — exit 0 на задаче.

### FF-T163-4 — positive self-test нового чека (AC-4)
**Правило:** planted violation в `src/core/` → exit 1. Planted violation не
найден → exit 2.
**CI:** логика внутри `no-env-in-core.sh`; временный `.tmp.ts` создаётся и
удаляется через `trap 'rm -f "$TMP_PLANT"' EXIT` — нет постоянного мусора.

### FF-T163-5 — T-0143 suite зелёный (AC-5)
**Правило:** `npm test` зелёный; keyed-digest-e2e, hash-oracle, data-classification,
grant-resolver, main-wired-entry — зелёные без изменений.
**CI:** `npm test`.

### FF-T163-6 — bridge-runner/bridge-smoke-runner читают env локально (AC-6)
**Правило:** оба файла строят конфиг из `process.env` в своём `src/` scope
и передают явным аргументом. `npx tsc --noEmit` зелёный.
**CI:** `tsc --noEmit`.

### FF-T163-7 — чек обновлён и зарегистрирован (AC-7)
**Правило:** `ci/checks/no-env-in-core.sh` существует с заголовком T-0163;
`npm run fitness` включает его вызов.
**CI:** grep в package.json scripts.fitness + существование файла.

---

## 7. Трассируемость

| AC | Покрыто |
|----|---------|
| AC-1 | §2.1 поведение с полным конфигом; FF-T163-1 |
| AC-2 | §2.1 adminPassword throw без env; FF-T163-2 |
| AC-3 | §2.1 удаление 3 env-reads; §2.3 new check; FF-T163-3 |
| AC-4 | §2.3 positive self-test + trap pattern; FF-T163-4 |
| AC-5 | §2.1 NF-no-change; §2.2 bridge callers updated; FF-T163-5 |
| AC-6 | §2.2 bridge-runner/bridge-smoke-runner конфиг; FF-T163-6 |
| AC-7 | §2.3 new file + package.json; FF-T163-7 |

---

## 8. Runtime target

Без изменений инфраструктуры. Три env-переменных
(`FLOWABLE_BASE_URL`, `FLOWABLE_REST_APP_ADMIN_USER_ID`,
`FLOWABLE_REST_APP_ADMIN_PASSWORD`) продолжают читаться в composition root —
теперь явно в `bridge-runner.ts`, `bridge-smoke-runner.ts`, `lifecycle-bridge.ts`
(уже). Поведение в production container идентично.

---

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
