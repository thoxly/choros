/**
 * T-0074 · E11.3: Authoring Floor Classifier
 *
 * Pure function — no I/O, no DB, no network, no filesystem, no env reads.
 * Зеркалит purity-дисциплину binding-compat.ts (T-0072 · checkBindingCompat)
 * и report-page-compat.ts (T-0176 · classifyReportPageFloor).
 *
 * Exports:
 *   - FormEditKind            — дискриминатор вида правки формы (§4 / §9.2 ADR)
 *   - FormEditChange          — один артефакт правки (вход классификатора)
 *   - AuthoringFloorResult    — результат классификации (floor 1|2 + reason)
 *   - FLOOR1_EDIT_KINDS       — ReadonlySet<FormEditKind> Floor-1 vocab (машинная граница)
 *   - FLOOR2_EDIT_KINDS       — ReadonlySet<FormEditKind> Floor-2 vocab (машинная граница)
 *   - classifyAuthoringFloor  — основная чистая функция (§9.2 ADR, T-0074)
 *
 * Прецедентная ссылка (NF-1 обязательна):
 *   classifyAuthoringFloor является обобщённым правилом маршрутизации для
 *   форм/правок, построенным по образцу classifyReportPageFloor (T-0176).
 *   Это один control plane «вид правки → этаж», не второй механизм.
 *
 * Потребители:
 *   - T-0073 (Floor-1 кнопочный редактор форм) импортирует classifyAuthoringFloor
 *     для проверки, что кнопочный путь не направляет Floor-2 правку в Floor-1.
 *   - T-0078 (red-lines авторинга) потребляет FormEditKind для разграничения
 *     деструктивных правок (drop_field / rename_field / lossy_type_change).
 *
 * Граница — ЛЕКСИЧЕСКОЕ свойство FormEditChange.kind (дискриминатор), не
 * «вкус агента». Агент, эмитящий Floor-2 kind для формы, выразимой Floor-1,
 * ловится фитнес-проверкой FF-FLOOR-AUTH (ci/checks/authoring-floor-isolation.sh).
 *
 * ВАЖНО: form_def как сущность БД отложена (T-0125 review). Классификатор
 * работает от чистых структур-параметров (FormEditChange), а не от БД-строк.
 * Это делает его честным и потребляемым при любой будущей форме хранения.
 *
 * Источник: docs/design/extensibility-and-authoring.md §4 + §9.2
 */

// ---------------------------------------------------------------------------
// FormEditKind — словарь видов правок (§4 / §9.2)
// ---------------------------------------------------------------------------

/**
 * Floor-1 kinds — декларативные, config-primary, button-edit, zero-LLM.
 * Детерминированны, переживают агента-офлайн (§4).
 *
 * relabel_field      — изменить label / placeholder / help-text поля.
 * toggle_required    — переключить required/optional у поля.
 * hide_field         — скрыть поле (visibility=hidden).
 * show_field         — показать скрытое поле.
 * reorder_fields     — изменить порядок отображения полей.
 */
export type Floor1EditKind =
  | "relabel_field"
  | "toggle_required"
  | "hide_field"
  | "show_field"
  | "reorder_fields";

/**
 * Floor-2 kinds — структурные, требуют агента / кода / schema-migration.
 * Не выразимы через кнопочный Floor-1 редактор (§4 / §9.2).
 *
 * add_field          — добавить новое поле (новый named-binding ключ).
 * drop_field         — удалить поле (RED-LINE: деструктивно, human-gate §4).
 * rename_field       — переименовать field key (RED-LINE: эквивалентно drop + add).
 * type_change        — изменить тип поля (может быть lossy, red-line §4).
 * add_conditional    — добавить/изменить DMN-условие / expression-visibility (Middle→Floor-2).
 * custom_component   — кастомный React-компонент (sandbox-iframe, §4 Floor-2).
 * external_task      — изменение External-Task worker логики (§4 Floor-2).
 * object_migration   — изменение object-schema + per-record expand/contract (§7 Floor-2).
 */
export type Floor2EditKind =
  | "add_field"
  | "drop_field"
  | "rename_field"
  | "type_change"
  | "add_conditional"
  | "custom_component"
  | "external_task"
  | "object_migration";

/**
 * Полный словарь видов правок формы.
 * Vocab закрытый (расширяем аддитивной миграцией — новый вид всегда Floor-2
 * до явного вердикта в следующей версии классификатора).
 */
export type FormEditKind = Floor1EditKind | Floor2EditKind;

// ---------------------------------------------------------------------------
// Машинно-читаемые наборы (для внешней валидации агентов — T-0073 / T-0078)
// ---------------------------------------------------------------------------

/** Все Floor-1 kinds — button-edit, zero-LLM. */
export const FLOOR1_EDIT_KINDS: ReadonlySet<Floor1EditKind> = new Set<Floor1EditKind>([
  "relabel_field",
  "toggle_required",
  "hide_field",
  "show_field",
  "reorder_fields",
]);

/** Все Floor-2 kinds — structural, requires agent / code / migration. */
export const FLOOR2_EDIT_KINDS: ReadonlySet<Floor2EditKind> = new Set<Floor2EditKind>([
  "add_field",
  "drop_field",
  "rename_field",
  "type_change",
  "add_conditional",
  "custom_component",
  "external_task",
  "object_migration",
]);

// ---------------------------------------------------------------------------
// FormEditChange — артефакт правки (вход классификатора)
// ---------------------------------------------------------------------------

/**
 * Один артефакт правки формы.
 *
 * @param kind     - Дискриминатор вида правки. Единственный вход классификатора;
 *                   остальные поля — справочный контекст для аудита / ошибок.
 * @param fieldKey - Ключ поля, которого касается правка (опционально — не
 *                   для всех kinds обязателен, напр. reorder_fields может
 *                   касаться нескольких). Используется в reason-строке.
 * @param meta     - Произвольные метаданные для аудита. Классификатор НЕ
 *                   читает их — purity гарантирована.
 *
 * ВАЖНО: классификатор смотрит ТОЛЬКО на поле `kind`. Любое другое поле
 * не влияет на результат (чистая функция от kind).
 */
export interface FormEditChange {
  kind: FormEditKind;
  fieldKey?: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AuthoringFloorResult — результат классификации
// ---------------------------------------------------------------------------

/**
 * Результат classifyAuthoringFloor.
 *
 * requiredFloor — минимальный достаточный этаж для данной правки.
 *   '1' — Floor-1 (кнопочный редактор, zero-LLM, детерминировано).
 *   '2' — Floor-2 (структурная правка, требует агента / кода).
 * reason — человекочитаемое объяснение (для аудита / ошибок агента).
 */
export interface AuthoringFloorResult {
  requiredFloor: "1" | "2";
  reason: string;
}

// ---------------------------------------------------------------------------
// classifyAuthoringFloor — основная чистая функция (§9.2 / §4 ADR)
// ---------------------------------------------------------------------------

/**
 * Определяет машинную границу Floor-1 ↔ Floor-2 для одной правки формы.
 *
 * Правило (§9.2 / §4 extensibility-and-authoring.md):
 *   «Каждая правка маршрутизируется на САМЫЙ НИЗКИЙ достаточный этаж.
 *    Код — последний этаж, не первый.»
 *
 * Floor-1 — iff change.kind ∈ FLOOR1_EDIT_KINDS.
 * Floor-2 — iff change.kind ∈ FLOOR2_EDIT_KINDS.
 * Unknown kind — Floor-2 по принципу «неизвестное → структурное»
 *   (новые kinds всегда Floor-2 до явного включения в FLOOR1_EDIT_KINDS).
 *
 * Граница — лексическое свойство change.kind, не «вкус агента».
 *
 * @param change - Артефакт правки формы (FormEditChange).
 * @returns { requiredFloor: '1' | '2', reason: string }
 *
 * Pre-conditions: нет. Классификатор принимает unknown-входы через change.kind
 * и обрабатывает их детерминированно (unknown kind → Floor-2).
 */
export function classifyAuthoringFloor(change: FormEditChange): AuthoringFloorResult {
  const { kind, fieldKey } = change;
  const fieldSuffix = fieldKey != null ? ` (field: "${fieldKey}")` : "";

  // Fast path: Floor-1 vocab — check first (most common path per §9.2)
  if ((FLOOR1_EDIT_KINDS as ReadonlySet<string>).has(kind)) {
    return {
      requiredFloor: "1",
      reason: `"${kind}" is a Floor-1 declarative edit — button-edit, zero-LLM${fieldSuffix}`,
    };
  }

  // Floor-2 vocab — structural, requires agent/code
  if ((FLOOR2_EDIT_KINDS as ReadonlySet<string>).has(kind)) {
    return {
      requiredFloor: "2",
      reason: `"${kind}" is a Floor-2 structural edit — requires agent/code/migration${fieldSuffix}`,
    };
  }

  // Unknown kind — floor-2 by default (§9.2: «неизвестное → структурное»,
  // новые kinds включаются в Floor-1 только явно)
  return {
    requiredFloor: "2",
    reason: `"${kind}" is not in the Floor-1 or Floor-2 vocab — unknown kinds default to Floor-2${fieldSuffix}`,
  };
}
