# Спека: T-0573 — Разблокировка ассистента (backfill tenant-zero владельцам старых тенантов + человечные ошибки)

**Status:** ready (no blocking questions)
**Phase:** SPEC
**Date:** 2026-07-02
**Task:** T-0573 [W1/ассистент] «Разблокировать ассистента: backfill authoring_draft владельцам существующих тенантов + человечные ошибки (нет LLM-ключа → «подключите ключ» со ссылкой, не сырой INTERNAL) + снять бейдж «демо» после починки»
**Предшественники:** T-0373 (PD-7, tenant-zero seeding для НОВЫХ тенантов, `src/core/register.ts`), T-0574 (LLM-ключ тенанта в UI, смержено 080486c — `docs/specs/T-0574-tenant-llm-key.spec.md`, миграция 115), D-064 (LIVE_PROOF/анти-кейс/эпик=кейс-доказательство/столп-дисциплина).
**Источник наблюдений:** живая приёмка 2026-07-02 глазами владельца тенанта ООО Аксон (`c7a70702…`), карта примитивов `demiurge/docs/choros-primitives-map-2026-07-02.md`; свежая находка LIVE_PROOF T-0574 (2026-07-02, тот же день) — у старых тенантов НЕТ employee `assistant-agent` вовсе, не только грантов.

---

## 1. Проблема (L-факт, не гипотеза)

На живом стенде владелец тенанта ООО Аксон открывает Ассистента-конфигуратора и получает
отказ: «У вас нет прав настраивать систему… в пространстве нет администратора с правами
настройки». Отдельно, при обращении к аналитику (intent=analyst того же ассистентского
чата), тенант без рабочего LLM-ключа получает не честный человекочитаемый отказ, а сырой
`{"error":{"code":"INTERNAL"}}` (HTTP 500) — вместо обещанного спекой `ai-assistant-byo.spec.md`
§3.1 «честного 503 «подключите LLM»».

Обе проблемы имеют общий корень: тенант ООО Аксон зарегистрирован ДО того, как в
`register.ts` появилось seed-наполнение tenant-zero (T-0373, PD-7) — владелец, employee
`assistant-agent`, гранты `authoring_draft` для него не существуют для этого тенанта вовсе.

## 2. Разведанное состояние кода (2026-07-02, до этой задачи)

### 2.1 Что сидит `register.ts` НОВЫМ тенантам (эталонный инвариант, `src/core/register.ts:339-497`)

Для КАЖДОГО нового self-registered тенанта транзакция шага 3 создаёт (все — `ON CONFLICT DO
NOTHING`, идемпотентно):

- **3e.** `role` `slug='role-configurator'` — роль-держатель `authoring_draft` грантов.
- **3f.** `employee` `slug='assistant-agent'`, `kind='agent'` — агентская идентичность
  ассистента (нужна для intersection-check в `assistant-configurator.ts:598` —
  `getGrantsForSubject` для агента).
- **3f-bis (T-0574).** `agent_card` строка для этого employee (`agent_type='assistant'`,
  `kc_client_id='assistant-agent-'||tenantId`, LLM-колонки `NULL`/опущены) — делает
  ассистента АДРЕСУЕМЫМ для `PUT /api/agents/:id/llm-connection` и видимым в
  `GET /api/agents`.
- **3g.** `role_assignment`: владелец (`employeeId`) → `role-configurator`, CONFIRMED.
- **3h.** `role_assignment`: `assistant-agent` → `role-configurator`, CONFIRMED.
- **3i/3j.** `grant`: `authoring_draft` / `create` и `authoring_draft` / `update` на
  `role-configurator`, scope=⊥, CONFIRMED.
- **3j-bis (T-0475).** `grant`: `llm_connection:configure` и `system_agent:operate` на
  `role-configurator`, scope=⊥, CONFIRMED.

Итого — **9 строк** (1 role, 1 employee, 1 agent_card, 2 role_assignment, 4 grant),
воспроизводимых по коду `register.ts`, не по памяти/спекам.

### 2.2 Что фактически имеют СУЩЕСТВУЮЩИЕ тенанты (например ООО Аксон)

Существующие тенанты были зарегистрированы `registerTenant` ДО появления шага 3e–3j-bis
(до T-0373/T-0475/T-0574) либо частично — до T-0574 конкретно (миграция 115 покрыла ТОЛЬКО
случай «employee уже есть, `agent_card` нет»). Наблюдение LIVE_PROOF T-0574 (сегодня):
у части старых тенантов **employee `assistant-agent` отсутствует полностью** — то есть
разрыв глубже, чем «нет `agent_card»: нет ни employee, ни role-configurator, ни грантов,
ни agent_card. Migration 115 (`migrations/115_assistant_agent_card_backfill.sql`) — единственная
существующая миграция backfill — покрывает **только** шаг 3f-bis (agent_card) и только для
тенантов, у которых employee `assistant-agent` УЖЕ существует (`LEFT JOIN … WHERE e.slug =
'assistant-agent' AND ac.id IS NULL`). Она структурно не создаёт ни role-configurator, ни
employee, ни role_assignment, ни grant для тенантов без employee assistant-agent вовсе.

Наблюдаемые следствия для владельца такого тенанта:

- `hasAuthoringDraftGrant` (`assistant-configurator.ts:598-602`) на intersection-проверке
  видит пустой список грантов для агента (нет employee → нет role_assignment → нет grants)
  → `canOperateSystemAgent([])` = false → владелец получает
  `AUTHORING_ACCESS_DENIED_MESSAGE` (`assistant-configurator.ts:534-536`, уже человекочитаемый
  текст, НЕ сырая ошибка) — сам текст корректен, но **должен был не показываться вообще**,
  так как владелец тенанта — это в точности тот, кому спека и продукт обещают доступ.
- `GET /api/agents` не видит `assistant-agent` (нет `agent_card` строки) → на
  `/llm-connections` кнопка «Назначить ассистенту» не имеет чем адресовать ассистента этого
  тенанта — задизейблена/недостижима (наблюдение T-0574, §2 п.3 той спеки).

### 2.3 Источник сырого `INTERNAL` (не 503 «подключите LLM»)

`src/http/assistant.ts:1738`: `let llm = await llmPortFactory(tenantId);` вызывается **до**
блока `try { … } catch (err) { if (err instanceof LlmDormantError) { …503… } throw err; }`
(строки 1843-1995) — то есть построение LLM-порта НЕ обёрнуто в этот catch. Отдельно, внутри
самого try-блока (`intentDispatch`/`runAnalyst`/`runConfigurator` → `ctx.llm.chat()`),
единственный перехватываемый тип ошибки — `LlmDormantError` (строка 1956); любая ДРУГАЯ
ошибка (сбой резолва секрета, сетевая ошибка реального провайдера, исключение внутри
`OpenAILlmPort.chat()` при невалидном ключе — `src/adapters/openai-llm-port.ts:108/154`)
прокидывается дальше (`throw err`, строка 1994) в общий catch роутера
(`src/http/router.ts:296-304`), который для любой НЕ-`HttpError` ошибки безусловно
отдаёт `sendErrorEnvelope(res, 500, "INTERNAL", "internal server error")` — это и есть
наблюдаемый сырой `{"error":{"code":"INTERNAL"}}`.

Дормантный путь (когда порт = `dormantLlmPort`, т.е. НИКАКОЙ конфиг вообще не найден) уже
частично человечен: строки 1983-1991 отдают `HTTP 503 {"error":"LLM_NOT_CONFIGURED","message":
"LLM не настроен — настройте BYO-ключ для активации ассистента."}` — но это сообщение (а)
не содержит ссылки на `/llm-connections`, (б) не покрывает случай «конфиг ЕСТЬ, но ключ
невалиден/провайдер недоступен» (тот случай, для которого `LlmDormantError` не бросается —
бросается любая другая ошибка адаптера).

### 2.4 Бейдж «демо»

`web/src/app-shell/nav-config.js:115` — пункт `{ id: "assistant", …, status: "demo" }`
рендерится `shell.jsx:242`/`:422-423` как чип «демо» с `aria-label="демо — данные
иллюстративные"` и тултипом «Демо — данные иллюстративные (mock)». Формально данные
ассистента НЕ мок (реальные audit_event, реальный intersection grant-check) — бейдж относится
к тому же классу, что и другие `status: "demo"` пункты навигации (сравни `T-0550`, снявшую
такой же бейдж с `forms` после починки).

## 3. Что делает эта задача (в объёме)

- Backfill (миграция, set-driven, БЕЗ хардкода UUID тенанта — эталон формата: миграции
  115/116/117 в dev) для КАЖДОГО существующего тенанта, у которого хотя бы одна из 9 строк
  §2.1 отсутствует: довести состояние ассистент-контура тенанта до РОВНО того же инварианта,
  который получает свежерегистрированный тенант (role-configurator + employee assistant-agent
  + agent_card + 2 role_assignment + 4 grant). Владелец тенанта — существующий employee с ролью
  `tenant-owner` этого тенанта (та же роль, которую `register.ts` шаг 3b/3g использует как цель
  грантов для нового тенанта) — получает `role_assignment` на `role-configurator` РОВНО как в
  3g.
- Человечная обработка ошибки «нет LLM-ключа» ПОСЛЕ backfill: и путь «конфиг вовсе не найден»
  (уже частично 503), и путь «конфиг есть, но нерабочий» (сегодня падает в сырой INTERNAL)
  ОБЯЗАНЫ отдавать один и тот же класс честного ответа со ссылкой на `/llm-connections» —
  никогда сырой `{"error":{"code":"INTERNAL"}}` по причине отсутствия/нерабочего LLM.
- Снятие бейджа «демо» с пункта `assistant` в навигации — но ТОЛЬКО как следствие того, что
  ассистент реально доступен владельцу/админу тенанта (см. критерий снятия ниже, AC-9) — не
  косметика впереди факта.
- LIVE_PROOF на живом стенде (D-064): путь владельца ООО Аксон от отказа к рабочему чату.

## 4. Явно out of scope

- O1. Реальный рабочий LLM-ключ (Anthropic/иной) вставить в интерфейс — некому: вставка ключа
  требует секрет, которым аналитик/агент не располагает, а фаундер явно директирует не делать
  это в рамках автономного impl-прогона. Путь «ассистент ОТВЕТИЛ ПО-НАСТОЯЩЕМУ содержательным
  текстом от реального провайдера» фиксируется как **founder-todo** (см. AC-8) — задача
  ЗАКРЫВАЕТСЯ без него, если весь ОСТАЛЬНОЙ путь (права + человечная ошибка + адресуемость +
  бейдж) доказан.
- O2. UI/экран `/llm-connections` сам по себе (создание профиля, вставка ключа, тест
  подключения, назначение профиля ассистенту) — это T-0574, уже смержено (080486c). Эта задача
  ТОЛЬКО потребляет то, что T-0574 построила (адресуемость ассистента), не переделывает экран.
- O3. Обобщение backfill на ЛЮБЫЕ будущие поля/сущности tenant-zero сверх текущего набора §2.1
  (9 строк) — если `register.ts` в будущем добавит десятый примитив seed-наполнения, это будет
  предмет отдельной задачи, не ретроактивный контракт этой спеки.
- O4. Полная замена `x-dev-user`/worker-token модели (`access-and-tenant-zero.spec.md` §3.2,
  F1) — отдельная задача (T-0328), не в объёме.
- O5. Приглашение по ссылке / email-инвайты (`access-and-tenant-zero.spec.md` §3.4, F3) —
  отдельная задача, не в объёме.
- O6. Редизайн текста системного промта ассистента/аналитика — не трогается; меняются только
  тексты ОШИБОК (отказ в правах уже человечен и не меняется по содержанию — меняется ТОЛЬКО
  факт, что он больше не показывается владельцу; тексты LLM-недоступности — меняются, см. AC-5,
  AC-6).
- O7. Любая реорганизация экрана `/llm-connections` под нужды этой задачи, кроме уже
  существующей (T-0574) кнопки «назначить профиль ассистенту» — переиспользуется как есть.

## 5. Функциональные требования

- F1. Существует backfill-механизм (миграция), который для КАЖДОГО тенанта, у которого
  отсутствует любая из 9 строк §2.1 (role-configurator / employee assistant-agent / agent_card
  / 2× role_assignment / 4× grant), досоздаёт недостающие строки — set-driven (без литерала
  UUID конкретного тенанта), идемпотентно (повторный прогон — no-op), не трогая тенанты, у
  которых инвариант уже полон (в т.ч. свежезарегистрированные — не дублирует).
- F2. Владелец тенанта (employee с `role_assignment` на роль `tenant-owner` этого тенанта) —
  цель нового `role_assignment` на `role-configurator`, созданного backfill (та же связка,
  что шаг 3g `register.ts` устанавливает для нового тенанта: владелец = employee, назначаемый
  на `tenant-owner` при регистрации).
- F3. После backfill владелец тенанта, открывший Ассистента-конфигуратора, видит рабочий чат
  (интерфейс принимает сообщение, не возвращает отказ `AUTHORING_ACCESS_DENIED_MESSAGE`) — при
  условии, что backfill выполнен, независимо от того, подключён ли LLM-ключ.
- F4. Кнопка «Назначить ассистенту» на `/llm-connections` (построена T-0574) становится живой
  (не задизейблена по причине отсутствия `agent_card`/`employee`) для тенанта, прошедшего
  backfill — сам факт разблокировки проверяется тем же наблюдаемым контрактом, каким T-0574
  AC-4 проверяет свежий тенант (эндпойнт назначения профиля не возвращает `AGENT_NOT_FOUND`).
- F5. Путь «LLM-конфиг для тенанта существует в БД, но провайдер/ключ нерабочий» (ошибка внутри
  `ctx.llm.chat()`, НЕ являющаяся `LlmDormantError`) отдаёт пользователю тот же класс честного
  человекочитаемого ответа, что и путь «LLM вовсе не настроен» — НЕ сырой `{"error":{"code":
  "INTERNAL"}}`/HTTP 500 по причине проблемы с LLM.
- F6. Текст человечной ошибки «нет LLM-ключа» (оба пути: не настроен / настроен-но-нерабочий)
  содержит: (а) явное указание, что нужно подключить/проверить LLM-ключ; (б) ссылку/указание
  на экран `/llm-connections`, где это делается; (в) НЕ содержит дев-жаргона (не должен
  показывать сырые строки вида «endpoint», «handle», «secretHandle», «LLM_NOT_CONFIGURED» как
  единственный смысловой текст, «OpenAILlmPort», стек-трейс, код исключения).
- F7. Текст отказа «нет прав» (`AUTHORING_ACCESS_DENIED_MESSAGE`, не переписывается по
  содержанию) в честном случае «у пользователя ДЕЙСТВИТЕЛЬНО нет гранта после backfill»
  (не-владелец, не-админ) продолжает называть, кто может выдать право («администратор или
  владелец») — не регресс существующего текста.

## 6. Нефункциональные / инвариантные требования

- N1. Backfill не создаёт НИ ОДНОЙ строки для тенанта, у которого инвариант §2.1 уже полон
  (в т.ч. тенанты, зарегистрированные после T-0373/T-0475/T-0574, и тенант, уже прошедший
  migration 115) — проверяется через `ON CONFLICT DO NOTHING` + предикат `WHERE … IS NULL`
  по образцу migration 115.
- N2. Backfill не содержит НИ ОДНОГО литерала UUID конкретного тенанта — грепом проверяемо
  (эталон: `ci/checks/demo/no-hardcoded-tenant.sh`, `ci/checks/seed/no-hardcoded-fixture-ids.sh`
  уже действуют на миграции; новая миграция обязана проходить оба).
- N3. Backfill не меняет и не удаляет существующие строки других тенантов (аддитивный INSERT
  ONLY — как migration 115; никаких UPDATE/DELETE на существующих role/employee/grant строках
  тенантов, у которых часть §2.1 уже есть — только досоздание недостающего остатка).
- N4. Анти-кейс гейт (D-064): изменения этой задачи (backfill-миграция, обработчик ошибок,
  nav-config) не вносят новых кейс-специфичных строковых констант (конкретные названия
  тенантов/владельцев/e-mail из живой приёмки, например «ООО Аксон», `c7a70702…`) в `src/` —
  разведка §2 ссылается на конкретный тенант диагностически, но код/миграция обязаны остаться
  set-driven (см. N2).
- N5. Изменение обработки ошибок (F5/F6) не расширяет и не сужает круг лиц, которым разрешено
  видеть текст ошибки — тот же гейт доступа (владелец/админ тенанта пытается использовать
  ассистента), что и сегодня; меняется только СОДЕРЖАНИЕ сообщения, не авторизация.
- N6. Снятие бейджа «демо» (AC-9) выполняется ТОЛЬКО как следствие F3/F4 — то есть после того,
  как разведка/тест подтвердили, что владелец тенанта реально получает рабочий чат (не отказ
  в правах); недопустимо снять бейдж как чисто косметическое изменение `nav-config.js` без
  этого предварительного условия (декоративное «снятие бейджа» без факта = нарушение D-064
  анти-кейс-дисциплины «эпик=кейс-доказательство»).

## 7. LIVE_PROOF-путь (D-064) — как это доказывается на живом стенде

1. На живом стенде (100.121.76.86:3000 либо эквивалентном dev-стенде), ДО деплоя backfill:
   зайти под владельцем тенанта ООО Аксон (или эквивалентного старого тенанта без seed) →
   открыть Ассистента → отправить сообщение конфигуратору («создай приложение …») → зафиксировать
   текущий отказ (`AUTHORING_ACCESS_DENIED_MESSAGE`).
2. Задеплоить backfill-миграцию на dev.
3. SQL-проверка (см. AC-1): для тенанта ООО Аксон все 9 строк §2.1 теперь существуют.
4. Тем же владельцем, той же сессией — открыть Ассистента снова → отправить то же сообщение
   конфигуратору → увидеть РАБОЧИЙ чат (ответ по существу или честный запрос уточнения от
   конфигуратора — НЕ `AUTHORING_ACCESS_DENIED_MESSAGE`).
5. Открыть `/llm-connections` → убедиться, что «Назначить ассистенту» больше не задизейблено
   для ассистента этого тенанта (сравнимо с T-0574 AC-4).
6. Без вставки реального LLM-ключа (ключа физически нет — founder-todo) — отправить сообщение
   в чат аналитика или конфигуратора → увидеть человечный ответ «подключите LLM-ключ» со
   ссылкой на `/llm-connections`, НЕ `{"error":{"code":"INTERNAL"}}`, НЕ сырой 500.
7. Убедиться, что бейдж «демо» у пункта «Ассистент» в навигации снят.
8. Founder-todo, зафиксировано, НЕ входит в DoD этой задачи: фаундер вставляет реальный
   рабочий LLM-ключ на `/llm-connections`, назначает его ассистенту (сама возможность уже
   доказана шагом 5) → ассистент отвечает содержательным текстом реального провайдера.

## 8. Acceptance Criteria (машинно-проверяемые)

- **AC-1 (инвариант backfill, SQL-проверяемый).** Для КАЖДОГО тенанта в `choros.tenant`
  выполняется (проверяется прямым SQL-запросом к dev-БД после миграции):
  ```sql
  SELECT t.id AS tenant_id
  FROM choros.tenant t
  WHERE NOT EXISTS (
      SELECT 1 FROM choros.role r
       WHERE r.tenant_id = t.id AND r.slug = 'role-configurator'
    )
     OR NOT EXISTS (
      SELECT 1 FROM choros.employee e
       WHERE e.tenant_id = t.id AND e.slug = 'assistant-agent' AND e.kind = 'agent'
    )
     OR NOT EXISTS (
      SELECT 1 FROM choros.agent_card ac
       JOIN choros.employee e ON e.tenant_id = ac.tenant_id AND e.id = ac.employee_id
       WHERE ac.tenant_id = t.id AND e.slug = 'assistant-agent'
    )
     OR NOT EXISTS (
      -- owner → role-configurator confirmed assignment
      SELECT 1 FROM choros.role_assignment ra
       JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
       JOIN choros.role_assignment owner_ra
         ON owner_ra.tenant_id = ra.tenant_id AND owner_ra.employee_id = ra.employee_id
       JOIN choros.role owner_role
         ON owner_role.tenant_id = owner_ra.tenant_id AND owner_role.id = owner_ra.role_id
            AND owner_role.slug = 'tenant-owner'
       WHERE ra.tenant_id = t.id AND r.slug = 'role-configurator'
         AND ra.confirmed_by IS NOT NULL
    )
     OR NOT EXISTS (
      -- assistant-agent → role-configurator confirmed assignment
      SELECT 1 FROM choros.role_assignment ra
       JOIN choros.role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
       JOIN choros.employee e ON e.tenant_id = ra.tenant_id AND e.id = ra.employee_id
       WHERE ra.tenant_id = t.id AND r.slug = 'role-configurator'
         AND e.slug = 'assistant-agent' AND ra.confirmed_by IS NOT NULL
    )
     OR (
      SELECT COUNT(*) FROM choros."grant" g
       JOIN choros.role r ON r.tenant_id = g.tenant_id AND r.id = g.role_id
       WHERE g.tenant_id = t.id AND r.slug = 'role-configurator'
         AND g.resource_type = 'authoring_draft' AND g.operation IN ('create','update')
         AND g.confirmed_by IS NOT NULL
    ) < 2
     OR (
      SELECT COUNT(*) FROM choros."grant" g
       JOIN choros.role r ON r.tenant_id = g.tenant_id AND r.id = g.role_id
       WHERE g.tenant_id = t.id AND r.slug = 'role-configurator'
         AND g.resource_type IN ('llm_connection:configure','system_agent:operate')
         AND g.confirmed_by IS NOT NULL
    ) < 2;
  ```
  Запрос ОБЯЗАН вернуть 0 строк (пустой результат) после применения backfill-миграции —
  ни один тенант не остаётся без полного набора §2.1. *(fitness)*
- **AC-2.** Тот же SQL-запрос AC-1, выполненный ПОВТОРНО после повторного (второго) прогона
  backfill-миграции, по-прежнему возвращает 0 строк, и количество строк в `choros.role` /
  `choros.employee` / `choros.agent_card` / `choros.role_assignment` / `choros."grant"`
  не увеличилось по сравнению с состоянием сразу после первого прогона (идемпотентность —
  второй прогон не добавляет дублей). *(fitness)*
- **AC-3.** Grep-проверка: файл(ы) backfill-миграции этой задачи не содержат ни одного
  литерала-UUID тенанта (regex вида `'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-
  [0-9a-f]{12}'` вне динамически вычисляемых выражений/имён столбцов) — проверяется тем же
  механизмом, что и существующие `ci/checks/demo/no-hardcoded-tenant.sh` /
  `ci/checks/seed/no-hardcoded-fixture-ids.sh`, оба ОБЯЗАНЫ проходить на новом файле. *(fitness)*
- **AC-4.** На живом dev-стенде: владелец тенанта ООО Аксон (или эквивалентного тенанта без
  предварительного seed) после применения backfill открывает Ассистента-конфигуратора и
  отправляет содержательное сообщение → получает ответ, ОТЛИЧНЫЙ от
  `AUTHORING_ACCESS_DENIED_MESSAGE` (рабочий диалог конфигуратора: план/уточняющий вопрос/
  предложение — любой ответ, кроме отказа в правах). *(manual)*
- **AC-5.** Интеграционный тест (живая Postgres, не мок): при вызове `ctx.llm.chat()` внутри
  обработки сообщения ассистента, когда порт бросает ошибку, НЕ являющуюся `LlmDormantError`
  (смоделировано — например `OpenAILlmPort`-подобная ошибка сети/провайдера), HTTP-ответ
  маршрута `POST /api/assistant/threads/:id/messages` НЕ является `HTTP 500 {"error":{"code":
  "INTERNAL"}}` — ответ отражает честное состояние «LLM недоступен» (например тем же классом
  ответа, что и `LlmDormantError`-путь: `HTTP 503` с `message`, содержащим человекочитаемый
  текст и путь `/llm-connections`). *(test)*
- **AC-6.** Интеграционный тест: маршрут `POST /api/assistant/threads/:id/messages` для тенанта
  без ЛЮБОГО LLM-конфига (dormant path) возвращает тело ответа, текст `message` которого
  содержит подстроку `/llm-connections` (проверка наличия ссылки на экран подключения) — не
  просто «настройте BYO-ключ» без указания КУДА. *(test)*
- **AC-7.** Текстовый грep/юнит-тест: человекочитаемый текст ошибки «нет LLM» (оба места —
  dormant-путь `assistant.ts` и путь произвольной ошибки адаптера из AC-5) НЕ содержит ни
  одной из строк-маркеров дев-жаргона: `LLM_NOT_CONFIGURED` (как единственный текст без
  человеческого пояснения рядом), `OpenAILlmPort`, `endpoint`, `secretHandle`, `stack` —
  тест проверяет ТОЛЬКО пользовательское поле `message`/эквивалент, не машинный код `error`
  (код ошибки в JSON — не пользовательский текст, не предмет этого критерия). *(test)*
- **AC-8 (founder-todo, явно зафиксирован).** Путь «владелец тенанта получает от ассистента
  СОДЕРЖАТЕЛЬНЫЙ ответ реального LLM-провайдера (не заглушка, не честный отказ)» требует
  вставки настоящего рабочего API-ключа на `/llm-connections` — это НЕ проверяется в рамках
  DoD этой задачи (вставить ключ некому по директиве фаундера); фиксируется как отдельный
  founder-todo пункт, не блокирующий закрытие T-0573. *(manual — founder-only, вне автоматической
  приёмки)*
- **AC-9 (снятие бейджа «демо», честный критерий).** `web/src/app-shell/nav-config.js`
  пункт `{ id: "assistant" }` меняет `status: "demo"` → `status: "live"` ТОЛЬКО ПОСЛЕ того,
  как AC-1 (backfill применён) И AC-4 (владелец реально получает рабочий чат, не отказ в
  правах) зафиксированы зелёными — снятие бейджа без предварительно доказанных AC-1/AC-4
  является нарушением этой спеки (декоративное изменение без факта). Автоматизированная
  проверка: тест на `nav-config.js` (по образцу `nav-config.test.js`) подтверждает
  `status === "live"` для пункта `assistant`. *(test, гейт по порядку — CI обязан проверять
  этот тест ПОСЛЕ/вместе с AC-1..AC-7, не как независимую косметику)*
- **AC-10.** Существующий текст `AUTHORING_ACCESS_DENIED_MESSAGE` (не изменяется по
  содержанию этой задачей) по-прежнему возвращается для НЕ-владельца/НЕ-админа тенанта, не
  имеющего гранта `authoring_draft` даже после backfill (backfill выдаёт грант только владельцу
  и агенту, не всем сотрудникам тенанта) — регрессия проверяется существующим тестовым
  покрытием `assistant-configurator.test.ts` (не создаётся новый тест, если существующий уже
  покрывает не-владельца). *(test)*

## 9. Definition of done (справочно, не AC-поле)

DoD = зелёные AC-1..AC-3, AC-5..AC-7, AC-9, AC-10 в CI/тестах + AC-4 пройден глазами на
задеплоенном dev-стенде (LIVE_PROOF, D-064) — карточка не закрывается по одной лишь
арифметике дочерних PR, а по факту «владелец существующего тенанта открыл ассистента и
получил рабочий чат, а не отказ в правах». AC-8 — явный founder-todo, не входит в DoD.

---

*Файл: `docs/specs/T-0573-assistant-unlock.spec.md`. Разведка: `src/core/register.ts`
(шаги 3e-3j-bis, строки 313-497), `migrations/115_assistant_agent_card_backfill.sql`
(эталон формата backfill), `src/http/assistant.ts` (строка 1738 — `llmPortFactory` вне
try/catch; строки 1843-1995 — единственный перехватываемый тип `LlmDormantError`),
`src/http/router.ts` (строки 296-304 — универсальный fallback на сырой `INTERNAL`),
`src/core/assistant-configurator.ts` (строки 534-541 — `AUTHORING_ACCESS_DENIED_MESSAGE`,
598-602 — `hasAuthoringDraftGrant`), `src/core/llm-port.ts` (`LlmDormantError`,
`dormantLlmPort`), `src/adapters/openai-llm-port.ts` (строки 108/154 — источники
не-`LlmDormantError` ошибок), `web/src/app-shell/nav-config.js:115` (бейдж «демо»),
`web/src/app-shell/shell.jsx:242,422-423` (рендер бейджа). Спеки: `docs/specs/
ai-assistant-byo.spec.md` §3.1 (обещанный честный 503), `docs/specs/access-and-tenant-zero.
spec.md` §3.3 (F2 tenant-zero), `docs/specs/T-0574-tenant-llm-key.spec.md` §4 O1 (явно
передаёт эту задачу сюда).*
