/**
 * web/src/forms/form-document-emit.js  (T-0481 · E-FORMS F2)
 *
 * THE AI/BOT DRIVER — emit a form-document from a structured intent.
 *
 * One contract, two drivers (PD-9 / PD-18, deliverable 2): the human drag-n-drop
 * editor (FormDesigner.jsx) and THIS bot emitter produce the SAME form-document.
 * The emitter does NOT generate React or a parallel shape — it assembles the
 * exact tree the drag-n-drop editor would, from the SAME palette + the SAME
 * node-construction helpers (nodeForField), so the two are byte-comparable for an
 * equivalent layout. This is the literal "форма→документ" уточнение of PD-9: for
 * 99% the AI emits a document, not raw code.
 *
 * The intent is a small declarative description ("section with these fields, then
 * a positions table, then a total readout") — the kind of thing an LLM produces
 * from a natural-language request. It references fields by KEY only (named-binding
 * discipline: the bot cannot invent a field; every key is checked against the live
 * schema by validateDocument before persist, same gate as the human driver).
 *
 * Pure, React-free — unit-testable. No I/O.
 */

import {
  buildDefaultDocument, nodeForField, validateDocument, FORM_DOCUMENT_SCHEMA_VERSION,
} from './form-document.js';
import { indexSchema } from './form-document.js';

/**
 * @typedef {object} EmitIntent
 * @property {{applicationId?:string, registryDefId?:string}} source
 * @property {object} [step]   { processKey, step } for a step form
 * @property {Array<EmitBlock>} layout  ordered blocks to emit
 *
 * @typedef {object} EmitBlock
 *   A block is one of:
 *   { kind:'section', title?, fields:string[] }            — a titled group of fields
 *   { kind:'columns', count?, fields:string[] }            — fields laid out in N columns
 *   { kind:'table', fieldKey, label?, mode? }              — a collection (line-items) table
 *   { kind:'readout', fieldKey, label? }                   — a rollup total
 *   { kind:'field', fieldKey, widget?, label?, mode? }     — a single field
 *   { kind:'relation', fieldKey, label?, displayField? }   — a relation picker
 *   { kind:'divider' } | { kind:'text', content }          — layout
 */

/**
 * Emit a form-document from an intent + the live schema view. Every block's
 * fields resolve through nodeForField (the SAME helper the human palette uses),
 * so the emitted nodes are identical to drag-n-drop output for the same fields.
 *
 * Unknown field keys are still EMITTED (so the document is honest about what the
 * bot asked for) — but validateEmitted (below) flags them as broken, exactly as
 * the editor surfaces a dangling binding. The emitter does not silently drop.
 *
 * @param {EmitIntent} intent
 * @param {Array} fields  parseRecordSchema(...) — live schema view
 * @returns {object} the form-document
 */
export function emitFormDocument(intent, fields) {
  const { byKey } = indexSchema(fields);
  const blocks = Array.isArray(intent?.layout) ? intent.layout : [];

  // No layout intent → fall back to the default document (the baseline a bot
  // emits when it just wants "a form for these fields"). Identical to what
  // FormDesigner starts from — the single shared baseline.
  if (blocks.length === 0) {
    return buildDefaultDocument(intent?.source || {}, fields, { step: intent?.step });
  }

  const children = [];
  for (const block of blocks) {
    const node = emitBlock(block, byKey);
    if (node) children.push(node);
  }

  const doc = {
    schemaVersion: FORM_DOCUMENT_SCHEMA_VERSION,
    source: {
      applicationId: intent?.source?.applicationId,
      registryDefId: intent?.source?.registryDefId,
    },
    root: { type: 'section', children },
  };
  if (intent?.step && typeof intent.step === 'object') doc.step = intent.step;
  return doc;
}

/** Emit one block into a node (or null to skip). */
function emitBlock(block, byKey) {
  if (!block || typeof block !== 'object') return null;
  switch (block.kind) {
    case 'divider':
      return { type: 'divider' };
    case 'text':
      return { type: 'text', content: block.content || '' };
    case 'section':
      return {
        type: 'section',
        title: block.title,
        children: (block.fields || []).map((k) => fieldNode(k, byKey, block.mode)),
      };
    case 'columns':
      return {
        type: 'columns',
        count: Math.max(2, Math.min(4, Number(block.count) || 2)),
        children: (block.fields || []).map((k) => fieldNode(k, byKey, block.mode)),
      };
    case 'field':
      return fieldNode(block.fieldKey, byKey, block.mode, block.widget, block.label);
    case 'relation': {
      const n = fieldNode(block.fieldKey, byKey, block.mode, undefined, block.label);
      n.type = 'relation';
      n.widget = 'record-picker';
      if (block.displayField) n.displayField = block.displayField;
      return n;
    }
    case 'table': {
      const field = byKey.get(block.fieldKey);
      const n = field
        ? nodeForField(field, { mode: block.mode })
        : { type: 'table', fieldKey: block.fieldKey, columns: [] };
      n.type = 'table';
      if (block.label) n.label = block.label;
      return n;
    }
    case 'readout': {
      const field = byKey.get(block.fieldKey);
      const n = field
        ? nodeForField(field, { mode: block.mode })
        : { type: 'readout', fieldKey: block.fieldKey };
      n.type = 'readout';
      if (block.label) n.label = block.label;
      return n;
    }
    default:
      return null;
  }
}

/** Build a single field node for a key (uses the live schema where it exists). */
function fieldNode(fieldKey, byKey, mode, widget, label) {
  const field = byKey.get(fieldKey);
  let node;
  if (field) {
    node = nodeForField(field, { mode });
  } else {
    // Honest dangling binding — emitted as a field node so validateDocument can
    // flag it (V-KEY), not silently dropped.
    node = { type: 'field', fieldKey, widget: widget || 'text' };
  }
  if (widget) node.widget = widget;
  if (label) node.label = label;
  return node;
}

/**
 * Validate an emitted document against the live schema — the SAME gate the human
 * editor runs (validateDocument). The bot's output is held to the identical
 * binding-discipline standard before it can persist.
 */
export function validateEmitted(doc, fields) {
  return validateDocument(doc, fields);
}
