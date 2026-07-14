# T-0599 — Спека: проактивный баннер «LLM-ключ не подключён» на экране ассистента

**Status:** ready
**Phase:** SPEC
**Task:** T-0599 [W2/ассистент-UX] (UX-петля №4, `docs/ux-loop-report-2026-07-02.md`)
**Date:** 2026-07-02
**База:** dev @ `edff87e` (ветка `task/T-0599-assistant-banner`) — включает все сегодняшние
мержи, вкл. T-0595 (deepLink в honest-503) и T-0597 (5 UX quick-wins).
**Предшественники:** T-0573 (honest-503 + canonical envelope), T-0595 (серверный
admin-предикат + `error.deepLinks`), T-0597 (честный статус ключа на `/llm-connections`).

---

## 1. Контекст (L-факты разведки)

Сегодня «подключите LLM-ключ» узнаётся ТОЛЬКО после отправки сообщения — честный
`HTTP 503 {error:{code:"LLM_UNAVAILABLE", message, deepLinks?}}` (T-0573/T-0595).
Экран ассистента (`web/src/screens/screen-assistant.jsx`) не показывает НИЧЕГО о
состоянии LLM-ключа ДО отправки — пользователь пишет сообщение, ждёт, и только
тогда узнаёт про отсутствующий ключ. Задача: проактивный баннер на экране ассистента,
видимый ДО отправки.

**Источник статуса — разведано, найден баг честности.**
`GET /api/agents` (`src/http/agents-list.ts`, T-0271/T-0473, БЕЗ admin-гейта — любой
аутентифицированный участник тенанта может вызвать) уже отдаёт на каждого агента
поле `llm_bound: boolean` (`:158`, `:189`, `:205`) и `llm_connection_id` (`:164`,
`:207`). НО `llm_bound` вычисляется как `row.llm_secret_handle !== null` (`:189`) —
читает ТОЛЬКО `agent_card.llm_secret_handle`, устаревшее inline-поле (migration
094, "DEPRECATED... use llm_connection_id → llm_connection.secret_handle").
Реальный резолвер, которым пользуется рантайм при вызове LLM
(`src/db/agent-provision.ts::readConfiguredAgentLlmConfig`, вызывается из
`src/server.ts::makeLlmPortFactory`), считает конфиг «полным» через
`COALESCE(lc.secret_handle, ac.llm_secret_handle) IS NOT NULL` (`agent-provision.ts:204/213`)
— то есть падает назад на `llm_connection.secret_handle`, когда агент привязан к
именованному профилю через `llm_connection_id` (T-0498/E-AGENTS L2, актуальный путь
привязки ключа через экран `/llm-connections`, которым и пользуется T-0595/T-0597/
tenant-zero backfill migration 118). Для ассистента, привязанного НОРМАЛЬНЫМ путём
(через `/llm-connections` → `llm_connection.secret_handle` заполнен, `agent_card.
llm_secret_handle` остаётся NULL по migration 115/118 дизайну — «dormant; resolved
later via llm_connection_id»), текущий `llm_bound` из `agents-list.ts` ЛОЖНО
показывает `false` даже когда ключ реально привязан и рантайм-резолвер видит
конфиг как полный. Это дефект уже существующего `GET /api/agents` (используется
также в `web/src/screens/screen-agents.jsx:258-259` — тот же баг там, за скобками
скоупа T-0599, но исправление `agents-list.ts` чинит и этот экран как побочный
честный эффект, не new-scope).

**Решение: чинить `agents-list.ts`, не строить новый эндпойнт.** `listAgentsTx`
(`agents-list.ts:229-262`) добавляет LEFT JOIN на `choros.llm_connection` (та же
таблица, что `agent-provision.ts:208-209` джойнит) и вычисляет `llm_bound` тем же
`COALESCE`-предикатом, что использует рантайм-резолвер — единственный источник
правды становится общим для «настоящего» LLM-вызова и для превентивного баннера.
Никакого нового HTTP-маршрута не создаётся (рамка задачи явно требует reuse).

**Идентификация ассистента среди агентов списка.** `GET /api/agents` возвращает ВСЕ
агенты тенанта (workforce/system/assistant). Ассистент адресуется по
`slug === 'assistant-agent'` — тот же идентификатор, которым пользуется сам
рантайм-резолвер (`agent-provision.ts:214`, `ORDER BY CASE WHEN e.slug =
'assistant-agent' THEN 0…`) и который сеет `register.ts`/migration 118. Поле
`agent_type` НЕ используется как дискриминатор — migration 093 комментирует, что
`assistant-agent` никогда не бэкфиллился в `agent_type='assistant'` (остаётся
`'workforce'` по умолчанию); `slug` — единственный надёжный ключ.

**Admin-статус на клиенте — уже доступен, без нового запроса.** `web/src/app-shell/
active-tenant.js::getNavCapabilities()` — синхронный геттер module-level кэша,
заполняемого `shell.jsx` (`resolveNavCapabilities()`, вызывается в auth-bootstrap
ДО рендера защищённых маршрутов, `shell.jsx:798-805`) из `GET /api/me/nav-capabilities`
(T-0539). К моменту монтирования `AssistantScreen` кэш уже разрешён (или `null` при
деградации — честный fail-closed). `isAdmin = navCaps?.isGenesisOwner ||
(navCaps?.zones ?? []).includes('admin')` — тот же предикат, что определяет
видимость admin-зоны в навигации (`nav-config.js::projectZones`, зеркалит серверный
`isGenesisOwner || adminGrants.length>0`, `src/http/org.ts:379`). Кнопка «Открыть
LLM-соединения» в баннере — ЧИСТО клиентская навигация (`navigate('/llm-connections')`),
не обходит серверный гейт T-0595 (тот гейтит СЕРВЕРНЫЙ envelope деталями honest-503;
здесь клиент лишь решает, показывать ли ссылку на экран, видимость которого САМА
УЖЕ определена тем же nav-предикатом — если предикат неверен, весь сайдбар неверен,
это не новая поверхность риска).

**Kit-компонент.** `web/src/components/components.jsx` не содержит выделенного
Alert/Notice/Banner-примитива — есть `Toast` (`:638-654`, транзиентный, свой
viewport) и `Badge` (`:826`, инлайн-чип), но нет персистентной предупреждающей
плашки. Паттерн `Toast` (tone-варианты, `role="alert"`/`role="status"` по тону,
`KitIcon`) — ближайший образец для нового переиспользуемого `Notice`-компонента
(персистентный, без auto-dismiss, тот же токен-набор `--chs-color-warning`/
`--chs-color-warning-soft`, уже существующий в обеих темах, `tokens.css:193-195/
263-265`).

---

## 2. Функциональные требования

- **F1.** `GET /api/agents` (`agents-list.ts`) чинится: `listAgentsTx` LEFT JOIN
  `choros.llm_connection` на `ac.llm_connection_id`; `llm_bound` вычисляется как
  `COALESCE(lc.secret_handle, ac.llm_secret_handle) IS NOT NULL` — тот же предикат,
  что `agent-provision.ts::readConfiguredAgentLlmConfig`. Раздельного нового поля
  не вводится — `llm_bound` СТАНОВИТСЯ честным (единый корректный сигнал), не
  дублируется вторым полем.
- **F2.** `screen-assistant.jsx` при монтировании экрана вызывает `GET /api/agents`
  (существующий, no-admin-gate эндпойнт), находит запись с `slug === 'assistant-agent'`,
  и держит состояние `{ loading, llmBound: boolean | null }`.
- **F3.** Пока запрос не завершился (`loading === true`), баннер НЕ рендерится
  (никакого мигания/дефолтного показа).
- **F4.** Если запись найдена и `llm_bound === false` → баннер виден: warning-тон,
  текст без жаргона, консистентный `assistant-messages.ts` стилистике («Ассистент
  пока не может отвечать — не подключён LLM-ключ.»).
- **F5.** Если запись найдена и `llm_bound === true`, либо запрос упал (network/
  ошибка), либо запись не найдена (не должно происходить в норме, но не должно
  падать) → баннер НЕ рендерится (честный fail-quiet: неизвестность не равна
  «точно сломано» — не педалируем предупреждение на непроверенном факте; 503-путь
  остаётся страховкой при реальной отправке).
- **F6.** Кнопка «Открыть LLM-соединения» в баннере рендерится ТОЛЬКО когда
  `isAdmin === true` (см. §1, `getNavCapabilities()`). Для не-админа баннер без
  кнопки, текст указывает «обратитесь к администратору вашей организации» —
  консистентно `ASSISTANT_LLM_UNAVAILABLE_MESSAGE_NON_ADMIN` (T-0595).
- **F7.** Баннер живой: перечитывает статус on-mount и on-focus (`window` focus
  event ИЛИ React Router location-based remount — see DESIGN §механизм) — так что
  после возврата с `/llm-connections` (привязал ключ → назад) баннер обновляется
  без ручного refresh. Realtime/polling НЕ требуется (явно out-of-scope).
- **F8.** 503-путь (T-0573/T-0595, `send()` в `screen-assistant.jsx`) НЕ меняется —
  баннер это превенция ДО отправки, honest-503 остаётся страховкой при реальной
  попытке (напр. race: баннер успел показать «всё ок» по стейл-кэшу, а ключ
  инвалидировался между чтением баннера и отправкой).

## 3. Нефункциональные требования

- **N1 (без нового эндпойнта).** Баннер строится из существующего `GET /api/agents` +
  существующего `getNavCapabilities()` — ноль новых HTTP-маршрутов.
- **N2 (честность источника, G7).** `llm_bound` после фикса F1 — ЕДИНЫЙ источник
  правды, тот же предикат, что определяет реальную работоспособность LLM-вызова.
  Никакого отдельного «оптимистичного» вычисления на клиенте.
- **N3 (loading-честность).** См. F3 — баннер не показывается/не мигает до
  разрешения запроса (нет flash-of-wrong-state).
- **N4 (жаргон-гейт).** Текст баннера проходит `ci/checks/ux/assistant-llm-message-jargon.sh`
  ЛИБО отдельным честным путём: если баннер переиспользует ФОРМУЛИРОВКИ из
  `ASSISTANT_LLM_UNAVAILABLE_MESSAGE_ADMIN`/`_NON_ADMIN` (T-0595, `src/core/
  assistant-messages.ts`) напрямую в web-слое — НЕТ, `web/` не импортирует `src/`
  (раздельные пакеты, тот же принцип, что `screen-assistant.error-envelope.test.js`
  комментирует). Баннер держит СВОЙ текст в `web/`, консистентный по стилю
  (проверяется `ux-g5-jargon-denylist.sh`, INFORMATIONAL — не новый денилист-токен),
  без называния голого пути `/llm-connections` для не-админа (тот же принцип
  T-0595 F-2/AC-3 — не создавать мёртвую дверь текстом).
- **N5 (UX-гейты).** `ux-g2-theme-pairing.sh` (токены light/dark уже парные,
  `--chs-color-warning*` существуют в обеих темах — новый CSS не вводит
  непарных токенов). `ux-g5-jargon-denylist.sh` / `ux-g6-no-new-hardcode.sh`
  (INFORMATIONAL, diff-based) — ноль новых hardcoded цветов, ноль новых
  denylist-токенов в видимом тексте.
- **N6 (не переписывать честный 503).** `assistant-error-text.js`, envelope-шейп,
  `assistant-llm-message-jargon.sh` — НЕ трогаются (F8).
- **N7 (совместимость `llm_bound` consumers).** Фикс F1 меняет ЗНАЧЕНИЕ `llm_bound`
  для connection-bound агентов (было `false`, станет `true`, где ключ реально
  привязан) — это КОРРЕКЦИЯ бага, не breaking change контракта (тип поля/название
  не меняются). `screen-agents.jsx` (единственный существующий consumer,
  `:258-259`) становится ТОЧНЕЕ, не ломается — существующий тест
  `screen-agents.test.jsx` не проверяет конкретное значение `llm_bound`
  (проверено разведкой), только структуру.

## 4. Out of scope

- **O1.** Realtime-обновление статуса (WebSocket/SSE/polling-интервал) — F7
  ограничен on-mount/on-focus, этого достаточно по формулировке задачи.
- **O2.** Изменение `classifyLlmUnavailability`, честного 503-пути, `assistant-
  messages.ts` — не трогаются (F8/N6).
- **O3.** Исправление `screen-agents.jsx` UI-текста/логики сверх того, что чинит
  сам `agents-list.ts` (баг там был идентичный, но не в тексте задачи — F1 чинит
  ИСТОЧНИК, экран `screen-agents.jsx` автоматически получает корректные данные
  без изменения своего кода).
- **O4.** Новый HTTP-эндпойнт статуса LLM специально для баннера — прямо запрещено
  рамкой задачи (reuse `GET /api/agents`).
- **O5.** Полный machine-readable capability-объект для баннера — не нужен,
  достаточно boolean `isAdmin` из уже существующего `navCaps`.

## 5. Acceptance criteria

| id | текст | verifiable_as |
|---|---|---|
| AC-1 | `GET /api/agents` для тенанта, где assistant-agent привязан к `llm_connection` с непустым `secret_handle` (а `agent_card.llm_secret_handle` NULL), возвращает `llm_bound: true` для этой записи. | fitness |
| AC-2 | `GET /api/agents` для тенанта, где assistant-agent НЕ привязан ни к connection с секретом, ни к inline-handle, возвращает `llm_bound: false`. | fitness |
| AC-3 | `serializeAgent`/`listAgentsTx` unit: чистая функция вычисления `llm_bound` покрыта тестами на все 4 комбинации (`ac.llm_secret_handle` × `lc.secret_handle`, каждое null/non-null). | test |
| AC-4 | Экран ассистента до разрешения запроса `GET /api/agents` НЕ рендерит баннер (loading-состояние честное). | test |
| AC-5 | Экран ассистента после разрешения запроса с `llm_bound:false` для assistant-agent рендерит баннер warning-тона с текстом без жаргона. | test |
| AC-6 | Баннер для `isAdmin:true` (из `getNavCapabilities()`) показывает кнопку «Открыть LLM-соединения» → `navigate('/llm-connections')`. | test |
| AC-7 | Баннер для `isAdmin:false` НЕ показывает кнопку, текст направляет к администратору без голого пути `/llm-connections`. | test |
| AC-8 | Баннер НЕ рендерится когда `llm_bound:true` для assistant-agent. | test |
| AC-9 | 503-путь (T-0573/T-0595, `send()`, deepLinks-рендер) не регрессирует — существующие тесты `screen-assistant.error-envelope.test.js` (12/12) проходят без изменений. | test |
| AC-10 | `npm run ci` (root), `npx vitest run` (web), `tsc --noEmit`, `eslint src` — зелёные. | fitness |
| AC-11 | `ux-g2-theme-pairing.sh`, `ux-g5-jargon-denylist.sh`, `ux-g6-no-new-hardcode.sh` — зелёные / без новых находок. | fitness |
| AC-12 | Новый kit-компонент (Notice/Alert) в `components.jsx` использует ТОЛЬКО `--chs-*` токены, экспортирован рядом с `Toast`/`Badge`, переиспользован (не one-off inline styling). | test |

## 6. Открытые вопросы

Нет блокирующих вопросов. Единственная содержательная развилка (чинить
`agents-list.ts` vs завести отдельное поле/эндпойнт) разрешена в §1: чинить
источник — иначе баннер строился бы на заведомо неверном сигнале, что хуже,
чем не строить баннер вовсе (G7 — не показывать честный текст на нечестных
данных). `status: ready`.

---

*Файл: `docs/specs/T-0599-assistant-banner.spec.md`. Разведка: `src/http/agents-list.ts`
(:158/:189/:205/:229-262 — текущий `llm_bound`), `src/db/agent-provision.ts`
(:189-218 `readConfiguredAgentLlmConfig` — реальный резолвер), `migrations/094_llm_connection_registry.sql`
(deprecation комментарии), `migrations/115_assistant_agent_card_backfill.sql`/
`118_assistant_tenant_zero_backfill.sql` (assistant-agent seed path), `web/src/app-shell/
active-tenant.js` (:79-118 `getNavCapabilities`/`resolveNavCapabilities`), `web/src/app-shell/
shell.jsx` (:798-805 auth-bootstrap заполнение navCaps ДО рендера маршрутов), `web/src/
app-shell/nav-config.js` (:235-242 `projectZones` admin-предикат), `web/src/components/
components.jsx` (:638-654 `Toast` — ближайший паттерн), `web/src/design/tokens.css`
(:193-195/:263-265 `--chs-color-warning*`), `docs/adr/ADR-T0595-assistant-deeplink.md`,
`ci/checks/ux/assistant-llm-message-jargon.sh`, `ci/checks/ux/ux-g2/g5/g6-*.sh`.*
