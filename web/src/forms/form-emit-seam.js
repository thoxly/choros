/**
 * web/src/forms/form-emit-seam.js  (T-0545 · E-FORMS AI-emit seam)
 *
 * CLIENT-SIDE EMIT SEAM — FF-T0545-SAME-GATE / FF-T0545-FLOOR2-FLAG.
 *
 * Takes a structured EmitIntent + live schema fields → runs emitFormDocument →
 * THEN passes the result through THE SAME validateDocument that the human
 * drag-n-drop editor uses. No parallel validator for the bot path.
 *
 * Dependency map (impl §9):
 *   T-0543 coerceToSurface / validateSurface — NOT yet available.
 *   Fallback: v1 form-document + validateDocument (compat layer per design §9 point 1).
 *   When T-0543 impl ships, replace validateDocument → validateSurface here and
 *   advance the seam to v2. The interface of emitSurfaceLocal is stable.
 *
 *   T-0402 classifyFloorBoundary — NOT yet available.
 *   Fallback: hasCustomNode(doc) per design §9 point 3.
 *
 *   T-0455 (server LLM routing) — NOT yet available.
 *   This module is the DETERMINISTIC client seam: it runs synchronously on a
 *   caller-supplied intent (a plain JS object). The real LLM will call this same
 *   logic server-side once T-0455 ships. Until then emitSurfaceLocal is invoked
 *   from the assistant UI's "Собрать форму" panel with a deterministic default
 *   intent (all fields → flat section). LLM connection point is clearly marked.
 *
 * FF-T0545-SAME-GATE: emitSurfaceLocal calls validateDocument — the IDENTICAL
 *   gate used by FormDesigner before persist. No bypass, no AI-only path.
 * FF-T0545-FLOOR2-FLAG: hasCustomNode(doc) → floor2Flag = true.
 * FF-T0545-NO-BYPASS: if V-NODE error (unknown type), doc is returned but
 *   ok === false and floor2Flag is set conservatively; caller must not persist.
 * FF-T0545-HONEST-DEGRADE: on any error the result carries a human-readable
 *   errorMessage; caller shows it and offers to open FormDesigner empty.
 */

import { emitFormDocument, validateEmitted } from './form-document-emit.js';
import { hasCustomNode } from './form-document.js';

/**
 * @typedef {object} EmitSurfaceLocalResult
 * @property {object|null} doc              the form-document (or null on full failure)
 * @property {boolean}     ok               true iff validateDocument passed (no errors)
 * @property {Array}       validationErrors [{code, path, message}]
 * @property {string[]}    brokenKeys       field keys absent from the live schema
 * @property {boolean}     floor2Flag       true iff doc contains a custom (code) node
 * @property {string|null} errorMessage     human-readable error for the user (null if ok)
 * @property {string|null} canvasPath       deep-link to FormDesigner ("/forms")
 */

/**
 * Client-side emit seam: intent → form-document → SAME validator → result.
 *
 * FF-T0545-SAME-GATE: validateEmitted = validateDocument (the IDENTICAL gate).
 *
 * @param {import('./form-document-emit.js').EmitIntent} intent
 * @param {Array} fields  parseRecordSchema() output — live schema view
 * @returns {EmitSurfaceLocalResult}
 */
export function emitSurfaceLocal(intent, fields) {
  // Safeguard: intent must be a plain object.
  if (!intent || typeof intent !== 'object') {
    return {
      doc: null,
      ok: false,
      validationErrors: [],
      brokenKeys: [],
      floor2Flag: false,
      errorMessage: 'Намерение сборки формы пустое или невалидно. Попробуйте снова или соберите вручную.',
      canvasPath: '/forms',
    };
  }

  let doc;
  try {
    // Step 1: emit using the SAME emitter + nodeForField helper the human uses.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // LLM CONNECT POINT (T-0455 / D8): when server LLM routing is live, the
    // LLM will call the server-side emitSurface() with this same intent shape.
    // For now we produce the document deterministically from the intent directly.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    doc = emitFormDocument(intent, fields);
  } catch (err) {
    return {
      doc: null,
      ok: false,
      validationErrors: [],
      brokenKeys: [],
      floor2Flag: false,
      errorMessage: `Ошибка при сборке документа: ${err?.message ?? 'неизвестная ошибка'}. Попробуйте снова или соберите вручную.`,
      canvasPath: '/forms',
    };
  }

  // Step 2: Floor-2 classifier (§5).
  // T-0402 classifyFloorBoundary not yet available → hasCustomNode fallback (design §9 point 3).
  const floor2Flag = hasCustomNode(doc);

  // Step 3: THE SAME validateDocument gate (FF-T0545-SAME-GATE).
  // AI output is held to the IDENTICAL binding-discipline standard as the human.
  const { ok, errors: validationErrors, brokenKeys } = validateEmitted(doc, fields);

  // Compose human-readable error message.
  let errorMessage = null;
  if (!ok) {
    const unknownNode = validationErrors.find((e) => e.code === 'V-NODE');
    if (unknownNode) {
      // FF-T0545-NO-BYPASS: V-NODE = unknown type → full reject.
      errorMessage = `Ассистент предложил тип блока вне реестра (${unknownNode.message}). Соберите форму вручную.`;
    } else if (brokenKeys.length > 0) {
      // Broken field keys: doc is still usable (open with warnings).
      errorMessage = `${brokenKeys.length} ${pluralFields(brokenKeys.length)} не найдено в схеме. Откройте черновик в конструкторе и исправьте привязки.`;
    } else {
      errorMessage = `Форма собрана с ${validationErrors.length} ошибками привязки. Откройте черновик в конструкторе.`;
    }
  }

  if (floor2Flag && !errorMessage) {
    errorMessage = 'Черновик содержит кастомный код-виджет (Floor-2). Откроется в конструкторе с ограниченным доступом.';
  }

  return {
    doc,
    ok,
    validationErrors,
    brokenKeys,
    floor2Flag,
    errorMessage,
    canvasPath: '/forms',
  };
}

/**
 * Build a default "flat all-fields" emit intent for an app context.
 * This is what the assistant emits when the user says "сделай форму для X"
 * without a specific layout — a deterministic baseline the human then shapes.
 *
 * @param {{ applicationId?: string, registryDefId?: string }} source
 * @param {Array} fields  live schema view
 * @returns {import('./form-document-emit.js').EmitIntent}
 */
export function defaultEmitIntent(source, fields) {
  const layout = (fields || []).map((f) => {
    if (f.type === 'collection') return { kind: 'table', fieldKey: f.key };
    if (f.type === 'computed') return { kind: 'readout', fieldKey: f.key };
    if (f.type === 'relation') return { kind: 'relation', fieldKey: f.key };
    return { kind: 'field', fieldKey: f.key };
  });
  return { source: source || {}, layout };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pluralFields(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'поле';
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'поля';
  return 'полей';
}
