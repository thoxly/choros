/**
 * src/core/floor-boundary.ts — T-0519 (D7-5 · реализация спеки T-0402)
 *
 * МАШИННО-ПРОВЕРЯЕМАЯ ГРАНИЦА Floor-1 ↔ Floor-2 + контентный детектор.
 *
 * Pure function — no I/O, no DB, no network, no filesystem, no env reads.
 * Зеркалит purity-дисциплину authoring-floor-classifier.ts (T-0074),
 * binding-contract-catalog.ts (T-0399) и floor2-renderer.ts (T-0076).
 *
 * --- ЧТО ЭТО ЗАКРЫВАЕТ (spec §1 / §2) ---
 * Лексический классификатор T-0074 (classifyAuthoringFloor) ДОВЕРЯЕТ
 * самозаявленному `kind` и НЕ инспектирует содержимое диффа. Агент, отдавший
 * `kind:"relabel_field"` для диффа, протаскивающего custom-узел / новое поле /
 * непустой reactSource, прошёл бы как Floor-1. Этот модуль собирает ДВА слоя
 * (лексический + контентный) в один авто-гейт.
 *
 * --- ПРАВИЛО (spec §3.2 / FR-2) ---
 *   Floor-1 ⟺ R-1 ∧ R-2 ∧ R-3 ∧ R-4, иначе Floor-2.
 *   floor = max(lexicalFloor(kind), contentFloor(changedKeys, doc, descriptor, schema))
 *   — этаж монотонно растёт; контент ТОЛЬКО поднимает (FR-3). Один Floor-2-сигнал
 *   → Floor-2 (fail-up, симметрично default-DENY ADR §9).
 *
 *   R-1 (лексика)              — op.kind ∈ FLOOR1_EDIT_KINDS (T-0074); unknown → Floor-2.
 *   R-2 (whitelist ключей)     — каждый op.changedKeys ∈ FLOOR1_DECLARATIVE_WHITELIST.
 *   R-3 (нет код-сигнала)      — !hasCodeSignal (§3.4 контентный детектор, структурный).
 *   R-4 (named-binding целостн)— KEY_SET(op.doc) ⊆ ключи живой schema (record_schema),
 *                                три канала: fieldKey | table.columns[].subKey |
 *                                relation.displayField.
 *
 * --- ОДИН CONTROL-PLANE (spec §8 / FB-8 / NF-1) ---
 *   Потребляет FLOOR1_EDIT_KINDS / FLOOR2_EDIT_KINDS (T-0074),
 *   делегирует Floor-2 под-классификацию validateFloor2Descriptor (T-0076).
 *   НЕ объявляет параллельный словарь видов-правок и НЕ второй sandbox-полиси.
 *   FLOOR1_DOC_NODE_TYPES здесь — закрытый whitelist типов узлов декларативного
 *   форма-документа (§3.3), машинно-читаемая граница (ReadonlySet, паттерн AFC-5).
 *
 * Источник: docs/specs/floor-boundary.spec.md (§3/§4) +
 *           docs/specs/floor-boundary.spec.contract.json (FB-1..FB-8, FR-1..FR-10).
 */

import {
  FLOOR1_EDIT_KINDS,
  FLOOR2_EDIT_KINDS,
  type FormEditKind,
} from "./authoring-floor-classifier.js";
import {
  validateFloor2Descriptor,
  FLOOR2_CUSTOM_FLAG_KEY,
  type Floor2RenderDescriptor,
} from "./floor2-renderer.js";
import type { BindingField } from "./binding-compat.js";

// ---------------------------------------------------------------------------
// FLOOR1_DOC_NODE_TYPES — whitelist типов узлов декларативного документа (§3.3)
// ---------------------------------------------------------------------------

/**
 * Закрытый набор типов узлов, допустимых в декларативном (Floor-1) форма-документе
 * (form-document-format.spec.md §3 / floor-boundary.spec.md §3.3). Узел `custom`
 * сюда НЕ входит — он код-escape (componentId + bindings, sandbox-iframe) и делает
 * операцию ввода/правки этого узла Floor-2-операцией.
 *
 * Машинно-читаемая граница (паттерн AFC-5 — ReadonlySet, как FLOOR1_EDIT_KINDS).
 */
export const FLOOR1_DOC_NODE_TYPES: ReadonlySet<string> = new Set<string>([
  // презентационные (НЕ привязаны к полю) — §3.1
  "section",
  "columns",
  "tabs",
  "divider",
  "text",
  // привязанные к данным — §3.2
  "field",
  "table",
  "readout",
  "relation",
]);

// ---------------------------------------------------------------------------
// FLOOR1_DECLARATIVE_WHITELIST — whitelist изменяемых ключей (§3.2 R-2)
// ---------------------------------------------------------------------------

/**
 * Конечный набор декларативных слотов, НЕ влияющих на контракт данных
 * (floor-boundary.spec.md §3.2 R-2). Любой ключ ВНЕ whitelist (`key`, `type`/
 * `contract`, record_schema property, `reactSource`, `componentId`,
 * expression-поле, `fieldKey`/`subKey`/`displayField` — named-binding каналы) → Floor-2.
 *
 * Три слоя (§3.2 R-2):
 *   1. UI-schema (FieldUiMeta, T-0073): label / placeholder / help_text / hidden / display_order.
 *   2. named-binding presentation-слой (НЕ контракт): required / label / presentation / display_order.
 *   3. структурно-нейтральные узлы форма-документа: label / mode / placeholder / widget
 *      (БЕЗ смены fieldKey — это R-4), + чисто-раскладочные свойства презентационных узлов
 *      (title / collapsible / count / content / tabs).
 *
 * Машинно-читаемая граница (паттерн AFC-5 — ReadonlySet).
 */
export const FLOOR1_DECLARATIVE_WHITELIST: ReadonlySet<string> = new Set<string>([
  // --- UI-schema слой (FieldUiMeta, T-0073) ---
  "label",
  "placeholder",
  "help_text",
  "hidden",
  "display_order",
  // --- named-binding presentation-слой (НЕ контракт) ---
  "required",
  "presentation",
  // --- структурно-нейтральные узлы форма-документа (§3.2 / §3.3) ---
  "mode",
  "widget",
  // презентационные/раскладочные свойства узлов (section/columns/tabs/text)
  "title",
  "collapsible",
  "count",
  "content",
  "tabs",
]);

// ---------------------------------------------------------------------------
// CODE_SIGNAL_KINDS — kinds, кодирующие логику/код/миграцию (§3.4 / FR-4)
// ---------------------------------------------------------------------------

/**
 * Подмножество FLOOR2_EDIT_KINDS, которое САМО ПО СЕБЕ — код-сигнал (§3.4):
 * add_conditional (DMN/expression-visibility), custom_component, external_task,
 * object_migration. Эти kinds кодируют логику/код/миграцию. Производное от
 * FLOOR2_EDIT_KINDS (T-0074) — НЕ параллельный словарь (NF-1).
 */
const CODE_SIGNAL_KINDS: ReadonlySet<string> = new Set<string>([
  "add_conditional",
  "custom_component",
  "external_task",
  "object_migration",
]);

/**
 * Имена полей, присутствие которых на узле документа = expression/condition/script
 * (логика сверх плоской декларации, §3.4). Структурный детектор — смотрит на
 * наличие code-несущего ПОЛЯ, не пытается интерпретировать его значение.
 */
const EXPRESSION_FIELD_NAMES: ReadonlySet<string> = new Set<string>([
  "expression",
  "condition",
  "script",
  "reactSource",
  "componentId",
]);

// ---------------------------------------------------------------------------
// Публичные типы входа/выхода (FR-6 / FR-7)
// ---------------------------------------------------------------------------

/**
 * Форма-документ — минимальная структурная проекция, нужная границе (FR-6).
 * Граница НЕ владеет полным schema документа (это F1/F2, out_of_scope) — она
 * обходит дерево по `type` + named-binding каналам. Узлы — open shape: любые
 * дополнительные ключи допустимы и игнорируются (кроме code-сигнальных).
 */
export interface FormDocNode {
  type: string;
  fieldKey?: string;
  /** для relation — вторичная схема-ссылка (§3 R-4 канал 3) */
  displayField?: string;
  /** для table — колонки, каждая называет subKey (§3 R-4 канал 2) */
  columns?: ReadonlyArray<{ subKey?: string; [k: string]: unknown }>;
  /** дочерние узлы (section/columns/divider/...) */
  children?: ReadonlyArray<FormDocNode>;
  /** вкладки (tabs) — каждая со своими children */
  tabs?: ReadonlyArray<{ children?: ReadonlyArray<FormDocNode>; [k: string]: unknown }>;
  /** code-сигнальные поля (§3.4) — присутствие поднимает этаж */
  reactSource?: string;
  componentId?: string;
  expression?: unknown;
  condition?: unknown;
  script?: unknown;
  [k: string]: unknown;
}

/** Корень форма-документа: `root.children` (form-document-format.spec.md §3). */
export interface FormDocument {
  type?: string;
  children?: ReadonlyArray<FormDocNode>;
  [k: string]: unknown;
}

/**
 * Операция редактирования — вход классификатора (spec §4.1 / FR-6).
 *   kind        — лексический сигнал (T-0074 FormEditKind или unknown-строка).
 *   changedKeys — ключи, которых касается дифф (для R-2).
 *   doc         — целевой/новый форма-документ (для R-3/R-4, обход дерева).
 *   descriptor  — если операция несёт Floor-2-рендер (vetted/custom).
 *   meta        — аудит-контекст; классификатор его НЕ читает (чистота, NF-3).
 */
export interface FloorEditOp {
  kind: FormEditKind | string;
  changedKeys?: readonly string[];
  doc?: FormDocument;
  descriptor?: Floor2RenderDescriptor;
  meta?: Record<string, unknown>;
}

/**
 * Read-only проекция живой record_schema (spec §4.1 / NF-3). Передаётся —
 * НЕ читается из БД внутри. Множество существующих fieldKey + (опционально)
 * BindingField[] для делегирования validateFloor2Descriptor (FB-5).
 */
export interface LiveSchemaView {
  /** множество существующих fieldKey живой record_schema (для R-4). */
  fieldKeys: readonly string[];
  /**
   * T-0680: sub-schema ключей коллекций — map { <collectionFieldKey>: [subKey, …] }.
   * R-4 канал 2 (table.columns[].subKey) НЕ живёт в плоском top-level `fieldKeys`
   * (record_schema.properties[collection].items.properties — вложенный уровень).
   * Раньше subKey сваливался в тот же плоский keySet и сверялся с top-level
   * ключами → любая колонка коллекции («Позиции».qty/product) ложно висела
   * (LIVE-дефект T-0678: форма с таблицей → 409 WRONG_FLOOR). Теперь subKey
   * коллекции, чей РОДИТЕЛЬ (collection fieldKey) присутствует в живой схеме,
   * покрыт родительским биндингом:
   *   - есть запись для коллекции → subKey висит ⟺ subKey ∉ этой записи
   *     (настоящий битый столбец — как V-SUBKEY клиента — ОСТАётся Floor-2);
   *   - записи нет (sub-schema не передана) → subKey покрыт родителем, НЕ висит
   *     (родитель уже проверен каналом 1).
   * Отсутствие всей map (legacy-вызыватели) → тот же «покрыт родителем» fallback.
   */
  subKeysByCollection?: Readonly<Record<string, readonly string[]>>;
  /** named-binding поля (для делегирования validateFloor2Descriptor, FB-5). опционально. */
  fields?: readonly BindingField[];
}

/** Результат классификации (spec §4.1 / FR-7). */
export interface FloorBoundaryResult {
  floor: "1" | "2";
  route: "declarative" | "sandbox";
  /** какие из R-1..R-4 (и какой сигнал) подняли этаж; пусто при чистом Floor-1. */
  reasons: string[];
  /** только при floor==='2' — делегируется validateFloor2Descriptor (T-0076). */
  floor2Sub?: "vetted" | "custom";
}

// ---------------------------------------------------------------------------
// Обход дерева — собирает KEY_SET(doc) три-канала + детектит код-сигнал
// ---------------------------------------------------------------------------

interface DocScan {
  /**
   * Ключи record_schema канала 1+3 (fieldKey на field/table/readout/relation +
   * relation.displayField) — сверяются с top-level `fieldKeys` живой схемы.
   * T-0680: канал 2 (table.columns[].subKey) ВЫНЕСЕН из этого множества в
   * `collectionSubKeys` — subKey живёт во вложенной sub-schema коллекции, а НЕ
   * среди top-level ключей, поэтому сверять его с `fieldKeys` было неверно.
   */
  keySet: Set<string>;
  /**
   * T-0680: канал 2 — subKey'и колонок таблиц, привязанные к ОБЪЕМЛЮЩЕЙ коллекции.
   * `{ collectionKey, subKey }` — collectionKey = fieldKey table-узла (может быть
   * пустой строкой, если у table нет fieldKey; тогда это уже висящий table-биндинг
   * канала 1). Проверяются против sub-schema коллекции (см. LiveSchemaView).
   */
  collectionSubKeys: Array<{ collectionKey: string; subKey: string }>;
  /** true если в дереве есть code-несущий узел/поле (§3.4). */
  hasCodeSignal: boolean;
  /** true если в дереве есть узел type вне FLOOR1_DOC_NODE_TYPES (т.е. custom). */
  hasNonDeclarativeNode: boolean;
}

/**
 * Обходит дерево форма-документа, собирая (1) KEY_SET по трём каналам привязки
 * (§3 R-4: fieldKey | table.columns[].subKey | relation.displayField),
 * (2) флаг код-сигнала (§3.4: custom-узел / reactSource / componentId /
 * expression|condition|script-поле). Чистый обход, детерминирован, fail-closed.
 */
function scanDocument(doc: FormDocument | undefined): DocScan {
  const scan: DocScan = {
    keySet: new Set<string>(),
    collectionSubKeys: [],
    hasCodeSignal: false,
    hasNonDeclarativeNode: false,
  };
  if (doc == null || typeof doc !== "object") {
    return scan;
  }
  // B-1 fix: прогоняем САМ корневой узел через ту же логику, что и листья —
  // visitNode инспектирует type (R-1 узлов), code-поля (R-3), fieldKey/columns/
  // displayField (R-4) И рекурсит в children/tabs. Поэтому НЕ зовём visitNodes
  // на children отдельно (это задвоило бы обход). Раньше корень обходился мимо
  // visitNode → код-сигнал и висящий биндинг НА КОРНЕ давали ложный Floor-1.
  visitNode(doc as FormDocNode, scan, /* isRoot */ true);
  return scan;
}

function visitNodes(
  nodes: ReadonlyArray<FormDocNode> | undefined,
  scan: DocScan,
): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    visitNode(node, scan);
  }
}

/**
 * §3.4 структурный детектор code-несущих полей на ЛЮБОМ объекте (узел документа
 * ИЛИ объект колонки таблицы — NB-1). reactSource/componentId считаются сигналом
 * только при непустой строке; expression/condition/script — при любом присутствии.
 */
function scanCodeFields(obj: Record<string, unknown>, scan: DocScan): void {
  for (const f of EXPRESSION_FIELD_NAMES) {
    const v = obj[f];
    if (f === "reactSource" || f === "componentId") {
      if (typeof v === "string" && v.trim().length > 0) scan.hasCodeSignal = true;
    } else if (v !== undefined && v !== null) {
      scan.hasCodeSignal = true;
    }
  }
}

function visitNode(node: FormDocNode | undefined, scan: DocScan, isRoot = false): void {
  if (node == null || typeof node !== "object") return;

  const type = typeof node.type === "string" ? node.type : undefined;

  // --- §3.3 / §3.4: тип узла вне декларативного whitelist (напр. "custom") ---
  // Корневой узел-обёртка `root` (form-document-format §3: «дерево root.children»)
  // структурно-нейтрален и допустим ТОЛЬКО на корне. Любой иной нештатный type
  // (на корне или в листе) → non-declarative → поднимает этаж (R-1 узлов).
  const isAllowedNode =
    type !== undefined &&
    (FLOOR1_DOC_NODE_TYPES.has(type) || (isRoot && type === "root"));
  if (!isAllowedNode) {
    scan.hasNonDeclarativeNode = true;
    scan.hasCodeSignal = true; // custom-узел / нештатный type = код-сигнал (§3.4)
  }

  // --- §3.4: code-несущие поля на узле (структурный детектор) ---
  scanCodeFields(node, scan);

  // --- §3 R-4 канал 1: fieldKey на field/table/readout/relation ---
  if (typeof node.fieldKey === "string" && node.fieldKey.length > 0) {
    scan.keySet.add(node.fieldKey);
  }

  // --- §3 R-4 канал 2: table.columns[].subKey + NB-1: код-сигнал в объекте колонки ---
  // T-0680: subKey записывается вместе с ОБЪЕМЛЮЩЕЙ коллекцией (fieldKey table-узла),
  // НЕ в плоский keySet. subKey живёт во вложенной sub-schema коллекции
  // (record_schema.properties[collection].items.properties) — сверять его с
  // top-level `fieldKeys` было неверно и ложно валило любую форму с таблицей.
  if (Array.isArray(node.columns)) {
    const collectionKey =
      typeof node.fieldKey === "string" && node.fieldKey.length > 0 ? node.fieldKey : "";
    for (const col of node.columns) {
      if (col == null || typeof col !== "object") continue;
      if (typeof col.subKey === "string" && col.subKey.length > 0) {
        scan.collectionSubKeys.push({ collectionKey, subKey: col.subKey });
      }
      // NB-1: §3.4 «где бы ни лежал» — code-несущее поле внутри объекта колонки
      // (мимо subKey) обязано поднимать этаж симметрично узлам.
      scanCodeFields(col, scan);
    }
  }

  // --- §3 R-4 канал 3: relation.displayField ---
  if (typeof node.displayField === "string" && node.displayField.length > 0) {
    scan.keySet.add(node.displayField);
  }

  // --- рекурсия: children + tabs[].children ---
  visitNodes(node.children, scan);
  if (Array.isArray(node.tabs)) {
    for (const tab of node.tabs) {
      if (tab != null) visitNodes(tab.children, scan);
    }
  }
}

// ---------------------------------------------------------------------------
// classifyFloorBoundary — основная чистая функция (spec §4.1)
// ---------------------------------------------------------------------------

/**
 * Классифицирует операцию редактирования формы на Floor-1 / Floor-2 и маршрут.
 *
 * Предикат (§3.2): floor = '1' ⟺ R-1 ∧ R-2 ∧ R-3 ∧ R-4; иначе '2'.
 * Вычисляется как floor = max(lexicalFloor(kind), contentFloor(...)) — контент
 * только поднимает этаж (FR-3). Один Floor-2-сигнал → Floor-2 (fail-up).
 *
 * Детерминизм + fail-closed (NF-2): неизвестный kind / неоднозначный вход /
 * висящий биндинг → Floor-2 (route:'sandbox'). Floor-1 — явно-доказанное
 * выполнение всех четырёх R, НЕ дефолт. Повтор того же входа → идентичный результат.
 *
 * Чистая функция (NF-3): без I/O; `schema` — переданная проекция, не БД-чтение.
 *
 * @param op     операция редактирования (FloorEditOp).
 * @param schema read-only проекция живой record_schema (LiveSchemaView).
 * @returns FloorBoundaryResult
 */
export function classifyFloorBoundary(
  op: FloorEditOp,
  schema: LiveSchemaView,
): FloorBoundaryResult {
  const reasons: string[] = [];

  // Нормализуем вход fail-closed (NF-2): отсутствие op → Floor-2.
  if (op == null || typeof op !== "object") {
    return sandboxResult(
      ["R-1: операция отсутствует или невалидна — fail-closed → Floor-2"],
      undefined,
      undefined,
    );
  }

  const kind = op.kind;
  const changedKeys = Array.isArray(op.changedKeys) ? op.changedKeys : [];
  const liveKeys = new Set<string>(
    Array.isArray(schema?.fieldKeys) ? schema.fieldKeys : [],
  );

  // === R-1 (лексика): kind ∈ FLOOR1_EDIT_KINDS; unknown / Floor-2-kind → Floor-2 ===
  const kindIsFloor1 =
    typeof kind === "string" &&
    (FLOOR1_EDIT_KINDS as ReadonlySet<string>).has(kind);
  if (!kindIsFloor1) {
    if (
      typeof kind === "string" &&
      (FLOOR2_EDIT_KINDS as ReadonlySet<string>).has(kind)
    ) {
      reasons.push(`R-1: "${kind}" — Floor-2-kind (структурная правка, T-0074)`);
    } else {
      reasons.push(
        `R-1: "${String(kind)}" не в FLOOR1_EDIT_KINDS — неизвестный/недопустимый kind → Floor-2 (fail-up)`,
      );
    }
  }

  // === R-2 (whitelist ключей): каждый changedKey ∈ FLOOR1_DECLARATIVE_WHITELIST ===
  for (const key of changedKeys) {
    if (typeof key !== "string" || !FLOOR1_DECLARATIVE_WHITELIST.has(key)) {
      reasons.push(
        `R-2: изменённый ключ "${String(key)}" вне FLOOR1_DECLARATIVE_WHITELIST (влияет на контракт данных / код) → Floor-2`,
      );
    }
  }

  // === R-3 (нет код-сигнала): §3.4 контентный детектор ===
  const scan = scanDocument(op.doc);
  const kindIsCodeSignal =
    typeof kind === "string" && CODE_SIGNAL_KINDS.has(kind);
  const descriptorIsCode =
    op.descriptor != null && op.descriptor.mode === "custom";
  const hasCodeSignal =
    scan.hasCodeSignal || kindIsCodeSignal || descriptorIsCode;
  if (hasCodeSignal) {
    if (scan.hasNonDeclarativeNode) {
      reasons.push(
        "R-3: документ содержит non-declarative/custom-узел (вне FLOOR1_DOC_NODE_TYPES) — код-сигнал → Floor-2",
      );
    }
    if (scan.hasCodeSignal && !scan.hasNonDeclarativeNode) {
      reasons.push(
        "R-3: документ содержит код-сигнал (reactSource/componentId/expression/condition/script) → Floor-2",
      );
    }
    if (kindIsCodeSignal) {
      reasons.push(`R-3: kind "${kind}" кодирует логику/код/миграцию → Floor-2`);
    }
    if (descriptorIsCode) {
      reasons.push("R-3: операция несёт custom Floor-2-дескриптор (reactSource) → Floor-2");
    }
  }

  // === R-4 (named-binding целостность): KEY_SET(doc) ⊆ живой record_schema ===
  // Канал 1+3 (fieldKey / relation.displayField): сверяем с top-level ключами.
  for (const key of scan.keySet) {
    if (!liveKeys.has(key)) {
      reasons.push(
        `R-4: ключ "${key}" из KEY_SET(doc) отсутствует в живой record_schema — висящий биндинг → Floor-2`,
      );
    }
  }
  // T-0680 · Канал 2 (table.columns[].subKey): subKey живёт во ВЛОЖЕННОЙ sub-schema
  // коллекции, НЕ среди top-level `fieldKeys`. Раньше subKey сверялся с плоским
  // top-level множеством → колонки коллекции («Позиции».qty/product) ложно висли
  // и валили сохранение любой формы с таблицей (LIVE-дефект T-0678). Теперь:
  //   • родитель (collectionKey) ОБЯЗАН быть в живой схеме — иначе это настоящий
  //     висящий table-биндинг (ловится каналом 1 через fieldKey table-узла; при
  //     collectionKey==="" table вообще без fieldKey → тоже висящий, помечаем);
  //   • при живом родителе: если для коллекции передана sub-schema — subKey висит
  //     ⟺ его нет в ней (настоящий битый столбец → Floor-2, симметрично V-SUBKEY
  //     клиента); если sub-schema НЕ передана — subKey ПОКРЫТ родительским
  //     биндингом и висящим НЕ считается (родитель уже проверен каналом 1).
  const subSchema = schema?.subKeysByCollection;
  for (const { collectionKey, subKey } of scan.collectionSubKeys) {
    if (collectionKey === "" || !liveKeys.has(collectionKey)) {
      // table-узел без валидного collection-fieldKey — висящий родитель.
      reasons.push(
        `R-4: колонка "${subKey}" привязана к таблице без живого поля-коллекции ` +
          `("${collectionKey || "∅"}") — висящий биндинг → Floor-2`,
      );
      continue;
    }
    const known =
      subSchema && Object.prototype.hasOwnProperty.call(subSchema, collectionKey)
        ? subSchema[collectionKey]
        : undefined;
    if (Array.isArray(known) && !known.includes(subKey)) {
      reasons.push(
        `R-4: колонка "${subKey}" отсутствует в sub-schema коллекции "${collectionKey}" ` +
          `— висящий биндинг → Floor-2`,
      );
    }
    // known === undefined → sub-schema не передана → subKey покрыт родителем (не висит).
  }

  // === Решение: floor = max(lexicalFloor, contentFloor) ===
  if (reasons.length === 0) {
    // Floor-1 — явно-доказанное R-1 ∧ R-2 ∧ R-3 ∧ R-4 (FR-2 / NF-2).
    return {
      floor: "1",
      route: "declarative",
      reasons: [],
    };
  }

  // Floor-2 — делегируем под-классификацию (vetted/custom) validateFloor2Descriptor (FB-5 / FR-9).
  return sandboxResult(reasons, op.descriptor, schema);
}

// ---------------------------------------------------------------------------
// Floor-2 результат + делегирование validateFloor2Descriptor (T-0076)
// ---------------------------------------------------------------------------

/**
 * Собирает Floor-2 (route:'sandbox') результат. floor2Sub вычисляется
 * ДЕЛЕГИРОВАНИЕМ в validateFloor2Descriptor (T-0076) — НЕ реимплементацией
 * sandbox-полиси (FR-9 / NF-1 / FB-5). Если дескриптор присутствует, его mode
 * проходит через гейт T-0076; иначе floor2Sub не выставляется (граница не
 * выдумывает под-класс там, где дескриптора нет).
 */
function sandboxResult(
  reasons: string[],
  descriptor: Floor2RenderDescriptor | undefined,
  schema: LiveSchemaView | undefined,
): FloorBoundaryResult {
  let floor2Sub: "vetted" | "custom" | undefined;

  if (descriptor != null && (descriptor.mode === "vetted" || descriptor.mode === "custom")) {
    // Делегируем sandbox-полиси (vetted/custom + FLOOR2_CUSTOM_FLAG_KEY) T-0076.
    const fields = Array.isArray(schema?.fields) ? [...schema!.fields] : [];
    const validation = validateFloor2Descriptor(descriptor, fields);
    floor2Sub = descriptor.mode;
    if (!validation.ok) {
      for (const err of validation.errors) {
        reasons.push(`floor2: ${err.code} — ${err.message}`);
      }
    }
    if (descriptor.mode === "custom") {
      // Аудит-хвост: явно отмечаем, что custom требует governance-флаг (§9.10, делегировано T-0076).
      reasons.push(
        `floor2: custom-режим требует meta.${FLOOR2_CUSTOM_FLAG_KEY} (делегировано validateFloor2Descriptor, T-0076)`,
      );
    }
  }

  return {
    floor: "2",
    route: "sandbox",
    reasons,
    ...(floor2Sub !== undefined ? { floor2Sub } : {}),
  };
}
