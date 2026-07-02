# ADR-T0595 — Кликабельный deep-link в honest-503 ассистента, честно по правам

**Status:** ready
**Phase:** DESIGN
**Task:** T-0595 [W2/бесшовность]
**Date:** 2026-07-02
**Спека:** `docs/specs/T-0595-assistant-deeplink.spec.md` + `docs/specs/T-0595.spec.contract.json` (AC-1..AC-9)
**База:** dev @ `0370cf5` (ветка `task/T-0595-assistant-deeplink`)
**Предшественники:** T-0573 (honest-503, canonical envelope, `ASSISTANT_LLM_UNAVAILABLE_MESSAGE`,
жаргон-гейт `assistant-llm-message-jargon.sh`), T-0465/D8-G4 (`DeepLink` контракт + рендер в
`screen-assistant.jsx`), T-0539 (`loadAdminContext`/admin-zone canonical predicate).

---

## 1. Решение

**Сервер (не клиент) решает, кому положена кнопка**, переиспользуя существующий admin-резолвер;
клиент рендерит ровно то, что получил, тем же паттерном, что уже есть для bundle-review
deep-links. Ноль новых таблиц/эндпоинтов/UI-примитивов.

### 1.1 Дельта A — admin-ветвление в `respondLlmUnavailable` (F1-F3, AC-1..AC-4)

`respondLlmUnavailable` (`src/http/assistant.ts:1160-1195`) уже получает `tenantId` и
`actorSlug`. Добавляется ОДИН резолв ПЕРЕД отправкой envelope:

```ts
const admin = await loadAdminContext(pool, tenantId, actorSlug, Date.now());
const isAdmin = admin.isGenesisOwner || admin.adminGrants.length > 0;
```

Это ТОЧНО тот предикат, который уже гейтует видимость admin-зоны на клиенте
(`src/http/org.ts:379`: `isGenesisOwner || adminCtx.adminGrants.length > 0` →
`zones.push("admin")`) и `nav-config.js` `projectZones` (`web/src/app-shell/nav-config.js:240`).
Переиспользуем — не изобретаем параллельный предикат, который может разойтись.

**Два текста, два envelope-шейпа** (заменяют единственную сегодняшнюю константу
`ASSISTANT_LLM_UNAVAILABLE_MESSAGE`):

- **Admin** (`ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN`): «Ассистент пока не может ответить —
  не подключён рабочий LLM-ключ. Подключите или проверьте ключ на странице «Подключения LLM»,
  затем повторите.» (голый `(/llm-connections)` убран — F-2). Envelope несёт
  `error.deepLinks: [{path:"/llm-connections", label:"Открыть подключения LLM"}]`.
- **Не-admin** (`ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN`): «Ассистент пока не может
  ответить — не подключён рабочий LLM-ключ. Обратитесь к администратору тенанта, чтобы
  подключить ключ, затем повторите.» Никакого пути, никакой кнопки — `error.deepLinks`
  отсутствует (ключ не сериализуется вовсе, не пустой массив — честная асимметрия шейпа, а не
  «пустая полка»).

Обе константы живут в `src/core/assistant-messages.ts` (соседствуют со старой, которая
удаляется — оба call site (`:1799`, `:2028`) уже проходят через ЕДИНСТВЕННУЮ функцию
`respondLlmUnavailable`, так что правка ровно одного места покрывает оба failure-сайта).

Персист assistant-сообщения (`payload.text`) использует ТОТ ЖЕ текст, что уходит в HTTP-тело —
инвариант «пользователь видит в треде то же, что в error.message» (существующий с T-0573)
сохраняется для обеих веток.

### 1.2 Дельта B — `sendErrorEnvelope` остаётся неизменной; deepLinks добавляется через
прямую сборку тела в `respondLlmUnavailable` (F1, N1)

`sendErrorEnvelope(res, code, message)` (`router.ts:177-187`) — общая утилита с фиксированной
сигнатурой `{error:{code,message}}`, используемая ДЕСЯТКАМИ мест. Расширять её сигнатуру ради
одного call site — не соразмерно и рискованно (все остальные вызовы теряют смысл нового
параметра). Вместо этого `respondLlmUnavailable` для admin-ветки строит envelope НАПРЯМУЮ (как
уже делает non-ok bundle-путь для `deepLinks` на success-ответе, `assistant.ts:2080-2085`, —
инлайн-JSON, не через `sendErrorEnvelope`):

```ts
if (isAdmin) {
  const body = JSON.stringify({
    error: {
      code: "LLM_UNAVAILABLE",
      message: ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN,
      deepLinks: [{ path: "/llm-connections", label: "Открыть подключения LLM" }],
    },
  });
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json");
  res.end(body);
} else {
  sendErrorEnvelope(res, 503, "LLM_UNAVAILABLE", ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN);
}
```

`sendErrorEnvelope` НЕ модифицируется (N1, аддитивность на уровне вызова, не сигнатуры) — её
контракт `{error:{code,message}}` остаётся неизменным для всех ~10 существующих вызовов; только
ЭТОТ call site иногда обходит её ради одного лишнего поля. Альтернатива (расширить сигнатуру
`sendErrorEnvelope` необязательным 5-м параметром) — рассмотрена и отклонена в §3.

### 1.3 Дельта C — рендер на клиенте (F4, AC-5)

`screen-assistant.jsx` `send()` 503-ветка (`:166-180`) сегодня строит `assistantMsg` без поля
`deepLinks`. Добавляется чтение `d.error.deepLinks` (массив или `undefined`):

```js
const assistantMsg = {
  id: `msg-dormant-${Date.now()}`,
  role: 'assistant',
  text: assistantErrorText(d, 'LLM не настроен — настройте BYO-ключ для активации ассистента.'),
  ts: new Date().toISOString(),
  streaming_done: true,
  deepLinks: (d && d.error && Array.isArray(d.error.deepLinks)) ? d.error.deepLinks : null,
};
```

`MessageBubble` (`:424`: `const deepLinks = Array.isArray(msg.deepLinks) ? msg.deepLinks :
[]`) уже читает `msg.deepLinks` универсально (используется сегодня успешным bundle-путём,
`:207`) — НИКАКОЙ правки рендер-блока (`:568-584`) не требуется. Один и тот же JSX-блок «Проверьте
черновик в разделах:» рендерит кнопку и для bundle-review, и теперь для honest-503. Заголовок
блока («Проверьте черновик в разделах:») контекстно неточен для 503-случая — минорная правка:
заголовок вычисляется по наличию `msg.intent` (bundle-путь всегда несёт `intent`, honest-503 —
нет, `respondLlmUnavailable` не устанавливает `intent`) — см. Контракты §4.

### 1.4 Дельта D — гейт `assistant-llm-message-jargon.sh` (N4, AC-7) — САНКЦИОНИРОВАННОЕ
аддитивное обновление ЧУЖОГО гейта

Гейт создан T-0573, проверяет ОДНУ константу `ASSISTANT_LLM_UNAVAILABLE_MESSAGE` на присутствие
`/llm-connections` (AC-6 T-0573). Т.к. текст расщепляется на ДВЕ константы (admin/non-admin,
§1.1), и admin-текст по F-2 БОЛЬШЕ НЕ содержит `/llm-connections` (путь заменён кнопкой), гейт
обновляется — не отменяется, не ослабляется вслепую, а **пересобирается под новый контракт**,
с явным комментарием-санкцией в самом файле:

```bash
# T-0595 по UX_REVIEW T-0573 F-2: ASSISTANT_LLM_UNAVAILABLE_MESSAGE расщеплена на
# ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN (путь заменён кликабельной кнопкой — /llm-connections
# в прозе больше не требуется, деньлист по-прежнему в силе) и
# ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN (путь НЕ упоминается вовсе — не-админ не может
# им воспользоваться). Обе проверяются по СВОЕМУ контракту, старая единая проверка на
# "содержит /llm-connections" заменяется на:
#   ADMIN:     НЕ содержит "/llm-connections" (F-2 — путь заменён кнопкой) И денилист чист.
#   NON_ADMIN: НЕ содержит "/llm-connections" И денилист чист И явно упоминает "администратор".
```

`extract_message` обобщается на обе константы (цикл по массиву имён вместо одной); denylist
(`LLM_NOT_CONFIGURED`, `OpenAILlmPort`, `endpoint`, `secretHandle`, `stack`) проверяется на
ОБЕИХ без изменений. `--self-test` расширяется двумя новыми fixture-парами (good/bad для каждой
константы), старые good/bad fixtures (одна константа) заменяются на актуальный контракт
(единая константа `ASSISTANT_LLM_UNAVAILABLE_MESSAGE` удаляется из кода — self-test на неё был
бы вводящим в заблуждение, если оставить как «мёртвый» сценарий; вместо этого self-test
проверяет ОБЕ новые константы). Это ТОЧНО санкция, требуемая заданием: «текст меняется
санкционированно самим стюардом (его finding)» — F-2 явно предписывает убрать голый путь, когда
появится клик-переход; T-0595 это и есть тот клик-переход.

### 1.5 Совместимость `assistant-llm-unavailable.test.ts` (T-0573 db-fitness, FF-5/FF-6)

Этот тест регистрирует тенанты через `registerTenant`, чей owner всегда получает
`tenant-owner` role → `isGenesisOwner=true` → ВСЕГДА admin-ветка. Ассерт
`expect(body.error.message).toContain('/llm-connections')` (`:184`, `:211`) **больше не
корректен** для admin-текста (F-2 убрал путь из прозы) — обновляется на:
`expect(body.error.deepLinks).toEqual([{ path: '/llm-connections', label: expect.any(String) }])`
(проверяем структурный контракт вместо текстовой подстроки — точнее и переживёт будущие правки
формулировки). Это ожидаемая правка теста T-0573 в рамках T-0595 (не «чужой» гейт — тест
проверяет ПОВЕДЕНИЕ envelope, а не зафиксированную формулировку; F-2 прямо предписывает это
изменение).

---

## 2. Object model

Изменений схемы БД нет. Наблюдаемое (не хранимое) состояние ответа:

- **`AssistantErrorResponse`** (расширение, аддитивно) —
  `{ statusCode: 503, body: { error: { code: "LLM_UNAVAILABLE", message: <HUMAN>,
  deepLinks?: DeepLink[] } } }`. `deepLinks` присутствует ⟺ actor admin; для не-admin поле
  ОТСУТСТВУЕТ (не `[]` — различимо от «bundle без предметов», семантика «не положено», не
  «пока пусто»).
- **`DeepLink`** — переиспользуется существующий тип (`assistant.ts:907-914`,
  `{label, path, kind}`), но `error.deepLinks` использует УПРОЩЁННУЮ форму `{label, path}` без
  `kind` (kind нужен только рендеру bundle-review для иконки app/process; honest-503-кнопка не
  привязана к сущности — иконка не нужна, `MessageBubble` ветвление `dl.kind === 'process' ?
  <Icon name="process"/> : <Icon name="apps"/>` (`:579`) по умолчанию рисует `apps`-иконку, что
  приемлемо as-is — правка иконки вне скоупа, косметика допустима).

---

## 3. Отклонённые альтернативы

| Опция | Почему нет |
|---|---|
| Клиент решает admin-статус (читает `navCaps` из `GET /api/me/nav-capabilities`, прячет кнопку) | Дублирует источник правды, расходится при stale client state / нескольких вкладках; честность (G7) должна гарантироваться сервером, который и есть единственный арбитр admin-статуса. Спека прямо требует «сервер знает admin-контекст вызывающего». |
| Расширить `sendErrorEnvelope` пятым необязательным параметром `deepLinks` | Меняет сигнатуру утилиты с ~10 вызовами ради одного call site; остальные вызовы получили бы неиспользуемый параметр без смысла. Прямая инлайн-сборка тела в `respondLlmUnavailable` (как уже делает bundle-success-путь) — соразмернее и локальнее. |
| Единая константа текста + флаг `showLink: boolean`, кнопка рендерится всегда (просто disabled для не-админа) | Disabled-кнопка на недостижимый путь — тот же анти-паттерн «честно назвали → нечестно предложили», просто в другой форме (видимый, но неработающий контрол хуже, чем полное отсутствие). Спека требует ЧЕСТНОГО текста без мёртвой кнопки, не декоративного disabled-состояния. |
| Пустой массив `deepLinks: []` для не-админа (вместо отсутствия поля) | Семантически «результат посчитан, но нечего показать» (как bundle с 0 предметов) — вводит в заблуждение: здесь НЕ «нечего показать», а «не положено показывать». Отсутствие поля — честнее и differentiable от bundle-empty-case. |
| Смягчить/удалить `assistant-llm-message-jargon.sh` вместо обновления | Прямое нарушение задания: гейт ЧУЖОЙ (T-0573), удаление/ослабление без причины — деградация. Правка ТОЛЬКО аддитивная, с явной санкцией в комментарии и self-test, покрывающим НОВЫЙ контракт (обе константы). |
| Не трогать `assistant-llm-unavailable.test.ts` (оставить textContain-ассерт, добавить отдельный SKIP) | Тест стал бы КРАСНЫМ (admin-текст больше не содержит `/llm-connections`) — не вариант; either чинить его под новый контракт, either оставить сломанным. Первое — единственный честный путь, тест и так проверяет ПОВЕДЕНИЕ (T-0573 FF-5/FF-6), а не буквальную строку. |
| Разный `kind` для honest-503 deep-link (новое значение `"settings"` в `DeepLink.kind`) | Несоразмерно: единственное потребление `kind` — выбор иконки (app/process), дефолт на `apps`-иконку для honest-503-кнопки визуально приемлем, не вводит в заблуждение (просто иконка «приложения» вместо специализированной). Новое значение enum — лишняя поверхность ради косметики иконки. |

---

## 4. Контракты для coder/tester

1. **`src/core/assistant-messages.ts`** — `ASSISTANT_LLM_UNAVAILABLE_MESSAGE` (единая) заменяется
   на `ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN` + `ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN`
   (обе export, обе без дев-жаргона, admin-текст без `/llm-connections`, non-admin-текст без
   `/llm-connections` и с явным «обратитесь к администратору»).
2. **`src/http/assistant.ts`** `respondLlmUnavailable` (:1160) — принимает то же (`pool`,
   `tenantId`, `threadId`, `actorSlug`, `agentSlug`, `res`); внутри резолвит
   `loadAdminContext(pool, tenantId, actorSlug, Date.now())`, ветвится на
   `isGenesisOwner || adminGrants.length > 0`; персистит В ТРЕД тот текст, что соответствует
   ветке; отправляет envelope по §1.2 (admin — инлайн JSON с `deepLinks`; non-admin —
   `sendErrorEnvelope` без изменений сигнатуры). Импорт `loadAdminContext` из `../db/org.js`
   (уже импортируется `resolveActorSlugFromArgs`/`resolveActorSlugFromAuth` оттуда — сосед).
3. **`web/src/screens/screen-assistant.jsx`** — 503-ветка `send()` (:166) добавляет поле
   `deepLinks` в `assistantMsg` (чтение `d.error.deepLinks`, см. §1.3). `MessageBubble`
   рендер-блок (:568-584) НЕ меняется структурно; заголовок блока (:570, «Проверьте черновик в
   разделах:») переключается по признаку `msg.intent` (bundle несёт `intent`, honest-503 —
   нет): условный текст `msg.intent ? 'Проверьте черновик в разделах:' : 'Действие:'` — минимальная
   контекстная правка ярлыка, не новый компонент.
4. **`ci/checks/db/assistant-llm-unavailable.test.ts`** (T-0573, живой Postgres) — ассерты
   `.toContain('/llm-connections')` заменяются на структурную проверку `error.deepLinks`
   (§1.5); owner в этом тесте всегда admin.
5. **`ci/checks/ux/assistant-llm-message-jargon.sh`** — обновляется аддитивно по контракту §1.4
   (санкция T-0595 по F-2 в комментарии, обе константы, обновлённый `--self-test`).
6. **`web/src/screens/__tests__/screen-assistant.error-envelope.test.js`** — 8 существующих
   тестов НЕ ломаются (envelope-чтение `d.error.message` не менялось); ДОБАВЛЯЮТСЯ новые кейсы:
   canonical-body-с-deepLinks → `assistantErrorText` по-прежнему возвращает `message` (deepLinks
   не мешает извлечению текста — pure-функция игнорирует незнакомые поля); source-grep
   подтверждает, что 503-ветка кладёт `deepLinks` из `d.error.deepLinks` в рендеримое сообщение.
7. **Новый db-fitness тест** (или расширение `assistant-llm-unavailable.test.ts`) — AC-1/AC-2:
   admin-actor (owner, как во всех текущих сценариях этого файла) получает `error.deepLinks` с
   `path==="/llm-connections"`; НЕ-admin actor (сотрудник БЕЗ `role-configurator`/mgmt-грантов —
   например `employee`, зарегистрированный через прямой INSERT без role_assignment на
   `role-configurator`/`tenant-owner`, либо переиспользование существующего фикстур-паттерна
   не-владельца из `assistant-configurator.test.ts`, FF-8 T-0573) НЕ получает `deepLinks` и видит
   non-admin-текст.

**Затронутая public-поверхность (grep-обязательство):** `ASSISTANT_LLM_UNAVAILABLE_MESSAGE`
(единственный старый экспорт) удаляется — coder ОБЯЗАН грепнуть все импортёры (сейчас: только
`assistant.ts` и `assistant-llm-message-jargon.sh` через `extract_message` в файле-константе,
плюс любые unit-тесты на константу — проверить `src/__tests__/assistant-llm-message.unit.test.ts`
упомянутый в ADR-T0573 FF-UX-7 ci_check и обновить его на новые константы). `sendErrorEnvelope`
НЕ меняется (сигнатура/импортёры не затронуты).

---

## 5. Fitness-функции

| id | правило | ci_check |
|---|---|---|
| FF-1 | AC-1: admin actor получает `error.deepLinks` с `path==="/llm-connections"` и непустым `label` в honest-503 (dormant И adapter-failure пути) | `vitest run ci/checks/db/assistant-llm-unavailable.test.ts --no-file-parallelism` |
| FF-2 | AC-2: НЕ-admin actor НЕ получает `error.deepLinks` (поле отсутствует) в honest-503 | `vitest run ci/checks/db/assistant-llm-unavailable.test.ts --no-file-parallelism` |
| FF-3 | AC-3: non-admin-текст не содержит `/llm-connections`, содержит указание на администратора | `bash ci/checks/ux/assistant-llm-message-jargon.sh` |
| FF-4 | AC-4: admin-текст не содержит голого `(/llm-connections)`, упоминает «Подключения LLM» по названию, денилист чист | `bash ci/checks/ux/assistant-llm-message-jargon.sh` |
| FF-5 | AC-5: `screen-assistant.jsx` 503-ветка кладёт `deepLinks` из `d.error.deepLinks`; рендер тем же паттерном, что bundle-review | `vitest run web/src/screens/__tests__/screen-assistant.error-envelope.test.js` |
| FF-6 | AC-6: существующие 8 тестов error-envelope продолжают проходить (аддитивность envelope) | `vitest run web/src/screens/__tests__/screen-assistant.error-envelope.test.js` |
| FF-7 | AC-7: `assistant-llm-message-jargon.sh` и его `--self-test` зелёные после обновления под новый контракт (обе константы) | `bash ci/checks/ux/assistant-llm-message-jargon.sh && bash ci/checks/ux/assistant-llm-message-jargon.sh --self-test` |
| FF-8 | AC-8: полный локальный CI (root+web) зелёный | `npm run ci && (cd web && npx vitest run)` |
| FF-9 | AC-9: `ux-g5-jargon-denylist.sh` не показывает новых находок на видимом тексте T-0595 | `bash ci/checks/ux/ux-g5-jargon-denylist.sh` |

---

## 6. Traceability

- AC-1 → FF-1
- AC-2 → FF-2
- AC-3 → FF-3
- AC-4 → FF-4
- AC-5 → FF-5
- AC-6 → FF-6
- AC-7 → FF-7
- AC-8 → FF-8
- AC-9 → FF-9

---

## 7. Escalation

Нет. Весь механизм переиспользует существующие резолверы/паттерны; ЧУЖОЙ гейт обновляется под
санкцией собственной находки его автора (F-2), с explicit комментарием и расширенным
self-test — не решение coder-а вслепую, а прямое исполнение зафиксированной рекомендации
ревью T-0573.

---

*Файл: `docs/adr/ADR-T0595-assistant-deeplink.md`. Разведка кода:
`src/http/assistant.ts:1160-1195` (respondLlmUnavailable), `:907-914` (DeepLink),
`:2080-2085` (существующий инлайн-JSON паттерн deepLinks на success-пути), `src/db/org.ts:674`
(loadAdminContext), `src/http/org.ts:379` (canonical admin-zone предикат), `src/core/llm-port.ts`
(LlmDormantError/LlmUnavailableError/classifyLlmUnavailability — НЕ трогаются),
`web/src/screens/screen-assistant.jsx:166-218` (503-ветка), `:408-425` (MessageBubble
deepLinks-чтение, уже универсальное), `:568-584` (существующий рендер-блок), `ci/checks/db/
assistant-llm-unavailable.test.ts` (T-0573 FF-5/FF-6, требует правки ассертов под F-2),
`ci/checks/ux/assistant-llm-message-jargon.sh` (ЧУЖОЙ гейт, обновляется санкционированно).*
