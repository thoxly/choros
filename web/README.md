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
│   └── design-system.html        П0 — показывает токены + примитивы из src/
└── src/
    ├── design/
    │   ├── tokens.css            ← П0: КОНТРАКТ --chs-* (источник истины)
    │   ├── showcase.css          ← П0: стили витрины
    │   └── showcase.jsx          ← П0: витрина дизайн-системы
    ├── components/               ← П0: доменные примитивы
    │   ├── components.jsx          ExecutorBadge, TaskRow, AuditEvent, MonoId,
    │   └── components.css          Mono, StatusChip, Button, Field, BudgetMeter
    ├── app-shell/                ← П1: оболочка (нав, топбар, переключатель тем)   [pending]
    ├── screens/                  ← П1: оргструктура · инбокс · таймлайн аудита     [pending]
    │   └── rights/               ← П1R: «Права и доступ» (новый hero)               [pending]
    ├── canvas/
    │   └── bpmn-theme.css        ← П2: тема поверх bpmn-js                          [pending]
    └── forms/
        └── form-theme.css        ← П3: тема поверх form-js (sandbox-iframe)         [pending]
```

## Поверхности (5 проектов Claude Design)

| | Поверхность | Куда ложится | Статус |
|---|---|---|---|
| **П0** | Design System | `src/design/` + `src/components/` | ✅ интегрирован |
| **П1** | Chrome (оргструктура, инбокс, аудит, каркас) | `src/app-shell/` + `src/screens/` | ⏳ ресинк под текущую модель |
| **П1R** | Права и доступ *(hero)* | `src/screens/rights/` | ⏳ не сгенерирован |
| **П2** | BPMN Canvas | `src/canvas/bpmn-theme.css` | ⏳ не сгенерирован |
| **П3** | Forms | `src/forms/form-theme.css` | ⏳ не сгенерирован |

## Предпросмотр

Открой `web/preview/design-system.html` в браузере (React + Babel-standalone с CDN,
сборка не нужна). Витрина подключена к каноническим путям `src/`, поэтому
показывает ровно то, что лежит в репо.

> Правило: в `main` не мержим — это гейт фаундера. Интеграция идёт в ветку `dev`.
