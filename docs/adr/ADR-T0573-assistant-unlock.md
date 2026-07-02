# ADR-T0573 — Разблокировка ассистента для существующих тенантов

**Status:** ready
**Phase:** DESIGN
**Task:** T-0573 [W1/ассистент]
**Date:** 2026-07-02
**Спека:** `docs/specs/T-0573-assistant-unlock.spec.md` + `docs/specs/T-0573.spec.contract.json` (AC-1..AC-10)
**База:** dev @ `080486c` (ветка `task/T-0573-assistant-unlock`, следующая свободная миграция — **117**)
**Предшественники:** T-0373 (tenant-zero seed в `register.ts`), T-0475 (capability-гранты), T-0574 (agent_card ассистента + миграция 115 + экран `/llm-connections`), D-064 (LIVE_PROOF/анти-кейс/эпик=кейс-доказательство).

---

## 1. Контекст (L-факты разведки, не гипотезы)

Три независимых дефекта с одним корнем — **старые тенанты не прошли tenant-zero seeding**, который `register.ts` даёт только НОВЫМ регистрациям:

1. **Нет прав у владельца.** `register.ts:339-495` сидит новым тенантам 9 строк tenant-zero
   (`role-configurator`, `employee` `assistant-agent`, `agent_card`, 2× `role_assignment`, 4× `grant`).
   Старые тенанты (ООО Аксон `c7a70702…`) зарегистрированы ДО этого блока → у них НЕТ ни одной
   из 9 строк. `hasAuthoringDraftGrant` (`assistant-configurator.ts:598-602`) видит пустое
   пересечение → владелец получает `AUTHORING_ACCESS_DENIED_MESSAGE` (`assistant-configurator.ts:534`) —
   текст верен, но показывается ровно тому, кому продукт обещает доступ.
2. **Сырой INTERNAL вместо честного 503.** `assistant.ts:1738` строит LLM-порт ВНЕ try/catch
   (:1844-1995); внутри try единственный перехватываемый тип — `LlmDormantError` (:1956). Любая
   ДРУГАЯ ошибка адаптера (сбой резолва секрета, сетевая, `OpenAILlmPort._post` reject на HTTP
   ≥400/timeout/non-JSON — `openai-llm-port.ts:274/279/286/288`) прокидывается (`throw err` :1994)
   в общий catch роутера (`router.ts:296-304`), который для любой не-`HttpError` безусловно
   отдаёт `sendErrorEnvelope(res, 500, "INTERNAL", …)` → сырой `{"error":{"code":"INTERNAL"}}`.
3. **Бейдж «демо».** `nav-config.js:115` — пункт `assistant` имеет `status:"demo"`; рендерится
   чипом «демо» (`shell.jsx:242`). Данные ассистента реальны (audit_event, intersection-grant),
   бейдж относится к тому же классу, что снятый T-0550 с `forms`.

**Разведанное про идентичность (ответ на п.2 задания — нужен ли реальный KC-клиент).** Чат
ассистента идёт под identity **ВЛАДЕЛЬЦА**: `assistant.ts:1473` `extractActorSlug(req)` →
`resolveActorTenant`; `agentSlug="assistant-agent"` (:1463) используется ТОЛЬКО как субъект
grant-пересечения (`agentSubject` :1810, резолв по slug, не по auth). `kc_client_id=
'assistant-agent-'||tenant_id` — детерминированный адрес + глобальная уникальность (миграция
092), **НЕ настоящий Keycloak service account** (ассистент никогда не аутентифицируется как
клиент — он внутренний чат-хелпер тенанта). **ВЫВОД, зафиксирован явно: реальный KC-клиент
ассистента для чата НЕ нужен**; backfill воспроизводит тот же `kc_client_id`-паттерн, что 115 и
`register.ts:3f-bis`, как непрозрачный уникальный токен, не как auth-идентичность.

**Разведанная поправка к спеке (важно для coder).** N2/AC-3 утверждают, что
`ci/checks/demo/no-hardcoded-tenant.sh` и `ci/checks/seed/no-hardcoded-fixture-ids.sh` «уже
действуют на миграции». **Это неточно**: `no-hardcoded-tenant.sh` (FF-ACTOR-7) грепает ТОЛЬКО
`src/db/org.ts`; `no-hardcoded-fixture-ids.sh` (FF-10) — ТОЛЬКО тестовые каталоги. Ни один не
сканирует `migrations/`. Поэтому AC-3 закрывается НОВОЙ шелл-проверкой, грепающей файл миграции
117 на литерал-UUID (см. FF-3 ниже) — старые чеки прогоняются как совместимость (должны остаться
зелёными), но НЕ являются гарантией AC-3 для миграции.

**Разведанная поправка к envelope (урок T-0571 F-1).** Существующий dormant-путь
(`assistant.ts:1985-1991`) отдаёт **НЕ-канонический** `{"error":"LLM_NOT_CONFIGURED","message":…}`
(строка вместо объекта). Канонический envelope кодовой базы — `{"error":{"code","message"}}`
(`router.ts:183` `sendErrorEnvelope`). Обе ветки (dormant + adapter) ОБЯЗАНЫ отдавать канонический
объектный envelope, иначе клиент (и AC-5/AC-6/AC-7 тесты) читают поле не там.

---

## 2. Решение

Три соразмерные дельты, ноль новых таблиц/колонок/эндпоинтов, ассистент НЕ переписывается.

### 2.1 Дельта A — backfill-миграция `117_assistant_tenant_zero_backfill.sql` (F1, F2, N1–N4; AC-1, AC-2, AC-3)

**Одна миграция, set-driven, идемпотентная, аддитивная (INSERT-only), эталон формата — 115.**
Для КАЖДОГО тенанта досоздаёт недостающие из 9 строк tenant-zero — по образцу `register.ts:3e–3j-bis`,
но выраженные как `INSERT … SELECT … LEFT JOIN … WHERE <partner> IS NULL` + `ON CONFLICT DO NOTHING`.
**Одна миграция vs миграция+shared-функция:** выбрана ОДНА миграция (см. §3 отклонённые); анти-дрейф
между двумя seed-сайтами (`register.ts` TS-транзакция и миграция SQL) закрывается НЕ общим кодом
(потребовал бы SQL↔TS-рефактор, несоразмерно — O3-подобно), а **fitness-гейтом сверки** FF-2:
живой тест регистрирует свежий тенант через `registerTenant` И прогоняет инвариант-запрос AC-1 —
он ОБЯЗАН вернуть 0 строк, то есть оба сайта удовлетворяют один предикат. Если register.ts и
миграция разойдутся — FF-2 покраснеет.

Порядок вставки (каждый шаг — отдельный `INSERT…SELECT` с предикатом «партнёрской строки ещё нет»,
все — на РОВНО тех тенантах, где её нет; `role-configurator` и владелец резолвятся из уже
существующих строк тенанта, без литерала UUID):

- **A1. `role` `role-configurator`** — `SELECT t.id FROM tenant t LEFT JOIN role r (…r.slug=
  'role-configurator') WHERE r.id IS NULL`. `gen_random_uuid()` id, `display_name='Конфигуратор
  системы'`.
- **A2. `employee` `assistant-agent`** (`kind='agent'`) — аналогично, `WHERE e.id IS NULL`.
- **A3. `agent_card`** для этого employee — **точная логика миграции 115** (INSERT…SELECT FROM
  employee LEFT JOIN agent_card WHERE ac.id IS NULL, `agent_type='assistant'`, `kc_client_id=
  'assistant-agent-'||e.tenant_id::text`, llm_* = NULL). Порядок: A3 после A2, чтобы покрыть и
  тенанты, у которых employee создан только что этой же миграцией.
- **A4. `role_assignment` владелец → `role-configurator`** (F2). **Владелец = employee с
  `role_assignment` на роль `tenant-owner` этого тенанта** (ровно связка `register.ts:3d/3g`).
  `INSERT…SELECT` соединяет `role_assignment ra_owner JOIN role ro (ro.slug='tenant-owner')` →
  берёт `ra_owner.employee_id` как цель нового назначения на `role-configurator`;
  `granted_by=confirmed_by=<этот же владелец-employee>` (self-bootstrap, source='backfill'),
  `org_scope='{"kind":"set","members":[]}'` (⊥). Предикат «такого назначения ещё нет».
- **A5. `role_assignment` `assistant-agent` → `role-configurator`** — аналогично 3h; `granted_by=
  confirmed_by` = владелец тенанта (тот же, что A4).
- **A6. 2× `grant` `authoring_draft` create+update** на `role-configurator` (3i/3j), scope=⊥,
  `confirmed_by='backfill'`, предикат — этих грантов < 2.
- **A7. 2× `grant` `llm_connection:configure` + `system_agent:operate`** на `role-configurator`
  (3j-bis), scope=⊥, `confirmed_by='backfill'`, предикат — этих грантов < 2.

**Инварианты миграции:** `SET LOCAL search_path TO choros` в начале; каждый INSERT ведёт `tenant_id`
(T-0013); НИ ОДНОГО литерала UUID тенанта (всё через `SELECT` по существующим строкам, N2/AC-3);
`ON CONFLICT DO NOTHING` + `WHERE … IS NULL`/`COUNT < N` предикаты (идемпотентность N1/AC-2 —
второй прогон = no-op, дублей нет); НИ ОДНОГО `UPDATE`/`DELETE` (аддитивность N3); НЕ пишет
`llm_secret_handle` (остаётся NULL — dormant, FF-25-5 seed-plane инвариант не тронут); НИ ОДНОГО
кейс-специфичного литерала («Аксон», конкретный e-mail — N4/AC-3).

**`granted_by`/`confirmed_by` для грантов A6/A7** — строковый маркер `'backfill'` (как `register.ts`
использует `'registration'`); это НЕ UUID и НЕ FK на employee (колонки — свободный текст, ср.
`register.ts:437` `'registration'`), значит не требует резолва владельца и проходит грепы.

### 2.2 Дельта B — честная ошибка LLM-недоступности (F5, F6, F7, N5; AC-5, AC-6, AC-7, AC-10)

**Ввести доменную классификацию «LLM недоступен» и свести ОБА пути к одному честному ответу.**

- **B1. Классификатор `classifyLlmUnavailability(err)`** (новый чистый хелпер, соседствует с
  `LlmDormantError` в `src/core/llm-port.ts` — ядро, без IO). Возвращает `"unavailable"` для:
  (а) `err instanceof LlmDormantError` (конфига нет); (б) ошибок адаптера класса «ключ/провайдер/
  секрет» — распознаётся по признаку, НЕ по строке сообщения: адаптер бросает эти ошибки как
  подкласс `LlmUnavailableError` (новый экспорт в `llm-port.ts`), в который `OpenAILlmPort`
  оборачивает свои текущие `throw new Error(...)` точки (:108 невалидный handle, :155 невалидный
  JSON-ответ, `_post` reject на HTTP≥400/timeout/сеть/non-JSON). Возвращает `null` (НЕ маскировать)
  для любой другой ошибки — баг в нашем коде, синтаксическая ошибка, нарушение инварианта БД —
  такие продолжают падать в INTERNAL (не прячем баги под «нет ключа»). **Классификация по ТИПУ,
  а не по тексту** — чтобы N4 (никаких кейс-строк) и AC-7 (никакого дев-жаргона) держались.
- **B2. Единый обработчик в `assistant.ts`.** Расширить существующий catch (:1955): вместо
  `if (err instanceof LlmDormantError)` — `if (classifyLlmUnavailability(err) === "unavailable")`.
  Обернуть и построение порта (:1738 `llmPortFactory`) в тот же try (либо отдельный try→rethrow
  как классифицируемый), чтобы ошибка резолва конфигурации тоже ловилась. Внутри ветки:
  персистить «dormant/unavailable» assistant-сообщение (как сейчас :1960) с тем же
  человекочитаемым текстом, затем отдать **канонический** envelope.
- **B3. Единый текст и envelope (F6, AC-6, AC-7, T-0571 F-1).** Ответ:
  `HTTP 503`, тело `{"error":{"code":"LLM_UNAVAILABLE","message":<HUMAN>}}` — объектный envelope,
  ровно `router.ts:sendErrorEnvelope`-формы (можно переиспользовать её же). `<HUMAN>` — новая
  экспортируемая константа (соседствует с текстами в `assistant-configurator.ts` или новый
  `assistant-messages.ts`):
  > «Ассистент пока не может ответить — не подключён рабочий LLM-ключ. Подключите или проверьте
  > ключ на странице «Подключения LLM» (/llm-connections), затем повторите.»

  Требования к тексту (AC-6, AC-7): содержит подстроку `/llm-connections`; НЕ содержит
  дев-жаргона `LLM_NOT_CONFIGURED`/`OpenAILlmPort`/`endpoint`/`secretHandle`/`stack` в ПОЛЕ
  `message` (машинный `code` — не предмет AC-7). Старый текст «LLM не настроен — настройте
  BYO-ключ…» и старый не-канонический envelope (:1987) — заменяются на этот.
- **B4. N5 (границы доступа не меняются).** Правится ТОЛЬКО содержание/форма ответа внутри уже
  существующего гейта (владелец/член тенанта дошёл до чата). Круг лиц, видящих ошибку, не
  расширяется и не сужается.
- **B5. AC-10 (регресс отказа в правах).** `AUTHORING_ACCESS_DENIED_MESSAGE` по СОДЕРЖАНИЮ не
  трогается (O6). Для НЕ-владельца/НЕ-админа без гранта (даже после backfill — backfill выдаёт
  назначение на `role-configurator` только владельцу A4 и агенту A5, не всем сотрудникам)
  отказ по-прежнему возвращается. Покрыто существующим `assistant-configurator.test.ts` — новый
  тест не создаётся, если существующий уже покрывает не-владельца (FF-8 = прогон существующего).

### 2.3 Дельта C — снятие бейджа «демо» (N6; AC-9)

**Статический флип** `status:"demo"→"live"` в `nav-config.js:115` для пункта `assistant`. Выбран
статический флип, НЕ динамический признак (см. §3 отклонённые): бейдж — глобальное свойство
«функция доставлена», а не per-tenant runtime-состояние; динамика тут = ложная точность (для
тенанта без ключа ассистент всё равно «live»-функция, честно отвечающая «подключите ключ» — это
рабочее состояние, а не демо-мок). **Анти-декорация (D-064, N6):** флип легитимен ТОЛЬКО как
следствие доказанных AC-1 (backfill применён) + AC-4 (владелец получил рабочий чат). Гейт порядка
— fitness FF-9: тест `nav-config.test.js` утверждает `status==='live'` для `assistant`, и в CI он
живёт в общем прогоне ПОСЛЕ/вместе с db-тестами AC-1/AC-2 (FF-1) — не как независимая косметика.
Бейдж≡контент (G7): чип рендерится из `status` (`shell.jsx:242`), другого источника «демо» для
этого пункта нет → снятие статуса снимает и чип, рассинхрона нет.

---

## 3. Отклонённые альтернативы

| Опция | Почему нет |
|---|---|
| Backfill = миграция + shared TS/SQL-функция, общая с `register.ts` | Требует SQL↔TS-рефактор seed-транзакции (register.ts вставляет per-row параметризованными query, не SQL-функцией); несоразмерно объёму (§3 задания). Анти-дрейф дешевле закрыть fitness-сверкой FF-2 (register+инвариант-запрос вместе), чем разделяемым кодом. |
| Расширить миграцию 115 на месте (дописать недостающие 8 строк) | 115 уже применена и трекнута в `schema_migrations` — правка тела применённой миграции = невоспроизводимое состояние на средах, где 115 уже прошла. Новая 117 — единственно корректно. |
| Хардкод известного dev-tenant UUID в backfill | Нарушает N2/AC-3, молча пропустит прочие тенанты. Set-driven SELECT из `tenant`/`role_assignment` — единственно верно. |
| Backfill только грантов (как думала первая гипотеза) | LIVE_PROOF T-0574 доказал: у старых тенантов НЕТ и employee, и role, и agent_card — не только грантов. Гранты на несуществующую роль/агента ничего не разблокируют. Нужен ПОЛНЫЙ инвариант 9 строк. |
| Классифицировать «нет ключа» по СТРОКЕ сообщения ошибки | Хрупко, тянет дев-жаргон в проверки (нарушая AC-7 дух), ломается при смене формулировки адаптера. Классификация по ТИПУ (`LlmUnavailableError` подкласс) — устойчива. |
| Маскировать ЛЮБУЮ ошибку в try-блоке под «нет ключа» (503 на всё) | Прячет реальные баги (нарушение инварианта, ошибка кода) под ложным «подключите ключ» — анти-паттерн наблюдаемости. Классификатор возвращает `null` для не-LLM ошибок → они честно падают в INTERNAL. |
| Динамический бейдж (снимать per-tenant по наличию рабочего ключа) | Ложная точность: ассистент — доставленная «live» функция даже без ключа (честно отвечает «подключите»). Per-tenant demo/live усложняет `nav-config` (статическая структура) и путает G7 бейдж≡контент. Статический флип честнее и проще. |
| Снять бейдж отдельным косметическим PR раньше backfill | Прямое нарушение D-064 «эпик=кейс-доказательство»/N6: бейдж «live» без факта разблокировки = декорация впереди факта. FF-9 гейтует порядок. |
| Реальный Keycloak service account для assistant-agent | Чат идёт под identity владельца; ассистент как auth-клиент не нужен (§1). Лишняя KC-поверхность ради несуществующей потребности. |

---

## 4. Object model (изменяемые/затрагиваемые сущности — новых колонок/таблиц НЕТ)

Backfill досоздаёт СТРОКИ в существующих таблицах — точные шейпы см. `register.ts:3e–3j-bis` и
миграцию 115. Ключевые:

- **`role`** — новая строка `slug='role-configurator'` для тенантов без неё (id `gen_random_uuid()`).
- **`employee`** — новая строка `slug='assistant-agent'`, `kind='agent'`, `position_id=NULL`.
- **`agent_card`** — новая строка (`agent_type='assistant'`, `kc_client_id='assistant-agent-'||
  tenant_id`, все `llm_*`/`autonomy_threshold` = NULL) — ровно шейп миграции 115.
- **`role_assignment`** ×2 — владелец→`role-configurator` (A4) и `assistant-agent`→`role-configurator`
  (A5), `org_scope=⊥`, `confirmed_by` NOT NULL.
- **`grant`** ×4 — `authoring_draft/create`, `authoring_draft/update`, `llm_connection:configure/
  configure`, `system_agent:operate/operate` на `role-configurator`, `scope=⊥`, `confirmed_by`
  NOT NULL.

Наблюдаемое (не хранимое) состояние ответа ассистента:
- **`AssistantErrorResponse`** — `{ statusCode: 503, body: {error:{code:"LLM_UNAVAILABLE",
  message: <HUMAN, содержит "/llm-connections", без дев-жаргона>}} }` — единый для dormant и
  adapter-путей.

---

## 5. Контракты для coder/tester

1. **Миграция** `migrations/117_assistant_tenant_zero_backfill.sql` — 7 блоков A1–A7
   (§2.1), заголовок-комментарий по образцу 115/116 (почему/set-driven/идемпотентно/аддитивно).
2. **`src/core/llm-port.ts`** — добавить `export class LlmUnavailableError extends Error`
   (подкласс/сосед `LlmDormantError`) + `export function classifyLlmUnavailability(err: unknown):
   "unavailable" | null` (dormant ∪ unavailable → "unavailable"; иначе null). Ядро, без IO
   (FF-LP-9 no-env-in-core остаётся зелёным).
3. **`src/adapters/openai-llm-port.ts`** — точки `throw new Error(...)` (:108, :155) и `_post`
   reject-ы (:274/279/286/288) оборачиваются в `LlmUnavailableError` (сохраняя `cause` для логов;
   пользователю уходит НЕ текст исключения, а константа B3). Грепнуть импортёров `OpenAILlmPort`
   на предмет ловли конкретного `Error` (public-поверхность).
4. **Текст-константа** `ASSISTANT_LLM_UNAVAILABLE_MESSAGE` (B3) — экспорт; содержит
   `/llm-connections`, без дев-жаргона.
5. **`src/http/assistant.ts`** — catch-ветка (:1955) переходит на `classifyLlmUnavailability`;
   построение порта (:1738) попадает в тот же перехват; ответ — канонический `{error:{code,
   message}}` 503 (B2/B3). Старый не-канонический envelope (:1987) удаляется.
6. **`web/src/app-shell/nav-config.js:115`** — `status:"demo"→"live"` (C).

**Затронутая public-поверхность (grep-обязательство §5 правил architect):** `LlmDormantError`
импортируется в `assistant.ts` (и, вероятно, тестах/других хендлерах) — новый `classifyLlmUnavailability`
аддитивен, `LlmDormantError` НЕ удаляется (остаётся частью классификации). `OpenAILlmPort` —
композиционный корень + db-тесты. Coder обязан грепнуть `LlmDormantError`, `OpenAILlmPort`,
`status: "demo"` перед изменением.

---

## 6. Fitness-функции (исполнимые CI-правила)

| id | правило | ci_check |
|---|---|---|
| FF-1 | AC-1: после миграции 117 инвариант-запрос §8 AC-1 возвращает 0 строк для всех тенантов (живой Postgres) | `vitest run ci/checks/db/migration-117-tenant-zero-backfill.test.ts --no-file-parallelism` |
| FF-2 | AC-1/анти-дрейф: свежерегистрированный через `registerTenant` тенант И backfill-тенант ОБА проходят инвариант-запрос (0 строк) — два seed-сайта удовлетворяют один предикат | `vitest run ci/checks/db/migration-117-tenant-zero-backfill.test.ts --no-file-parallelism` |
| FF-3 | AC-2: повторный прогон тела 117 — no-op (0 новых строк в role/employee/agent_card/role_assignment/grant), инвариант всё ещё 0 строк | `vitest run ci/checks/db/migration-117-tenant-zero-backfill.test.ts --no-file-parallelism` |
| FF-4 | AC-3: файл `migrations/117_*.sql` не содержит литерала UUID тенанта (regex `[0-9a-f]{8}-…-[0-9a-f]{12}`); совместимость — старые `no-hardcoded-tenant.sh`/`no-hardcoded-fixture-ids.sh` зелёные | `bash ci/checks/migrations/no-hardcoded-tenant-uuid.sh && bash ci/checks/demo/no-hardcoded-tenant.sh && bash ci/checks/seed/no-hardcoded-fixture-ids.sh` |
| FF-5 | AC-5: `ctx.llm.chat()` бросает не-`LlmDormantError` (смоделировано) → `POST /api/assistant/threads/:id/messages` НЕ 500 INTERNAL, а 503 с `error.code="LLM_UNAVAILABLE"` и `message` c `/llm-connections` (живой Postgres, реальные маршруты) | `vitest run ci/checks/db/assistant-llm-unavailable.test.ts --no-file-parallelism` |
| FF-6 | AC-6: тот же маршрут для тенанта без ЛЮБОГО LLM-конфига (dormant) → тело содержит подстроку `/llm-connections` в пользовательском тексте | `vitest run ci/checks/db/assistant-llm-unavailable.test.ts --no-file-parallelism` |
| FF-UX-7 | AC-7 (жаргон-denylist на НОВОМ тексте): поле `message` обоих путей LLM-ошибки не содержит `LLM_NOT_CONFIGURED`(как единственный текст)/`OpenAILlmPort`/`endpoint`/`secretHandle`/`stack` | `bash ci/checks/ux/assistant-llm-message-jargon.sh && vitest run src/__tests__/assistant-llm-message.unit.test.ts` |
| FF-8 | AC-10: `AUTHORING_ACCESS_DENIED_MESSAGE` неизменен по содержанию и возвращается не-владельцу без гранта после backfill (регресс) | `vitest run src/__tests__/assistant-configurator.test.ts` |
| FF-UX-9 | AC-9 (бейдж≡контент, гейт порядка): `nav-config` пункт `assistant` имеет `status==='live'`; тест бежит вместе с db-гейтами AC-1 (не как независимая косметика) | `vitest run web/src/app-shell/nav-config.test.js` |

---

## 7. Traceability (AC → покрытие)

- AC-1 → FF-1, FF-2
- AC-2 → FF-3
- AC-3 → FF-4
- AC-4 → manual (LIVE_PROOF §7 спеки; вне авто-гейта, но DoD)
- AC-5 → FF-5
- AC-6 → FF-6
- AC-7 → FF-UX-7
- AC-8 → founder-todo (вне DoD; вставка реального ключа фаундером)
- AC-9 → FF-UX-9 (гейтован порядком за FF-1/AC-4)
- AC-10 → FF-8

---

## 8. Escalation

Нет. Все дельты автономны в рамках impl-прогона. AC-8 (реальный рабочий LLM-ключ) — уже
зафиксированный спекой **founder-todo**, НЕ входит в DoD T-0573 и не требует эскалации сейчас:
задача закрывается на «права + честная ошибка + адресуемость + бейдж», ключ вставляет фаундер
позже (директива фаундера, §4 O1 спеки).

---

*Файл: `docs/adr/ADR-T0573-assistant-unlock.md`. Разведка кода: `src/core/register.ts:220-495`
(шаги 3a-3j-bis, эталон инварианта), `migrations/115_assistant_agent_card_backfill.sql` (эталон
формата backfill), `migrations/116` (следующий свободный № = 117), `src/http/assistant.ts:1738/
1844-1995` (порт вне try, единственный catch = LlmDormantError), `src/http/router.ts:183/296-304`
(канонический sendErrorEnvelope vs fallback INTERNAL), `src/core/llm-port.ts` (LlmDormantError/
dormantLlmPort), `src/adapters/openai-llm-port.ts:108/155/274-288` (источники не-dormant ошибок),
`src/core/assistant-configurator.ts:534/598-602` (AUTHORING_ACCESS_DENIED / hasAuthoringDraftGrant),
`web/src/app-shell/nav-config.js:115` + `shell.jsx:242` (бейдж), `ci/checks/db/assistant-llm-binding.
test.ts` + `ci/checks/db/migration-115-backfill.test.ts` (эталоны live-pg тестов), `ci/checks/ux/
ux-g5-jargon-denylist.sh` (эталон жаргон-denylist). Поправки к спеке зафиксированы в §1: (1) старые
CI-чеки НЕ сканируют migrations/ → нужна новая проверка FF-4; (2) следующий № = 117, не 118; (3)
dormant-envelope сегодня не-канонический — обе ветки переводятся на {error:{code,message}}.*
