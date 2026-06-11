/**
 * T-0176 · T-0121b: Report-Page Compat Validator
 *
 * Pure function — no I/O, no DB, no network, no filesystem, no env reads.
 * Зеркалит purity-дисциплину binding-compat.ts (T-0072 · checkBindingCompat).
 *
 * Exports:
 *   - DepKind              — тип зависимости ('read' | 'aggregate')
 *   - PageDep              — одна запись dep (зеркало row report_page_dep)
 *   - DepViolation         — один экземпляр нарушения (зеркало BindingViolation)
 *   - DepCompatResult      — результат проверки
 *   - JsonSchema           — минимально-достаточный тип схемы (properties-only)
 *   - checkReportPageDepFields — основная чистая функция (§3 ADR T-0121)
 *   - classifyReportPageFloor  — машинная граница Floor-1 ↔ Floor-2 (§4 ADR T-0121)
 *
 * Прецедентная ссылка (NF-1 ADR §3, обязательна):
 *   checkReportPageDepFields является расширением паттерна checkBindingCompat (T-0072).
 *   DepViolation — зеркало BindingViolation. Это один контрол плейн согласованности
 *   «артефакт ↔ поля схемы», не второй механизм.
 *
 * Формa зависит от: T-0072 (производит переменные в form_binding)
 * Отчётная страница зависит от: T-0121 (потребляет поля схемы в report_page_dep)
 *
 * НЕ является публичной точкой расширения: logic lossy_narrowing (ADR §5.2)
 * принадлежит T-0121c / T-0177 (schema-change API — знает старую и новую схему).
 * Этот модуль реализует missing_in_schema; lossy_narrowing добавляется T-0177.
 */

// ---------------------------------------------------------------------------
// Exported types (frozen public surface — ADR §9 T-0121b)
// ---------------------------------------------------------------------------

/** Тип зависимости страницы от поля схемы. Vocab закрытый (расширяем аддитивной миграцией). */
export type DepKind = "read" | "aggregate";

/** Одна запись зависимости страницы от поля реестра (зеркало row report_page_dep). */
export interface PageDep {
  registryDefId: string;
  fieldKey: string;
  depKind: DepKind;
}

/**
 * Тип нарушения совместимости.
 * - missing_in_schema: field_key отсутствует в record_schema.properties реестра.
 * - lossy_narrowing:   деструктивное сужение типа при dep_kind='aggregate' (T-0177).
 *
 * Vocab закрытый: оба значения ADR §3/§5.2. Расширяется в T-0177, не здесь.
 */
export type DepViolationType = "missing_in_schema" | "lossy_narrowing";

/** Один экземпляр нарушения совместимости (зеркало BindingViolation из T-0072). */
export interface DepViolation {
  type: DepViolationType;
  registryDefId: string;
  fieldKey: string;
  message: string;
}

/** Результат проверки совместимости deps страницы со схемой реестра. */
export type DepCompatResult =
  | { ok: true }
  | { ok: false; violations: DepViolation[] };

/**
 * Минимально-достаточный тип JSON-Schema для нужд compat-проверки.
 * Только поле `properties` — достаточно для проверки field_key ∈ schema.
 * Расширяется потребителями без breaking-change (additive only).
 */
export interface JsonSchema {
  properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// checkReportPageDepFields — core pure function (ADR §3)
// ---------------------------------------------------------------------------

/**
 * Проверяет структурную совместимость зарегистрированных зависимостей страницы
 * с текущим `record_schema` реестра (`registry_def.record_schema`).
 *
 * Для каждого `dep` в `deps`:
 *   dep.fieldKey ∉ recordSchema.properties → DepViolation{ type:'missing_in_schema', ... }
 *
 * Все ключи присутствуют → { ok: true }.
 *
 * @param deps         - Массив PageDep из report_page_dep.
 * @param recordSchema - Схема реестра (registry_def.record_schema).
 * @returns { ok: true } или { ok: false; violations: DepViolation[] }.
 *
 * Pre-conditions (callers must enforce before calling):
 *   - deps элементы уже прошли валидацию write-path guard при регистрации.
 *   - Дубли fieldKey в пределах одного registryDefId не проверяются здесь
 *     (write-path guard via UNIQUE constraint ADR §2.2).
 *
 * Прецедент: checkBindingCompat (T-0072) — аналогичная pure-функция для form_binding.
 * Эта функция — зеркало на стороне «потребляет поля», а не «производит переменные».
 */
export function checkReportPageDepFields(
  deps: PageDep[],
  recordSchema: JsonSchema,
): DepCompatResult {
  const violations: DepViolation[] = [];

  // properties-объект из схемы; отсутствие properties ≡ пустой объект
  const props = recordSchema.properties ?? {};

  for (const dep of deps) {
    if (!(dep.fieldKey in props)) {
      violations.push({
        type: "missing_in_schema",
        registryDefId: dep.registryDefId,
        fieldKey: dep.fieldKey,
        message: `Field key "${dep.fieldKey}" (dep on registry ${dep.registryDefId}) is not declared in record_schema.properties`,
      });
    }
  }

  if (violations.length === 0) {
    return { ok: true };
  }
  return { ok: false, violations };
}

// ---------------------------------------------------------------------------
// classifyReportPageFloor — machine boundary Floor-1 ↔ Floor-2 (ADR §4 / §9.2)
// ---------------------------------------------------------------------------

/**
 * Vocab Floor-1 (исчерпывающий, детерминированный — ADR §4).
 * Каждая метрика — объект с обязательными полями source_registry_def_id, field_key, agg,
 * и допустимыми опциональными: group_by, filter, title, subtitle.
 * Любое поле ВНЕ этого vocab → Floor-2 (синтаксическое свойство, не «вкус агента»).
 */
const FLOOR1_REQUIRED_KEYS = new Set(["source_registry_def_id", "field_key", "agg"]);
const FLOOR1_OPTIONAL_KEYS = new Set(["group_by", "filter", "title", "subtitle"]);
const FLOOR1_ALLOWED_KEYS = new Set([...FLOOR1_REQUIRED_KEYS, ...FLOOR1_OPTIONAL_KEYS]);

/** Допустимые значения agg для Floor-1 vocab (ADR §4). */
const FLOOR1_AGG_VOCAB = new Set(["count", "sum", "avg", "min", "max", "list"]);

/** Допустимые операторы фильтра Floor-1 vocab (ADR §4). */
const FLOOR1_FILTER_OPS = new Set(["=", "!=", "<", ">", "in"]);

/**
 * Проверяет один элемент metrics[] на соответствие vocab Floor-1.
 * Возвращает причину несоответствия или null (если соответствует).
 */
function checkMetricFloor1(metric: unknown): string | null {
  if (metric === null || typeof metric !== "object" || Array.isArray(metric)) {
    return "metric is not a plain object";
  }

  const m = metric as Record<string, unknown>;

  // Обязательные поля
  for (const key of FLOOR1_REQUIRED_KEYS) {
    if (!(key in m)) {
      return `required Floor-1 field "${key}" is missing`;
    }
  }

  // Проверка типов обязательных полей
  if (typeof m["source_registry_def_id"] !== "string") {
    return "source_registry_def_id must be a string";
  }
  if (typeof m["field_key"] !== "string") {
    return "field_key must be a string";
  }
  if (typeof m["agg"] !== "string" || !FLOOR1_AGG_VOCAB.has(m["agg"] as string)) {
    return `agg "${String(m["agg"])}" is not in Floor-1 vocab (count|sum|avg|min|max|list)`;
  }

  // Запрещённые ключи — любой ключ вне FLOOR1_ALLOWED_KEYS делает это Floor-2
  for (const key of Object.keys(m)) {
    if (!FLOOR1_ALLOWED_KEYS.has(key)) {
      return `field "${key}" is outside Floor-1 vocab`;
    }
  }

  // Опциональные поля — если присутствуют, проверяем их типы
  if ("group_by" in m && typeof m["group_by"] !== "string") {
    return "group_by must be a string if present";
  }
  if ("title" in m && typeof m["title"] !== "string") {
    return "title must be a string if present";
  }
  if ("subtitle" in m && typeof m["subtitle"] !== "string") {
    return "subtitle must be a string if present";
  }

  if ("filter" in m) {
    const filter = m["filter"];
    if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
      return "filter must be a plain object if present";
    }
    const f = filter as Record<string, unknown>;
    if (typeof f["field_key"] !== "string") {
      return "filter.field_key must be a string";
    }
    if (typeof f["op"] !== "string" || !FLOOR1_FILTER_OPS.has(f["op"] as string)) {
      return `filter.op "${String(f["op"])}" is not in Floor-1 vocab (=|!=|<|>|in)`;
    }
    if (!("value" in f)) {
      return "filter.value is required";
    }
  }

  return null; // соответствует Floor-1 vocab
}

/**
 * Определяет машинную границу Floor-1 ↔ Floor-2 для page_def страницы (ADR §4 / §9.2).
 *
 * Floor-1 (requiredFloor='1') — если `pageDef` — массив (включая пустой), где каждый
 * элемент целиком выразим vocab Floor-1 (agg-метрики + допустимые optional поля).
 *
 * Floor-2 (requiredFloor='2') — если `pageDef` не массив, либо любой элемент
 * содержит поле вне vocab Floor-1, либо agg не из допустимого enum.
 *
 * Граница — синтаксическое свойство `page_def`, не «вкус агента» (§9.2 инвариант).
 * Config-агент, эмитящий Floor-2 для страницы, выразимой Floor-1, ловится FF-FLOOR.
 *
 * @param pageDef - Содержимое page_def страницы (unknown; валидируется внутри).
 * @returns { requiredFloor: '1' | '2', reason: string }
 */
export function classifyReportPageFloor(
  pageDef: unknown,
): { requiredFloor: "1" | "2"; reason: string } {
  // Не массив → Floor-2
  if (!Array.isArray(pageDef)) {
    return {
      requiredFloor: "2",
      reason: `page_def is not an array (got ${pageDef === null ? "null" : typeof pageDef})`,
    };
  }

  // Пустой массив → Floor-1 (нет метрик — нет ничего за пределами Floor-1 vocab)
  if (pageDef.length === 0) {
    return { requiredFloor: "1", reason: "empty metrics array — trivially Floor-1" };
  }

  // Каждый элемент проверяем на соответствие vocab Floor-1
  for (let i = 0; i < pageDef.length; i++) {
    const reason = checkMetricFloor1(pageDef[i]);
    if (reason !== null) {
      return {
        requiredFloor: "2",
        reason: `metrics[${i}]: ${reason}`,
      };
    }
  }

  return {
    requiredFloor: "1",
    reason: `all ${pageDef.length} metric(s) conform to Floor-1 vocab`,
  };
}
