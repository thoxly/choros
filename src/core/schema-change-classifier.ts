/**
 * src/core/schema-change-classifier.ts
 *
 * T-0177 · T-0121c: Schema-change classifier for registry_def.record_schema updates.
 *
 * Pure function — no I/O, no DB, no network, no filesystem, no env reads.
 * Зеркалит purity-дисциплину binding-compat.ts (T-0072 · checkBindingCompat)
 * и report-page-compat.ts (T-0176 · checkReportPageDepFields).
 *
 * Exports:
 *   - AffectedDep        — одна запись о затронутой зависимости
 *   - SchemaChangeClass  — результат классификации (softWarnings + destructiveDeps)
 *   - FieldSchemaEntry   — тип поля в record_schema.properties
 *   - classifySchemaChange — основная чистая функция (ADR §5)
 *
 * ADR references (T-0121 §5.2 — деструктивные изменения):
 *   - drop field_key: ключ есть в oldSchema.properties, нет в newSchema.properties
 *     → destructive для всех активных deps с этим field_key.
 *   - lossy type-narrowing при dep_kind='aggregate':
 *       number→integer, string→enum-сужение (меньше вариантов) → destructive.
 *   - type-narrowing при dep_kind='read' → soft (warning only).
 *   - add field, enum widening, relabel (title/description), toggle required → soft.
 *
 * Прецедентная ссылка (NF-1 ADR §3, обязательна):
 *   classifySchemaChange расширяет паттерн checkBindingCompat (T-0072) и
 *   checkReportPageDepFields (T-0176) — один контрол плейн согласованности
 *   «артефакт ↔ поля схемы». Этот модуль знает OLD и NEW схему (schema-change
 *   API), поэтому реализует lossy_narrowing (T-0176 carry: из ADR §3 — триггер
 *   принадлежит T-0177, не T-0176).
 *
 * НЕ является публичной точкой расширения: логика находится целиком здесь.
 * HTTP layer (src/http/registry-defs.ts) импортирует classifySchemaChange.
 */

import type { DepKind } from "./report-page-compat.js";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Тип поля в record_schema.properties (минимально-достаточный для классификатора). */
export interface FieldSchemaEntry {
  type?: string;
  enum?: unknown[];
  title?: string;
  description?: string;
  required?: boolean;
}

/**
 * Одна запись о затронутой зависимости при изменении схемы.
 * Shape машинно-читаемый (NF-5 ADR, NF-7 spec — payload для T-0084 changelog).
 *
 * Extends report_page_dep shape additive (NF-1): optional template_id/template_slug
 * fields added for template_dep rows (T-0235/T-0124 §2.9 / FF-TEMPLATE-COHERENCE).
 * dep_source discriminates which table the dep came from:
 *   "report_page" (default) — page_id/page_slug are populated, template_id/template_slug absent.
 *   "template"              — template_id/template_slug are populated, page_id/page_slug absent.
 * One classifier, one dep-set, no forked path (NF-1 — mirrors report_page_dep exactly).
 */
export interface AffectedDep {
  /** UUID report_page (populated for dep_source='report_page'; absent for template deps). */
  page_id?: string;
  /** URL-safe slug страницы (populated for dep_source='report_page'; absent for template deps). */
  page_slug?: string;
  /** UUID template_def (populated for dep_source='template'; absent for report_page deps). */
  template_id?: string;
  /** Human-readable id/slug of template (populated for dep_source='template'). */
  template_slug?: string;
  registry_def_id: string; // UUID registry_def
  field_key: string;       // ключ поля в record_schema.properties
  dep_kind: DepKind;       // 'read' | 'aggregate'
  /** Discriminates the dep source table. Default 'report_page' (backward-compatible). */
  dep_source?: "report_page" | "template";
}

/**
 * Результат классификации schema-change (ADR §5.1/§5.2).
 * softWarnings: мягкие изменения — операция проходит, в ответе warnings[].
 * destructiveDeps: деструктивные — блокируют без force (409).
 */
export interface SchemaChangeClassification {
  softWarnings: AffectedDep[];
  destructiveDeps: AffectedDep[];
}

/** Минимально-достаточный тип JSON-Schema (properties-only + type + enum). */
export interface JsonSchemaForClassify {
  properties?: Record<string, FieldSchemaEntry | unknown>;
}

// ---------------------------------------------------------------------------
// Internal: type-narrowing classifier (ADR §5.2 lossy_narrowing criterion)
// ---------------------------------------------------------------------------

/**
 * Проверяет, является ли переход old→new типа «lossy narrowing» (деструктивным).
 *
 * ADR §5.2 lossy type-narrowing критерий (при dep_kind='aggregate'):
 *   - number → integer (integer — строгое подмножество number: теряем дробные)
 *   - string → enum с меньшим vocab (сужение допустимых значений)
 *   - расширение → сужение (enum с большим → меньшим набором)
 *
 * При dep_kind='read' narrowing → soft (warning), не destructive.
 * ADD/RELABEL/WIDEN → не lossy.
 */
function isLossyNarrowing(
  oldEntry: FieldSchemaEntry,
  newEntry: FieldSchemaEntry,
): boolean {
  const oldType = oldEntry.type;
  const newType = newEntry.type;

  // number → integer (loses fractional values)
  if (oldType === "number" && newType === "integer") {
    return true;
  }

  // string/number → enum with FEWER variants (narrowing)
  if (Array.isArray(newEntry.enum)) {
    const newEnumSize = newEntry.enum.length;
    if (Array.isArray(oldEntry.enum)) {
      // old enum → new enum: narrowing if new set is strictly smaller
      if (newEnumSize < oldEntry.enum.length) {
        return true;
      }
    } else {
      // Was an open type (string/number); now constrained to enum → narrowing
      // Only flag as lossy if old type was compatible (string or number, not boolean/object/array)
      if (oldType === "string" || oldType === "number" || oldType === "integer") {
        return true;
      }
    }
  }

  // enum widening (more variants) or type stays same → not lossy
  return false;
}

// ---------------------------------------------------------------------------
// classifySchemaChange — core pure function (ADR §5 / spec FR-6)
// ---------------------------------------------------------------------------

/**
 * Классифицирует изменение record_schema реестра относительно активных зависимостей
 * страниц (`report_page_dep` с `stale=false`).
 *
 * Для каждого dep из `activeDeps`:
 *   1. field_key ∉ newSchema.properties → destructive (drop/rename).
 *   2. field_key ∈ newSchema.properties + lossy type narrowing при dep_kind='aggregate'
 *      → destructive.
 *   3. field_key ∈ newSchema.properties + lossy type narrowing при dep_kind='read'
 *      → soft warning.
 *   4. Всё остальное (add field, relabel, widen, toggle required) → нет нарушения
 *      для этого dep; если поле вообще не трогалось — тем более нет.
 *
 * Поля, которых не было в activeDeps, не влияют на классификацию
 * (нет зависимостей — нет защищаемых страниц).
 *
 * @param oldSchema    — текущий record_schema реестра (из БД).
 * @param newSchema    — новый record_schema из тела запроса.
 * @param activeDeps   — активные (stale=false) report_page_dep для данного registry_def.
 * @returns { softWarnings, destructiveDeps }
 *
 * Pre-conditions (HTTP layer должен обеспечить):
 *   - activeDeps — только stale=false строки для данного registry_def_id.
 *   - Нет дублей (page_id, field_key): гарантируется UNIQUE constraint §2.2 ADR.
 *
 * Прецедент: checkBindingCompat (T-0072) + checkReportPageDepFields (T-0176).
 */
export function classifySchemaChange(
  oldSchema: JsonSchemaForClassify,
  newSchema: JsonSchemaForClassify,
  activeDeps: AffectedDep[],
): SchemaChangeClassification {
  const softWarnings: AffectedDep[] = [];
  const destructiveDeps: AffectedDep[] = [];

  const oldProps = oldSchema.properties ?? {};
  const newProps = newSchema.properties ?? {};

  for (const dep of activeDeps) {
    const { field_key, dep_kind } = dep;

    // Case 1: field dropped (or renamed — equivalent to drop for existing deps)
    if (!(field_key in newProps)) {
      destructiveDeps.push(dep);
      continue;
    }

    // field_key still exists in new schema; check for lossy narrowing
    const oldEntry = (field_key in oldProps)
      ? (oldProps[field_key] as FieldSchemaEntry)
      : {};
    const newEntry = newProps[field_key] as FieldSchemaEntry;

    const lossy = isLossyNarrowing(
      typeof oldEntry === "object" && oldEntry !== null ? oldEntry as FieldSchemaEntry : {},
      typeof newEntry === "object" && newEntry !== null ? newEntry as FieldSchemaEntry : {},
    );

    if (lossy) {
      if (dep_kind === "aggregate") {
        // Case 2: lossy narrowing at aggregate dep → destructive (ADR §5.2)
        destructiveDeps.push(dep);
      } else {
        // Case 3: lossy narrowing at read dep → soft warning (ADR §5.2 last bullet)
        softWarnings.push(dep);
      }
    }
    // Case 4: no change or soft change (add/relabel/widen/toggle required) — no action
  }

  return { softWarnings, destructiveDeps };
}
