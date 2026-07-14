# T-0595 — Спека: кликабельный deep-link в honest-503 ассистента

**Status:** ready
**Phase:** SPEC
**Task:** T-0595 [W2/бесшовность]
**Date:** 2026-07-02
**Источник:** `docs/ux-review/T-0573.ux-review.json` findings F-1 (nit), F-2 (nit) — approved-вердикт
T-0573, находки санкционированы стюардом как follow-up.
**База:** dev @ `0370cf5` (ветка `task/T-0595-assistant-deeplink`)
**Предшественники:** T-0573 (honest-503 + canonical envelope `{error:{code,message}}`,
`ASSISTANT_LLM_UNAVAILABLE_MESSAGE`), T-0465/D8-G4 (deep-link рендер-паттерн в
`screen-assistant.jsx` MessageBubble, `DeepLink` тип в `assistant.ts`).

---

## 1. Контекст (L-факты разведки)

T-0573 ввела честный `HTTP 503 {error:{code:"LLM_UNAVAILABLE", message:<HUMAN>}}` вместо
сырого `INTERNAL`. `<HUMAN>` (`src/core/assistant-messages.ts:16-18`,
`ASSISTANT_LLM_UNAVAILABLE_MESSAGE`) называет путь `/llm-connections` ГОЛЫМ текстом внутри
прозы: «…проверьте ключ на странице «Подключения LLM» (/llm-connections), затем повторите.»
UX-ревью T-0573 (approved) поймало это как nit, но зафиксировало реальный шов бесшовности:

- **F-1** (`screen-assistant.jsx:514` + `assistant-messages.ts:16`): `msg.text` рендерится
  плоским `<div className="chs-asst__msg-text">{msg.text}</div>` — `/llm-connections` не
  кликабелен. Тот же экран УЖЕ умеет клик-навигацию по deep-links: `navigate(dl.path)`
  (`screen-assistant.jsx:576`, паттерн T-0465/D8-G4 для bundle-review), но 503-ответ не несёт
  `deepLinks` — рендерить нечего.
- **Усугубление, зафиксированное ревью:** экран ассистента — `audience:'builder'`
  (`nav-config.js:117`, zone `constructor`, capability `authoring_draft`). `/llm-connections`
  живёт в zone `admin` (`nav-config.js:162`, `audience:'admin'`, capability-сентинел
  `mgmt_object:*`, фактический гейт — `isGenesisOwner || adminGrants.length > 0`, см.
  `src/http/org.ts:379` и `web/src/app-shell/nav-config.js:235-240` `projectZones`). Билдер без
  admin-грантов физически не может дойти до `/llm-connections` через собственную навигацию (зона
  `admin` ему не видна) — даже если бы путь был кликабелен, это была бы **мёртвая дверь** для
  него: клик either 403 на сервере, либо экран, недостижимый обычным путём (nav не показывает
  пункт, прямой URL — вопрос отдельного гейта, не в скоупе).
- **F-2** (`assistant-messages.ts:16-18`): голый `(/llm-connections)` в скобках внутри прозы —
  техническая деталь, торчащая в бизнес-текст. Suggestion ревью: убрать путь из прозы, когда
  появится клик-переход, оставить название страницы «Подключения LLM» + кнопку.

**Кто на сервере знает admin-статус вызывающего.** `respondLlmUnavailable`
(`src/http/assistant.ts:1160-1195`) уже имеет `tenantId` и `actorSlug` в аргументах (оба вызова
`:1799` и `:2028` передают их). `loadAdminContext(pool, tenantId, actorSlug, nowMs)`
(`src/db/org.ts:674`) — существующий, многократно переиспользуемый резолвер
(`llm-config.ts:232`, `grants.ts:734/1002/1123/1237`, `org.ts:345`), возвращающий
`{isGenesisOwner, adminGrants}`. Предикат «виден ли пункт admin-зоны» — уже канонизирован
(`src/http/org.ts:379`): `isGenesisOwner || adminGrants.length > 0`. Это ТОЧНО тот же
предикат, под которым живёт `/llm-connections` (capability-сентинел `mgmt_object:*`,
`nav-config.js:162`, `projectZones` `web/src/app-shell/nav-config.js:240`). Ничего нового
изобретать не нужно — переиспользуем существующий резолвер.

**Deep-link контракт уже существует.** `export interface DeepLink { label; path;
kind: "app" | "process" }` (`src/http/assistant.ts:907-914`) — рендерится
`screen-assistant.jsx:568-584` (`deepLinks.map(...)` → `<Button onClick={() =>
navigate(dl.path)}>`). Экран уже читает `assistantMsg.deepLinks` в успешном пути
(`:207`), но НЕ в 503-ветке (`:166-180` собирает `assistantMsg` без поля `deepLinks`).

---

## 2. Функциональные требования

- **F1.** 503-ответ (`respondLlmUnavailable`) для actor'а, у которого
  `isGenesisOwner || adminGrants.length > 0` (т.е. видит admin-зону), несёт в envelope
  `error.deepLinks: [{path:"/llm-connections", label:"Открыть подключения LLM"}]`
  (аддитивное поле — старый шейп `{error:{code,message}}` не ломается).
- **F2.** Для actor'а БЕЗ admin-доступа `error.deepLinks` отсутствует (или пустой массив) —
  кнопка не рендерится, мёртвая дверь не создаётся.
- **F3.** `ASSISTANT_LLM_UNAVAILABLE_MESSAGE` для НЕ-админа переформулируется на честный текст
  БЕЗ пути `/llm-connections` и БЕЗ ссылки на конкретную страницу — вместо этого просит
  обратиться к администратору тенанта (billing/tech contact). Для админа — текст меняется
  по F-2: путь `(/llm-connections)` убирается из прозы (название страницы «Подключения LLM»
  остаётся), т.к. кнопка теперь несёт «куда» и «как».
- **F4.** `screen-assistant.jsx` 503-ветка (`send()`, `:166-180`) читает `d.error.deepLinks` и
  кладёт их в `assistantMsg.deepLinks`, используя ТОТ ЖЕ рендер-паттерн, что и bundle-review
  (`MessageBubble` `:568-584`, `navigate(dl.path)` `:576`) — новый UI-примитив не вводится.
- **F5.** Non-ok-ветка (`:182-190`, 4xx/5xx кроме 503) НЕ меняет своего текущего поведения по
  умолчанию (она бросает `Error` с текстом и не рендерит структурированное сообщение с
  кнопками) — deepLinks там не нужны, т.к. это ошибка запроса, а не honest-503 доменного
  состояния. Явно ВНЕ скоупа (см. Out-of-scope O2).

## 3. Нефункциональные требования

- **N1 (совместимость).** Envelope-расширение строго аддитивно: `error.deepLinks` — НОВОЕ
  опциональное поле. Существующие потребители (не читающие `deepLinks`) продолжают работать
  без изменений — `assistantErrorText(d, fallback)` (`web/src/screens/assistant-error-text.js`)
  не трогается по сигнатуре, продолжает читать `d.error.message`.
- **N2 (честность, G7).** Ни один пользователь не должен увидеть путь/кнопку, которую не может
  реализовать. Решение по не-админу принимает СЕРВЕР (не клиент) — единственный источник
  правды об admin-статусе вызывающего, тот же предикат, что гейтует саму admin-зону.
- **N3 (жаргон-гейт).** Обе новые формулировки текста (админ/не-админ) проходят
  `ci/checks/ux/assistant-llm-message-jargon.sh` — без dev-жаргона денилиста
  (`LLM_NOT_CONFIGURED`, `OpenAILlmPort`, `endpoint`, `secretHandle`, `stack`). Админ-текст
  по-прежнему упоминает страницу «Подключения LLM» по названию (не по пути).
- **N4 (гейт — ЧУЖОЙ, меняется санкционированно).** `assistant-llm-message-jargon.sh` создан
  T-0573 и жёстко проверяет присутствие подстроки `/llm-connections` в
  `ASSISTANT_LLM_UNAVAILABLE_MESSAGE` (AC-6 T-0573). Т.к. F-2 (санкция самого стюарда,
  автора гейта) требует убрать путь из прозы, гейт обновляется АДДИТИВНО в BUILD-фазе с
  комментарием-санкцией `T-0595 по UX_REVIEW T-0573 F-2`: новое условие — сообщение либо
  содержит `/llm-connections` (обратная совместимость с константой, если она таки есть в
  каком-то тексте), либо содержит явную ссылку на кнопку/deep-link семантически (проверяется
  через наличие структурного deep-link дескриптора в источнике, не строки). Точная форма
  проверки — предмет DESIGN/ADR §Fitness-функции.
- **N5 (не переписывать домен).** Классификатор `classifyLlmUnavailability`, оба failure-сайта
  (`:1799`, `:2028`), персист assistant-сообщения — НЕ меняются по механике, только
  добавляется admin-ветвление внутри `respondLlmUnavailable` и обогащение envelope.

## 4. Out of scope

- **O1.** Клиентская проверка `nav-capabilities` для скрытия кнопки — решение целиком серверное
  (§2 F1/F2). Клиент рендерит ровно то, что получил (`deepLinks` присутствует → кнопка;
  отсутствует → нет кнопки) — нет отдельного client-side capability-фильтра для этого случая.
- **O2.** Non-ok-ветка (4xx/5xx кроме 503) — deepLinks туда не добавляются (F5).
- **O3.** UI/экран `/llm-connections` сам по себе — не трогается (T-0574, уже смержено).
- **O4.** Любая правка `classifyLlmUnavailability`, адаптеров LLM-портов, миграций — не в
  скоупе (T-0595 — чисто UX-шов адресуемости, домен LLM-недоступности не меняется).
- **O5.** Redesign системного промпта ассистента/аналитика — не требуется.
- **O6.** Полный machine-readable capability-объект в error envelope (например список
  доступных для actor'а зон) — избыточно; нужен только сам deep-link дескриптор.

## 5. Acceptance criteria

| id | текст | verifiable_as |
|---|---|---|
| AC-1 | Actor с admin-доступом (`isGenesisOwner \|\| adminGrants.length>0`), получивший honest-503 от `POST /api/assistant/threads/:id/messages`, видит в теле ответа `error.deepLinks` — непустой массив, содержащий объект с `path==="/llm-connections"` и непустым `label`. | fitness |
| AC-2 | Actor БЕЗ admin-доступа, получивший тот же honest-503, НЕ видит `error.deepLinks` с путём `/llm-connections` (поле отсутствует либо пустой массив) — сервер не выдаёт мёртвую кнопку. | fitness |
| AC-3 | Текст `error.message` для НЕ-админа не содержит `/llm-connections` (голого пути) и явно указывает действие «обратитесь к администратору» (или эквивалент) вместо самостоятельного перехода. | fitness |
| AC-4 | Текст `error.message` для админа НЕ содержит голого `(/llm-connections)` в скобках прозы (F-2) — при этом сохраняет упоминание страницы «Подключения LLM» по названию и остаётся человекочитаемым/actionable. | fitness |
| AC-5 | `screen-assistant.jsx` 503-ветка кладёт `deepLinks` из `d.error.deepLinks` в рендеримое сообщение; `MessageBubble` рендерит кнопку `navigate(dl.path)` для 503-сообщения ТЕМ ЖЕ паттерном, что bundle-review deep-links (`:568-584`) — не новый UI-примитив. | test |
| AC-6 | Envelope-изменение аддитивно: существующие 8 тестов `screen-assistant.error-envelope.test.js` продолжают проходить без регресса (assistantErrorText по-прежнему читает `d.error.message`; legacy flat-shape ветка не тронута). | test |
| AC-7 | `assistant-llm-message-jargon.sh` зелёный после правки — обновлён аддитивно с комментарием-санкцией `T-0595 по UX_REVIEW T-0573 F-2`; self-test гейта (`--self-test`) тоже зелёный. | fitness |
| AC-8 | `npm run fitness`, `npm run ci` (root), `vitest run` (web), `tsc --noEmit`, `eslint src` — все зелёные после изменений. | fitness |
| AC-9 | UX-гейт `ux-g5-jargon-denylist.sh` (INFORMATIONAL) не показывает НОВЫХ находок на видимом продуктовом тексте (только pre-existing шум в `*.test.jsx`, как в T-0573). | fitness |

## 6. Открытые вопросы

Нет блокирующих вопросов — весь механизм (admin-предикат, deep-link контракт, рендер-паттерн)
уже существует в кодовой базе и переиспользуется. `status: ready`.

---

*Файл: `docs/specs/T-0595-assistant-deeplink.spec.md`. Разведка:
`docs/ux-review/T-0573.ux-review.json` (F-1/F-2), `src/http/assistant.ts:907-914` (DeepLink),
`:1160-1195` (respondLlmUnavailable), `:1799`/`:2028` (call sites), `src/db/org.ts:674`
(loadAdminContext), `src/http/org.ts:379` (canonical admin-zone predicate),
`web/src/app-shell/nav-config.js:148-164/235-240` (admin zone gate + projectZones),
`web/src/screens/screen-assistant.jsx:166-218/499-584` (503-ветка, MessageBubble, existing
deep-link render), `src/core/assistant-messages.ts` (текст-константа),
`ci/checks/ux/assistant-llm-message-jargon.sh` (гейт на текст, T-0573, обновляется
санкционированно).*
