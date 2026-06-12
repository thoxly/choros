/**
 * src/core/authoring-redlines.ts
 *
 * T-0078 · E11.7: Authoring Red-Lines Guard — default-DENY на необратимость
 * авторинг-операций (форм и объектных схем).
 *
 * Pure function — no I/O, no DB, no network, no filesystem, no env reads.
 * Зеркалит purity-дисциплину binding-compat.ts (T-0072 · checkBindingCompat)
 * и schema-change-classifier.ts (T-0177 · classifySchemaChange).
 *
 * Exports:
 *   - AuthoringOpKind          — вид авторинг-операции
 *   - AuthoringOp              — описание конкретной операции
 *   - AuthoringContext          — контекст поля (core-pinned flag)
 *   - AuthoringChangeClass      — класс изменения (non_destructive / destructive / core_pinned)
 *   - AuthoringRedLineConfirm   — semantic human-confirm (§4 ADR)
 *   - AuthoringRedLineDecision  — решение гарда
 *   - classifyAuthoringOp       — классификатор операции (чистая функция)
 *   - evaluateAuthoringRedLine  — gate function: allow / deny
 *
 * ADR references (обязательны, NF-1):
 *   - docs/design/extensibility-and-authoring.md §4 (RED-LINES: default-DENY
 *     на необратимость, semantic human-confirm, §9 гард 7).
 *   - docs/design/extensibility-and-authoring.md §5 (core/system-directory-поля:
 *     БЛОКИРУЕТ drop/rename/overwrite — extend-not-replace).
 *   - Прецедент T-0177 · classifySchemaChange (src/core/schema-change-classifier.ts):
 *     drop/rename/lossy → destructive; force escape-hatch для registry_def.record_schema.
 *     T-0078 = обобщение на авторинг-операции; для core-pinned полей escape-hatch
 *     запрещён (§5 ADR: «ядро БЛОКИРУЕТ delete/rename/overwrite системных полей»).
 *   - Прецедент T-0072 · checkBindingCompat (src/core/binding-compat.ts):
 *     один control plane согласованности «артефакт ↔ поля схемы».
 *
 * Примечание об алгоритме lossy-narrowing:
 *   isLossyFieldChange (ниже) реализует ту же логику, что private isLossyNarrowing
 *   в T-0177 (schema-change-classifier.ts). Алгоритм не копировался механически —
 *   он выведен из того же ADR §4 (number→integer, string→enum-сужение).
 *   FieldSchemaEntry импортируется из T-0177, а не переопределяется.
 *
 * НЕ является публичной точкой расширения: логика целиком здесь.
 * HTTP layer (будущий T-0073 Floor-1 редактор) импортирует evaluateAuthoringRedLine.
 */

import type { FieldSchemaEntry } from "./schema-change-classifier.js";

// ---------------------------------------------------------------------------
// Re-export FieldSchemaEntry for callers that need the type
// ---------------------------------------------------------------------------

export type { FieldSchemaEntry };

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * Вид авторинг-операции над полем формы или объектной схемы.
 * Vocab закрытый (аддитивное расширение при появлении новых операций).
 */
export type AuthoringOpKind =
  | "add_field"              // добавление нового поля (soft)
  | "drop_field"             // удаление поля (destructive / core_pinned)
  | "rename_field"           // переименование поля = drop старого + add нового (destructive / core_pinned)
  | "change_type"            // изменение типа / enum-состава (может быть destructive или soft)
  | "relabel"                // только title/description/help-text (soft)
  | "toggle_required"        // toggle required (soft)
  | "enum_change"            // изменение набора enum-значений (widening=soft, narrowing=destructive)
  | "lossy_live_migration";  // Camunda-grade перенос инстансов при деструктивном изменении schema
                             // (ADR §4 RED-LINES строки 154-155: «lossy live-migration» перечислен
                             // в одном ряду с drop/rename core-поля — категорический абсолют).
                             // Escape-hatch запрещён: core_pinned всегда, независимо от isCorePinned.
                             // Rollback при живых инстансах — ADR §7, строки 246-248.

/**
 * Описание конкретной авторинг-операции над одним полем.
 * Для change_type и enum_change обязательны oldSchema и newSchema.
 */
export interface AuthoringOp {
  kind: AuthoringOpKind;
  fieldKey: string;
  /** Старая схема поля — для change_type / enum_change. */
  oldSchema?: FieldSchemaEntry;
  /** Новая схема поля — для change_type / enum_change. */
  newSchema?: FieldSchemaEntry;
}

/**
 * Контекст поля: знает о core-pinned статусе.
 * isCorePinned=true = поле принадлежит core/system-directory (контрагенты,
 * оргструктура, пользователи — §5 ADR: extend-not-replace, БЛОКИРУЕТ drop/rename/overwrite).
 */
export interface AuthoringContext {
  isCorePinned: boolean;
}

/**
 * Класс изменения авторинг-операции.
 * - non_destructive: add field, relabel, toggle required, enum widening → проходит.
 * - destructive:     drop/rename/lossy на non-core поле → требует semantic confirm.
 * - core_pinned:     drop/rename/lossy на core-owned поле → безусловный deny.
 */
export type AuthoringChangeClass = "non_destructive" | "destructive" | "core_pinned";

/**
 * Semantic human-confirm (§4 ADR RED-LINES).
 * Подтверждение = переписать последствие словами, а не нажать OK.
 * consequenceStatement: человек ПИШЕТ последствие (≥10 символов, не пустой).
 * force: разрешён только для non-core (isCorePinned=false) полей.
 */
export interface AuthoringRedLineConfirm {
  /** Человек пишет последствие операции, напр: "поле amount будет удалено" */
  consequenceStatement: string;
  /** Разрешить деструктивную операцию (только для non-core полей) */
  force?: boolean;
}

/**
 * Решение гарда evaluateAuthoringRedLine.
 * Четыре ветки:
 *  1. allow non_destructive — операция безопасна, confirm не нужен.
 *  2. allow destructive — деструктив подтверждён semantic confirm'ом.
 *  3. deny requires_confirm — деструктив, confirm отсутствует.
 *  4. deny invalid_confirm — деструктив, confirm есть но невалиден:
 *       - force !== true, или < 10 символов (length floor), или
 *       - запрещённый шаблон авто-заполнения (isForbiddenTemplate).
 *  5. deny core_pinned — core-owned поле или lossy_live_migration; escape-hatch запрещён.
 */
export type AuthoringRedLineDecision =
  | { verdict: "allow"; classification: "non_destructive" }
  | {
      verdict: "allow";
      classification: "destructive";
      confirmedConsequence: string;
    }
  | {
      verdict: "deny";
      reason: "requires_confirm";
      classification: "destructive";
      requiresConfirm: true;
    }
  | {
      verdict: "deny";
      reason: "invalid_confirm";
      classification: "destructive";
      requiresConfirm: true;
    }
  | {
      verdict: "deny";
      reason: "core_pinned";
      classification: "core_pinned";
      requiresConfirm: false;
    };

// ---------------------------------------------------------------------------
// Internal: lossy type-narrowing classifier
// ---------------------------------------------------------------------------

/**
 * Проверяет, является ли изменение схемы поля «lossy narrowing» (деструктивным).
 *
 * Реализует ту же логику, что private isLossyNarrowing в T-0177
 * (schema-change-classifier.ts) — выведена из ADR §4 lossy_narrowing критерия:
 *   - number → integer (integer — строгое подмножество number)
 *   - string → enum с меньшим vocab (сужение допустимых значений)
 *   - enum widening (больше вариантов) или тот же тип → НЕ lossy.
 *
 * Прецедент: T-0177 · isLossyNarrowing (private) — алгоритм идентичен.
 */
function isLossyFieldChange(
  oldEntry: FieldSchemaEntry,
  newEntry: FieldSchemaEntry,
): boolean {
  const oldType = oldEntry.type;
  const newType = newEntry.type;

  // number → integer (loses fractional values)
  if (oldType === "number" && newType === "integer") {
    return true;
  }

  // string/number → enum с МЕНЬШИМ набором вариантов (narrowing)
  if (Array.isArray(newEntry.enum)) {
    const newEnumSize = newEntry.enum.length;
    if (Array.isArray(oldEntry.enum)) {
      // old enum → new enum: narrowing если новый набор строго меньше
      if (newEnumSize < oldEntry.enum.length) {
        return true;
      }
    } else {
      // Был открытый тип (string/number); теперь ограничен enum → narrowing
      if (oldType === "string" || oldType === "number" || oldType === "integer") {
        return true;
      }
    }
  }

  // enum widening (больше вариантов) или тип остался → не lossy
  return false;
}

// ---------------------------------------------------------------------------
// classifyAuthoringOp — core pure classifier (ADR §4/§5/§9 гард 7)
// ---------------------------------------------------------------------------

/**
 * Классифицирует авторинг-операцию как non_destructive / destructive / core_pinned.
 *
 * Алгоритм (ADR §4 RED-LINES + §5 core-owned):
 *   1. add_field → non_destructive (безопасно всегда).
 *   2. relabel / toggle_required → non_destructive (soft).
 *   3. drop_field / rename_field: если core-pinned → core_pinned; иначе → destructive.
 *   4. change_type / enum_change: lossy narrowing (isLossyFieldChange) ?
 *      — core-pinned → core_pinned
 *      — non-core → destructive
 *      : non_destructive (widening / no change).
 *
 * Pre-conditions: для change_type и enum_change caller передаёт op.oldSchema и op.newSchema.
 * Если они отсутствуют — операция считается non_destructive (консервативный дефолт: без
 * схемы невозможно классифицировать lossy; HTTP-слой обязан передавать схемы).
 *
 * @param op      — описание операции
 * @param context — контекст поля (core-pinned flag)
 */
export function classifyAuthoringOp(
  op: AuthoringOp,
  context: AuthoringContext,
): AuthoringChangeClass {
  switch (op.kind) {
    case "add_field":
      // Добавление нового поля — всегда безопасно (§4: add field → soft)
      return "non_destructive";

    case "relabel":
    case "toggle_required":
      // Мягкие операции — безопасны даже на core-pinned (extend-not-replace
      // позволяет читать/видеть, только drop/rename/overwrite заблокированы)
      return "non_destructive";

    case "drop_field":
    case "rename_field":
      // Необратимые операции — core-pinned = абсолютный запрет (§5 ADR)
      return context.isCorePinned ? "core_pinned" : "destructive";

    case "change_type": {
      // Проверяем lossy narrowing
      const old = op.oldSchema ?? {};
      const newS = op.newSchema ?? {};
      if (isLossyFieldChange(old, newS)) {
        return context.isCorePinned ? "core_pinned" : "destructive";
      }
      return "non_destructive";
    }

    case "enum_change": {
      // enum_change: widening = soft, narrowing = destructive
      const old = op.oldSchema ?? {};
      const newS = op.newSchema ?? {};
      if (isLossyFieldChange(old, newS)) {
        return context.isCorePinned ? "core_pinned" : "destructive";
      }
      return "non_destructive";
    }

    case "lossy_live_migration":
      // ADR §4 RED-LINES (строки 154-155): «lossy live-migration» — категорический абсолют,
      // перечислен в одном ряду с drop/rename core/system-directory-поля.
      // core_pinned БЕЗУСЛОВНО — escape-hatch запрещён независимо от isCorePinned.
      // (Camunda-grade перенос инстансов — риск живых данных; §7 ADR строки 246-248.)
      return "core_pinned";
  }
}

// ---------------------------------------------------------------------------
// Confirm validation
// ---------------------------------------------------------------------------

/** Минимальная длина consequenceStatement для semantic confirm (§4 ADR). */
const MIN_CONSEQUENCE_LENGTH = 10;

/**
 * Список запрещённых шаблонов авто-заполнения для consequenceStatement.
 *
 * Назначение: anti-autofill floor — блокирует программную/автоматическую
 * подстановку кнопочного OK вместо семантически осмысленного текста.
 * Семантическая проверка (понял ли человек последствие) — задача UI-слоя
 * (T-0073) и UX-формы; гард = последняя линия против авто-шаблонов.
 *
 * Категории запрещённых шаблонов:
 *  1. Одиночные слова-согласия (ru/en): "ok", "да", "yes", "no", "нет",
 *     "confirm", "подтверждаю", "confirmed" — case-insensitive, trimmed.
 *  2. Числовые последовательности: только цифры (1234567890, 000000000).
 *  3. Повторяющийся символ × N (aaaaaaaaaa, ----------, ..........):
 *     строка длиной ≥2 из одного и того же символа.
 *
 * Ограничение: гард НЕ проверяет полную семантику (требует LLM-судьи,
 * исключённого из scope). Граница 10 символов + forbidden-list = минимальный
 * ненулевой барьер против кнопки-OK и авто-заполнения; истинная семантическая
 * валидация — UI-слой (T-0073).
 */
const FORBIDDEN_SINGLE_WORDS = new Set([
  "ok", "да", "yes", "no", "нет", "confirm", "подтверждаю", "confirmed",
]);

/** Regexp: строка целиком из цифр (любой длины) */
const RE_DIGITS_ONLY = /^\d+$/;

/** Regexp: строка из одного повторяющегося символа (≥2 повтора) */
const RE_REPEATED_CHAR = /^(.)\1+$/;

/**
 * Проверяет, является ли consequenceStatement запрещённым шаблоном авто-заполнения.
 * Возвращает true, если строка попадает в один из запрещённых классов.
 */
function isForbiddenTemplate(statement: string): boolean {
  const trimmed = statement.trim().toLowerCase();

  // Категория 1: одиночные слова-согласия
  if (FORBIDDEN_SINGLE_WORDS.has(trimmed)) {
    return true;
  }

  // Категория 2: только цифры (числовая последовательность)
  if (RE_DIGITS_ONLY.test(trimmed)) {
    return true;
  }

  // Категория 3: повторяющийся символ (aaaaaaaaaa, ----------)
  if (trimmed.length >= 2 && RE_REPEATED_CHAR.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Проверяет валидность semantic confirm (§4 ADR RED-LINES).
 *
 * Три условия:
 *  1. force === true — явное намерение.
 *  2. consequenceStatement.trim().length >= 10 — length floor против пустого флага.
 *  3. consequenceStatement не является запрещённым шаблоном авто-заполнения
 *     (isForbiddenTemplate) — anti-autofill барьер.
 *
 * force=true обязателен (только для non-core; core_pinned блокируется до этой проверки).
 *
 * Комментарий к дизайну: length=10 — не семантическая проверка (машинно
 * семантику не проверить без LLM-судьи). Это length-floor = минимальный
 * барьер против OK-флага. Истинная семантическая валидация — UX-слой (T-0073).
 */
function isValidConfirm(confirm: AuthoringRedLineConfirm): boolean {
  if (confirm.force !== true) {
    return false;
  }
  if (typeof confirm.consequenceStatement !== "string") {
    return false;
  }
  const trimmed = confirm.consequenceStatement.trim();
  if (trimmed.length < MIN_CONSEQUENCE_LENGTH) {
    return false;
  }
  if (isForbiddenTemplate(confirm.consequenceStatement)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// evaluateAuthoringRedLine — gate function (ADR §9 гард 7 default-DENY)
// ---------------------------------------------------------------------------

/**
 * Применяет red-line discipline к авторинг-операции.
 *
 * Механика default-DENY (ADR §9 гард 7):
 *   - non_destructive → allow (confirm не требуется).
 *   - core_pinned → deny(core_pinned) БЕЗ исключений (§5: «ядро БЛОКИРУЕТ
 *     delete/rename/overwrite стандартных полей» — escape-hatch запрещён).
 *   - destructive без confirm → deny(requires_confirm).
 *   - destructive + confirm невалиден → deny(invalid_confirm).
 *   - destructive + confirm валиден → allow(destructive, confirmedConsequence).
 *
 * Семантический confirm (§4 ADR):
 *   Подтверждение — НЕ флаг, а consequenceStatement ≥10 символов (человек
 *   ПИШЕТ что потеряется, не нажимает «OK»). force=true обязателен.
 *
 * @param op      — описание операции
 * @param context — контекст поля
 * @param confirm — опциональный semantic confirm
 */
export function evaluateAuthoringRedLine(
  op: AuthoringOp,
  context: AuthoringContext,
  confirm?: AuthoringRedLineConfirm,
): AuthoringRedLineDecision {
  const classification = classifyAuthoringOp(op, context);

  switch (classification) {
    case "non_destructive":
      return { verdict: "allow", classification: "non_destructive" };

    case "core_pinned":
      // §5 ADR: core-owned поля абсолютно защищены; escape-hatch не предусмотрен.
      return {
        verdict: "deny",
        reason: "core_pinned",
        classification: "core_pinned",
        requiresConfirm: false,
      };

    case "destructive": {
      // Default-DENY: без confirm → deny
      if (confirm === undefined || confirm === null) {
        return {
          verdict: "deny",
          reason: "requires_confirm",
          classification: "destructive",
          requiresConfirm: true,
        };
      }
      // Confirm присутствует — проверяем семантическую валидность
      if (!isValidConfirm(confirm)) {
        return {
          verdict: "deny",
          reason: "invalid_confirm",
          classification: "destructive",
          requiresConfirm: true,
        };
      }
      // Валидный confirm → allow с сохранением consequenceStatement (аудит-след)
      return {
        verdict: "allow",
        classification: "destructive",
        confirmedConsequence: confirm.consequenceStatement,
      };
    }
  }
}
