# ADR-T0600 — Честность LLM-контура: env-fallback дыра BYO + утечка сырого провайдер-ответа

**Status:** ready
**Phase:** DESIGN
**Task:** T-0600 [P1/честность-контура-прав]
**Date:** 2026-07-03
**Спека:** `docs/specs/T-0600-llm-fallback-honesty.spec.md` + `docs/specs/T-0600.spec.contract.json` (AC-1..AC-12)
**База:** dev @ `c6db7b8` (ветка `task/T-0600-llm-fallback-honesty`)
**Предшественники:** T-0363 (DeepSeek env composition root), T-0382 (per-tenant
agent_card config + async factory), T-0413 (env:// reject для tenant-хендлов),
T-0573 (`classifyLlmUnavailability` + honest-503), T-0574 (assistant-agent bind
path, C4 env-fallback-preserved комментарий), T-0595 (admin/non-admin split),
T-0599 (честный `llm_bound`).

---

## 1. Решение

### 1.1 Дельта A — `makeLlmPortFactory`: env-fallback убран из tenant-resolution (F1/F2, AC-1/AC-2/AC-3)

`src/server.ts::makeLlmPortFactory` (`:272-306`) меняет порядок резолюции с
трёх шагов на два для tenant-пути:

```ts
async function makeLlmPortFactory(
  tenantId: string,
  grantsPool: pg.Pool | null,
) {
  // 1. Per-tenant DB config (unchanged).
  const tenantCfg = await loadTenantLlmConfig(grantsPool, tenantId);
  if (tenantCfg) {
    const verdict = validateSecretHandleShape(tenantCfg.secretHandle);
    if (verdict.ok) {
      return new OpenAILlmPort({ ...tenantCfg, tenantId, secretResolver: tenantSecretResolver });
    }
    // Invalid handle shape in DB → dormant (fail-closed, NOT env fallback —
    // T-0600: a malformed per-tenant handle must not silently degrade to the
    // shared server key either).
  }

  // 2. No tenant config (or invalid shape) → dormant. NO global env fallback
  // for a real tenant path (T-0600 BYO fix — was step "2. env fallback" here).
  return dormantLlmPort;
}
```

**Судьба `DEEPSEEK_API_KEY`/`DEEPSEEK_HANDLE`/`deepseekSecretResolver`
(§F2/O4 развилка): УДАЛЯЮТСЯ, не оставляются мёртвым кодом.** Разведка (см.
спека §1.1) подтвердила: `makeLlmPortFactory` — ЕДИНСТВЕННЫЙ потребитель этих
трёх констант/резолвера во всей кодовой базе (`grep -rn "DEEPSEEK_API_KEY\|
DEEPSEEK_HANDLE\|deepseekSecretResolver" src/` — только объявления +
`makeLlmPortFactory` шаг 2, больше нигде). После удаления шага 2 они
становятся ПОЛНОСТЬЮ недостижимым кодом (не «редко используемым», а
буквально непризываемым — `tsc --noEmit` с `noUnusedLocals` уже это отловит).
Оставлять недостижимый код с комментарием «на будущее» — то же самое, что
оставлять неправду в дереве: следующий читатель увидит валидный env-var +
resolver и предположит, что путь жив (ровно тот тип ошибки, который эта
задача чинит на уровне поведения — не стоит чинить поведение и одновременно
оставлять код, лгущий о его существовании). Удаляются:
`DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL`/`DEEPSEEK_HANDLE`
константы, `_handleVerdict` startup-проверка, `deepseekSecretResolver` объект,
шаг 2 в `makeLlmPortFactory`. `tenantSecretResolver` (T-0413, `:182-255`)
НЕ трогается — он не читает `DEEPSEEK_*`, это ОТДЕЛЬНЫЙ tenant-facing
resolver (`app://`/`env://`-reject), нужен независимо от этой дельты.

**`grantsPool === null` ветка (N2) не меняется.** `server.ts:1038
if (grantsPool) { registerAssistantRoutes(...) }` — при отсутствии
`DATABASE_URL` роут не регистрируется вовсе, `makeLlmPortFactory` не
вызывается структурно. Удаление env-fallback шага НЕ вводит новый способ
деградации в dev-без-DB режиме — та ветка и раньше не проходила через
`makeLlmPortFactory`.

**`loadTenantLlmConfig`'s собственный внутренний catch (`agent-card-llm.ts:123-126`,
«DB failure → fall back to global env config») — комментарий, не код.**
Разведка: сам `loadTenantLlmConfig` НЕ вызывает env-fallback — он возвращает
`null` при ошибке БД, а РЕШЕНИЕ «что делать при null» лежит целиком в
`makeLlmPortFactory` (вызывающая сторона). Комментарий в `agent-card-llm.ts:124`
описывает ПРЕЖНЕЕ поведение вызывающей стороны (шаг 2, ныне удалён) — правится
как часть этой дельты (комментарий, не логика — `loadTenantLlmConfig` уже и
так корректно возвращает `null`, ничего не нужно менять в её теле).

### 1.2 Дельта B — provider-auth-fail классификатор (F3/F5, AC-5/AC-6)

Новая чистая функция в `src/core/llm-port.ts` (рядом с
`classifyLlmUnavailability`, тот же файл — единый дом классификаторов):

```ts
/**
 * T-0600: classify a caught LlmUnavailableError as a provider AUTH failure
 * (401/403 — bad/revoked key) vs a generic unavailability (timeout, network,
 * malformed response, etc). Classification is BY STRUCTURE of the message
 * prefix the adapter itself controls (openai-llm-port.ts `_post`: "OpenAI API
 * error <code>: <body>") — NOT by sniffing the raw provider body, which must
 * never leak regardless of classification outcome (see canonicalizeLlmError).
 */
export function isProviderAuthFailure(err: unknown): boolean {
  if (!(err instanceof LlmUnavailableError)) return false;
  return /OpenAI API error (401|403):/.test(err.message);
}
```

Плюс единая функция «обезвреживания» сырого сообщения для мест, которые
СЕЙЧАС catch-ат и печатают `.message` (Дельта C ниже) — не для честного
503-пути (тот уже не трогает `.message` вовсе, F6):

```ts
/**
 * T-0600 (F4/F5): turn a caught LLM error into a canonical, jargon-free,
 * Russian, human message — NEVER echoing the raw provider body. Used ONLY by
 * call sites that currently interpolate err.message directly into
 * user-visible text (assistant-configurator.ts, process-gen-loop.ts). The
 * honest-503 path (respondLlmUnavailable) does NOT use this — it already
 * ignores err.message entirely (T-0573/T-0595 canonical constants).
 */
export function canonicalizeLlmError(err: unknown): string {
  if (isProviderAuthFailure(err)) {
    return "Ключ LLM отклонён провайдером. Проверьте или замените ключ в LLM-соединениях.";
  }
  if (err instanceof LlmDormantError) {
    return "LLM-ключ не подключён. Настройте профиль ассистента в LLM-соединениях.";
  }
  // Generic adapter failure (timeout / network / malformed JSON) — same
  // human framing, no status code, no raw body, no "port"/"adapter" jargon.
  return "Не удалось обработать запрос из-за проблемы с подключением к LLM. Попробуйте ещё раз позже.";
}
```

Обе функции — ЧИСТЫЕ (без IO), живут в `src/core/llm-port.ts` (уже дом
`classifyLlmUnavailability`/`LlmUnavailableError`/`LlmDormantError`) — не
новый файл, минимальный контракт-diff. `classifyLlmUnavailability` САМА не
меняется (F6, N6) — `isProviderAuthFailure`/`canonicalizeLlmError` ДОПОЛНЯЮТ,
вызываются НЕЗАВИСИМО в конкретных call-sites, где сейчас происходит утечка
(Дельта C), не в `respondLlmUnavailable` (тот уже честен и не нуждается в
классификации auth-vs-generic — ОБА варианта уже используют один и тот же
канонический ADMIN/NON_ADMIN текст безусловно, задача явно не расширяет
скоуп honest-503 differentiation дальше, чем нужно катч-сайтам).

### 1.3 Дельта C — устранение двух утечек (F4, AC-7/AC-8/AC-9)

**`src/core/assistant-configurator.ts::runConfiguratorLoop`** (`:1194-1205`):

```ts
let result: ChatLlmResult;
try {
  result = await ctx.llm.chat(request);
} catch (err) {
  // T-0600 (F4): log the FULL error server-side; the user-visible text is
  // ALWAYS the canonical, jargon-free form — never the raw err.message
  // (which may embed the provider's raw JSON body, see
  // openai-llm-port.ts::_post — T-0600 anti-case).
  console.error(`[T-0600] configurator LLM call failed: ${String(err)}`);
  const canonical = canonicalizeLlmError(err);
  finalText =
    `${canonical} ` +
    (approvedOps.length > 0 || blockedOps.length > 0
      ? "Частичные результаты ниже."
      : "Конфигурация не была изменена.");
  break;
}
```

**`src/core/process-gen-loop.ts::runProcessGenLoop`** (`:230-250`):

```ts
try {
  const result = await req.llm.chat(buildGenRequest(req.systemPrompt, history));
  replyText = result.text;
} catch (err) {
  if (err instanceof LlmDormantError) {
    return {
      status: "llm_error",
      cause: "dormant",
      message: canonicalizeLlmError(err), // same canonical dormant text, now shared with configurator
    };
  }
  // T-0600 (F4): log full error server-side; user-facing message is canonical.
  console.error(`[T-0600] process-gen LLM call failed: ${String(err)}`);
  return {
    status: "llm_error",
    cause: "error",
    message: canonicalizeLlmError(err),
  };
}
```

`ProcessGenOutcome`'s `status`/`cause` union НЕ меняется (AC-9 — существующий
тест `process-gen-loop.test.ts` «error port → llm_error with cause=error»
проверяет ТОЛЬКО `status`/`cause`, не текст `message` — проходит без
изменений). `src/http/assistant.ts:851` (`generate_process[${outcome.status}]:
${outcome.message}`) автоматически перестаёт нести сырое тело — `outcome.message`
теперь канонический по построению, вызывающий код не меняется.

### 1.4 Почему НЕ шире (отклонённые расширения scope)

Задача явно ограничивает провайдер-классификацию 401/403 (auth-fail) — не
429/5xx. `canonicalizeLlmError` для ЛЮБОЙ НЕ-auth `LlmUnavailableError`
(timeout, network, malformed JSON, 429, 500...) схлопывается в ОДИН
generic-текст — это НАМЕРЕННО консервативно (спека O3): различать причины
глубже 401/403 не требуется этой задачей и не имеет живого факта приёмки,
подтверждающего необходимость.

## 2. Отклонённые альтернативы

| Вариант | Почему нет |
|---|---|
| Оставить `DEEPSEEK_API_KEY`/`deepseekSecretResolver` как мёртвый код с комментарием «не используется» | Недостижимый код, который выглядит живым (валидная константа + resolver + startup-проверка), лжёт следующему читателю о своём статусе — ровно тот класс дефекта честности, который T-0600 чинит на уровне поведения. Разведка подтвердила единственный consumer — безопасно удалить целиком. |
| Держать env-fallback, но требовать явного `ALLOW_ENV_LLM_FALLBACK=true` флага | Плодит вторую конфигурационную развилку ради поведения, которое и так должно быть выключено по умолчанию (BYO — N1); флаг легко забыть выключенным в проде (тот же класс риска, что и текущая дыра, просто на один уровень абстракции выше). Полное удаление — проще и честнее. |
| Классифицировать ПОЛНЫЙ спектр HTTP-кодов провайдера (429/500/503 и т.д.) отдельными каноническими текстами | Спека явно ограничивает scope 401/403 (единственный живой факт приёмки — 401). Расширение без живого кейса — преждевременная спецификация; `canonicalizeLlmError`'s generic-ветка уже покрывает остальные коды честно (без утечки), просто без差ференцированного текста. Дешёво добавить позже, если появится живой факт. |
| Sniff-парсинг сырого provider JSON внутри `canonicalizeLlmError`, чтобы process "message" поле провайдера и включить его (обезличенно) в canonical-текст | Провайдерский JSON-шейп не стандартизован (OpenAI/DeepSeek/Anthropic-совместимые endpoint'ы могут отличаться) — парсинг чужого формата вносит хрупкость (парсер сломается на другом провайдере, эффект — либо exception, либо мусор в тексте). Классификация СТРОГО по префиксу, который контролирует НАШ адаптер (`"OpenAI API error <code>:"`), а не по телу, которое контролирует внешняя сторона — надёжнее и не требует расширения при смене провайдера. |
| Переносить `canonicalizeLlmError`/`isProviderAuthFailure` в `assistant-messages.ts` вместо `llm-port.ts` | `assistant-messages.ts` — дом ГОТОВЫХ строковых констант (ADMIN/NON_ADMIN), не классификаторов; `llm-port.ts` уже дом `classifyLlmUnavailability`/`LlmUnavailableError`/`LlmDormantError` — логически те же типы ошибок, тот же файл, меньше кросс-импортов. |
| Менять `respondLlmUnavailable`/honest-503 путь, чтобы тоже различать auth-fail текстом | F6/N6 — тот путь уже честен и покрыт T-0573/T-0595 тестами безусловно (ADMIN/NON_ADMIN константы одинаковы независимо от dormant/adapter-failure под-причины). Расширение туда — increase surface без живого требования; задача просит различение ИМЕННО там, где сейчас утечка (catch-места), не в уже честном пути. |

## 3. Object model

| entity | fields |
|---|---|
| `makeLlmPortFactory` (существующая функция, `src/server.ts`) | сигнатура не меняется (`tenantId: string, grantsPool: pg.Pool \| null) => Promise<LlmPort>`); тело — шаг 2 (env-fallback) удалён |
| `isProviderAuthFailure` (новая, `src/core/llm-port.ts`) | `(err: unknown) => boolean` — pure, классифицирует по message-префиксу адаптера |
| `canonicalizeLlmError` (новая, `src/core/llm-port.ts`) | `(err: unknown) => string` — pure, возвращает канонический русский текст, никогда сырое тело |

## 4. Контракты для coder/tester

1. `src/server.ts` — удалить `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`/
   `DEEPSEEK_MODEL`/`DEEPSEEK_HANDLE`/`_handleVerdict`/`deepseekSecretResolver`
   и шаг 2 внутри `makeLlmPortFactory` (см. §1.1). `tenantSecretResolver`
   (T-0413) остаётся нетронутым.
2. `src/db/agent-card-llm.ts` — комментарий на `:124` («DB failure → fall
   back to global env config») правится на честное описание нынешнего
   поведения (dormant, не env) — комментарий-only правка, тело функции не
   меняется.
3. `src/core/llm-port.ts` — добавить `isProviderAuthFailure`,
   `canonicalizeLlmError` (см. §1.2). Экспортируются рядом с
   `classifyLlmUnavailability`.
4. `src/core/assistant-configurator.ts::runConfiguratorLoop` — catch-блок
   переписан на `canonicalizeLlmError` + `console.error` (см. §1.3).
5. `src/core/process-gen-loop.ts::runProcessGenLoop` — catch-блок аналогично
   (см. §1.3); dormant-ветка тоже переиспользует `canonicalizeLlmError` для
   единого текста между dormant/error (не обязательно дословно совпадающего
   со старым текстом — AC-9 проверяет только `status`/`cause`).
6. Новые unit-тесты:
   - `src/core/__tests__/llm-port.test.ts` (новый ЛИБО расширение
     `src/__tests__/assistant-llm-message.unit.test.ts`) — `isProviderAuthFailure`/
     `canonicalizeLlmError` покрыты на 401/403/generic/dormant (AC-5/AC-6).
   - `src/__tests__/assistant-configurator.test.ts` — расширение: сценарий
     `ctx.llm.chat()` throw с `LlmUnavailableError`, содержащим provider-JSON
     фикстуру в `.message` → `finalText` не содержит фрагментов фикстуры
     (AC-7).
   - `src/core/__tests__/process-gen-loop.test.ts` — расширение
     существующего "error port" сценария (либо новый it()) — `outcome.message`
     не содержит фрагментов provider-JSON фикстуры, существующая проверка
     `status`/`cause` сохраняется (AC-8/AC-9).
7. Живой DB-тест: расширение `ci/checks/db/assistant-llm-unavailable.test.ts`
   (тот же файл, тот же паттерн что FF-5/FF-6) ЛИБО новый файл рядом —
   реальный `makeLlmPortFactory`-подобный сценарий: тенант без per-tenant
   конфига, `DEEPSEEK_API_KEY` временно установлен в окружении теста (или
   среды процесса), POST сообщения → 503 (не реальный сетевой вызов) (AC-1/AC-2).
   Coder решает конкретное расположение при реализации, документируя выбор в
   PR-handoff, если отличается от этого пункта (deviations_from_adr).
8. `docs/handoff/T-0600.pr-handoff.json` — BUILD-фаза.

## 5. Fitness-функции

| id | правило | ci_check |
|---|---|---|
| FF-1 | AC-1: `makeLlmPortFactory` без per-tenant конфига возвращает `dormantLlmPort` даже с `DEEPSEEK_API_KEY` в env. | unit test, `src/__tests__/server-llm-factory.test.ts` (новый) либо co-located |
| FF-2 | AC-2: живой DB-тест — реальный тенант, `DEEPSEEK_API_KEY` в env процесса теста, POST сообщения → 503, не сетевой вызов. | `ci/checks/db/*` живой Postgres |
| FF-3 | AC-3: `ci/checks/db/assistant-llm-binding.test.ts` (C4/3f-bis) не регрессирует. | `npm run fitness:db` |
| FF-4 | AC-4: `ci/checks/db/assistant-llm-unavailable.test.ts` (FF-5/FF-6/FF-1/FF-2/anti-mask) не регрессирует. | `npm run fitness:db` |
| FF-5 | AC-5/AC-6: `isProviderAuthFailure`/`canonicalizeLlmError` 401/403 unit-покрытие, без фрагментов provider-JSON. | `vitest run` (root) |
| FF-6 | AC-7: `runConfiguratorLoop` catch — `finalText` не содержит provider-JSON фрагментов. | `vitest run src/__tests__/assistant-configurator.test.ts` |
| FF-7 | AC-8: `runProcessGenLoop` catch — `outcome.message` не содержит provider-JSON фрагментов. | `vitest run src/core/__tests__/process-gen-loop.test.ts` |
| FF-8 | AC-9: существующий "error port" тест проходит без изменений сигнатуры. | тот же файл |
| FF-9 | AC-10: жаргон-гейт зелёный. | `bash ci/checks/ux/assistant-llm-message-jargon.sh && bash ci/checks/ux/assistant-llm-message-jargon.sh --self-test` |
| FF-10 | AC-11: анти-кейс-замок зелёный. | `bash ci/checks/anti-case-lock.sh` |
| FF-11 | AC-12: полный локальный CI зелёный. | `npm test && npm run build && npm run fitness:db` |

## 6. Traceability

| ac | covered_by |
|---|---|
| AC-1 | FF-1 |
| AC-2 | FF-2 |
| AC-3 | FF-3 |
| AC-4 | FF-4 |
| AC-5 | FF-5 |
| AC-6 | FF-5 |
| AC-7 | FF-6 |
| AC-8 | FF-7 |
| AC-9 | FF-8 |
| AC-10 | FF-9 |
| AC-11 | FF-10 |
| AC-12 | FF-11 |

## 7. Эскалация

Нет. Обе дельты — коррекция дефектов честности в уже существующем контракте
(BYO-доктрина + T-0573 honest-503 механизм), не новая архитектура. Удаление
`DEEPSEEK_API_KEY`-механизма — устранение единственного, отныне-недостижимого
consumer'а после поведенческого фикса, не решение, требующее founder-гейта
(деньги/секреты/необратимость не затронуты — переменная окружения просто
перестаёт читаться кодом; если оператор оставил её в реальном `.env`, это
becomes a no-op, не breaking change для чего-либо живого).

---

*Файл: `docs/adr/ADR-T0600-llm-fallback-honesty.md`. См. также
`docs/adr/T-0600.adr.contract.json` (машиночитаемый дубликат для validate.py).*
