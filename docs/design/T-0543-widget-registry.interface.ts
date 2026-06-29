/**
 * T-0543 — Widget Registry + Surface Document interface contract (DESIGN ONLY).
 *
 * ЧИСТЫЕ ТИПЫ. Никакой реализации рендера / реестра здесь нет — это контракт,
 * который impl-фаза (фаза 1, см. ADR §9) обязана реализовать в
 * `web/src/forms/widget-registry.js` + `surface-document.js` + `SurfaceRenderer.jsx`.
 *
 * ЯДРО РЕШЕНИЯ: один декларативный реестр дескрипторов виджетов заменяет хардкод
 * (PALETTE + WIDGET_COMPAT + switch(node.type) в FormDocumentRenderer + ветки
 * field-renderer + серверный binding-contract-catalog как отдельный источник).
 * Рендерер, конструктор (палитра+инспектор) и серверный валидатор читают ОДИН
 * реестр. Новый виджет = ОДНА запись реестра (FF-REG-1).
 *
 * Сегодняшние 10 узлов (section/columns/tabs/divider/text/field/table/readout/
 * relation/custom) становятся 10 дескрипторами 1-в-1 (поведенческий no-op,
 * FF-COERCE-1). list/chart/metric/action — новые дескрипторы для страниц.
 */

/* ===========================================================================
 * 1. Surface document (обобщение form-document v1 → v2)
 *    Зеркалит T-0543-surface-document.schema.json. Форма = частный случай.
 * ======================================================================== */

export type SurfaceKind = 'record-form' | 'step-form' | 'page';

/** Контекст записи (record/step-form); для page опционален. */
export interface SurfaceSource {
  applicationId?: string;
  registryDefId?: string;
}

/** Идентичность и контекст поверхности. */
export interface SurfaceMeta {
  kind: SurfaceKind;
  /** record-form/step-form: обязателен; page: опционален. */
  source?: SurfaceSource;
  /** ТОЛЬКО step-form. */
  step?: { processKey: string; step: string };
  /** ТОЛЬКО page: URL-safe идентичность standalone-страницы (E-NAV-IA). */
  slug?: string;
  title?: string;
}

/** Закрытый набор типов узлов (R-CLOSED). Должен совпадать с WidgetId. */
export type NodeType =
  | 'section' | 'columns' | 'tabs' | 'divider' | 'text'
  | 'field' | 'table' | 'readout' | 'relation'
  | 'list' | 'chart' | 'metric' | 'action'
  | 'custom';

/** Per-step режим узла (form-document-format §5). */
export type NodeMode = 'editable' | 'readonly' | 'hidden' | 'required';

/**
 * Узел дерева. Data-bound узлы несут ТОЛЬКО ключи привязки (fieldKey/subKey/
 * displayField/источниковые columns/measure/groupBy) — тип/опции/виджет-
 * совместимость резолвятся из ЖИВОЙ схемы при рендере (named-binding, R-NB).
 * Поля per-type — см. JSON Schema; здесь индексная сигнатура для расширяемости.
 */
export interface SurfaceNode {
  type: NodeType;
  id?: string;
  label?: string;
  title?: string;
  mode?: NodeMode;
  /** layout (section/columns). */
  children?: SurfaceNode[];
  /** tabs. */
  tabs?: Array<{ title?: string; children: SurfaceNode[] }>;
  /** columns. */
  count?: number;
  /** text. */
  content?: string;
  /** data-bound (field/table/readout/relation): named-binding ключ. */
  fieldKey?: string;
  /** field/relation/column: presentation-override (совместимость — против живого типа). */
  widget?: string;
  /** relation: канал 3 named-binding. */
  displayField?: string;
  /** table: канал 2 named-binding. */
  columns?: Array<{ subKey: string; widget?: string; label?: string }>;
  /** list/chart/metric: объявленный источник (query/aggregate). */
  dataSource?: QuerySource | AggregateSource;
  /** chart: тип визуализации. */
  viz?: 'bar' | 'line' | 'pie' | 'number';
  /** action: семантику владеет E16; узел несёт ТОЛЬКО ссылку. */
  outcomeRef?: string;
  triggerRef?: string;
  /** custom (Floor-2): код-escape в sandbox. */
  componentId?: string;
  code?: string;
  flagged?: boolean;
  bindings?: string[];
}

/** Полный surface-документ (v2). */
export interface SurfaceDocument {
  schemaVersion: 2;
  surface: SurfaceMeta;
  root: SurfaceNode;
}

/* ===========================================================================
 * 2. Источники данных (ключ к страницам)
 * ======================================================================== */

export type DataSourceKind = 'current-record' | 'query' | 'aggregate' | 'none';

/** list (query): читает ДРУГИЕ записи. Видимость — read-грант (T-0021). */
export interface QuerySource {
  kind: 'query';
  applicationId: string;
  filter?: Record<string, unknown>;
  sort?: Array<{ fieldKey: string; dir?: 'asc' | 'desc' }>;
  /** Каждый fieldKey проверяется против живой схемы (R-SRC-BIND / DepViolation). */
  columns: Array<{ fieldKey: string; label?: string; widget?: string }>;
}

/** chart/metric (aggregate): Floor-1 агрегат (поглощает report-page T-0121). */
export interface AggregateSource {
  kind: 'aggregate';
  applicationId: string;
  groupBy?: string;
  measure: string;
  op: 'count' | 'sum' | 'avg' | 'min' | 'max';
}

/* ===========================================================================
 * 3. Binding contracts (источник: server binding-contract-catalog.ts PD-18)
 *    Реестр ПОТРЕБЛЯЕТ каталог, не дублирует его.
 * ======================================================================== */

export type BindingContractKind =
  | 'scalar' | 'enum' | 'relation' | 'collection' | 'date-range'
  | 'money' | 'multi-select' | 'person' | 'file' | 'rollup' | 'matrix-lookup';

/* ===========================================================================
 * 4. WidgetDescriptor — ОДНА запись реестра на блок
 * ======================================================================== */

export type WidgetId = NodeType;

export type WidgetClass =
  | 'layout'          // section/columns/tabs/divider
  | 'presentational'  // text
  | 'data-bound'      // field/table/readout/relation (current-record)
  | 'list'            // list (query)
  | 'viz'             // chart/metric (aggregate)
  | 'action'          // action (ссылка на E16)
  | 'custom';         // custom (Floor-2 sandbox)

/** Floor: 1 = декларативный inline; 2 = sandbox-iframe код-escape. */
export type WidgetFloor = 1 | 2;

/** Что инспектор конструктора показывает для узла. */
export interface PropDescriptor {
  /** ключ свойства на узле (e.g. 'label', 'widget', 'mode', 'count', 'dataSource'). */
  key: string;
  /** контрол инспектора. */
  control: 'text' | 'select' | 'toggle' | 'number' | 'field-picker'
    | 'source-config' | 'outcome-picker' | 'code';
  label: string;
  /** для select-контролов: варианты (или функция, резолвящая их из живой схемы). */
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
}

/** Нарушение авторинг-валидации (typed). */
export interface Violation {
  code: string;     // 'V-NODE' | 'V-KEY' | 'V-CONTRACT' | 'V-WIDGET' | 'V-SUBKEY' | 'DEP-VIOLATION' | ...
  path: string;
  message: string;
}

/** Живой контекст рендера (impl детализирует; здесь — контракт). */
export interface RenderCtx {
  /** indexSchema(fields) — живой вид схемы (byKey/subByKey). */
  schema: { byKey: Map<string, unknown>; subByKey: Map<string, Map<string, unknown>> };
  values?: Record<string, unknown>;
  onChange?: (key: string, value: unknown) => void;
  onTableCellChange?: (fieldKey: string, rowIndex: number, subKey: string, value: unknown) => void;
  errors?: Record<string, string>;
  /** query/aggregate-источники резолвятся через грант-гейтнутый read-API (фаза 3). */
  resolveSource?: (src: QuerySource | AggregateSource) => Promise<unknown>;
  /** дочерний рендер (для layout-узлов): делегирует обратно реестру. */
  renderNode: (node: SurfaceNode) => unknown; // ReactNode
}

/** Контекст авторинг-валидации. */
export interface AuthoringCtx {
  schema: { byKey: Map<string, unknown>; subByKey: Map<string, Map<string, unknown>> };
  /** разрешить контракт поля из живой схемы (resolveFieldContract). */
  resolveFieldContract: (field: unknown) => { contractKind: BindingContractKind };
}

/**
 * WidgetDescriptor — единственная запись на блок. Метаданные (id/class/floor/
 * dataSource/contractKinds/paletteGroup/icon/label/editorProps) — ОБЩИЙ манифест
 * (клиент+сервер). render/validate — поведение (render клиентское). Один id ⇒
 * серверная валидация и клиентский рендер согласованы по построению (R-MANIFEST).
 */
export interface WidgetDescriptor {
  id: WidgetId;
  class: WidgetClass;
  floor: WidgetFloor;
  dataSource: DataSourceKind;
  /** для data-bound: какие binding-contracts принимает (из каталога PD-18). */
  contractKinds?: BindingContractKind[];
  paletteGroup: string; // 'Раскладка'|'Данные'|'Списки'|'Аналитика'|'Действия'|'Контент'|'Код'
  icon: string;
  label: string;
  /** что инспектор показывает для узла. */
  editorProps: PropDescriptor[];

  /**
   * КЛИЕНТ: единственное место отрисовки этого блока. Замещает один case в
   * сегодняшнем FormNode switch. layout-узлы делегируют детям через ctx.renderNode.
   * Возвращает ReactNode (тип unknown, чтобы не тянуть React в чистый контракт).
   */
  render(node: SurfaceNode, ctx: RenderCtx): unknown;

  /**
   * Авторинг-время: дополнительные проверки узла поверх общего обхода
   * (named-binding/contract/widget/subKey). Возвращает [] если узел валиден.
   */
  validate?(node: SurfaceNode, ctx: AuthoringCtx): Violation[];
}

/* ===========================================================================
 * 5. WidgetRegistry — реестр дескрипторов
 *    Единый, читаемый рендерером, конструктором и валидатором.
 * ======================================================================== */

/** Манифест метаданных (без render) — то, что сервер тоже может прочитать. */
export type WidgetManifestEntry = Omit<WidgetDescriptor, 'render' | 'validate'>;

export interface WidgetRegistry {
  /** Зарегистрировать дескриптор. Дубликат id → ошибка (закрытость). */
  register(descriptor: WidgetDescriptor): void;
  /** Получить дескриптор по id; неизвестный id → undefined (R-CLOSED: caller обязан обработать). */
  get(id: WidgetId): WidgetDescriptor | undefined;
  /** Все дескрипторы (для палитры/инспектора). */
  list(): WidgetDescriptor[];
  /** Дескрипторы, сгруппированные по paletteGroup (для палитры конструктора). */
  byPaletteGroup(): Record<string, WidgetDescriptor[]>;
  /** True iff id зарегистрирован (валидатор: closed-by-default). */
  has(id: string): id is WidgetId;
  /** Манифест метаданных (сериализуемый; общий клиент↔сервер источник). */
  manifest(): WidgetManifestEntry[];
}

/* ===========================================================================
 * 6. Совместимость v1 → v2 + единый рендер/валидатор (контракт фасадов)
 * ======================================================================== */

/** v1 form-document (для типизации коэрсии). */
export interface FormDocumentV1 {
  schemaVersion: 1;
  source?: SurfaceSource;
  step?: { processKey: string; step: string };
  root: SurfaceNode;
}

/**
 * Авто-коэрсия v1 → v2 (FF-COERCE-1). Детерминированная, чистая. v2 → as-is.
 * v1 без step → record-form; с step → step-form. root байт-стабилен.
 */
export type CoerceToSurface = (doc: FormDocumentV1 | SurfaceDocument) => SurfaceDocument;

/**
 * Единый авторинг-валидатор: обходит дерево, для каждого узла проверяет
 * R-CLOSED (registry.has) + named-binding + descriptor.validate?(). Заменяет
 * сегодняшний validateDocument switch-набор. Возвращает violations + brokenKeys.
 */
export type ValidateSurface = (
  doc: SurfaceDocument,
  fields: unknown[],
  registry: WidgetRegistry,
) => { ok: boolean; violations: Violation[]; brokenKeys: string[] };

/**
 * Контракт совместимости публичной поверхности form-document.js (ADR §10):
 * PALETTE/WIDGET_COMPAT становятся ПРОИЗВОДНЫМИ от реестра (вычисляются из
 * дескрипторов), но экспорт-форма прежняя — импортёры не ломаются.
 */
export type PaletteFromRegistry = (registry: WidgetRegistry) => Record<WidgetId, {
  type: WidgetId; floorClass: 'a' | 'b'; data: boolean;
  contract: BindingContractKind | null; paletteGroup: string;
  label: string; summary?: string;
}>;
