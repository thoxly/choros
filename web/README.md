# Choros · web/

Фронтенд-поверхность Choros. Дизайн генерируется в **Claude Design** по промптам
из [`../docs/design/claude-design-prompts.md`](../docs/design/claude-design-prompts.md)
и интегрируется сюда. Это каркас (backlog **E9.1**) — сборщика приложения здесь
ещё нет; пока живой код смотрим через `preview/*.html` (открыть в браузере).

## Линчпин: контракт токенов `--chs-*`

Единственный источник истины — [`src/design/tokens.css`](src/design/tokens.css).
Все цвета/отступы/типографика/радиусы/тени — только через `--chs-*` переменные.
**Никаких хардкод-значений в компонентах и экранах.** Тёмная тема в `:root`,
равноправная светлая — в `[data-theme="light"]`. Три исполнителя (человек/агент/
сервис) узнаются сквозным цвето-иконочным кодом `--chs-exec-*` + форма глифа
(круг / ромб / квадрат).

## Структура (репо-маппинг, handoff §2)

```
web/
├── preview/                      запускаемые витрины (открыть в браузере)
│   ├── design-system.html        П0 — токены + примитивы
│   ├── chrome.html               П1 — оргструктура · инбокс · аудит · права · каркас
│   ├── rights.html               П1R — права и доступ (standalone hero)
│   └── process-editor.html       П2 — редактор процесса (тема bpmn-js)
└── src/
    ├── design/
    │   ├── tokens.css            ← П0: КОНТРАКТ --chs-* (источник истины)
    │   └── showcase.{jsx,css}    ← П0: витрина дизайн-системы
    ├── components/               ← П0: доменные примитивы
    │   └── components.{jsx,css}    ExecutorBadge, TaskRow, AuditEvent, MonoId,
    │                               BudgetMeter, ReservationMeter (две крыши),
    │                               RoleAssignment, OpChip, DerivedChip, …
    ├── app-shell/                ← П1: оболочка
    │   ├── shell.jsx               нав (вкл. «Права и доступ») · топбар · темы
    │   └── app.css                 стили экранов П1 (+ стили новых примитивов*)
    ├── screens/                  ← П1: экраны
    │   ├── screen-org.jsx          оргструктура + карточка исполнителя (read)
    │   ├── screen-inbox.jsx        инбокс задач
    │   ├── screen-audit.jsx        таймлайн аудита инстанса (hero)
    │   └── rights/               ← П1R: «Права и доступ» (hero)
    │       ├── screen-rights.jsx   in-shell обёртка (роутится из shell)
    │       ├── ra-shell.jsx        standalone RightsAdminShell (вкладки)
    │       ├── ra-role-editor.jsx  редактор роли (структурные гранты + scope-решётка)
    │       ├── ra-criticality.jsx  role_criticality + dual-control + эффективный дифф
    │       ├── ra-sod.jsx          SoD-конфликты + реестр правил
    │       ├── ra-grant-trail.jsx  журнал выдачи прав (append-only)
    │       ├── ra-data.jsx         общие данные/хелперы П1R
    │       └── rights-admin.css    стили П1R
    └── canvas/                   ← П2: BPMN Canvas
        ├── bpmn-theme.css          ТЕМА: override .djs-*/.bpmn-icon-* через --chs-*
        ├── screen-editor.jsx       макет редактора (харнесс превью)
        └── editor.css              роль diagram-js.css в макете
```

> `*` Стили четырёх новых примитивов (`chs-resv`/`chs-asgn`/`chs-op`/`chs-derived`)
> сейчас лежат в `app-shell/app.css`, а сами компоненты — в `components/components.jsx`.
> Известный долг: при следующем ре-экспорте перенести их в `components/components.css`,
> чтобы слой примитивов был самодостаточным. Витрина П0 их не использует, поэтому
> `design-system.html` рендерится и без `app.css`.

## Поверхности (5 проектов Claude Design)

| | Поверхность | Куда ложится | Статус |
|---|---|---|---|
| **П0** | Design System | `src/design/` + `src/components/` | ✅ интегрирован |
| **П1** | Chrome | `src/app-shell/` + `src/screens/` | ✅ интегрирован (v2, on-model) |
| **П1R** | Права и доступ *(hero)* | `src/screens/rights/` | ✅ интегрирован |
| **П2** | BPMN Canvas | `src/canvas/bpmn-theme.css` | ✅ тема интегрирована |
| **П3** | Forms | `src/forms/form-theme.css` | ⏳ не сгенерирован |

## Предпросмотр

Открой любой `web/preview/*.html` в браузере (React + Babel-standalone с CDN,
сборка не нужна). Витрины подключены к каноническим путям `src/`, поэтому
показывают ровно то, что лежит в репо.

> Правило: в `main` не мержим — это гейт фаундера. Интеграция идёт в ветку `dev`.
