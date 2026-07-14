/**
 * T-0073 · E11.2: Floor-1 Form Editor — declarative JSON-Schema + UI-schema,
 * button-based zero-LLM editor (relabel / hide / required / order / help),
 * backend validation.
 *
 * Pure functions — no I/O, no DB, no network, no filesystem, no env reads.
 * Зеркалит purity-дисциплину binding-compat.ts (T-0072 · checkBindingCompat)
 * и authoring-floor-classifier.ts (T-0074 · classifyAuthoringFloor).
 *
 * Exports:
 *   - FieldUiMeta            — UI-schema слой для одного поля (label/placeholder/
 *                              help_text/hidden/display_order)
 *   - FormUiSchema           — карта fieldKey → FieldUiMeta (UI-schema формы)
 *   - Floor1EditRequest      — дискриминированный union 6 Floor-1 операций
 *   - Floor1ValidationError  — ошибка валидации одной операции
 *   - Floor1ValidationResult — результат бэкенд-валидации
 *   - Floor1EditResult       — результат применения правки (ok/err)
 *   - applyFloor1Edit        — основная чистая функция (применяет Floor1EditRequest)
 *   - validateFloor1Request  — бэкенд-валидация входа (Floor-2 guard + схема)
 *
 * Предметная модель (честное сужение):
 *   form_def как сущность БД отложена (T-0125 review). Floor-1 редактор работает
 *   над двумя структурами:
 *
 *   1. BindingField[] из form_binding (named-binding контракт, ADR §4):
 *      {key, type, required, label?} — эта структура уже есть в БД.
 *      Floor-1 операции toggle_required, relabel_field, reorder_fields модифицируют
 *      именно этот массив (т. е. идут через форму PUT/PATCH /binding).
 *
 *   2. FormUiSchema (FieldUiMeta per fieldKey) — ui-schema слой:
 *      {label?, placeholder?, help_text?, hidden?, display_order?}
 *      Пока нет отдельной таблицы — Floor-1 работает как pure-трансформация,
 *      consumer (HTTP-слой, будущая таблица form_ui_schema) обёртывает.
 *      hide_field / show_field / set_help_text / relabel_field (placeholder-часть)
 *      модифицируют этот слой.
 *
 *   Таким образом Floor-1 редактор = чистые функции трансформации над
 *   (BindingField[], FormUiSchema). HTTP API-скелет передаёт обе структуры
 *   в теле запроса и возвращает трансформированные.
 *
 * 6 операций (= Floor-1 kinds, T-0074 FLOOR1_EDIT_KINDS):
 *   relabel_field   — обновить label поля (BindingField.label + FieldUiMeta.label).
 *   toggle_required — переключить required/optional у поля (BindingField.required).
 *   hide_field      — установить FieldUiMeta.hidden = true.
 *   show_field      — установить FieldUiMeta.hidden = false.
 *   reorder_fields  — задать display_order для набора полей.
 *   set_help_text   — задать FieldUiMeta.help_text поля.
 *
 * Бэкенд-валидация:
 *   1. classifyAuthoringFloor(change) — если requiredFloor='2' → 409 WRONG_FLOOR.
 *   2. Схема-валидность после правки: ключ fieldKey существует в fields[].key.
 *   3. named-binding не ломается: если toggle_required/relabel меняет BindingField,
 *      checkBindingCompat() должна давать ok:true (поля не добавляются/удаляются).
 *
 * Источник: docs/design/extensibility-and-authoring.md §4 / §9.1
 * Прецеденты: checkBindingCompat (T-0072), classifyAuthoringFloor (T-0074)
 */

import {
  classifyAuthoringFloor,
  type FormEditKind,
} from "./authoring-floor-classifier.js";
import {
  type BindingField,
} from "./binding-compat.js";

// ---------------------------------------------------------------------------
// FieldUiMeta — UI-schema слой одного поля
// ---------------------------------------------------------------------------

/**
 * UI-schema слой одного поля формы.
 * Все поля опциональны: отсутствие = «дефолт из BindingField / не задан».
 *
 * label         — человекочитаемое название (переопределяет BindingField.label).
 * placeholder   — placeholder текстового поля.
 * help_text     — подсказка под полем (ADR §9.1 — set_help_text).
 * hidden        — скрыто ли поле (hide_field / show_field).
 * display_order — порядок отображения (reorder_fields). Меньше = выше.
 */
export interface FieldUiMeta {
  label?: string;
  placeholder?: string;
  help_text?: string;
  hidden?: boolean;
  display_order?: number;
}

/**
 * UI-schema формы: карта fieldKey → FieldUiMeta.
 * Все ключи — валидные fieldKey из BindingField[].key.
 */
export type FormUiSchema = Record<string, FieldUiMeta>;

// ---------------------------------------------------------------------------
// Floor1EditRequest — дискриминированный union 6 операций
// ---------------------------------------------------------------------------

/** relabel_field: изменить label поля (и необязательно placeholder). */
export interface RelabelFieldRequest {
  kind: "relabel_field";
  fieldKey: string;
  label: string;
  placeholder?: string;
}

/** toggle_required: переключить required/optional у поля. */
export interface ToggleRequiredRequest {
  kind: "toggle_required";
  fieldKey: string;
  required: boolean;
}

/** hide_field: скрыть поле (FieldUiMeta.hidden = true). */
export interface HideFieldRequest {
  kind: "hide_field";
  fieldKey: string;
}

/** show_field: показать скрытое поле (FieldUiMeta.hidden = false). */
export interface ShowFieldRequest {
  kind: "show_field";
  fieldKey: string;
}

/**
 * reorder_fields: задать display_order нескольким полям.
 * Каждый элемент orders[] — пара {fieldKey, displayOrder}.
 * Поля, не перечисленные в orders[], сохраняют текущий порядок.
 */
export interface ReorderFieldsRequest {
  kind: "reorder_fields";
  orders: Array<{ fieldKey: string; displayOrder: number }>;
}

/** set_help_text: задать/обновить help-text поля. */
export interface SetHelpTextRequest {
  kind: "set_help_text";
  fieldKey: string;
  helpText: string;
}

/** Дискриминированный union 6 Floor-1 операций. */
export type Floor1EditRequest =
  | RelabelFieldRequest
  | ToggleRequiredRequest
  | HideFieldRequest
  | ShowFieldRequest
  | ReorderFieldsRequest
  | SetHelpTextRequest;

// ---------------------------------------------------------------------------
// Floor1ValidationError / Floor1ValidationResult
// ---------------------------------------------------------------------------

/** Тип ошибки валидации Floor-1 запроса. */
export type Floor1ValidationErrorCode =
  | "WRONG_FLOOR"        // kind классифицирован Floor-2 → 409
  | "UNKNOWN_FIELD"      // fieldKey не найден в fields[]
  | "EMPTY_LABEL"        // label пустая строка
  | "EMPTY_HELP_TEXT"    // helpText пустая строка
  | "EMPTY_ORDERS"       // orders пустой массив
  | "DUPLICATE_FIELD_KEY"; // дубль fieldKey в orders[]

/** Одна ошибка бэкенд-валидации. */
export interface Floor1ValidationError {
  code: Floor1ValidationErrorCode;
  message: string;
  fieldKey?: string;
}

/** Результат бэкенд-валидации Floor-1 запроса. */
export type Floor1ValidationResult =
  | { ok: true }
  | { ok: false; errors: Floor1ValidationError[] };

// ---------------------------------------------------------------------------
// Floor1EditResult — результат применения правки
// ---------------------------------------------------------------------------

/**
 * Результат applyFloor1Edit.
 *
 * Успех: { ok: true, fields, uiSchema } — обновлённые структуры.
 * Ошибка: { ok: false, errors } — нарушения валидации.
 */
export type Floor1EditResult =
  | { ok: true; fields: BindingField[]; uiSchema: FormUiSchema }
  | { ok: false; errors: Floor1ValidationError[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Создаёт копию BindingField[] (shallow per element, key/type/required/label).
 * Гарантирует неизменяемость оригинала при трансформации.
 */
function cloneFields(fields: BindingField[]): BindingField[] {
  return fields.map((f) => ({ ...f }));
}

/**
 * Создаёт копию FormUiSchema с deep-копией каждого FieldUiMeta.
 */
function cloneUiSchema(schema: FormUiSchema): FormUiSchema {
  const result: FormUiSchema = {};
  for (const [key, meta] of Object.entries(schema)) {
    result[key] = { ...meta };
  }
  return result;
}

/**
 * Возвращает FieldUiMeta для ключа (создаёт пустой объект если отсутствует).
 * Мутирует переданный schema — используется только после cloneUiSchema().
 */
function getMeta(schema: FormUiSchema, fieldKey: string): FieldUiMeta {
  if (!Object.prototype.hasOwnProperty.call(schema, fieldKey)) {
    schema[fieldKey] = {};
  }
  return schema[fieldKey] as FieldUiMeta;
}

// ---------------------------------------------------------------------------
// validateFloor1Request — бэкенд-валидация входа
// ---------------------------------------------------------------------------

/**
 * Бэкенд-валидация Floor-1 запроса.
 *
 * Выполняет три проверки (ADR §9.1):
 *   1. classifyAuthoringFloor(change) — если requiredFloor='2' → WRONG_FLOOR.
 *   2. Все fieldKey из запроса существуют в fields[].
 *   3. Специфичные проверки (empty label, empty help_text и т. д.).
 *
 * Пуро — не модифицирует fields / uiSchema. Не вызывает checkBindingCompat
 * здесь, т.к. Floor-1 операции не добавляют/удаляют поля (binding-структура
 * не изменяется для hide/show/help; для relabel/toggle — ключи остаются теми же).
 * checkBindingCompat вызывается в HTTP-слое при финальной записи.
 *
 * @param request - Floor1EditRequest для проверки.
 * @param fields  - Текущий BindingField[] (для проверки существования fieldKey).
 * @returns Floor1ValidationResult
 */
export function validateFloor1Request(
  request: Floor1EditRequest,
  fields: BindingField[],
): Floor1ValidationResult {
  const errors: Floor1ValidationError[] = [];

  // Проверка 1: classifyAuthoringFloor — WRONG_FLOOR если Floor-2
  const classifyResult = classifyAuthoringFloor({
    kind: request.kind as FormEditKind,
  });
  if (classifyResult.requiredFloor === "2") {
    errors.push({
      code: "WRONG_FLOOR",
      message: `Edit kind "${request.kind}" requires Floor-2 (agent/code); use Floor-2 authoring path. Reason: ${classifyResult.reason}`,
    });
    // Fail fast — Floor-2 guard is definitive; no point continuing
    return { ok: false, errors };
  }

  // Текущие ключи полей
  const fieldKeys = new Set(fields.map((f) => f.key));

  // Проверка 2 + специфичные — по виду операции
  switch (request.kind) {
    case "relabel_field": {
      if (!fieldKeys.has(request.fieldKey)) {
        errors.push({
          code: "UNKNOWN_FIELD",
          message: `Field "${request.fieldKey}" does not exist in the form binding`,
          fieldKey: request.fieldKey,
        });
      }
      if (request.label.trim().length === 0) {
        errors.push({
          code: "EMPTY_LABEL",
          message: "label must be a non-empty string",
          fieldKey: request.fieldKey,
        });
      }
      break;
    }

    case "toggle_required": {
      if (!fieldKeys.has(request.fieldKey)) {
        errors.push({
          code: "UNKNOWN_FIELD",
          message: `Field "${request.fieldKey}" does not exist in the form binding`,
          fieldKey: request.fieldKey,
        });
      }
      break;
    }

    case "hide_field": {
      if (!fieldKeys.has(request.fieldKey)) {
        errors.push({
          code: "UNKNOWN_FIELD",
          message: `Field "${request.fieldKey}" does not exist in the form binding`,
          fieldKey: request.fieldKey,
        });
      }
      break;
    }

    case "show_field": {
      if (!fieldKeys.has(request.fieldKey)) {
        errors.push({
          code: "UNKNOWN_FIELD",
          message: `Field "${request.fieldKey}" does not exist in the form binding`,
          fieldKey: request.fieldKey,
        });
      }
      break;
    }

    case "reorder_fields": {
      if (request.orders.length === 0) {
        errors.push({
          code: "EMPTY_ORDERS",
          message: "orders must be a non-empty array",
        });
        break;
      }
      const seen = new Set<string>();
      for (const { fieldKey } of request.orders) {
        if (!fieldKeys.has(fieldKey)) {
          errors.push({
            code: "UNKNOWN_FIELD",
            message: `Field "${fieldKey}" does not exist in the form binding`,
            fieldKey,
          });
        }
        if (seen.has(fieldKey)) {
          errors.push({
            code: "DUPLICATE_FIELD_KEY",
            message: `Duplicate fieldKey "${fieldKey}" in reorder_fields orders`,
            fieldKey,
          });
        }
        seen.add(fieldKey);
      }
      break;
    }

    case "set_help_text": {
      if (!fieldKeys.has(request.fieldKey)) {
        errors.push({
          code: "UNKNOWN_FIELD",
          message: `Field "${request.fieldKey}" does not exist in the form binding`,
          fieldKey: request.fieldKey,
        });
      }
      if (request.helpText.trim().length === 0) {
        errors.push({
          code: "EMPTY_HELP_TEXT",
          message: "helpText must be a non-empty string",
          fieldKey: request.fieldKey,
        });
      }
      break;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// applyFloor1Edit — основная чистая функция
// ---------------------------------------------------------------------------

/**
 * Применяет Floor-1 правку к (fields, uiSchema) и возвращает обновлённые структуры.
 *
 * Порядок:
 *   1. validateFloor1Request(request, fields) — WRONG_FLOOR / UNKNOWN_FIELD и пр.
 *   2. Применяет трансформацию к копиям (cloneFields / cloneUiSchema).
 *   3. Возвращает { ok: true, fields, uiSchema } или { ok: false, errors }.
 *
 * Чистота: не модифицирует входные fields / uiSchema. Не вызывает I/O.
 * Переживает агента-офлайн (детерминированная кнопочная трансформация).
 *
 * @param request   - Floor1EditRequest (одна из 6 операций).
 * @param fields    - Текущий BindingField[] из form_binding.
 * @param uiSchema  - Текущий FormUiSchema (может быть пустым {}).
 * @returns Floor1EditResult
 */
export function applyFloor1Edit(
  request: Floor1EditRequest,
  fields: BindingField[],
  uiSchema: FormUiSchema,
): Floor1EditResult {
  // Валидация
  const validation = validateFloor1Request(request, fields);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  // Работаем с копиями
  const newFields = cloneFields(fields);
  const newSchema = cloneUiSchema(uiSchema);

  switch (request.kind) {
    case "relabel_field": {
      // 1a. Обновляем BindingField.label
      const field = newFields.find((f) => f.key === request.fieldKey);
      if (field !== undefined) {
        field.label = request.label;
      }
      // 1b. Обновляем UI-schema layer
      const meta = getMeta(newSchema, request.fieldKey);
      meta.label = request.label;
      if (request.placeholder !== undefined) {
        meta.placeholder = request.placeholder;
      }
      break;
    }

    case "toggle_required": {
      // Обновляем BindingField.required (единственное место required)
      const field = newFields.find((f) => f.key === request.fieldKey);
      if (field !== undefined) {
        field.required = request.required;
      }
      break;
    }

    case "hide_field": {
      const meta = getMeta(newSchema, request.fieldKey);
      meta.hidden = true;
      break;
    }

    case "show_field": {
      const meta = getMeta(newSchema, request.fieldKey);
      meta.hidden = false;
      break;
    }

    case "reorder_fields": {
      for (const { fieldKey, displayOrder } of request.orders) {
        const meta = getMeta(newSchema, fieldKey);
        meta.display_order = displayOrder;
      }
      break;
    }

    case "set_help_text": {
      const meta = getMeta(newSchema, request.fieldKey);
      meta.help_text = request.helpText;
      break;
    }
  }

  return { ok: true, fields: newFields, uiSchema: newSchema };
}
