# Spec · T-0163 — Вынести env-чтения из src/core/flowable-client.ts в composition root + полный no-env-in-core fitness-инвариант

**Phase:** SPEC
**Status:** ready
**Product:** Choros · Purity / composition
**Base:** dev
**Born from:** T-0143 ADR §9 Amendment R-1 SCOPE NOTE + T-0143.review.md

---

## 1. Контекст

T-0143 (keyed-digest-request-path) установил инвариант: `process.env` — только в
`src/main.ts`. Но существующий CI-чек (`ci/checks/keyed-digest-core-purity.sh`)
намеренно сужен до трёх masking-модулей, потому что `src/core/flowable-client.ts`
**уже** читает `process.env` в трёх точках (строки 264, 269, 274 на момент
написания задачи), делая полный sweep `src/core/` невозможным. Эта задача
устраняет нарушения и расширяет чек до полного `src/core/`.

### 1.1 Нарушители в src/core/

| Файл | Строка | Переменная | Тип нарушения |
|------|--------|-----------|---------------|
| `src/core/flowable-client.ts` | ~264 | `FLOWABLE_BASE_URL` | fallback в фабрике |
| `src/core/flowable-client.ts` | ~269 | `FLOWABLE_REST_APP_ADMIN_USER_ID` | fallback в фабрике |
| `src/core/flowable-client.ts` | ~274 | `FLOWABLE_REST_APP_ADMIN_PASSWORD` | fallback в фабрике |

Все три находятся внутри `makeFlowableClient(config?: Partial<FlowableClientConfig>)`
— фабрика использует `process.env` как источник дефолтов когда `config` не задан.

### 1.2 Места вызова makeFlowableClient (callers)

| Файл | Строка | Паттерн вызова | Находится в |
|------|--------|----------------|-------------|
| `src/bridge-runner.ts` | ~44 | `makeFlowableClient()` — zero args, полный env-fallback | composition root (не core) |
| `src/bridge-smoke-runner.ts` | ~76 | `makeFlowableClient()` — zero args, полный env-fallback | composition root (не core) |
| `src/server/lifecycle-bridge.ts` | ~204 | `makeFlowableClient({ baseUrl, adminUser, adminPassword, ... })` — все поля переданы явно; env читается в `lifecycle-bridge.ts:190-211` (в `src/server/`, не `src/core/`) | composition root (не core) |

`src/core/externalTaskBridge.ts` и тестовые файлы используют только типы и
интерфейсы из `flowable-client.ts`, не вызывают `makeFlowableClient()`.

### 1.3 Вывод об объёме

Нарушители: только `flowable-client.ts` (3 строки в одной фабричной функции).
Все callers находятся вне `src/core/`, и `lifecycle-bridge.ts` уже читает env
до вызова — ему изменений не нужно. Под изменение подпадают: `flowable-client.ts`,
`bridge-runner.ts`, `bridge-smoke-runner.ts`, и новый/расширенный CI-чек.

---

## 2. Решение

### 2.1 Механизм

**Убрать все три `process.env`-fallback из `makeFlowableClient` и ввести
вспомогательную функцию `makeFlowableClientFromEnv` в `src/main.ts` (или
выделить в `src/server/flowable-client-env.ts`), которую используют
`bridge-runner.ts` и `bridge-smoke-runner.ts`.**

Конкретно:

1. **`src/core/flowable-client.ts`**: три env-дефолта удаляются.
   - `baseUrl`: обязательный параметр (нет `?? process.env[...]`). Дефолтное
     значение `"http://flowable:8082/flowable-rest/service"` переносится в
     `makeFlowableClientFromEnv` на уровне composition root.
   - `adminUser`: дефолт `"admin"` оставляется как **литерал**, не как env-читалка
     (`config?.adminUser ?? "admin"` — без `process.env`). Только пароль и URL
     были реальными секретами, требующими env.
   - `adminPassword`: обязательный — если не передан, выбрасывает
     `Error("FLOWABLE_REST_APP_ADMIN_PASSWORD is required")`.
     Проверка остаётся, но исчезает `process.env["FLOWABLE_REST_APP_ADMIN_PASSWORD"]`
     как fallback.
   - `FlowableClientConfig` и `makeFlowableClient` сигнатура не меняется
     (`config?: Partial<FlowableClientConfig>`). Изменяется только то, что при
     отсутствии полей нет env-чтения.

2. **`src/server/lifecycle-bridge.ts`**: без изменений. Уже передаёт явный
   объект конфига из env, прочитанного в `src/server/` (не core).

3. **`src/bridge-runner.ts`** и **`src/bridge-smoke-runner.ts`**: заменить
   `makeFlowableClient()` на `makeFlowableClient({ baseUrl, adminUser, adminPassword })`
   с явным чтением env локально — как уже делает `lifecycle-bridge.ts`.
   Эти файлы находятся в composition root (`src/`), не в `src/core/`, поэтому
   env-чтение там допустимо.

4. **`ci/checks/keyed-digest-core-purity.sh`**: расширить с трёх masking-модулей
   до **всего `src/core/`**. Обновить SCOPE NOTE — предыдущее ограничение снимается.
   Добавить явный positive self-test и negative self-test (уже есть в текущем чеке —
   сохранить). Переименование файла чека опционально; допустимо расширить текущий
   (предпочтительно — минимум diff).

### 2.2 Что НЕ меняется

- Поведение `makeFlowableClient` при явной передаче конфига — идентично (FF-T163-1).
- Дефолты для `timeoutMs`, `maxRetries`, `retryBaseDelayMs`, `retryMaxDelayMs`,
  `delayFn` — остаются как числовые литералы (не env-читалки, нарушением не являются).
- Все существующие тесты в `src/__tests__/flowable-client.test.ts` и
  `flowable-client.adversarial.test.ts` — все передают явный `TEST_CONFIG`; ни один
  не рассчитывает на env-fallback. Изменений в тестах не нужно.
- `src/core/externalTaskBridge.ts` — не затрагивается.
- Никакие other-core-файлы не имеют `process.env` на code-строках (подтверждено grep;
  `keyed-digest.ts:11` и `data-classification.ts:347` — comment-only, не нарушения).

---

## 3. Fitness-функции

### FF-T163-1 — makeFlowableClient поведение с полным конфигом неизменно (AC-1)

**Правило:** `makeFlowableClient({ baseUrl, adminUser, adminPassword, ... })` с
полным явным конфигом возвращает тот же клиент, тот же `auth`-заголовок, тот же
`extJobUrl`, что и до изменения.

**CI-проверка:** все существующие юнит-тесты (`flowable-client.test.ts`,
`flowable-client.adversarial.test.ts`) остаются зелёными без изменений.

### FF-T163-2 — makeFlowableClient без конфига выбрасывает на отсутствующем пароле (AC-2)

**Правило:** `makeFlowableClient()` (zero args) выбрасывает
`Error("FLOWABLE_REST_APP_ADMIN_PASSWORD is required")` вместо того, чтобы
молча использовать `process.env`. Явная ошибка — лучше, чем скрытый env-захват
в core.

**CI-проверка:** юнит-тест: `expect(() => makeFlowableClient()).toThrow(...)`.
Существующий тест для `adminPassword`-отсутствия (если есть) — уточняется.

### FF-T163-3 — no process.env в src/core/ (полный sweep) (AC-3)

**Правило:** `grep -rn "process\.env"` по `src/core/` после изменения возвращает
только comment-only строки (если вообще что-то). Ни одной code-строки с
`process.env` в `src/core/`.

**CI-проверка:** `ci/checks/keyed-digest-core-purity.sh` (расширенный) сканирует
весь `src/core/` (не только три файла), использует strip-comment-lines step из
текущей реализации. Positive self-test (planted violation detected) и negative
self-test (comment-only — не флагируется) сохраняются. Выходит 0 только при
полном отсутствии code-line нарушений.

### FF-T163-4 — negative self-test чека работает (AC-4)

**Правило:** если в `src/core/` подсунуть `process.env["TEST"]` на code-строке,
чек должен выйти с кодом 1 (FAIL). Если planted violation не обнаруживается —
чек выходит с кодом 2 (self-test сломан).

**CI-проверка:** логика self-test внутри скрипта — идентична текущей. Наследуется.

### FF-T163-5 — существующий T-0143 suite остаётся зелёным (AC-5)

**Правило:** `vitest src/__tests__/keyed-digest-e2e.test.ts`,
`src/__tests__/hash-oracle.test.ts`, `src/__tests__/data-classification.test.ts`,
`src/__tests__/grant-resolver.test.ts`, `src/__tests__/main-wired-entry.test.ts`
— все зелёные без изменений.

**CI-проверка:** `npm test` зелёный; все указанные файлы не изменяются.

### FF-T163-6 — bridge-runner и bridge-smoke-runner читают env в своём scope (AC-6)

**Правило:** `bridge-runner.ts` и `bridge-smoke-runner.ts` строят `FlowableClientConfig`
локально из `process.env` (в своём `src/` scope, не в `src/core/`) и передают
конфиг явно в `makeFlowableClient(config)`. Поведение при наличии/отсутствии env
идентично текущему (`FLOWABLE_REST_APP_ADMIN_PASSWORD` не задан → выбрасывает).

**CI-проверка:** `npx tsc --noEmit` зелёный (типы проходят); функциональный
эквивалент подтверждается code-review.

---

## 4. Acceptance Criteria

| ID | Текст | Как проверяется |
|----|-------|-----------------|
| AC-1 | `makeFlowableClient({ baseUrl, adminUser, adminPassword, ... })` ведёт себя идентично до и после задачи. Все существующие тесты `flowable-client.test.ts` и `flowable-client.adversarial.test.ts` проходят без изменений. | test |
| AC-2 | `makeFlowableClient()` без конфига выбрасывает явную ошибку на отсутствующем `adminPassword`. Не читает `process.env` ни для одного из трёх полей. | test |
| AC-3 | После изменения `grep -rn "process\.env" src/core/` не возвращает ни одной code-строки с нарушением. Расширенный `keyed-digest-core-purity.sh` сканирует весь `src/core/` и выходит с 0. | fitness |
| AC-4 | Positive self-test расширенного чека: planted `process.env` violation → exit 1. Если planted violation не найден → exit 2. | fitness |
| AC-5 | `npm test` зелёный; T-0143-специфичные тесты (keyed-digest-e2e, hash-oracle, data-classification, grant-resolver, main-wired-entry) зелёные без изменений. | test |
| AC-6 | `bridge-runner.ts` и `bridge-smoke-runner.ts` строят конфиг локально из env и передают в `makeFlowableClient(config)`. `npx tsc --noEmit` зелёный. | test + manual |
| AC-7 | `ci/checks/keyed-digest-core-purity.sh` обновлён — SCOPE NOTE снят, target расширен до полного `src/core/`. Новый header поясняет смену scope (T-0163). | fitness |

---

## 5. Трассируемость

| Источник | Ссылка |
|----------|--------|
| T-0143 ADR §9 R-1 SCOPE NOTE | backlog candidate — full `src/core/` sweep требует сначала вынести env из `flowable-client.ts` |
| T-0143.review.md R-1 | fitness function `keyed-digest-core-purity.sh` намеренно ограничена; полный sweep — отдельная задача |
| FF-DC9 (`data-classification-isolation.sh`) | аналог для masking-модулей — уже зелёный; T-0163 расширяет invariant на core в целом |
| NF-1 (T-0143 / T-0118) | env boundary exclusively in `src/main.ts` |

---

## 6. Out of scope

- Изменение семантики `makeFlowableClient` при полном конфиге.
- Изменение интерфейса `FlowableClientConfig` (поля остаются теми же).
- Рефактор `src/server/lifecycle-bridge.ts` (уже корректен).
- Изменение тестов для `flowable-client` (не нужно — все тесты передают явный конфиг).
- Python bindings (Stage-2).
- Rotation/secrets management.

---

## 7. Blocking

Нет. Задача самодостаточна; все зависимости (`flowable-client.ts`, callers,
`keyed-digest-core-purity.sh`) находятся в репо Choros, нет внешних блокеров.

---

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
