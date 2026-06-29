# DESIGN · T-0544 — Перестройка канваса в конструктор интерфейсов

> **status:** ready (DESIGN-фаза, architect)
> **parent:** T-0543 (реестр виджетов + surface-контракт)
> **эпик:** E-FORMS
> **children (impl):** отдельные задачи — CanvasNode, DropTarget, Inspector v2, undo/redo, multiselect
> **координация рисков:** T-0529 (клавиатурная доступность), T-0533 (guard несохранённых правок)

---

## 1. Контекст: что сейчас и почему не годится

Текущий `FormDesigner.jsx` (заземлено, прочитано):

- **Drag только корня** — `reorderNode(d, [], fromIndex, targetIndex)`: путь всегда `[]`. `CanvasNode` рендерит `rootChildren[i]` — плоский список без вложенности.
- **Превью в `<details>`** — скрыто за раскрывалкой, не живое side-by-side.
- **Нет undo/redo** — нет стека истории.
- **Нет мультивыбора** — `selectedIndex` одно число.
- **Палитра захардкожена** — `PALETTE` из `form-document.js`, `GROUP_LABELS` хардкод в компоненте; нет `icon`, `paletteGroup` из реестра.
- **`CanvasNode` не знает о вложенности** — не показывает дочерние узлы контейнеров.
- **Инспектор ручной switch** — `if (node.type === 'text')`, `if (node.type === 'columns')` — повторяет то, что уже есть в `descriptor.editorProps`.

Задача T-0544: перестроить канвас на реестре виджетов T-0543 — вложенный drag, живое превью, undo/redo, мультивыбор, палитра из реестра.

---

## 2. Interaction-модель

### 2.1 Вложенный drag (path-aware drop-зоны)

**Проблема:** сегодня `handleDrop(targetIndex, e)` работает только на корне (path `[]`). Контейнеры (`section`, `columns`, `tabs`) дочерние слоты не открывают.

**Решение — `DropTarget` с явным `containerPath`:**

Каждый контейнерный узел в дереве рендерится как `CanvasContainer` и сам является принимающей зоной:

```
DropTarget = {
  containerPath: PathSegment[],   // путь к контейнеру в документе ([] = корень)
  tabIndex?: number,              // для tabs — номер вкладки
  insertAt?: number,              // целевая позиция (undefined = в конец)
}
```

**Drop-зоны отображаются:**
1. **Между узлами** — `DropSlot` (горизонтальная полоса) появляется при `dragOver` в пределах контейнера. Высота 4px в спокойном состоянии, 8px + подсветка `--chs-color-accent` при активном dragOver.
2. **На пустой контейнер** — `EmptyDropZone` в теле `section`/`columns` без детей: «Перетащите сюда».
3. **На иконку раскрытия `tabs`** — при drag над заголовком вкладки — переключает активную вкладку (300ms delay, autoscroll).

**Механика вложенного drop:**

```
onDrop(e, dropTarget: DropTarget):
  dragData = parseDataTransfer(e.dataTransfer)
  if dragData.kind === 'reorder':
    if dragData.fromContainer == dropTarget.containerPath && dragData.fromTab == dropTarget.tabIndex:
      // reorder внутри контейнера
      doc = reorderNode(doc, dropTarget.containerPath, dragData.fromIndex, dropTarget.insertAt, dropTarget.tabIndex)
    else:
      // cross-container move — уже есть moveNodeAcross в form-document-ops.js
      doc = moveNodeAcross(doc, dragData.fromContainer, dragData.fromIndex,
                           dropTarget.containerPath, dropTarget.insertAt,
                           dragData.fromTab, dropTarget.tabIndex)
  elif dragData.kind === 'palette':
    descriptor = registry.get(dragData.widgetId)
    node = defaultNodeFromDescriptor(descriptor)
    doc = insertNode(doc, dropTarget.containerPath, node, dropTarget.insertAt, dropTarget.tabIndex)
  elif dragData.kind === 'field':
    node = nodeForField(field, { withId: true })
    doc = insertNode(doc, dropTarget.containerPath, node, dropTarget.insertAt, dropTarget.tabIndex)
  pushHistory(doc)
```

**Важно:** `moveNodeAcross` уже реализован в `form-document-ops.js` — именно он нужен для cross-container drag. Impl должен его использовать, а не reimpl.

**DataTransfer payload (JSON):**

```json
{
  "kind": "reorder",
  "fromContainer": [0],
  "fromIndex": 2,
  "fromTab": null
}
```

```json
{
  "kind": "palette",
  "widgetId": "section"
}
```

```json
{
  "kind": "field",
  "fieldKey": "amount"
}
```

### 2.2 Reorder внутри контейнера

`reorderNode(doc, path, fromIndex, toIndex, tabIndex)` — уже существует в ops с полным path-aware API. Конструктор вызывает его с непустым `path` когда пользователь переупорядочивает дочерние узлы секции/колонки/вкладки.

Пример: reorder внутри первой секции — `reorderNode(doc, [0], 1, 3)`.

### 2.3 Keyboard drag (координация T-0529)

Drag клавиатурой — фоллбэк для пользователей без мыши (WCAG 2.1 SC 2.1.1):

- Узел выбран (`selectedNodes` непустой): `Alt+Up` / `Alt+Down` — reorder внутри текущего контейнера.
- `Alt+Enter` на вложенном контейнере — «войти» (фокус перемещается внутрь).
- `Escape` — выйти из контейнера (фокус на родителя).
- `Delete` / `Backspace` при фокусе на узле — удалить (с confirm если удаляемый контейнер непуст).

Это **не отдельная система** — те же вызовы `reorderNode` / `moveNodeAcross` / `removeNode`, только без drag event.

---

## 3. Новые doc-ops — сигнатуры (не impl)

Существующих ops в `form-document-ops.js` достаточно для базового случая. Для удобства конструктора добавляем две специализированные функции, которые impl-фаза разместит там же:

```ts
/**
 * moveNode — семантический sugar над moveNodeAcross: перемещает узел с
 * fromPath (абсолютный путь к узлу: containerPath + [index]) в toPath.
 * Используется конструктором для cross-container drag.
 * fromPath и toPath — абсолютные пути узлов (не контейнеров).
 *
 * Реализация: fromContainer = fromPath.slice(0,-1), fromIndex = fromPath.at(-1),
 *             toContainer   = toPath.slice(0,-1),   toIndex   = toPath.at(-1).
 * Затем вызывает moveNodeAcross.
 */
export function moveNode(
  doc: SurfaceDocument,
  fromPath: PathSegment[],          // абсолютный path к узлу (включает его index)
  toPath: PathSegment[],            // целевое место (index = позиция ВСТАВКИ)
  fromTab?: number,
  toTab?: number,
): SurfaceDocument;

/**
 * insertAt — alias insertNode с обязательным index (для drag в конкретный слот).
 * Отличие от insertNode: index обязателен и выходит за bounds → clamp к длине.
 */
export function insertAt(
  doc: SurfaceDocument,
  containerPath: PathSegment[],
  node: SurfaceNode,
  index: number,
  tabIndex?: number,
): SurfaceDocument;
```

**Примечание:** `moveNodeAcross` уже корректно обрабатывает adjustPathAfterRemoval — `moveNode` просто делает вызов удобнее для конструктора. Не дублировать логику.

---

## 4. Layout: четыре зоны

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [Палитра 240px]  │      [Канвас — дерево]       │  [Живое превью 380px]   │
│                   │                               │                          │
│  Поиск/фильтр     │  ┌── section ──────────────┐ │  SurfaceRenderer         │
│  ─────────────    │  │  ↳ DropSlot             │ │  (идентично runtime)     │
│  Раскладка:       │  │  ┌─ columns(2) ────────┐│ │                          │
│  [§ Секция]       │  │  │  DropSlot           ││ │                          │
│  [⊞ Колонки]      │  │  │  [field: amount]    ││ │                          │
│  [⊟ Вкладки]      │  │  │  DropSlot           ││ │                          │
│  [─ Разделитель]  │  │  └─────────────────────┘│ │                          │
│  ─────────────    │  │  DropSlot               │ │                          │
│  Данные:          │  └─────────────────────────┘ │                          │
│  [Ф Поля схемы]   │  DropSlot (корень)            │                          │
│  ─────────────    │                               │                          │
│  Аналитика:       │  [Ошибки авторинга]           │                          │
│  [📊 График]      │                               │  [Инспектор 280px]       │
│  [# Метрика]      │                               │  Свойства выбранного     │
│  ─────────────    │                               │  узла из editorProps     │
│  Действия:        │                               │  [Сохранить]             │
│  [▶ Действие]     │                               │  [Undo Ctrl+Z]           │
│  ─────────────    │                               │  [Redo Ctrl+Y]           │
│  Код:             │                               │                          │
│  [<> Код-виджет]  │                               │                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Отличия от текущего:**
- Превью side-by-side (не в `<details>`), синхронизировано с каждым изменением документа.
- Инспектор перемещён в правую колонку вместе с кнопками Undo/Redo/Сохранить.
- Канвас — дерево с вложенностью, не плоский список.
- Палитра с иконками, группами из реестра (`registry.byPaletteGroup()`), с поиском.

### 4.1 Палитра из реестра (не хардкод)

```jsx
// Конструктор читает реестр напрямую:
const groups = registry.byPaletteGroup();
// → { 'Раскладка': [section, columns, tabs, divider], 'Данные': [...], ... }
// Иконка и метка — из descriptor.icon и descriptor.label
// PaletteGroup_LABELS захардкожены НЕ в коде — только порядок групп (константа ORDER)
```

`GROUP_LABELS` в `FormDesigner.jsx` (хардкод `{ layout: 'Раскладка', data: 'Данные', code: 'Код (песочница)' }`) удаляется. Метки приходят из `descriptor.paletteGroup` (строка из реестра).

### 4.2 Визуальные блоки CanvasNode v2

Каждый узел канваса показывает:
- `descriptor.icon` (SVG inline / CSS class) — тип блока визуально
- `descriptor.label` — тип человеко-читаемо
- `node.label || node.title` — пользовательская метка
- `node.fieldKey` если data-bound
- Кнопки: Дублировать, Удалить, Свернуть/развернуть (для контейнеров)
- Индикатор broken-binding (красная рамка) — из `validation.brokenKeys`
- Индикатор Floor-2 (badge «код») — из `descriptor.floor === 2`

Контейнерные узлы (`section`, `columns`, `tabs`) рендерят своих детей рекурсивно с отступом. `columns` показывает N вертикальных полос по `node.count`. `tabs` показывает переключатель вкладок.

### 4.3 Живое превью (SurfaceRenderer)

```jsx
<SurfaceRenderer document={doc} fields={fields} registry={registry} theme="light" />
```

`SurfaceRenderer` — impl T-0543 фаза 1. До его готовности конструктор использует `FormDocumentRenderer` через `coerceToSurface` (обратная совместимость). Превью всегда видимо, не скрыто в `<details>`.

Превью — только чтение (`readOnly` prop). Оно не должно быть интерактивным в режиме авторинга (нет onChange, нет submit).

---

## 5. Undo/Redo — модель истории

### 5.1 HistoryStack (объект состояния)

```ts
interface HistoryStack {
  past: SurfaceDocument[];    // предыдущие состояния (ограничено MAX_HISTORY=50)
  present: SurfaceDocument;   // текущий документ
  future: SurfaceDocument[];  // для redo
}
```

### 5.2 Операции над стеком

```ts
function pushHistory(stack: HistoryStack, next: SurfaceDocument): HistoryStack {
  // past = [...stack.past.slice(-(MAX_HISTORY-1)), stack.present]
  // present = next
  // future = []
}

function undo(stack: HistoryStack): HistoryStack | null {
  // если past.length === 0 → null (нет изменений)
  // present → future[0], past.pop() → present
}

function redo(stack: HistoryStack): HistoryStack | null {
  // если future.length === 0 → null
  // present → past, future.shift() → present
}
```

### 5.3 Интеграция в конструктор

- `useState<HistoryStack>` — единственный источник `doc` = `stack.present`.
- Каждый вызов doc-op → `pushHistory(stack, newDoc)`.
- `Ctrl+Z` / `Cmd+Z` → `undo(stack)`.
- `Ctrl+Y` / `Cmd+Shift+Z` → `redo(stack)`.
- `canUndo = stack.past.length > 0`, `canRedo = stack.future.length > 0` → кнопки disabled/enabled.

### 5.4 Граница с T-0533 (guard несохранённых правок)

`stack.past.length > 0 && saveState !== 'saved'` — признак «есть несохранённые изменения». T-0533 вешает `beforeunload`-предупреждение и блокирует навигацию. Конструктор выставляет этот флаг через `isDirty` prop / context — T-0533 его читает.

---

## 6. Мультивыбор

### 6.1 CanvasState.selectedNodes

```ts
interface CanvasState {
  selectedNodes: Set<string>;       // node.id или path-key (containerPath + ':' + index)
  focusedPath: PathSegment[] | null; // путь для клавиатурной навигации
}
```

### 6.2 UX мультивыбора

- `Click` — выбор одного узла (snb old selection).
- `Shift+Click` — добавить к выделению (range внутри одного контейнера).
- `Ctrl/Cmd+Click` — toggle одного узла в выделение.
- `Ctrl+A` — выбрать все в текущем контейнере (где фокус клавиатуры).

### 6.3 Операции над мультивыбором

- **Удалить выделенное** (`Delete`/`Backspace`) — удалить все выбранные узлы (от конца к началу чтобы не сдвигать индексы).
- **Дублировать** — скопировать все выбранные узлы после последнего выбранного.
- **Инспектор** при мультивыборе — показывает только общие поля (напр. `mode`), не тип-специфичные.

---

## 7. Инспектор v2 — из editorProps реестра

Текущий инспектор — ручные `if (node.type === 'columns')` ветки. V2 читает `descriptor.editorProps`:

```ts
// descriptor.editorProps: PropDescriptor[]
// PropDescriptor.control → компонент инспектора
const descriptor = registry.get(node.type);
// render: descriptor.editorProps.map(prop => <PropControl prop={prop} node={node} onPatch={...} />)
```

`PropControl` — общий компонент, dispatch по `prop.control`:
- `'text'` → `<input type="text">`
- `'select'` → `<Select options={prop.options}>` (или с resolver для field-picker)
- `'toggle'` → `<Switch>`
- `'number'` → `<input type="number">`
- `'field-picker'` → выпадающий список полей живой схемы (фильтр по contractKinds дескриптора)
- `'source-config'` → панель настройки `QuerySource` / `AggregateSource`
- `'outcome-picker'` → выпадающий E16-исход
- `'code'` → textarea для Floor-2

Нет больше `if (node.type === 'text')`, `if (node.type === 'columns')` — только обход `editorProps`. При добавлении нового виджета инспектор работает автоматически через реестр.

---

## 8. Как блок берёт данные из WidgetDescriptor

Полная цепочка:

```
registry.get(node.type)
  → descriptor.icon          → CanvasNode v2: иконка
  → descriptor.label         → CanvasNode v2: тип
  → descriptor.paletteGroup  → Palette: группировка (не хардкод)
  → descriptor.editorProps   → Inspector v2: поля настройки
  → descriptor.floor         → Badge «код» для Floor-2
  → descriptor.contractKinds → field-picker: фильтр совместимых полей
  → descriptor.render        → SurfaceRenderer (превью)
  → descriptor.validate?     → validateSurface: дополнительные проверки
```

---

## 9. DropTarget — полная структура

```ts
interface DropTarget {
  /** Путь к контейнеру (section/columns/tabs/root=[]) */
  containerPath: PathSegment[];
  /** Для tabs: номер активной вкладки */
  tabIndex?: number;
  /** Позиция вставки (0..children.length); undefined = конец */
  insertAt?: number;
}

// PathSegment из form-document-ops.js:
type PathSegment = number | { tab: number; index: number };
```

`DropSlot` компонент рендерится между узлами и принимает `onDragOver` / `onDrop` с конкретным `DropTarget`. Конструктор строит список `DropTarget[]` для текущего видимого дерева — они не хранятся в документе, только в UI-состоянии.

---

## 10. Координация рисков

### T-0529 — Клавиатурная доступность дизайнера

- Все drag-операции имеют keyboard-фоллбэк (§2.3 выше).
- `role="tree"` / `role="treeitem"` на канвасе для screen readers.
- `aria-label` на каждом блоке = `descriptor.label + ': ' + (node.label || node.fieldKey || 'без метки')`.
- Drag-иконка (`draggable`) имеет `aria-describedby` с инструкцией по клавишам.
- **Риск:** если T-0529 хочет отдельную keyboard-only модальную сортировку (`<dialog>`) — нужно уточнить; текущий дизайн даёт inline Alt+Up/Down без модалки. Если T-0529 настаивает на модалке — impl должен будет добавить. Пока impl идёт по Alt+Up/Down.

### T-0533 — Guard несохранённых правок

- Конструктор выставляет `isDirty = stack.past.length > 0 && saveState.status !== 'saved'`.
- T-0533 читает этот флаг через context или prop и вешает предупреждение на уход со страницы.
- При успешном сохранении (`saveState.status === 'saved'`) → `isDirty` сбрасывается.
- **Undo до начального состояния** (`stack.past.length === 0`) → `isDirty = false`.

---

## 11. Обратная совместимость

- `FormDesigner.jsx` переписывается, но публичный API (props `initialDocument`, `initialFields`) сохраняется.
- `form-document-ops.js` расширяется двумя функциями (`moveNode`, `insertAt`) — без изменений существующих.
- До готовности `SurfaceRenderer` (T-0543 impl фаза 1) превью работает через `FormDocumentRenderer(coerceToSurface(doc))`.
- Тесты `form-document-ops.test.js` продолжают проходить — новые функции добавляют тесты рядом.
