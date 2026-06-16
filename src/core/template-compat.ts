/**
 * T-0235 · T-0124: Template Compat Validator
 *
 * Pure function — no I/O, no DB, no network, no filesystem, no env reads.
 * Зеркалит purity-дисциплину binding-compat.ts (T-0072 · checkBindingCompat)
 * и report-page-compat.ts (T-0176 · checkReportPageDepFields).
 *
 * Exports:
 *   - TemplateDepKind        — тип зависимости ('read' | 'aggregate')
 *   - TemplateDep            — одна запись dep (зеркало row template_dep)
 *   - TemplateDepViolation   — один экземпляр нарушения (зеркало DepViolation)
 *   - TemplateDepViolationType — тип нарушения
 *   - TemplateCompatResult   — результат проверки
 *   - TemplateJsonSchema     — минимально-достаточный тип схемы (properties-only)
 *   - checkTemplateDepFields — основная чистая функция (§2.9 ADR T-0124)
 *
 * Прецедентная ссылка (NF-1 ADR T-0124 §2.9, обязательна):
 *   checkTemplateDepFields является расширением паттерна checkBindingCompat (T-0072)
 *   и checkReportPageDepFields (T-0176 / T-0121). Это один контрол плейн согласованности
 *   «артефакт ↔ поля схемы», не четвёртый механизм. TemplateDep — зеркало PageDep (T-0121).
 *
 * НЕ является публичной точкой расширения: логика deструктив-discipline (§5 T-0121)
 * принадлежит HTTP-handler слою (409/force/депромоут/audit). Эта функция реализует
 * только missing_in_schema — идентично checkReportPageDepFields.
 *
 * Деструктив-дисциплина (ADR §2.9):
 *   - Мягкое (relabel, add field, enum widening) → применяется + warnings.
 *   - Деструктивное (drop/rename field_key при non-stale dep) → 409 (решение = HTTP-handler).
 *   - Escape (force:true) → dep stale=true + шаблон депромоут tier='draft' + audit-event.
 *   Эта pure-функция сигнализирует нарушение; enforcement = HTTP-handler (не здесь).
 */

// ---------------------------------------------------------------------------
// Exported types (frozen public surface — ADR T-0124 §2.9)
// ---------------------------------------------------------------------------

/** Тип зависимости шаблона от поля схемы. Vocab закрытый (mirrors DepKind T-0121). */
export type TemplateDepKind = "read" | "aggregate";

/** Одна запись зависимости шаблона от поля реестра (зеркало row template_dep). */
export interface TemplateDep {
  templateId: string;
  registryDefId: string;
  fieldKey: string;
  depKind: TemplateDepKind;
  stale?: boolean;
}

/**
 * Тип нарушения совместимости.
 * - missing_in_schema: field_key отсутствует в record_schema.properties реестра.
 *
 * Vocab закрытый; расширяется аддитивно, как в T-0121/T-0072.
 */
export type TemplateDepViolationType = "missing_in_schema";

/** Один экземпляр нарушения совместимости (зеркало DepViolation из T-0121). */
export interface TemplateDepViolation {
  type: TemplateDepViolationType;
  templateId: string;
  registryDefId: string;
  fieldKey: string;
  message: string;
}

/** Результат проверки совместимости deps шаблона со схемой реестра. */
export type TemplateCompatResult =
  | { ok: true }
  | { ok: false; violations: TemplateDepViolation[] };

/**
 * Минимально-достаточный тип JSON-Schema для нужд compat-проверки.
 * Только поле `properties` — достаточно для проверки field_key ∈ schema.
 * Зеркало JsonSchema из report-page-compat.ts (T-0121).
 */
export interface TemplateJsonSchema {
  properties?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// checkTemplateDepFields — core pure function (ADR T-0124 §2.9)
// ---------------------------------------------------------------------------

/**
 * Проверяет структурную совместимость зарегистрированных зависимостей шаблона
 * с текущим `record_schema` реестра (`registry_def.record_schema`).
 *
 * Для каждого `dep` в `deps`:
 *   dep.fieldKey ∉ recordSchema.properties → TemplateDepViolation{ type:'missing_in_schema', ... }
 *   dep.stale === true → пропускается (escape-хатч активирован, dep помечен stale).
 *
 * Все ключи присутствуют (или stale) → { ok: true }.
 *
 * @param deps         - Массив TemplateDep из template_dep.
 * @param recordSchema - Схема реестра (registry_def.record_schema).
 * @returns { ok: true } или { ok: false; violations: TemplateDepViolation[] }.
 *
 * Pre-conditions (callers must enforce before calling):
 *   - deps элементы уже прошли валидацию write-path guard при регистрации.
 *   - Дубли fieldKey в пределах одного templateId/registryDefId не проверяются здесь
 *     (write-path guard via UNIQUE constraint ADR §2.9).
 *
 * Прецедент: checkBindingCompat (T-0072) — аналогичная pure-функция для form_binding.
 * Прецедент: checkReportPageDepFields (T-0176/T-0121) — зеркало на стороне «потребляет поля».
 * Эта функция — то же расширение: T-0072 → T-0121 → T-0124 (один контрол плейн, NF-1).
 */
export function checkTemplateDepFields(
  deps: TemplateDep[],
  recordSchema: TemplateJsonSchema,
): TemplateCompatResult {
  const violations: TemplateDepViolation[] = [];

  // properties-объект из схемы; отсутствие properties ≡ пустой объект
  const props = recordSchema.properties ?? {};

  for (const dep of deps) {
    // Stale deps пропускаются: escape-хатч уже применён, dep отмечен stale=true
    // (force:true путь HTTP-handler: dep stale=true + шаблон депромоут + audit).
    if (dep.stale === true) {
      continue;
    }

    if (!(dep.fieldKey in props)) {
      violations.push({
        type: "missing_in_schema",
        templateId: dep.templateId,
        registryDefId: dep.registryDefId,
        fieldKey: dep.fieldKey,
        message: `Field key "${dep.fieldKey}" (dep on registry ${dep.registryDefId} for template ${dep.templateId}) is not declared in record_schema.properties`,
      });
    }
  }

  if (violations.length === 0) {
    return { ok: true };
  }
  return { ok: false, violations };
}
