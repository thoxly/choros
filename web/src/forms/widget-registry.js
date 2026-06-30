/**
 * web/src/forms/widget-registry.js  (T-0544 · E-FORMS — impl of T-0543 reg)
 *
 * THE ONE DECLARATIVE WIDGET REGISTRY.
 *
 * This is the impl of the T-0543 contract (docs/design/T-0543-widget-registry
 * .interface.ts). It replaces the hardcoded triad — PALETTE + WIDGET_COMPAT +
 * the `switch (node.type)` in FormDocumentRenderer — with ONE declarative map
 * of widget descriptors. The renderer, the builder (palette + inspector) and the
 * authoring validator all read THIS registry instead of a switch / a literal.
 *
 * A new building block = ONE registry entry (FF-REG-1). Adding `list` / `chart`
 * / `metric` / `action` later is a single descriptor each — no edit to dispatch,
 * palette or compatibility matrix.
 *
 * PURE / REACT-FREE METADATA. This module is the manifest half (id / class /
 * floor / dataSource / contractKinds / paletteGroup / icon / label /
 * editorProps) — the part the SERVER could also read (R-MANIFEST) and the part
 * the palette + inspector need without pulling React. The CLIENT render function
 * (`render(node, ctx) => ReactNode`) is the only React-coupled piece; it is
 * ATTACHED by the renderer at module-load via `registerRender(id, fn)` so this
 * file stays React-free and unit-testable in node. One `id` keys both halves, so
 * metadata and render are consistent by construction.
 *
 * BEHAVIORAL NO-OP (FF-COERCE-1 / round-trip): the 10 existing node types
 * (section/columns/tabs/divider/text/field/table/readout/relation/custom) become
 * 10 descriptors 1-to-1. Render behavior, palette grouping, and inspector fields
 * are identical to the pre-registry hardcode — proven by the unchanged
 * FormDocumentRenderer + form-document tests, and by widget-registry.test.js.
 */

// ---------------------------------------------------------------------------
// Descriptor metadata for the 10 existing node types (1-to-1 with the old
// PALETTE / WIDGET_COMPAT / FormNode switch).
//
// Fields mirror WidgetDescriptor (T-0543-widget-registry.interface.ts) minus
// `render` (attached at runtime by the renderer) and `validate` (the existing
// validateDocument owns authoring checks; descriptors may add `validate` later).
//
// `paletteGroup` carries the human-facing Russian group label DIRECTLY (the ADR
// §4.1 decision: labels come from the descriptor, not a hardcoded GROUP_LABELS
// map in the component). PALETTE_GROUP_ORDER fixes display order.
// ---------------------------------------------------------------------------

export const PALETTE_GROUP_ORDER = Object.freeze([
  'Раскладка', 'Данные', 'Списки', 'Аналитика', 'Действия', 'Контент', 'Код',
]);

/**
 * Allowed presentation widgets per live-schema field type. Single source for the
 * builder's widget picker + the authoring validator. (Was WIDGET_COMPAT in
 * form-document.js; that export is now DERIVED from this.)
 */
export const WIDGET_COMPAT_TABLE = Object.freeze({
  string: ['text', 'textarea', 'select'],
  text: ['text', 'textarea', 'select'],
  textarea: ['textarea', 'text'],
  number: ['number', 'money'],
  integer: ['number', 'money'],
  boolean: ['switch', 'checkbox'],
  select: ['select', 'radio'],
  enum: ['select', 'radio'],
  date: ['date', 'date-range'],
  relation: ['record-picker'],
  collection: ['table'],
  computed: ['readout'],
});

/**
 * Inspector property descriptors per widget (T-0543 PropDescriptor). The
 * inspector renders these instead of `if (node.type === 'text')` branches.
 * `widget-only` props (the field widget picker) resolve their options from the
 * LIVE schema at render time, so they carry `control: 'select'` + a marker.
 */
const EDITOR_PROPS = {
  // layout
  section: [{ key: 'label', control: 'text', label: 'Метка' }],
  columns: [
    { key: 'label', control: 'text', label: 'Метка' },
    {
      key: 'count', control: 'select', label: 'Колонок',
      options: [{ value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }],
    },
  ],
  tabs: [{ key: 'label', control: 'text', label: 'Метка' }],
  divider: [{ key: 'label', control: 'text', label: 'Метка' }],
  // presentational
  text: [
    { key: 'label', control: 'text', label: 'Метка' },
    { key: 'content', control: 'text', label: 'Текст', multiline: true },
  ],
  // data-bound
  field: [
    { key: 'label', control: 'text', label: 'Метка' },
    { key: 'widget', control: 'select', label: 'Виджет', fromSchemaWidgets: true },
    { key: 'mode', control: 'mode', label: 'Режим на шаге' },
  ],
  table: [
    { key: 'label', control: 'text', label: 'Метка' },
    { key: 'mode', control: 'mode', label: 'Режим на шаге' },
  ],
  readout: [{ key: 'label', control: 'text', label: 'Метка' }],
  relation: [
    { key: 'label', control: 'text', label: 'Метка' },
    { key: 'mode', control: 'mode', label: 'Режим на шаге' },
  ],
  // custom (Floor-2)
  custom: [{ key: 'label', control: 'text', label: 'Метка' }],
};

/**
 * The 10 descriptors. icon = a short emoji/glyph token (consumed by CanvasNode
 * v2 + the palette). NO render here — attached by the renderer (registerRender).
 */
const DESCRIPTOR_META = [
  {
    id: 'section', class: 'layout', floor: 1, dataSource: 'none',
    paletteGroup: 'Раскладка', icon: '▤', label: 'Секция',
    summary: 'Озаглавленная группа полей.', isContainer: true,
  },
  {
    id: 'columns', class: 'layout', floor: 1, dataSource: 'none',
    paletteGroup: 'Раскладка', icon: '▥', label: 'Колонки',
    summary: 'Несколько колонок в ряд (2–4).', isContainer: true,
  },
  {
    id: 'tabs', class: 'layout', floor: 1, dataSource: 'none',
    paletteGroup: 'Раскладка', icon: '▦', label: 'Вкладки',
    summary: 'Разбить форму на вкладки.', isContainer: true, isTabs: true,
  },
  {
    id: 'divider', class: 'layout', floor: 1, dataSource: 'none',
    paletteGroup: 'Раскладка', icon: '―', label: 'Разделитель',
    summary: 'Горизонтальная линия.',
  },
  {
    id: 'text', class: 'presentational', floor: 1, dataSource: 'none',
    paletteGroup: 'Раскладка', icon: '¶', label: 'Текст',
    summary: 'Статичная подсказка/заголовок.',
  },
  {
    id: 'field', class: 'data-bound', floor: 1, dataSource: 'current-record',
    contractKinds: ['scalar', 'enum'],
    paletteGroup: 'Данные', icon: '🔤', label: 'Поле',
    summary: 'Скалярное поле (текст, число, дата, список).', data: true, contract: 'scalar',
  },
  {
    id: 'table', class: 'data-bound', floor: 1, dataSource: 'current-record',
    contractKinds: ['collection'],
    paletteGroup: 'Данные', icon: '▭', label: 'Таблица',
    summary: 'Позиции (один-ко-многим, line-items).', data: true, contract: 'collection',
  },
  {
    id: 'readout', class: 'data-bound', floor: 1, dataSource: 'current-record',
    contractKinds: ['rollup'],
    paletteGroup: 'Данные', icon: 'Σ', label: 'Итог',
    summary: 'Только чтение: сумма/количество (rollup).', data: true, contract: 'rollup',
  },
  {
    id: 'relation', class: 'data-bound', floor: 1, dataSource: 'current-record',
    contractKinds: ['relation'],
    paletteGroup: 'Данные', icon: '🔗', label: 'Связь',
    summary: 'Ссылка на запись другого приложения.', data: true, contract: 'relation',
  },
  {
    id: 'custom', class: 'custom', floor: 2, dataSource: 'none',
    paletteGroup: 'Код', icon: '〈〉', label: 'Код-виджет',
    summary: 'Кастомный виджет в песочнице (редко, флаг).', floorClass: 'b',
  },
];

// ---------------------------------------------------------------------------
// The registry instance (Map<id, descriptor>).
// ---------------------------------------------------------------------------

const _registry = new Map();

/** Register a descriptor. Duplicate id → throws (closed-by-default). */
export function register(descriptor) {
  if (!descriptor || typeof descriptor.id !== 'string') {
    throw new Error('widget-registry: descriptor must carry a string id');
  }
  if (_registry.has(descriptor.id)) {
    throw new Error(`widget-registry: duplicate widget id «${descriptor.id}»`);
  }
  _registry.set(descriptor.id, descriptor);
}

// Seed the 10 built-in descriptors at module load.
for (const meta of DESCRIPTOR_META) {
  register({ ...meta, editorProps: EDITOR_PROPS[meta.id] || [], render: null });
}

/** Get a descriptor by id; unknown id → undefined (R-CLOSED: caller handles). */
export function getWidget(id) {
  return _registry.get(id);
}

/** True iff `id` is a registered widget (validator: closed-by-default). */
export function hasWidget(id) {
  return _registry.has(id);
}

/** All descriptors (palette/inspector). */
export function listWidgets() {
  return Array.from(_registry.values());
}

/**
 * Descriptors grouped by paletteGroup, in PALETTE_GROUP_ORDER. Empty groups are
 * omitted. (Replaces paletteByGroup + the GROUP_LABELS hardcode.)
 */
export function byPaletteGroup() {
  const out = {};
  for (const group of PALETTE_GROUP_ORDER) out[group] = [];
  for (const d of _registry.values()) {
    if (!out[d.paletteGroup]) out[d.paletteGroup] = [];
    out[d.paletteGroup].push(d);
  }
  // drop empty groups, preserve order
  const ordered = {};
  for (const group of PALETTE_GROUP_ORDER) {
    if (out[group] && out[group].length) ordered[group] = out[group];
  }
  // any group not in ORDER (future) appended after
  for (const [group, list] of Object.entries(out)) {
    if (!ordered[group] && list.length) ordered[group] = list;
  }
  return ordered;
}

/** Serializable metadata manifest (no render) — the shared client↔server view. */
export function manifest() {
  return Array.from(_registry.values()).map((d) => {
    const { render, validate, ...rest } = d; // eslint-disable-line no-unused-vars
    return rest;
  });
}

/**
 * Attach the CLIENT render function for a widget id. Called by the renderer at
 * module load. Keeps THIS module React-free while one `id` still keys render.
 */
export function registerRender(id, fn) {
  const d = _registry.get(id);
  if (!d) throw new Error(`widget-registry: cannot attach render for unknown id «${id}»`);
  d.render = fn;
}

// ---------------------------------------------------------------------------
// Compatibility helpers (DERIVED — these power form-document.js's preserved
// PALETTE / WIDGET_COMPAT exports so importers don't break, ADR §10).
// ---------------------------------------------------------------------------

/**
 * Derive a PALETTE-shaped object (the old form-document.js literal) from the
 * registry. Same keys/shape as before (type/floorClass/data/contract/
 * paletteGroup/label/summary) so every importer keeps working, but there is now
 * ONE source (the registry), not a parallel literal (FF-REG-1).
 *
 * NOTE: legacy paletteGroup was 'layout'|'data'|'code'; importers (paletteByGroup)
 * keyed on those. We preserve the legacy group KEY here for byte-compat of the
 * old export, mapping the descriptor's human group → legacy key.
 */
const LEGACY_GROUP_KEY = {
  Раскладка: 'layout', Данные: 'data', Код: 'code',
  Списки: 'data', Аналитика: 'data', Действия: 'data', Контент: 'layout',
};

export function paletteFromRegistry() {
  const out = {};
  for (const d of _registry.values()) {
    out[d.id] = {
      type: d.id,
      floorClass: d.floor === 2 ? 'b' : 'a',
      data: d.data === true,
      contract: d.contract || null,
      paletteGroup: LEGACY_GROUP_KEY[d.paletteGroup] || 'layout',
      label: d.label,
      summary: d.summary,
    };
  }
  return out;
}
