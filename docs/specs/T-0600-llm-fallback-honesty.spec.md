# T-0600 — Спека: честность LLM-контура — env-fallback дыра BYO + утечка сырого провайдер-ответа

**Status:** ready
**Phase:** SPEC
**Task:** T-0600 [P1/честность-контура-прав]
**Date:** 2026-07-03
**База:** dev @ `c6db7b8` (ветка `task/T-0600-llm-fallback-honesty`)
**Живой факт приёмки:** чат ассистента показал пользователю
`«Ошибка LLM-порта: OpenAI API error 401: {raw json провайдера}»`.
**Предшественники:** T-0573 (honest-503 + `classifyLlmUnavailability` +
canonical envelope), T-0595 (admin/non-admin split, deep-links), T-0599
(проактивный баннер, честный `llm_bound`), T-0574 (assistant-agent bind path,
`ci/checks/db/assistant-llm-binding.test.ts` C4 «env-fallback preserved»).

---

## 1. Контекст (L-факты разведки)

Разведка нашла ДВА самостоятельных дефекта честности, оба воспроизводимые на
живом факте приёмки.

### 1.1 Дефект A — env-fallback дыра BYO

`src/server.ts::makeLlmPortFactory` (`:272-306`) — ЕДИНСТВЕННОЕ производственное
место композиции LLM-порта для ассистента (`src/server.ts:1048`,
`registerAssistantRoutes({ llmPortFactory: (tenantId) =>
makeLlmPortFactory(tenantId, grantsPool) })`). Порядок резолюции:

```
1. loadTenantLlmConfig(grantsPool, tenantId)  — per-tenant agent_card/llm_connection
2. if (DEEPSEEK_API_KEY) → OpenAILlmPort(DEEPSEEK_HANDLE, deepseekSecretResolver)
3. dormantLlmPort  — fail-closed
```

Шаг 2 — ГЛОБАЛЬНЫЙ серверный env-ключ (`DEEPSEEK_API_KEY`, T-0363 backward-compat
path), применяемый к ЛЮБОМУ tenantId, для которого шаг 1 вернул `null` — то есть
tenant, у которого `llm_connection_id` НЕ назначен (или назначен, но
`llm_connection.secret_handle` пуст), молча получает боевой LLM-вызов через
СЕРВЕРНЫЙ (не свой) ключ, если оператор фабрики когда-либо задал
`DEEPSEEK_API_KEY` в окружении процесса. Это прямое нарушение BYO-доктрины:
тенант без СВОЕГО назначенного профиля не должен молча пользоваться чужим/общим
ключом — коммерчески (чужой лимит тратится без спроса) и по доверию (тенант не
знает, что его сообщения обрабатывает не тот провайдер/ключ, который он
настраивал через `/llm-connections`).

**Важно: этот env-fallback НЕ является багом сам по себе для НЕ-tenant-путей.**
Разведка call-sites `DEEPSEEK_API_KEY`/`process.env` в LLM-контуре:

- `src/server.ts:272-306` (`makeLlmPortFactory`) — ЕДИНСТВЕННЫЙ вызов из
  продовой HTTP-обвязки ассистента (`server.ts:1048`), ВСЕГДА с реальным
  `tenantId` живого тенанта. Это и есть дыра.
- Юнит/интеграционные тесты (`src/__tests__/*.test.ts`,
  `src/core/__tests__/*.test.ts`) НЕ проходят через `makeLlmPortFactory`
  вообще — они инжектят собственный `llmPortFactory`/`LlmPort`-стаб
  (`src/__tests__/assistant-thread-ux.test.ts:282`,
  `ci/checks/db/assistant-llm-unavailable.test.ts:119`, и т.д.) — env-fallback
  из `server.ts` их не касается структурно (другой composition root).
- `ci/checks/db/assistant-llm-binding.test.ts` (T-0574, комментарий «C4»)
  ЯВНО документирует и проверяет, что СРАЗУ после регистрации тенанта
  `agent_card` дормантен (`llm_* IS NULL`) и что «COALESCE/env-fallback path
  не преэмптится INSERT'ом» — то есть на момент T-0574 env-fallback в
  `makeLlmPortFactory` (шаг 2) СЧИТАЛСЯ намеренным backward-compat поведением
  для тенантов без своего конфига. T-0600 меняет это решение для tenant-пути
  (см. §Решение ниже) — но тест C4 не проверяет ПОВЕДЕНИЕ фактического LLM-
  вызова (он проверяет только состояние строки `agent_card` сразу после
  регистрации), поэтому не ломается фиксом.
- `deepseekSecretResolver`/`DEEPSEEK_HANDLE` (`server.ts:119-158`) — тот же
  единственный путь; `tenantSecretResolver` (`:182-255`) explicitly REJECTS
  `env://`-хендлы, ЕСЛИ они пришли от тенанта (T-0413) — то есть система УЖЕ
  проводит границу «env:// системный, не тенантский» на уровне resolver'а;
  T-0600 продолжает ту же границу на уровень ВЫБОРА порта (не только резолвинга
  хендла).
- Никаких других продовых вызовов `makeLlmPortFactory`/`DEEPSEEK_API_KEY` не
  найдено (`grep -rn "makeLlmPortFactory\|DEEPSEEK_API_KEY"` — единственные
  вхождения: объявление констант, `deepseekSecretResolver`, сама функция,
  `server.ts:1048`).

**Граница (зафиксирована в ADR §решение):** env-fallback ОСТАЁТСЯ существующим
кодом (`DEEPSEEK_API_KEY`/`deepseekSecretResolver`/`DEEPSEEK_HANDLE`,
`server.ts:119-158`) НЕ удаляется — он остаётся легитимным «нет DB / dev-режим
без тенантов» fallback (например локальный `npm run dev` без Postgres,
`grantsPool === null` — в этом случае `makeLlmPortFactory` не вызывается вовсе,
роут не регистрируется, см. `server.ts:1038 if (grantsPool)`). Дыра — это ТОЛЬКО
шаг 2 внутри `makeLlmPortFactory`, вызываемого С РЕАЛЬНЫМ `tenantId` тенанта,
у которого шаг 1 (per-tenant lookup) вернул `null`. Фикс убирает шаг 2 из
tenant-resolution цепочки ассистента; см. F1.

### 1.2 Дефект B — утечка сырого провайдер-ответа в чат

Два независимых «catch-and-stringify» места ГЛОТАЮТ `LlmUnavailableError`
ЛОКАЛЬНО (не пробрасывают наверх к `classifyLlmUnavailability`/
`respondLlmUnavailable`, T-0573 механизм) и вставляют `err.message` ДОСЛОВНО
в текст, который становится частью `handlerResult.text` — обычного 200-ответа
ассистента, а не честного 503:

1. `src/core/assistant-configurator.ts::runConfiguratorLoop` (`:1194-1205`):
   ```ts
   try {
     result = await ctx.llm.chat(request);
   } catch (err) {
     const errMsg = err instanceof Error ? err.message : String(err);
     finalText = `Ошибка LLM-порта: ${errMsg}. ` + (...);
     break;
   }
   ```
   Этот текст (`finalText`) становится `handlerResult.text` (assistant.ts:1963)
   → персистится как `assistant.message` → рендерится в чате как ОБЫЧНЫЙ ответ
   ассистента (200 OK), НЕ проходя через 503-путь T-0573/T-0595 вовсе.

2. `src/core/process-gen-loop.ts::runProcessGenLoop` (`:230-250`): та же форма
   для `generate_process` (`cause: "error"`,
   `message: \`Ошибка LLM-порта при генерации процесса: ${msg}.\``). Этот
   `outcome.message` возвращается в `src/http/assistant.ts:851`
   (`return \`generate_process[${outcome.status}]: ${outcome.message}\``) —
   попадает в `toolResultContent`/`opErrors` и оттуда в финальный текст,
   показанный пользователю (`assistant.ts:2057`,
   `text: handlerResult.text + ... opErrors.join("; ")`).

Источник самого сырого тела — `src/adapters/openai-llm-port.ts::_post`
(`:282-285`):
```ts
if (res.statusCode && res.statusCode >= 400) {
  reject(new LlmUnavailableError(`OpenAI API error ${res.statusCode}: ${text}`));
}
```
`text` — ПОЛНОЕ необработанное тело ответа провайдера (например
`{"error":{"message":"Incorrect API key provided...","type":"invalid_request_error",...}}`)
конкатенируется в `.message` самого `LlmUnavailableError`. Для ОБЫЧНОГО чат-
пути (не configurator/generate_process) это безопасно — `classifyLlmUnavailability`
классифицирует ошибку ПО ТИПУ (не по содержимому message), `respondLlmUnavailable`
подставляет канонический `ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN/_NON_ADMIN`,
никогда не читая `.message` самой ошибки (доказано существующим тестом
`ci/checks/db/assistant-llm-unavailable.test.ts` FF-5, где
`LlmUnavailableError('OpenAI API error 401: invalid api key')` даёт честный 503
без утечки). Дефект — ИСКЛЮЧИТЕЛЬНО в двух catch-местах §1.2 п.1-2, которые
ОБХОДЯТ этот честный путь и печатают `.message` напрямую в пользовательский
текст.

Существующий гейт `ci/checks/ux/assistant-llm-message-jargon.sh` (T-0573/T-0595)
проверяет ТОЛЬКО константы `ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN/_NON_ADMIN`
в `src/core/assistant-messages.ts` — он структурно НЕ видит два catch-места
выше (другие файлы, другой текст, генерируется в рантайме, не статическая
константа). Дыра остаётся невидимой существующему гейту.

## 2. Функциональные требования

- **F1 (env-fallback границы).** `src/server.ts::makeLlmPortFactory` НЕ
  использует глобальный env-ключ (`DEEPSEEK_API_KEY`) как fallback для
  РЕАЛЬНОГО tenantId, у которого `loadTenantLlmConfig` вернул `null`. Вместо
  шага 2 функция переходит СРАЗУ к шагу 3 (`dormantLlmPort`) — честный
  503-путь (T-0573) активируется, `respondLlmUnavailable` отдаёт канонический
  текст «LLM-ключ не подключён — назначьте профиль ассистенту» (ADMIN/NON_ADMIN
  вариант, существующие константы, без изменений их текста).
- **F2 (env-константы остаются, дозволенный dev/system path сохранён).**
  `DEEPSEEK_API_KEY`/`DEEPSEEK_HANDLE`/`deepseekSecretResolver` НЕ удаляются
  из `server.ts` — они остаются доступны как явный, ОТДЕЛЬНЫЙ от
  tenant-resolution путь (см. ADR §решение за детальным механизмом: либо
  константа удаляется как мёртвый код после того, как этот единственный
  call-site её больше не использует — архитектор решает в DESIGN, какой
  вариант дешевле и honest, не оставляя "почти мёртвый" код без объяснения).
- **F3 (классификатор provider-auth-fail).** Новый различимый класс ошибки —
  провайдер вернул 401/403 (обычно — невалидный/отозванный ключ). Классифицируется
  ОТДЕЛЬНО от общего «unavailable», чтобы можно было (при желании) отличать
  «ключа нет вовсе» (dormant) от «ключ есть, но провайдер его отклонил»
  (auth-fail) — оба МАРШРУТИЗИРУЮТСЯ на честный 503 (не меняя внешний
  контракт `classifyLlmUnavailability` — оба классифицируются как
  `"unavailable"`), но canonical-текст для auth-fail явно называет ПРИЧИНУ
  («ключ отклонён провайдером»), а не общий «не подключён», чтобы админ
  понимал разницу (ключ вставлен неверно/протух — не «забыли подключить»).
- **F4 (никакое сырое тело провайдера не доходит до чата).** Генерически:
  независимо от того, где поймана ошибка LLM-вызова (обычный chat-путь,
  configurator loop, process-gen loop), пользовательский текст НИКОГДА не
  содержит сырое `err.message`/`.cause` провайдер-адаптера. Полное тело
  (для диагностики) — ТОЛЬКО в серверный лог (`console.error`), никогда в
  `handlerResult.text`/`outcome.message`, которые персистятся как
  `assistant.message` и уходят в HTTP-ответ.
  - `runConfiguratorLoop` (`assistant-configurator.ts`): catch-блок заменяет
    `errMsg` (сырой `err.message`) на канонический человекочитаемый текст
    (см. F5), логирует полный `err` через `console.error`.
  - `runProcessGenLoop` (`process-gen-loop.ts`): аналогично — `outcome.message`
    для `cause: "error"` становится каноническим текстом, полная ошибка
    логируется, не встраивается в `message`.
- **F5 (канонический текст, без жаргона, по-русски).** Новые тексты:
  - Provider-auth-fail (401/403 от провайдера): «Ключ LLM отклонён провайдером.
    Проверьте или замените ключ в LLM-соединениях.» (без «порт»/«adapter»/
    «endpoint»/кода статуса/сырого JSON).
  - Общий LLM-error (не auth, напр. timeout/network/malformed-json) в
    configurator/process-gen контурах: не более специфичный текст в духе
    существующего честного 503 (та же формулировка «ассистент не смог
    обработать запрос из-за проблемы с LLM-ключом/соединением», без
    «LLM-порта» как термина) — единый стиль с `assistant-messages.ts`.
  - НИ ОДНА новая строка не содержит токенов денилиста
    `ci/checks/ux/assistant-llm-message-jargon.sh`
    (`LLM_NOT_CONFIGURED`, `OpenAILlmPort`, `endpoint`, `secretHandle`, `stack`)
    и не содержит слова «порт»/«port»/«adapter» (расширение стиля, не
    расширение самого скрипта — F5 требование к НОВЫМ строкам, не новый
    denylist-токен в гейте, если не понадобится отдельно, см. AC).
- **F6 (существующий T-0573 503-путь не регрессирует).** `classifyLlmUnavailability`,
  `respondLlmUnavailable`, канонические ADMIN/NON_ADMIN константы —
  структурно НЕ меняются (тот путь уже честен). Новый provider-auth-fail
  класс (F3) — ДОПОЛНЕНИЕ, не замена: если понадобится текстовая
  дифференциация внутри честного 503 (F3), она реализуется БЕЗ изменения
  внешнего контракта `classifyLlmUnavailability(): "unavailable" | null`
  (см. DESIGN за конкретным механизмом — например доп. классификатор
  `classifyProviderAuthFailure` использованный ТОЛЬКО внутри
  `respondLlmUnavailable` для выбора текста, не меняющий сигнатуру уже
  протестированного `classifyLlmUnavailability`).

## 3. Нефункциональные требования

- **N1 (BYO-доктрина).** Тенант без своего назначенного LLM-профиля не
  получает боевой LLM-вызов через чужой/общий ключ — ни при каких условиях
  на реальном (production/deployed) composition root.
- **N2 (совместимость легитимных путей).** `grantsPool === null` ветка
  (`server.ts:1038 if (grantsPool)`) — ассистентский роут НЕ регистрируется
  вовсе, `makeLlmPortFactory` не вызывается — не затрагивается фиксом F1
  (уже честно деградирует, роута нет).
- **N3 (без кейс-литералов, D-064).** Ни новый код, ни тесты не вводят
  кейс-специфичные литералы (по образцу существующей дисциплины —
  `ci/checks/anti-case-lock.sh`).
- **N4 (жаргон-гейт зелёный).** `ci/checks/ux/assistant-llm-message-jargon.sh`
  (+ `--self-test`) проходит без изменений своего кода — новые строки в
  `assistant-configurator.ts`/`process-gen-loop.ts` (и любая новая константа,
  если добавлена в `assistant-messages.ts`) человекочитаемы, без жаргона.
- **N5 (secret custody).** Ничего в этой задаче не меняет custody-модель
  секретов (RL-3) — `LlmUnavailableError`/провайдер-тело никогда не содержат
  сырой API-ключ (уже так — ключ не входит в error-текст адаптера, только в
  `Authorization`-заголовок), только confirм, что F4 не открывает новый путь
  логирования сырого ключа (лог получает `err` целиком — сообщение об ошибке
  провайдера НЕ включает ключ, только тело ответа/статус).
- **N6 (обратная совместимость `LlmPort`/`classifyLlmUnavailability`
  интерфейсов).** Публичные типы `LlmPort`, `LlmUnavailableError`,
  `classifyLlmUnavailability` — не ломаются структурно (существующие
  потребители, T-0573/T-0595/T-0599 тесты, продолжают проходить).

## 4. Out of scope

- **O1.** Изменение `openai-llm-port.ts::_post` формата ИСКЛЮЧЕНИЯ
  (`LlmUnavailableError` продолжает нести полное сырое тело в `.message` —
  это НУЖНО для серверных логов/`cause`-цепочки; дефект не в том, ЧТО несёт
  исключение, а в том, ГДЕ (`runConfiguratorLoop`/`runProcessGenLoop`) это
  `.message` неправильно печатается пользователю без фильтра).
- **O2.** UI-баннер / проактивное предупреждение (T-0599 уже сделал баннер
  на основе `llm_bound`) — не расширяется этой задачей.
- **O3.** Полноценная провайдер-agnostic классификация ВСЕХ HTTP-кодов
  (429 rate-limit, 500 provider-side и т.д.) отдельными классами — F3
  ограничен 401/403 (auth-fail), явно упомянутых в задаче; остальные коды
  продолжают маршрутизироваться в общий honest-503 (F6) без отдельного текста.
- **O4.** Удаление `DEEPSEEK_API_KEY`/env-fallback механизма целиком из
  кодовой базы — граница (F2) определяет, остаётся ли он как мёртвый код с
  пояснением или физически удаляется; в любом случае механизм НЕ применяется
  к tenant-resolution пути ассистента (F1) — вопрос "остаётся ли константа"
  решается в DESIGN по критерию наименьшего риска/наибольшей честности кода.

## 5. Acceptance criteria

| id | текст | verifiable_as |
|---|---|---|
| AC-1 | `makeLlmPortFactory(tenantId, pool)` для тенанта БЕЗ per-tenant LLM-конфига (per `loadTenantLlmConfig` → null) возвращает `dormantLlmPort`, ДАЖЕ когда `DEEPSEEK_API_KEY` установлен в окружении процесса. | test |
| AC-2 | Живой DB-тест: реально зарегистрированный тенант (assistant-agent дормантен, `llm_connection_id` NULL) → POST сообщения ассистенту при `DEEPSEEK_API_KEY` установленном в окружении теста → честный 503 `LLM_UNAVAILABLE` (НЕ реальный сетевой вызов к DeepSeek/OpenAI). | fitness |
| AC-3 | Существующий тест `ci/checks/db/assistant-llm-binding.test.ts` (C4, «3f-bis») — без изменений, проходит: dormant agent_card row сразу после регистрации. | fitness |
| AC-4 | Существующий тест `ci/checks/db/assistant-llm-unavailable.test.ts` (FF-5/FF-6/FF-1/FF-2/anti-mask) — без изменений, проходит: 503-путь через явно инжектированный `llmPortFactory`-стаб (не через `makeLlmPortFactory`) не регрессирует. | fitness |
| AC-5 | Новый unit-тест: классификатор provider-auth-fail (401 с телом `{"error":{"message":"..."}}`) даёт канонический русский текст БЕЗ фрагментов исходного provider-JSON и без токенов денилиста. | test |
| AC-6 | То же для 403. | test |
| AC-7 | `runConfiguratorLoop`: при `ctx.llm.chat()` throw (`LlmUnavailableError` с сырым provider-телом в `.message`) — `finalText` НЕ содержит подстрок сырого тела (`"invalid_request_error"`, `"Incorrect API key"` — тестовые фикстуры), содержит канонический русский текст. | test |
| AC-8 | `runProcessGenLoop`: то же для `outcome.message` (`cause: "error"`). | test |
| AC-9 | Существующий тест `src/core/__tests__/process-gen-loop.test.ts` («error port → llm_error with cause=error») проходит без изменений сигнатуры (`status`/`cause` не меняются, только текст `message` внутри становится каноническим). | test |
| AC-10 | `bash ci/checks/ux/assistant-llm-message-jargon.sh` и `--self-test` — зелёные, без изменений. | fitness |
| AC-11 | `bash ci/checks/anti-case-lock.sh` — зелёный, без новых кейс-литералов. | fitness |
| AC-12 | `npm test` (root), `npm run build`, `npm run fitness:db` — зелёные. | fitness |

## 6. Открытые вопросы

Нет блокирующих. Единственная содержательная развилка — судьба
`DEEPSEEK_API_KEY`/`deepseekSecretResolver` кода после того, как единственный
call-site (`makeLlmPortFactory` шаг 2) перестаёт его использовать для
tenant-пути — решается в DESIGN (§ADR «Дельта A»). `status: ready`.

---

*Файл: `docs/specs/T-0600-llm-fallback-honesty.spec.md`. Разведка:
`src/server.ts` (:119-158 env-константы+resolver, :182-255 `tenantSecretResolver`
env-reject T-0413, :272-306 `makeLlmPortFactory`, :1038-1048 единственный
production call-site), `src/db/agent-card-llm.ts` (`loadTenantLlmConfig`),
`src/db/agent-provision.ts` (`readConfiguredAgentLlmConfig`, COALESCE-резолвер),
`src/core/llm-port.ts` (`classifyLlmUnavailability`, `LlmUnavailableError`,
`LlmDormantError`, `dormantLlmPort`), `src/adapters/openai-llm-port.ts`
(:282-305 `_post`, сырое provider-тело в `.message`), `src/core/assistant-configurator.ts`
(:1194-1205 `runConfiguratorLoop` catch-leak), `src/core/process-gen-loop.ts`
(:230-250 `runProcessGenLoop` catch-leak), `src/http/assistant.ts` (:1175-1238
`respondLlmUnavailable`, :1837-1846/:2064-2075 два `classifyLlmUnavailability`
call-sites честного пути, :849-852 `generate_process` non-honest leak route),
`src/core/assistant-messages.ts` (канонические ADMIN/NON_ADMIN константы),
`ci/checks/ux/assistant-llm-message-jargon.sh` (денилист-гейт, покрывает
только `assistant-messages.ts`), `ci/checks/db/assistant-llm-binding.test.ts`
(C4 env-fallback-preserved комментарий, T-0574), `ci/checks/db/assistant-llm-unavailable.test.ts`
(FF-5/FF-6/FF-1/FF-2/anti-mask, T-0573/T-0595), `src/core/__tests__/process-gen-loop.test.ts`
(существующий "error port" тест).*
