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

> Исключение по правилу контракта: `src/forms/form-theme.css` **самодостаточен** —
> объявляет свою копию `--chs-*` внутри себя, потому что форма исполняется в
> опаковом sandbox-iframe и снаружи ничего не наследует. Это требование Промпта 3,
> не нарушение: значения те же, просто продублированы для изоляции.

## Структура (репо-маппинг, handoff §2)

```
web/
├── preview/                      запускаемые витрины (открыть в браузере)
│   ├── design-system.html        П0 — токены + примитивы
│   ├── chrome.html               П1 — оргструктура · инбокс · аудит · права · каркас
│   ├── rights.html               П1R — права и доступ (standalone hero)
│   ├── process-editor.html       П2 — редактор процесса (тема bpmn-js)
│   └── forms.html                П3 — формы (sandbox-iframe, dark/light)
└── src/
    ├── design/
    │   ├── tokens.css            ← П0: КОНТРАКТ --chs-* (источник истины)
    │   └── showcase.{jsx,css}    ← П0: витрина дизайн-системы
    ├── components/               ← П0: доменные примитивы
    │   └── components.{jsx,css}    ExecutorBadge, TaskRow, AuditEvent, MonoId,
    │                               BudgetMeter, ReservationMeter, RoleAssignment,
    │                               OpChip, DerivedChip, …
    ├── app-shell/                ← П1: оболочка (shell.jsx · app.css)
    ├── screens/                  ← П1: оргструктура · инбокс · аудит
    │   └── rights/               ← П1R: «Права и доступ» (in-shell + standalone)
    ├── canvas/                   ← П2: BPMN Canvas
    │   ├── bpmn-theme.css          ТЕМА: override .djs-*/.bpmn-icon-* через --chs-*
    │   ├── screen-editor.jsx       макет редактора (харнесс превью)
    │   └── editor.css              роль diagram-js.css в макете
    └── forms/                    ← П3: Forms
        ├── form-theme.css          ТЕМА form-js (.fjs-*), САМОДОСТАТОЧНА для iframe
        └── form-defs.js            2 эталонные формы + sandbox-скрипт (auto-height)
```

## Поверхности (5 проектов Claude Design)

| | Поверхность | Куда ложится | Статус |
|---|---|---|---|
| **П0** | Design System | `src/design/` + `src/components/` | ✅ интегрирован |
| **П1** | Chrome | `src/app-shell/` + `src/screens/` | ✅ интегрирован (v2, on-model) |
| **П1R** | Права и доступ *(hero)* | `src/screens/rights/` | ✅ интегрирован |
| **П2** | BPMN Canvas | `src/canvas/bpmn-theme.css` | ✅ тема интегрирована |
| **П3** | Forms | `src/forms/form-theme.css` | ✅ интегрирован — **5/5** |

## Предпросмотр

Открой любой `web/preview/*.html` в браузере (React + Babel-standalone с CDN,
сборка не нужна). `forms.html` исполняет формы в реальных `sandbox`-iframe.
Витрины подключены к каноническим путям `src/`, поэтому показывают ровно то,
что лежит в репо.

> Правило: в `main` не мержим — это гейт фаундера. Интеграция идёт в ветку `dev`.
