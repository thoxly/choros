# T-0601 — Спека: разблокировка скролла экранов шелла (`.chs-screen`)

**Status:** ready
**Phase:** SPEC
**Task:** T-0601 [P0 UX]
**Date:** 2026-07-03
**База:** dev @ `c6db7b8` (ветка `task/T-0601-screen-scroll-unlock`)

---

## 1. Контекст (живой факт приёмки)

Владелец пожаловался на живом стенде: «не прокручивается». Диагноз JS на живом
стенде подтвердил: контейнер `div.chs-screen` (`web/src/app-shell/app.css:186`,
до фикса) имел `overflow: hidden` при контенте выше вьюпорта (`height=591px`,
`scrollHeight=1498px`). Родители `.chs-main`/`.chs-shell` тоже `overflow: hidden`
(по дизайну — это фиксированная рамка вьюпорта: страница целиком НЕ должна
скроллиться, скроллиться должны только нав и контент-пейн). С `.chs-screen`
тоже `hidden`, единственным реально скроллящимся элементом всей страницы
оставался левый нав (`.chs-nav__scroll`, `app.css:67`). Низ ЛЮБОГО экрана выше
вьюпорта был физически недостижим колесом/тачпадом — на `/llm-connections`
недостижимы поле ключа, «Проверить подключение», «Назначить ассистенту»; задача
называет также `/processes` (редактор правил ветвления) как пример.

**Почему не поймали раньше.** Клики через `ref`/`scrollIntoView` в тестах
двигают даже `overflow:hidden`-контейнер программно — тест «видит» элемент,
реальный пользователь колесом мыши — нет. Отсюда явное требование задачи:
детерминированный статический гейт (`ci/checks/ux/ux-g8-scroll-reachable.sh`),
а не полагание на клики в тестах или ручную проверку.

## 2. Разведка — инвентаризация скролл-контейнеров

Полная инвентаризация всех `web/src/screens/*.jsx`, рендерящихся внутри
`<div className="chs-screen">` (`shell.jsx:1144`, обёртка вокруг `<Routes>`):

**Screens с собственным ограниченным (bounded-height) внутренним скроллером —
безопасны, НЕ требуют изменений:**

| паттерн | экраны |
|---|---|
| `.chs-inbox` (flex-col, `height:100%`, `min-height:0`) + `.chs-inbox__scroll` (`flex:1; min-height:0; overflow:auto`) | screen-overview, screen-apps, screen-sections, screen-app-records, screen-app-schema, screen-record-detail, screen-processes, screen-dmn-editor, screen-process-instance, screen-inbox |
| `.chs-org` (grid, `height:100%`) + `.chs-org__tree`/`.chs-org__detail` (`overflow-y:auto`) | screen-org |
| `.chs-audit-screen` (`height:100%; min-height:0; overflow-y:auto`, один уровень) | screen-audit |
| `.chs-notif-screen`/`.chs-notif` (`height:100%`) + `.chs-notif__scroll` (`flex:1; min-height:0; overflow-y:auto`) | screen-notifications |
| `.chs-asst` (grid, `height:100%`) — двухпанельный, свой скролл треда/списка | screen-assistant |
| `.chs-editor` (`height:100%; min-height:0`) — BPMN-канвас (панорамирование библиотекой, не документ-скролл) | screen-process-editor |
| `.chs-forms-screen` (`height:100%`) + `.chs-forms-screen__canvas` (`overflow-y:auto`) — канвас-конструктор форм | screen-forms |

**Screens БЕЗ какого-либо внутреннего скролл-контейнера (голый `<div>` или
инлайн `layoutStyle={maxWidth, margin, padding}`, без `height`/`overflow`) —
ПОДТВЕРЖДЁННО СЛОМАНЫ, контент ниже вьюпорта был физически недостижим:**

- `screen-llm-connections.jsx` (живой факт приёмки — поле ключа, «Проверить
  подключение», «Назначить ассистенту» недостижимы)
- `screen-agents.jsx`
- `screen-llm-config.jsx`
- `screen-spend.jsx`
- `screen-reports.jsx`
- `screen-process-analytics.jsx`
- `screen-ops-overview.jsx`
- `screen-operational-analytics.jsx`
- `screen-assistant-prompt.jsx`

**Особые случаи (вне `.chs-screen` вовсе, не затронуты):**
`screen-login.jsx`/`screen-register.jsx` рендерятся из `shell.jsx` ДО монтирования
`<div className="chs-shell">` (auth-гейт, `shell.jsx:952-962`) — самостоятельные
полноэкранные экраны, не под `.chs-screen`. `apps-publish-dialog.jsx` — не
маршрут, суб-компонент модалки (`Modal` kit-компонент несёт свой скролл).

## 3. Решение (см. ADR-T0601 §1 для полного обоснования)

Один источник правды на уровне шелла: `.chs-screen` становится ЕДИНСТВЕННЫМ
легитимным владельцем скролла для маршрутизируемого контента —
`overflow-y: auto` вместо `overflow: hidden` (`.chs-main`/`.chs-shell` остаются
`overflow: hidden` — это фиксированная рамка вьюпорта, так и должно быть).

Для экранов с собственным bounded-height внутренним скроллером (`.chs-inbox` и
аналоги) это НЕ создаёт двойной скролл: их обёртка задана `height: 100%` (не
`min-height`), то есть заполняет — никогда не превышает — ограниченную высоту,
которую `.chs-screen` уже получал от flex-раскладки выше (`.chs-main`/
`.chs-shell`). `overflow-y: auto` меняет только то, что происходит, ЕСЛИ контент
переполняет бокс — для этих экранов контент точно совпадает с боксом, скролл
`.chs-screen` никогда не включается, внутренний скроллер продолжает работать
как раньше. Для голых `<div>`-экранов (список выше) скролл `.chs-screen`
становится ЕДИНСТВЕННЫМ и делает ранее недостижимый хвост экрана достижимым.

## 4. Функциональные требования

- **F1.** `.chs-screen` (`web/src/app-shell/app.css`) устанавливает
  `overflow-y: auto` (не `overflow: hidden`/`overflow-y: hidden`).
- **F2.** `.chs-main`/`.chs-shell` НЕ меняются — остаются `overflow: hidden`
  (фиксированная рамка вьюпорта; сама страница не скроллится целиком, только
  нав и контент-пейн).
- **F3.** Экраны с собственным bounded-height внутренним скроллером (см. §2,
  таблица 1) продолжают работать БЕЗ визуальной регрессии — их контент по
  прежнему заполняет доступную высоту, их внутренний скроллер остаётся
  единственным активным для их содержимого (двойной скролл не появляется).
- **F4.** Голые `<div>`-экраны (см. §2, список 2) становятся прокручиваемыми
  целиком через новый скролл `.chs-screen` — весь их контент, включая
  предыдущий недостижимый хвост, становится доступен колесом/тачпадом.
- **F5.** Детерминированный статический гейт `ci/checks/ux/ux-g8-scroll-reachable.sh`
  (+ `--self-test`) фиксирует регрессию: парсит `web/src/app-shell/app.css`,
  проверяет правило `.chs-screen` на отсутствие `overflow(-y):hidden` и наличие
  `overflow(-y):auto`. STRICT (exit 1 при нарушении), без `--required`-флага —
  баг уже исправлен и должен оставаться исправленным.
- **F6.** Гейт вписан в `npm run fitness` (`package.json`) аддитивно, рядом с
  существующей парой `ux-g5`/`ux-g6`/`ux-g2` (и их `--self-test`), без
  нарушения структуры `&&`-цепи.

## 5. Нефункциональные требования

- **N1 (нет двойного скролла).** См. F3 — ни один существующий экран не
  получает вложенную полосу прокрутки поверх своей уже существующей.
- **N2 (без кейс-литералов, D-064).** Изменение CSS-уровня, никаких новых
  кейс-специфичных литералов/условий по конкретному тенанту/процессу.
- **N3 (токены).** Изменение не вводит новых hardcoded цветов/отступов — правка
  затрагивает только `overflow`-свойство, никаких новых `--chs-*`-токенов не
  требуется.
- **N4 (регресс-safety).** Существующие web-тесты (60 файлов / 1634 теста на
  момент спеки) проходят без изменений — правка чисто CSS-уровня, не трогает
  JSX/логику экранов.

## 6. Out of scope

- **O1.** Правка каждого голого `<div>`-экрана индивидуально (добавление
  `.chs-inbox`-обёртки и т.п.) — НЕ требуется данной задачей: шелл-уровневый
  фикс `.chs-screen` уже делает их прокручиваемыми без изменения самих экранов.
  Отдельная задача может позже унифицировать паттерн ради консистентности
  визуального поведения (напр. padding у самого края скролла), но это не
  входит в рамку live-proof бага «не прокручивается».
- **O2.** `.chs-forms-screen__canvas` (`overflow-y:auto` без явного
  `min-height:0` на самой этой строке) — потенциальный отдельный узкий
  flex-min-height edge-case, НЕ тот баг, на который жаловался владелец (канвас
  форм уже имеет активный `overflow-y:auto`, в отличие от голых `<div>`-экранов
  из списка 2). Не трогается — вне рамки данной задачи, см. риски в pr-handoff.
- **O3.** BPMN-канвас (`.chs-editor`) и канвас форм (`.chs-forms-screen`) —
  не документ-скролл инструменты (панорамирование/зум своей библиотекой), не
  переводятся на паттерн `.chs-inbox`.
- **O4.** jsdom-раннер для рендер-теста скролла — web vitest-тир работает в
  `environment: 'node'` (без DOM/CSSOM, `web/vitest.config.js`), рендер-тест
  scrollHeight потребовал бы смены окружения тира ради одного теста;
  статический CSS-гейт (F5) достаточен и детерминирован без этой зависимости.

## 7. Acceptance criteria

| id | текст | verifiable_as |
|---|---|---|
| AC-1 | `.chs-screen` в `web/src/app-shell/app.css` НЕ имеет `overflow(-y): hidden`. | fitness |
| AC-2 | `.chs-screen` имеет `overflow-y: auto` (активный скролл-owner). | fitness |
| AC-3 | `.chs-main`/`.chs-shell` остаются `overflow: hidden` (рамка вьюпорта не меняется). | fitness |
| AC-4 | `ci/checks/ux/ux-g8-scroll-reachable.sh` — новый детерминированный гейт, PASS на текущем `app.css`, FAIL на фикстуре с `overflow:hidden`. | fitness |
| AC-5 | `ci/checks/ux/ux-g8-scroll-reachable.sh --self-test` — проходит (детектор не даёт ложных срабатываний на `.chs-screen-foo`, корректно отличает «не hidden» от «активно auto»). | fitness |
| AC-6 | Гейт вписан в `npm run fitness` рядом с `ux-g5`/`ux-g6`/`ux-g2`, структура `&&`-цепи не нарушена. | fitness |
| AC-7 | `cd web && npx vitest run` — 100% существующих тестов проходят без изменений (регресс-guard, CSS-only правка). | test |
| AC-8 | `npm run build` (root, tsc) и `cd web && npm run build` (vite) — зелёные. | fitness |
| AC-9 | `bash ci/checks/anti-case-lock.sh` — зелёный (без новых кейс-литералов). | fitness |

## 8. Открытые вопросы

Нет блокирующих вопросов. Единственная содержательная развилка (шелл-уровневый
фикс `.chs-screen` vs точечная правка каждого сломанного экрана) разрешена в
§3: один источник правды на уровне шелла чинит все 9 подтверждённо сломанных
экранов разом и не создаёт двойного скролла ни для одного из 16 экранов с уже
существующим внутренним скроллером — точечная правка 9 файлов была бы избыточна
и оставила бы шелл-уровневый баг для любого БУДУЩЕГО экрана, который забудет
завести свой `.chs-inbox`-паттерн. `status: ready`.

---

*Файл: `docs/specs/T-0601-screen-scroll-unlock.spec.md`. Разведка:
`web/src/app-shell/app.css` (`:186` `.chs-screen`, `:149` `.chs-main`, `:12`
`.chs-shell`, `:350` `.chs-inbox`/`.chs-inbox__scroll`, `:219` `.chs-org`,
`:405` `.chs-audit-screen`, `:766`+ `.chs-notif-screen`/`.chs-notif__scroll`,
`:841` `.chs-asst`, `:633` `.chs-forms-screen`), `web/src/canvas/editor.css`
(`.chs-editor`), `web/src/app-shell/shell.jsx` (`:952-962` login/register
до-шелл гейт, `:1144` `.chs-screen` обёртка вокруг `<Routes>`),
`web/src/screens/screen-llm-connections.jsx` (живой факт приёмки —
подтверждённо голый `<div>`, без scroll-обёртки), `ci/checks/ux/ux-g2-theme-pairing.sh`
(образец статического CSS-гейта с `--self-test`).*
