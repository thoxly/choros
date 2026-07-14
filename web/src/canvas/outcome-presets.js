/* ============================================================================
   CHOROS — outcome-presets.js
   T-0353 [E16]: Pure preset → named-branch ladder definitions.

   Design (spec §5):
     - Preset = a named bundle of 1..N outcomes, each with a semantic name
       (the named branch on the canvas) and a default target kind.
     - Presets kill "outcome config hell"; ~90% of user tasks fit 4 cases.
     - "Свои исходы" (custom) = escape hatch: the user defines N named outcomes.
     - Styling (text/color/requires-comment/confirm) lives in the PROPERTIES PANEL
       and is NOT encoded here — only the semantic outcome names and routing.

   CRITICAL: outcomeName on a SequenceFlow is NOT a DMN condition.
     - DMN gateway: DATA decides the branch (sum > 5M → юрист).
     - Outcome button: HUMAN decides the branch (Согласовать / Отклонить).
     Two mechanisms; do NOT conflate them.

   Exports:
     OUTCOME_PRESETS          — ordered array of PresetDef (UI picklist source).
     CUSTOM_PRESET_ID         — sentinel for "Свои исходы".
     getPreset(id)            — look up a PresetDef by id.
     defaultOutcomesFor(id)   — return a copy of the outcomes array for a preset.
   ============================================================================ */

/**
 * @typedef {Object} OutcomeDef
 * @property {string} name          — Semantic outcome name (e.g. "Согласовать").
 *                                    Serialised as choros:outcomeName on the SequenceFlow.
 * @property {'next'|'end'|'back'|'subprocess-sync'|'process-async'} targetKind
 *                                  — Default routing intent.  The resolver uses this
 *                                    when no explicit override is stored on the flow.
 * @property {boolean} [isBack]     — Convenience flag: this outcome routes backward (→ назад).
 * @property {string}  [color]      — Suggested button accent (UI hint, NOT schema data).
 */

/**
 * @typedef {Object} PresetDef
 * @property {string}       id       — Stable kebab-case id (stored in choros:outcomePreset).
 * @property {string}       label    — Human-readable label shown in the preset picker.
 * @property {string}       hint     — One-line description of when to use this preset.
 * @property {OutcomeDef[]} outcomes — Ordered list of outcomes in this preset.
 */

/** Sentinel for the "define your own" escape hatch. */
export const CUSTOM_PRESET_ID = 'custom';

/**
 * Ordered preset ladder.  Shown in this order in the panel picker.
 *
 * Targets:
 *   next              → the default next step / end of happy path
 *   end               → terminates the process instance
 *   back              → routes back (commonly a loop-back to a prior step)
 *   subprocess-sync   → launches a sub-process (synchronous, waits for result)
 *   process-async     → triggers a parallel process (fire-and-forget)
 *
 * @type {PresetDef[]}
 */
export const OUTCOME_PRESETS = [
  {
    id: 'done',
    label: 'Готово',
    hint: 'Один исход — шаг выполнен, идём дальше (~50% шагов)',
    outcomes: [
      { name: 'Готово', targetKind: 'next', color: 'primary' },
    ],
  },
  {
    id: 'decision',
    label: 'Решение',
    hint: 'Два исхода: согласовать или отклонить',
    outcomes: [
      { name: 'Согласовать', targetKind: 'next',  color: 'success' },
      { name: 'Отклонить',   targetKind: 'end',   color: 'danger'  },
    ],
  },
  {
    id: 'decision-rework',
    label: 'Решение с доработкой',
    hint: 'Три исхода: согласовать / отклонить / на доработку (возврат назад)',
    outcomes: [
      { name: 'Согласовать',   targetKind: 'next',  color: 'success' },
      { name: 'Отклонить',     targetKind: 'end',   color: 'danger'  },
      { name: 'На доработку',  targetKind: 'back',  color: 'warning', isBack: true },
    ],
  },
  {
    id: CUSTOM_PRESET_ID,
    label: 'Свои исходы',
    hint: 'Определите N именованных исходов самостоятельно',
    outcomes: [],   // user fills in via the panel
  },
];

/**
 * Look up a PresetDef by its id.
 * Returns undefined when not found (caller should handle gracefully).
 *
 * @param {string} id
 * @returns {PresetDef | undefined}
 */
export function getPreset(id) {
  return OUTCOME_PRESETS.find((p) => p.id === id);
}

/**
 * Return a deep copy of the outcomes array for a preset id.
 * Returns an empty array when the preset is not found or has no outcomes.
 *
 * @param {string} id
 * @returns {OutcomeDef[]}
 */
export function defaultOutcomesFor(id) {
  const preset = getPreset(id);
  if (!preset) return [];
  // Deep copy so callers can mutate without affecting the canonical definition.
  return preset.outcomes.map((o) => ({ ...o }));
}
