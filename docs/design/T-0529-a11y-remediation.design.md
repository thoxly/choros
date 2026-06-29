# T-0529 — A11y Remediation: клавиатура + ARIA + доступность (WCAG AA)

> **Статус:** DESIGN-спека (impl → отдельная задача)
> **Источник:** UX-аудит 2026-06-29 §5/8/9/13/15, гейт T-0314 (G1/G3/G4)
> **Связи:** T-0314 (OBLIK UX-гейт), T-0526 (disabled-причина), T-0528 (toast-озвучка), T-0544 (keyboard-фоллбэк в конструкторе форм)

---

## Диагноз (из аудита — только факты, на которые опирается спека)

| # | Поверхность | Нарушение WCAG | Severity |
|---|---|---|---|
| §5 | BPMN-канвас (bpmn-modeler-wrapper.jsx) | `keyboard: { bindTo: null }` — канвас полностью недоступен с клавиатуры; нет `role`/`aria-label` | high |
| §5 | FormDesigner.jsx — `CanvasNode` | `<div draggable onClick>` без `tabIndex`/`role`/`onKeyDown`; перетаскивание только мышью | high |
| §5 | shell.jsx — `ThemeToggle`, `NavItem` | `ThemeToggle` несёт `aria-pressed`, но кнопки без `type="button"`; `NavItem` disabled без видимой причины | high |
| §5 | Tabs (forms, inbox, rights) | `aria-selected` на голых `<button>` без `role=tablist/tab`, нет arrow-key-навигации | high |
| §5 | Кликабельные `<tr>`/`<div>` rows (records, apps) | нет `tabIndex`/`role=row`+`button`/`onKeyDown` | high |
| §8 | Field errors (Inspector, schema, records) | `aria-invalid` на контроле, но без `aria-describedby`; span ошибки без `id`; нет `role=alert` | high |
| §9 | Enabled no-ops (Экспорт прав, fake поиск) | кликабельны, но ничего не делают | high |
| §9 | Disabled-причина в native `title` / `Tooltip` на disabled | не доступно AT, keyboard, touch | high |
| §13 | Смысл через цвет/иконку без текста | критичность, dim-opacity для used-полей, SLA-цвет, статус-точки | medium |
| §15 | `Popover` — нет focus-trap, `aria-expanded`, `aria-controls` | нет управления фокусом при открытии | medium |

---

## А. Клавиатурные паттерны по поверхностям

### А1. BPMN-канвас (`bpmn-modeler-wrapper.jsx`)

**Проблема:** `keyboard: { bindTo: null }` — bpmn-js не принимает keyboard events вообще.

**Паттерн:**

```jsx
// Передавать containerRef как bindTo
const modeler = new BpmnModeler({
  container: containerRef.current,
  keyboard: { bindTo: containerRef.current },  // ← убрать null
  ...
});

// Контейнер — role=application + aria-label (AT не раскладывает дерево внутри)
<div
  ref={containerRef}
  className={`chs-bpmn-real-container ${className}`.trim()}
  role="application"
  aria-label="Редактор BPMN-диаграммы"
  aria-describedby="bpmn-keyboard-hint"
  tabIndex={-1}   // чтобы можно было программно фокусировать
  style={style}
/>
// Скрытый hint для AT:
<span id="bpmn-keyboard-hint" className="chs-sr-only">
  Используйте стрелки для навигации, Delete для удаления, E для открытия свойств выбранного элемента.
  Нажмите Tab чтобы перейти к инструментам панели.
</span>
```

**Дополнительно:**
- После `importXML` вызывать `modeler.get('keyboard').bind(containerRef.current)` явно — bpmn-js keyboard module умеет bind post-mount.
- Добавить краткое текстовое резюме диаграммы в `aria-description` контейнера (кол-во узлов, имя процесса) — генерить после importXML.
- Palette bpmn-js: элементы palette-provider уже получают DOM от bpmn-js; убедиться, что каждая entry имеет `title` (для AT), а при Tab-порядке внутри palette фокус ходит по записям.

**bpmn-js exception:** Некоторые внутренние controls bpmn-js (context-pad, properties-panel) не являются React-компонентами — для них устанавливать `aria-label` и `title` через `ContextPadProvider` / CSS-селекторы. Документировать как исключение в коде.

---

### А2. FormDesigner — drag-drop canvas (согласовать с T-0544)

**Проблема:** `CanvasNode` — `<div draggable onClick>` без keyboard support. `PaletteBlock` и `FieldChip` — `<button draggable>` (keyboard OK для click/Enter), но drag без keyboard alternative.

**T-0544 keyboard-фоллбэк** — наша задача задаёт контракт, T-0544 реализует. Здесь дизайн паттерна:

#### CanvasNode: превратить в button

```jsx
function CanvasNode({ node, index, selected, onSelect, onRemove, onMoveUp, onMoveDown, onDragStart, onDrop }) {
  return (
    <div
      className={`chs-canvas-node${selected ? ' chs-canvas-node--selected' : ''}`}
      role="listitem"   // родитель получает role="list"
      // drag — оставить для мышиного DnD
      draggable
      onDragStart={...}
      onDragOver={...}
      onDrop={...}
    >
      {/* Кнопка выбора — главный интерактивный контрол */}
      <button
        type="button"
        className="chs-canvas-node__select"
        onClick={() => onSelect(index)}
        aria-pressed={selected}
        aria-label={`Блок ${node.label || PALETTE[node.type]?.label || node.type}${selected ? ', выбран' : ''}`}
      >
        <span className="chs-canvas-node__type">...</span>
        <strong>{label}</strong>
      </button>

      {/* Keyboard reorder controls (T-0544 фоллбэк) */}
      <div className="chs-canvas-node__actions" role="group" aria-label="Управление блоком">
        <button type="button" className="chs-btn chs-btn--ghost chs-btn--sm"
          onClick={() => onMoveUp(index)} disabled={index === 0}
          aria-label="Переместить блок выше">
          <Icon name="chevron-up" />
        </button>
        <button type="button" className="chs-btn chs-btn--ghost chs-btn--sm"
          onClick={() => onMoveDown(index)} disabled={isLast}
          aria-label="Переместить блок ниже">
          <Icon name="chevron-down" />
        </button>
        <button type="button" className="chs-btn chs-btn--ghost chs-btn--sm"
          onClick={(e) => { e.stopPropagation(); onRemove(index); }}
          aria-label="Удалить блок">
          <Icon name="x" />  {/* не × — Icon-примитив */}
        </button>
      </div>
    </div>
  );
}
// Родительский canvas-list:
<div role="list" aria-label="Блоки формы" className="chs-canvas-list">
  {rootChildren.map((node, i) => <CanvasNode ... />)}
</div>
```

#### PaletteBlock / FieldChip: drag OK (уже `<button>`), добавить роль в группе

```jsx
// Палитра-группа:
<div role="group" aria-labelledby="palette-group-layout">
  <span id="palette-group-layout" className="chs-label">Раскладка</span>
  <PaletteBlock ... />
</div>

// FieldChip: used-поле dim через aria-disabled + visually-hidden reason (не только opacity):
<button ... aria-disabled={used} aria-describedby={used ? `field-used-${field.key}` : undefined}>
  ...
</button>
{used && <span id={`field-used-${field.key}`} className="chs-sr-only">Поле уже добавлено на форму</span>}
```

#### Inspector: raw `<input>`/`<textarea>` → `<Field>`

```jsx
// Вместо:
// <label className="chs-label">Метка</label>
// <input className="chs-input" ... />
// Использовать:
<Field label="Метка" value={node.label || ''} onChange={(e) => onPatch({ label: e.target.value })} />
```

---

### А3. Палитра команд (shell) — Listbox с roving tabindex

**Текущее состояние:** палитра (⌘K) объявляет `role=option` без `role=listbox`-контейнера, без arrow-key-навигации, без `aria-activedescendant`.

**Паттерн — настоящий listbox:**

```jsx
function CommandPalette({ items, query, onSelect }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[activeIdx]) onSelect(items[activeIdx]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  const optionId = (i) => `chs-palette-opt-${i}`;

  return (
    <div role="dialog" aria-label="Палитра команд" aria-modal="true">
      <input
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-controls="chs-palette-list"
        aria-activedescendant={items.length ? optionId(activeIdx) : undefined}
        aria-expanded={items.length > 0}
        value={query}
        onKeyDown={onKeyDown}
        ...
      />
      <ul
        id="chs-palette-list"
        ref={listRef}
        role="listbox"
        aria-label="Результаты"
      >
        {items.map((item, i) => (
          <li
            key={item.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === activeIdx}
            onClick={() => onSelect(item)}
          >
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

### А4. Tabs / деревья / кликабельные `<tr>` — общий паттерн

#### Tabs (WAI-ARIA Tabs pattern)

```jsx
function Tabs({ tabs, activeId, onChange }) {
  const [focused, setFocused] = useState(activeId);

  function onKeyDown(e) {
    const ids = tabs.map(t => t.id);
    const cur = ids.indexOf(focused);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = ids[(cur + 1) % ids.length];
      setFocused(next); onChange(next);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = ids[(cur - 1 + ids.length) % ids.length];
      setFocused(prev); onChange(prev);
    } else if (e.key === 'Home') {
      e.preventDefault(); setFocused(ids[0]); onChange(ids[0]);
    } else if (e.key === 'End') {
      e.preventDefault(); const last = ids[ids.length - 1]; setFocused(last); onChange(last);
    }
  }

  return (
    <>
      <div role="tablist" aria-label={label}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={tab.id === activeId}
            aria-controls={`panel-${tab.id}`}
            tabIndex={tab.id === activeId ? 0 : -1}  // roving tabindex
            onClick={() => { setFocused(tab.id); onChange(tab.id); }}
            onKeyDown={onKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map(tab => (
        <div
          key={tab.id}
          id={`panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab.id}`}
          hidden={tab.id !== activeId}
        >
          {tab.content}
        </div>
      ))}
    </>
  );
}
```

**Экстракт в kit:** `<Tabs>` / `<SubTabs>` — переиспользовать во всех 6 экранах (forms, inbox, rights, ra-shell, grant-trail, observability).

#### Кликабельные `<tr>` / `<div>` rows

```jsx
// НЕ делать: <tr onClick={navigate}> без tabIndex
// ДЕЛАТЬ: явный focusable control внутри строки как primary affordance
<tr>
  <td>
    <a href={`/apps/${app.id}/records`} className="chs-link">
      {app.display_name}
    </a>
  </td>
  <td>...</td>
  <td>
    <Button variant="ghost" size="sm" onClick={() => navigate(...)}>Открыть</Button>
  </td>
</tr>
// onClick на <tr> — оставить как pointer-удобство, НЕ как единственный путь
// Если <tr onClick> обязателен: role="row" tabIndex={0} + onKeyDown Enter/Space
```

#### Деревья (OrgTree)

```jsx
<ul role="tree" aria-label="Оргструктура">
  <li role="treeitem" aria-expanded={open} aria-level={1}>
    <button type="button" onClick={toggle} aria-expanded={open}>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} aria-hidden="true" />
      {name}
    </button>
    {/* Не вкладывать interactive controls ВНУТРЬ button */}
    <div role="group">
      {open && children.map(...)}
    </div>
  </li>
</ul>
```

---

## Б. Ошибки полей: `aria-describedby` + озвучка

**Паттерн (применять ко ВСЕМ custom-field контролам, не через `<Field>`):**

```jsx
function FieldWithError({ label, value, onChange, error, hint }) {
  const id = useId();
  const errorId = error ? `err-${id}` : undefined;
  const hintId = hint ? `hint-${id}` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="chs-field">
      <label htmlFor={id} className="chs-label">{label}</label>
      <input
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={!!error}
        aria-describedby={describedBy}
        // aria-errormessage предпочтительнее aria-describedby для ошибок,
        // но aria-describedby — более широкая поддержка AT; использовать оба:
        aria-errormessage={errorId}
      />
      {error && (
        <span id={errorId} className="chs-hint chs-hint--invalid" role="alert">
          {error}
        </span>
      )}
      {hint && !error && (
        <span id={hintId} className="chs-hint">{hint}</span>
      )}
    </div>
  );
}
```

**Правила:**
1. `role="alert"` на span ошибки — AT объявит сразу при появлении.
2. НЕ подавлять до publish — выводить `required`/`invalid` при `blur` (после первой попытки сохранения). Немедленный `touched`-флаг.
3. Группы чекбоксов (multi-select):

```jsx
<fieldset>
  <legend className="chs-label">Режим полей</legend>
  {options.map(opt => (
    <label key={opt.value} className="chs-checkbox-label">
      <input type="checkbox" ... />
      {opt.label}
    </label>
  ))}
</fieldset>
```

4. `<Field>` из kit уже делает `aria-describedby={hintId}` — использовать его везде; Inspector в FormDesigner и bespoke forms — мигрировать.

---

## В. Мёртвые enabled-контролы и disabled-причина

### В1. Убрать мёртвые enabled-ноупы

| Поверхность | Элемент | Решение |
|---|---|---|
| `shell.jsx` Экспорт прав | `<Button disabled>` уже стоит (T-0484 fix) | OK — но `Tooltip` на disabled-button не работает с AT |
| Grant-trail «Экспорт» | нет `onClick` | Либо wire endpoint, либо `disabled` |
| Fake «Поиск роли» | `<div>` без handler | Убрать или превратить в `<Field type="search">` |
| ⌘K overview hint | ведёт в никуда | Открывать палитру или убрать текст |
| Promote-step промпта | нет кнопки | Добавить `<Button>Опубликовать</Button>` |

### В2. Disabled-причина — НЕ `title`, НЕ `Tooltip` на `disabled`

**Проблема:** `<Tooltip label="..."><Button disabled>X</Button></Tooltip>` — AT не достигает `disabled` элемент; `title` не читается на keyboard/touch.

**Паттерн:**

```jsx
// НЕПРАВИЛЬНО:
<Tooltip label="Добавить исполнителя можно в панели слева">
  <Button disabled>Исполнитель</Button>
</Tooltip>

// ПРАВИЛЬНО — вариант А: aria-disabled (фокусируемо) + aria-describedby
function DisabledWithReason({ reason, children, ...rest }) {
  const reasonId = useId();
  return (
    <span>
      <button
        {...rest}
        aria-disabled="true"   // НЕ disabled — остаётся focusable
        aria-describedby={reasonId}
        onClick={(e) => e.preventDefault()}  // блокируем клик
        tabIndex={0}
      >
        {children}
      </button>
      <span id={reasonId} className="chs-sr-only">{reason}</span>
    </span>
  );
}

// ПРАВИЛЬНО — вариант Б: видимый inline helper text
<>
  <Button disabled aria-describedby="export-reason">Экспорт прав</Button>
  <span id="export-reason" className="chs-field-hint">Функция в разработке</span>
</>
```

**Правило:** `aria-disabled="true"` + focusable для inline-контролов, где важно услышать причину. `disabled` + visible helper text для form-submit блокировок (первичные кнопки форм).

**Из audit #9:** `NavItem` disabled (`isSoon`) — кнопка с `disabled` показывает badge «скоро» — этого достаточно (badge доступен как текст-дочерний элемент). Но удалить `onClick={() => clickable && navigate(...)}` — не нужен когда `disabled`.

---

## Г. Текст-эквиваленты для смысла-через-цвет/иконку

| Элемент | Сейчас | Паттерн |
|---|---|---|
| Criticality axes (буква A/B/C) | `title` только | `aria-label="Уровень A — высокая критичность"` на glyph; альт: `<span className="chs-sr-only">Высокая критичность</span>` |
| Dual-control checkmarks ✓ / ✓✓ | нет accessible name | `<span aria-label="Одна подпись">✓</span>` → Icon + `aria-label` |
| ExecGlyph (circle/diamond/square) | `title` на ExecutorBadge | `ExecGlyph` уже `aria-hidden`; ExecutorBadge несёт `title={meta.label}` но это не достаточно — добавить `aria-label={meta.label}` на `<span className="chs-exec">` |
| FieldChip used (opacity:0.5) | только opacity | `aria-disabled` + visually-hidden "Поле уже использовано" |
| SLA-бар (цвет urgency) | цвет + CSS | `role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-valuetext="Просрочено на 3 ч"` |
| StatusChip dot | CSS-dot | Dot уже `chs-chip__dot` без aria-hidden; добавить `aria-hidden="true"` на dot; текст внутри chip — текст-эквивалент |
| ThemeToggle selected | `aria-pressed` | OK, но кнопки нужен `type="button"` |
| Created-row success tint | permanent `background` | Сделать transient (fade 2s, reduced-motion: skip); передавать success через toast |

**Правило §1.4.1:** Каждый смысловой сигнал через цвет/форму/opacity ДОЛЖЕН иметь текстовый/ARIA-эквивалент. Цвет может дублировать, но не быть единственным носителем.

---

## Д. Оверлеи — фокус-менеджмент, Esc-дисмисс, live-region

### Д1. Modal / Drawer (уже в kit)

`useFocusTrap` уже реализован в `components.jsx` — ловушка, Esc, scroll-lock. **НО:**

- `onMouseDown` на overlay → заменить на `onClick` (mousedown прерывает text-selection drag):

```jsx
// Было:
onMouseDown={(e) => { if (closeOnOverlay && e.target === e.currentTarget) onClose?.(); }}
// Стало:
onClick={(e) => { if (closeOnOverlay && e.target === e.currentTarget) onClose?.(); }}
```

- Dirty-check перед закрытием: если Modal содержит форму с несохранёнными данными — `onClose` должен проверять `isDirty` и показывать `<ConfirmDialog>` перед закрытием. Передавать `onBeforeClose?: () => boolean | Promise<boolean>`.

### Д2. Popover (не имеет focus-trap)

Текущий `Popover` — `role=dialog` без фокус-управления. Два сценария:

**Сценарий "меню"** (выпадающий список опций, нет вложенных форм):
```jsx
// Downgrade до role=menu / нет роли dialog
// Trigger: aria-haspopup="listbox" / "menu", aria-expanded, aria-controls
// При открытии: focus на первый item
// Esc → закрыть, вернуть фокус на trigger
// ArrowDown/Up → навигация по items
```

**Сценарий "диалог"** (форма внутри):
```jsx
// Оставить role=dialog
// useFocusTrap или инлайн-вариант: focus на первый focusable при open
// aria-labelledby={headingId}
// Esc → onClose
// Trigger: aria-haspopup="dialog", aria-expanded, aria-controls={popoverPanelId}
```

Текущий `Popover` — `trigger` prop + `open`/`onClose` — добавить:
```jsx
// К trigger — клонировать и добавить:
React.cloneElement(trigger, {
  'aria-haspopup': isMenu ? 'listbox' : 'dialog',
  'aria-expanded': open,
  'aria-controls': open ? panelId : undefined,
})
// К панели:
<div id={panelId} role={isMenu ? 'listbox' : 'dialog'} aria-labelledby={labelId} tabIndex={-1}>
```

### Д3. Tooltip

Текущий `Tooltip` оборачивает children в `<span tabIndex={0} aria-describedby>`. **Проблема:** wrapper-span добавляет лишний focusable элемент если children уже focusable (button):

```jsx
// НЕ оборачивать в лишний span — клонировать children:
function Tooltip({ label, children }) {
  const tipId = useId();
  const child = React.Children.only(children);
  return (
    <>
      {React.cloneElement(child, { 'aria-describedby': tipId })}
      <span role="tooltip" id={tipId} className="chs-tooltip__bubble">{label}</span>
    </>
  );
}
// Контейнер: position:relative на родителе (не span-обёртка)
```

Esc-дисмисс tooltip — для клавиатурных пользователей:
```jsx
// На trigger: onKeyDown (e) => { if (e.key === 'Escape') setVisible(false); }
```

### Д4. Live regions — правила для assistant screen / toast

- **Toast (уже в kit):** `role="alert"` для error (assertive), `role="status"` для success (polite). Добавить `pause-on-hover`:
```jsx
// В useToasts: при наведении на ToastViewport останавливать таймер
// Хранить timeoutRef, clearTimeout onMouseEnter, restartTimeout onMouseLeave
```

- **Конкурирующие aria-live:** нельзя иметь вложенные `aria-live` — у screen-assistant вложенный aria-live в `role=log`. Решение: убрать `aria-live` у вложенного spinner-dots, оставить только `role=log` у контейнера сообщений.

- **GlobalToastProvider (T-0528):** Эта задача питает архитектуру из T-0528. Глобальный провайдер = одна точка монтирования `ToastViewport`, контекст `useToastContext()` для любого компонента без локального wiring.

---

## Е. Таблица поверхность → фиксы

| Поверхность | Файл | Фикс | Гейт |
|---|---|---|---|
| BPMN-канвас | `bpmn-modeler-wrapper.jsx` | `keyboard.bindTo=containerRef`, `role=application`, `aria-label`, `aria-describedby` hint | FF-UX-G4 |
| FormDesigner CanvasNode | `forms/FormDesigner.jsx` | `<div>→button` выбор + `onMoveUp/Down` controls (T-0544 фоллбэк) | FF-UX-G4 |
| FormDesigner Inspector | `forms/FormDesigner.jsx` | raw `<input>/<textarea>` → `<Field>` | FF-UX-G1 |
| FormDesigner FieldChip used | `forms/FormDesigner.jsx` | `aria-disabled` + sr-only reason, не только opacity | FF-UX-G1 |
| Tabs (forms/inbox/rights) | `screen-forms.jsx`, `screen-inbox.jsx`, `ra-shell.jsx` | `role=tablist/tab/tabpanel`, roving tabindex, arrow-key → extract `<Tabs>` kit primitive | FF-UX-G4 |
| Кликабельные tr/div rows | `screen-apps.jsx`, `screen-app-records.jsx` | Anchor/Button как primary affordance, `<tr onClick>` — pointer-only convenience | FF-UX-G4 |
| Org tree | `screen-org.jsx` | `role=tree/treeitem`, не вкладывать controls в `<button>` | FF-UX-G4 |
| Field errors везде | многие экраны | error-span с `id` + `aria-describedby` + `role=alert`; touched-validation | FF-A11Y-ERR |
| Disabled-с-причиной | `shell.jsx`, `screen-dmn-editor.jsx` | `aria-disabled` + focusable + `aria-describedby`, или visible helper text | FF-UX-G3 |
| Мёртвые enabled-ноупы | `shell.jsx`, `ra-grant-trail.jsx` | wire или `disabled` | FF-UX-G3 |
| ExecBadge / CritAxis | `components.jsx`, rights screens | `aria-label` на контейнере | FF-UX-G1 (1.4.1) |
| FieldChip opacity | `forms/FormDesigner.jsx` | sr-only text + `aria-disabled` | FF-UX-G1 (1.4.1) |
| SLA-meter | `screen-inbox.jsx` | `role=progressbar aria-valuenow/text` | FF-UX-G1 (1.4.1) |
| Popover | `components.jsx` | `aria-haspopup`, `aria-expanded`, `aria-controls`, focus-on-open, Esc | FF-UX-G4 |
| Tooltip | `components.jsx` | clone children (не wrap), Esc-дисмисс | FF-UX-G4 |
| Modal overlay close | `components.jsx` | `onMouseDown → onClick` | FF-UX-G4 |
| Toast pause-on-hover | `components.jsx` | clearTimeout onMouseEnter ToastViewport | FF-UX-G1 |
| Live regions (assistant) | `screen-assistant.jsx` | убрать вложенный aria-live из streaming-dots | FF-UX-G1 |

---

## Примечание по границам задач

- **T-0544** — реализует keyboard-фоллбэк CanvasNode (onMoveUp/onMoveDown). Эта спека задаёт контракт интерфейса; T-0544 — impl.
- **T-0528** — реализует GlobalToastProvider + pause-on-hover. Эта спека задаёт архитектуру (один root viewport, контекст).
- **T-0526** — disabled-причина видимым текстом. Эта спека добавляет aria-паттерн поверх видимого текста.
- **T-0314** — гейт G1/G3/G4: эта задача является РЕМОНТОМ, питающим гейт. После impl выполнять FF-UX-G1/G3/G4 в CI.

---

*DESIGN: architect · T-0529 · 2026-06-29*
