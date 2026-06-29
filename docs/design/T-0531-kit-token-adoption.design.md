# T-0531 — Kit/Token/Icon Adoption Sweep: Design Spec

> DESIGN-only. Impl-прогон (свип ~35 файлов) читает эту спеку и выполняет механические замены.  
> Источник: UX-аудит 2026-06-29 §10/11/12, обзор components.jsx + tokens.css + field-renderer.jsx.

---

## 1. Правила миграции по классам

### 1.1 Контролы: raw → kit primitives

**Принцип:** любой `<input>`, `<select>`, `<button>`, `<textarea>` с классами `chs-input`/`chs-label`/`chs-btn` вне `field-renderer.jsx` и вне `components.jsx` — это заимствование без kit-обёртки. Заменять на `<Field>`, `<Select>`, `<Button>` из `components.jsx`.

| Паттерн (raw) | Замена (kit) | Примечание |
|---|---|---|
| `<input className="chs-input" ...>` + отдельный `<label className="chs-label">` | `<Field label="…" …>` | `Field` автогенерит `id`, wires `aria-describedby`, фокус-ринг |
| `<select className="chs-input chs-select">` + ручная стрелка | `<Select label="…" options={…} …>` | `Select` содержит `<KitIcon name="chevron-down">` |
| `<button className="chs-btn …">` вручную | `<Button variant="…" size="…">` | `Button` несёт `aria-disabled`, `aria-busy`, `Spinner` при `loading` |
| `<textarea className="chs-input">` | поле в `FieldControl` с `presentation='textarea'` ИЛИ `<Field as="textarea">` (если расширить) | см. п. 1.5 |
| `<input type="checkbox">` standalone | остаётся `<input type="checkbox">` с явным `id`+`<label htmlFor>` (Checkbox-примитива нет в kit); добавить в бэклог T-0531-EXT | Checkbox-примитив — отдельная задача |

**Исключения (не трогать):**
- `web/src/forms/field-renderer.jsx` — это и есть «внутренность» unified-рендерера; его raw-контролы корректны по дизайну, они уже несут `chs-input`/`chs-label`, aria-атрибуты полные.
- `web/src/components/components.jsx` — сам kit; не мигрировать на себя.
- `web/src/canvas/` bpmn-js-хром — см. §4 «Исключения».

**Порядок замены в файле:**
1. Импортировать нужные примитивы из `components.jsx`.
2. Заменить контрол.
3. Убедиться, что `label`-проп передан (не оставлять безымянных полей).
4. Удалить обнулённые `aria-*`-дубликаты (Field/Select/Button несут их сами).

---

### 1.2 Глифы → Lucide Icon через `<KitIcon>`

**Принцип:** Unicode/emoji-символы, используемые как иконки, нарушают контракт Lucide/currentColor (аудит §10). Любой символ, несущий смысл действия или состояния, должен быть заменён на `<KitIcon name="…">` из `components.jsx`.

**Таблица замен (вся коллекция аудита + расширение):**

| Unicode-глиф | Назначение | Замена `KitIcon.name` |
|---|---|---|
| `▾` / `▴▾` | disclosure caret | `chevron-down` |
| `✕` / `✗` / `×` | закрыть / удалить | `close` |
| `★` / `☆` | избранное | _(добавить `star` в KitIcon — см. §2)_ |
| `✎` / `✏` | редактировать | _(добавить `pencil`)_ |
| `↑` / `↓` | порядок сортировки/строк | _(добавить `arrow-up` / `arrow-down`)_ |
| `←` | назад | _(добавить `arrow-left`)_ |
| `…` / `⋯` | переполнение меню | _(добавить `more-horizontal`)_ |
| `+` как текст кнопки | добавить строку | `plus` (уже в KitIcon) |
| `✕` в `CollectionField` remove-кнопке | удалить строку | `close` (промежуточно) или добавить `trash` |
| `●` / `◐` / `○` как статус | только в `StatusChip` | использовать `<StatusChip status="…">` |
| `≤` / `#` / `≥` операторы | текст-метки в условиях | оставить как текст в `<span>` (не иконки) |

**Правило «не-иконка»:** операторы фильтров (`≤ ≥ =`), числовые значения, пунктуация — оставить как текст. Меняем только глифы, НЕСУЩИЕ ФУНКЦИЮ (действие/состояние/навигация).

**Иконки в `Button`:** передавать через `glyph` проп:
```jsx
<Button glyph={<KitIcon name="plus" className="chs-btn__glyph" />} onClick={…}>
  Добавить
</Button>
```

**Aria-label на icon-only controls:** каждая кнопка без текстового потомка ОБЯЗАНА иметь `aria-label`. `Button` принимает `aria-label` через `...rest`. Проверить при замене.

---

### 1.3 Хардкод цветов/px/weights → семантические токены

**Принцип:** все `style={{ color: '#xxx' }}`, `style={{ fontWeight: 600 }}`, `style={{ padding: '8px' }}` и `var(--chs-*, #fallback-hex)` должны быть заменены на семантические `--chs-*` токены из `tokens.css`.

#### Карта замен (ключевые случаи из аудита §11):

| Хардкод | Токен | Контекст |
|---|---|---|
| `#c00` / `#e00` / `red` | `var(--chs-color-danger)` | ошибки, деструктивное |
| `#2563eb` / `blue` | `var(--chs-color-accent)` | акцент/действие |
| `#222` / `#333` | `var(--chs-color-text)` | основной текст |
| `green` / `#0a0` | `var(--chs-color-success)` | успех |
| `fontWeight: 600` | `var(--chs-weight-semibold)` | полужирный |
| `fontWeight: 700` | `var(--chs-weight-bold)` | жирный |
| `fontSize: '14px'` | `var(--chs-text-md)` | |
| `fontSize: '12px'` | `var(--chs-text-sm)` | |
| `fontSize: '11px'` | `var(--chs-text-xs)` | |
| `fontSize: '10px'` | `var(--chs-text-2xs)` | |
| `padding: '4px'` | `var(--chs-space-2)` | |
| `padding: '8px'` | `var(--chs-space-4)` | |
| `padding: '12px'` | `var(--chs-space-5)` | |
| `padding: '16px'` | `var(--chs-space-6)` | |
| `borderRadius: '4px'` | `var(--chs-radius-2)` | контрол |
| `borderRadius: '2px'` | `var(--chs-radius-1)` | чип |
| `borderRadius: '6px'` | `var(--chs-radius-3)` | панель |
| `border: '1px solid #ddd'` | `border: 1px solid var(--chs-color-border)` | |
| `system-ui` / `sans-serif` в iframe | `var(--chs-font-sans)` | инжектировать в iframe |
| `toFixed(4)` на деньгах | `Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB'})` + `<Mono>` | |

**Паттерн `var(--chs-color-primary)`** (встречается в `field-renderer.jsx` CollectionField `addBtnStyle`) — токен `--chs-color-primary` не определён в `tokens.css`. Заменить на `var(--chs-color-accent)`.

**var()-fallback-хаки:** паттерн `var(--chs-some-token, #hex)` с hex-fallback убивает dark-theme. Убрать hex-fallback целиком — токен гарантированно определён в `:root`.

**iframe form-theme:** форм-iframe (`web/src/forms/`) рендерится в opaque origin. Решение: родительский `<FormViewer>` инжектирует `--chs-color-bg`, `--chs-color-text`, `--chs-color-surface`, `--chs-font-sans` как inline CSS custom properties через `iframe.contentDocument.documentElement.style.setProperty(…)` после загрузки. Альтернативно — postMessage-канал.

---

### 1.4 Таблицы и секции → Table/Card/Badge

**Принцип:** CSS-grid div/span-«таблицы» без семантики не читаются AT (аудит §12). Конвергировать на:

#### Kit-компоненты (нужно добавить в `components.jsx` — scope impl-фазы):

| Компонент | Назначение | Минимальный контракт |
|---|---|---|
| `<DataTable columns rows className>` | семантическая `<table>` с `scope="col"` для `<th>` | `columns: [{key, label, render?}]`, `rows: object[]` |
| `<Card title children footer>` | raised surface с `--chs-shadow-1/2`, `--chs-color-surface` | заменяет per-file inline-border-radius divs |
| `<Badge tone? children>` | статусные/инфо-лейблы, заменяет `StatusChip` для контента (не процессов) | `tone: 'success'|'warning'|'danger'|'info'|'neutral'` |
| `<SectionHead title action>` | заголовок секции, заменяет h2/h3 + inline-button паттерн | |

**Области замены (приоритет impl-прогона):**
1. `screen-rights.jsx` — audit-log строки, grant-matrix ряды → `<DataTable>`.
2. `screen-observability.jsx` — notification/report матрицы → `<DataTable>`.
3. `screen-app-records.jsx` — schema `role=table` без row/cell → `<DataTable>`.
4. `screen-agents.jsx` и `screen-org.jsx` — секционные карточки → `<Card>`.
5. Статусные чипы в различных экранах → `<Badge>` или существующий `<StatusChip>`.

**Правило выбора `StatusChip` vs `Badge`:**
- `StatusChip` — только для **процессного статуса** (running/done/failed/waiting/paused). Несёт dot-индикатор.
- `Badge` — всё остальное (теги, роли, версии, типы).

---

## 2. Реестр иконок (Lucide) — объявление и связь с WidgetDescriptor

### 2.1 Структура `KitIcon` в `components.jsx`

`KitIcon` уже существует и содержит 9 глифов: `close`, `alert`, `error`, `info`, `success`, `retry`, `inbox`, `plus`, `chevron-down`.

**Добавляемые глифы (impl-фаза расширяет switch в `KitIcon`):**

```
star         — ★ аудит §10
pencil       — ✎ редактировать
trash        — удалить строку/запись
arrow-up     — ↑ сортировка/порядок
arrow-down   — ↓ сортировка/порядок
arrow-left   — ← назад
more-horizontal — … переполнение
check        — галочка подтверждения
external-link — ссылка-открыть
search       — поиск
```

**Правило добавления иконки:**
1. Выбрать Lucide-глиф (https://lucide.dev — stroke 1.6, 16×16 viewBox).
2. Добавить `{name === "X" && (<path …>)}` ветку в `KitIcon`.
3. Добавить `IconRegistryEntry` (см. §2.2).
4. Добавить dev-warn fallback (см. §2.3).

### 2.2 IconRegistryEntry (тип)

```ts
// web/src/design/icon-registry.js
export const ICON_REGISTRY = {
  // name → { label, since, usedIn }
  "close":          { label: "Закрыть",       since: "kit-v1", usedIn: ["Modal","Drawer","Toast","Button"] },
  "alert":          { label: "Предупреждение", since: "kit-v1", usedIn: ["Toast"] },
  "error":          { label: "Ошибка",         since: "kit-v1", usedIn: ["ErrorState","Toast"] },
  "info":           { label: "Информация",     since: "kit-v1", usedIn: ["Toast"] },
  "success":        { label: "Успех",          since: "kit-v1", usedIn: ["Toast"] },
  "retry":          { label: "Повторить",      since: "kit-v1", usedIn: ["ErrorState"] },
  "inbox":          { label: "Входящие",       since: "kit-v1", usedIn: ["EmptyState"] },
  "plus":           { label: "Добавить",       since: "kit-v1", usedIn: ["Button","CollectionField"] },
  "chevron-down":   { label: "Раскрыть",       since: "kit-v1", usedIn: ["Select","Popover"] },
  "star":           { label: "Избранное",      since: "T-0531", usedIn: [] },
  "pencil":         { label: "Редактировать",  since: "T-0531", usedIn: [] },
  "trash":          { label: "Удалить",        since: "T-0531", usedIn: ["CollectionField"] },
  "arrow-up":       { label: "Вверх",          since: "T-0531", usedIn: [] },
  "arrow-down":     { label: "Вниз",           since: "T-0531", usedIn: [] },
  "arrow-left":     { label: "Назад",          since: "T-0531", usedIn: [] },
  "more-horizontal":{ label: "Ещё",            since: "T-0531", usedIn: [] },
  "check":          { label: "Подтверждение",  since: "T-0531", usedIn: [] },
  "external-link":  { label: "Внешняя ссылка", since: "T-0531", usedIn: [] },
  "search":         { label: "Поиск",          since: "T-0531", usedIn: [] },
};
```

Файл `icon-registry.js` — source-of-truth для:
- grep-гарда FF-ICON-3 (все `KitIcon` name-значения в реестре).
- Авто-генерации showcase-секции иконок (опционально).

### 2.3 Dev-warn fallback в `KitIcon`

Impl-фаза добавляет в конец switch-цепочки:

```jsx
{/* fallback: неизвестное имя → видимая рамка + dev-warn */}
{!KNOWN_NAMES.has(name) && (
  <>
    {process.env.NODE_ENV !== 'production' && console.warn(`[KitIcon] Unknown name: "${name}"`)}
    <rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeDasharray="3 2" />
    <path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" strokeWidth="1" />
  </>
)}
```

`KNOWN_NAMES` = `new Set(Object.keys(ICON_REGISTRY))` — импорт из `icon-registry.js`.

### 2.4 Связь с `WidgetDescriptor.icon` (T-0543)

`WidgetDescriptor.icon: string` (из `T-0543-widget-registry.interface.ts`) декларирует иконку виджета в палитре конструктора. **Контракт:** значение `icon` ДОЛЖНО быть ключом `ICON_REGISTRY`. Реестр виджетов не дублирует SVG — он ссылается на реестр иконок по имени.

Impl-правило для T-0543/T-0544:
```ts
// При регистрации дескриптора в widget-registry.js:
import { ICON_REGISTRY } from '../design/icon-registry.js';
// ...
function registerWidget(descriptor) {
  if (!ICON_REGISTRY[descriptor.icon]) {
    throw new Error(`Widget "${descriptor.id}" references unknown icon "${descriptor.icon}". Add it to icon-registry.js first.`);
  }
  registry.set(descriptor.id, descriptor);
}
```

Текущие 10 виджетов T-0543 и их иконки (proposal, подтвердить при impl):

| `WidgetId` | `icon` (KitIcon name) |
|---|---|
| `section` | `plus` |
| `columns` | `plus` |
| `tabs` | `plus` |
| `divider` | `minus` _(добавить)_ |
| `text` | `pencil` |
| `field` | `check` |
| `table` | `plus` |
| `readout` | `info` |
| `relation` | `external-link` |
| `action` | `chevron-down` |
| `list` | `arrow-down` |
| `chart` | `plus` |
| `metric` | `plus` |
| `custom` | `star` |

> При impl-фазе T-0544 скорректировать иконки под реальный дизайн палитры.

---

## 3. Карта хардкод → токен (примеры из tokens.css)

Полная карта выше в §1.3. Здесь — ключевые «грабли» аудита §11 по файлам:

### 3.1 field-renderer.jsx (примеры, НЕ требующие замены в свипе — уже корректны)
- `var(--chs-color-danger)` для `*`-маркера — ОК.
- `var(--chs-space-1/2/4)` — ОК.
- `var(--chs-color-text-muted)` — ОК.
- **НУЖНО исправить:** `var(--chs-color-primary)` в `addBtnStyle` (строка ~609) → `var(--chs-color-accent)`.
- **НУЖНО исправить:** `var(--chs-radius)` (строка ~608 — без числа) → `var(--chs-radius-2)`.

### 3.2 Экранные файлы (scope impl-прогона)
Файлы-цели (из аудита §10/11): `screen-rights.jsx`, `screen-ai.jsx`, `screen-observability.jsx`, `bpmn-properties-panel.jsx`, `screen-app-records.jsx`, `screen-org.jsx`, `screen-agents.jsx`, `screen-inbox.jsx`, `showcase.jsx`.

Grep-паттерн для поиска перед свипом:
```sh
grep -rn --include="*.jsx" --include="*.css" \
  -E "(#[0-9a-fA-F]{3,6}|fontWeight:\s*(600|700)|fontSize:\s*'[0-9]+px'|padding:\s*'[0-9]+px'|color:\s*(red|green|blue))" \
  web/src/screens/ web/src/canvas/ web/src/app-shell/
```

---

## 4. Правило исключений

### 4.1 bpmn-js-хром (canvas/)

**Зона:** `web/src/canvas/` — BPMN-редактор на базе `bpmn-js`. Модалки, кнопки и контролы внутри `bpmn-js` рендерятся самой библиотекой и не подлежат миграции на kit.

**Правило документирования:** каждый файл-исключение содержит комментарий:
```js
// BPMN-JS-CHROME-EXCEPTION: controls in this scope are rendered by bpmn-js internals.
// Do NOT replace with kit <Field>/<Button>. Kit migration applies ONLY to the
// host-shell wrapper and properties-panel overlay (bpmn-properties-panel.jsx § host layer).
```

**Минимальная a11y для host-overlay:** `bpmn-properties-panel.jsx` хостит собственные `<input>`/`<select>` поверх bpmn-js-хрома. Для них:
- Добавить `aria-label` на все безымянные поля.
- Добавить `type="button"` на все `<div role="button">` accordion-headers.
- НЕ мигрировать на `<Field>/<Select>` (эта зона пер-сайт).

### 4.2 Форм-iframe (forms/FormViewer.jsx)

iframe рендерится в opaque origin. Kit-компоненты из host-bundle недоступны. Решение:
- Инжектировать CSS-переменные в iframe (описано в §1.3).
- НЕ пытаться импортировать `components.jsx` в iframe-код.
- Оставить `chs-input`/`chs-label` классы как есть; они попадают через `form-theme.css`.

### 4.3 Showcase (showcase.jsx)

`showcase.jsx` — витрина kit-примитивов, НЕ продуктовый экран. Тем не менее он может содержать хардкод hex (аудит: «ironically including the showcase»). Исправить хардкод → токены, но не менять структуру.

---

## 5. Приоритет и порядок свипа

### Волна 0 — исправления в самом kit (components.jsx / field-renderer.jsx)
1. `field-renderer.jsx` строка ~608-609: `--chs-color-primary` → `--chs-color-accent`; `--chs-radius` → `--chs-radius-2`.
2. `components.jsx` `KitIcon`: добавить глифы T-0531 (§2.1), `KNOWN_NAMES` Set, dev-warn fallback.
3. Создать `web/src/design/icon-registry.js`.

### Волна 1 — Unicode-глифы → KitIcon (высокий охват, low-risk)
Файлы (приоритет: максимум глифов): `screen-rights.jsx`, `bpmn-properties-panel.jsx`, `screen-inbox.jsx`, `showcase.jsx`, `screen-ai.jsx`.

### Волна 2 — Хардкод цветов/px/weights → токены (25 файлов)
Механический свип grep → replace. Критически: убрать hex-fallbacks в `var()`, заменить `#222`, `#2563eb`, `green`/`red`. Исправить iframe-инжект.

### Волна 3 — raw controls → kit Field/Select/Button
Файлы: `screen-rights.jsx`, `screen-org.jsx`, `screen-agents.jsx`, `screen-ai.jsx`, `screen-observability.jsx`. **НЕ трогать** `field-renderer.jsx` (уже правильно).

### Волна 4 — таблицы и секции → DataTable/Card/Badge
Требует сначала добавить `DataTable`, `Card`, `Badge` в `components.jsx`. Самая широкая волна (~10 файлов), начинать с `screen-rights.jsx` (audit-log).

**Итоговый порядок волн: 0 → 1 → 2 → 3 → 4.**

---

## 6. Что НЕ ломать

### 6.1 Focus-ring
`components.jsx` устанавливает `--chs-ring` через CSS в `components.css` (`:focus-visible`). Миграция на `<Field>/<Button>` НАСЛЕДУЕТ focus-ring автоматически. **Не добавлять** `outline` вручную при замене.

### 6.2 aria-* приходят из kit
`<Field>` wire-ит `aria-describedby` → hint-span, `aria-invalid` → input. `<Button>` wire-ит `aria-disabled`, `aria-busy`. При замене удалять ручные дубликаты этих атрибутов.

### 6.3 Специфика `chs-input--invalid`
`<Field invalid={Boolean(error)}>` рендерит `chs-input--invalid` и `chs-hint--invalid`. НЕ добавлять эти классы вручную снаружи kit.

### 6.4 Theme propagation
`--chs-color-*` токены определены в `:root` (светлая) и `[data-theme="dark"]`. После замены хардкода на токены dark-theme работает бесплатно — НЕ нужно добавлять `[data-theme="dark"]` переопределения в файлах.

### 6.5 KitIcon aria-hidden
`<KitIcon>` всегда рендерит `aria-hidden="true" focusable="false"`. Доступное имя несёт **родительский элемент** (`aria-label` на `<Button>`, текст в `<Tooltip>`). НЕ убирать `aria-hidden`.

### 6.6 Не добавлять новые токены
Свип — замена хардкода на СУЩЕСТВУЮЩИЕ токены `tokens.css`. Новые `--chs-*` переменные не вводить (это отдельная задача дизайн-системы).

---

_Версия: 2026-06-29 · Architect: T-0531 DESIGN phase_
