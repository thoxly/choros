/**
 * web/src/forms/form-document.js  (T-0481 · E-FORMS F2)
 *
 * THE FORM-DOCUMENT MODEL + THE VETTED PALETTE.
 *
 * Pure, React-free. This is the load-bearing half of the form-builder
 * environment: the declarative tree that BOTH the human drag-n-drop editor and
 * the AI emitter produce, and that the ONE renderer (FormDocumentRenderer.jsx)
 * walks. Keeping it React-free means every rule here — palette membership,
 * type→widget compatibility, the named-binding KEY_SET, the authoring
 * validator — is unit-testable in the node environment (cf. field-contract.js,
 * records-form.js convention).
 *
 * --- WHAT THIS IMPLEMENTS (the four deliverables of T-0481) ---
 *
 * 1. VETTED PALETTE (Floor-2 class-a). PALETTE below is a CLOSED, enumerated set
 *    of known building blocks: section, columns, tabs, divider, text (layout);
 *    field, table (line-items), readout (rollup total), relation (data); custom
 *    (the class-b escape). Each entry is a validated descriptor — NOT arbitrary
 *    code. Adding a palette entry is a deliberate catalog edit, the same
 *    discipline as BINDING_CONTRACT_KINDS / VETTED_COMPONENT_TYPES. This is the
 *    "class-a vetted palette" of docs/specs/floor-boundary.spec.md §3.1.
 *
 * 2. ONE CONTRACT, TWO DRIVERS (PD-9 / PD-18). The form-document is the single
 *    artefact. The human drag-n-drop editor (FormDesigner.jsx) MUTATES this
 *    document via the pure ops here (insertNode / moveNode / removeNode /
 *    updateNode); the AI emitter PRODUCES the same shape directly. Both go
 *    through validateDocument before persist. The contract is NOT forked per
 *    driver — buildDefaultDocument is exactly what a bot would emit for the same
 *    field set, and the human editor's output round-trips byte-stable.
 *
 * 3. BINDING DISCIPLINE (named-binding, ADR §4). Every data node (field / table /
 *    readout / relation) binds ONLY through a fieldKey (and table subKey /
 *    relation displayField) that MUST exist in the live record_schema. The
 *    document stores the KEY + presentation; the type/options come from the live
 *    schema at render time (anti-snapshot-drift). KEY_SET(doc) collects all three
 *    binding channels (floor-boundary.spec §3.2 R-4) so a widget can NEVER point
 *    at a process variable that does not exist. A widget never touches the
 *    process directly — it draws/writes through this validated binding.
 *
 * 4. CLASS-B ESCAPE (custom node). A `custom` node carries componentId + bindings
 *    and is rendered in the sandbox-iframe (Floor2Viewer, T-0076/T-0101) — never
 *    inline. It is the rare, flagged 1% path; its bindings are still validated
 *    against the live schema (a class-b widget binds through the contract too).
 *
 * LAYER BOUNDARY: self-contained (no cross-boundary import from src/core/). The
 * SERVER source of truth is binding-contract-catalog.ts (PD-18) + form-document /
 * floor-boundary specs; this client module mirrors the palette + compatibility
 * rules, the same accepted "ONE client module mirrors ONE server catalog"
 * separation as field-contract.js. The two MUST be kept in sync.
 */

import { resolveFieldContract } from './field-contract.js';
import { paletteFromRegistry, WIDGET_COMPAT_TABLE } from './widget-registry.js';

// ---------------------------------------------------------------------------
// Node type vocabulary (form-document-format.spec §3, floor-boundary §3.3)
// ---------------------------------------------------------------------------

/**
 * The CLOSED set of declarative (Floor-1, class-a) node types. Mirrors
 * FLOOR1_DOC_NODE_TYPES (floor-boundary.spec §3.3). A `custom` node is the ONLY
 * class-b (code-escape) node type — it is NOT in this set; introducing one
 * routes the OPERATION to the sandbox (§3.3), while the rest of the document
 * stays declarative.
 */
export const DECLARATIVE_NODE_TYPES = Object.freeze([
  // presentational (not bound to a field)
  'section',
  'columns',
  'tabs',
  'divider',
  'text',
  // bound to data
  'field',
  'table',
  'readout',
  'relation',
]);

/** All node types including the class-b escape. */
export const ALL_NODE_TYPES = Object.freeze([...DECLARATIVE_NODE_TYPES, 'custom']);

/** The data-bound node types (carry a fieldKey → named-binding). */
export const DATA_NODE_TYPES = Object.freeze(['field', 'table', 'readout', 'relation']);

/** True iff `type` is a known declarative (class-a) node type. */
export function isDeclarativeNodeType(type) {
  return DECLARATIVE_NODE_TYPES.includes(type);
}

/** True iff `type` is a data-bound node type. */
export function isDataNodeType(type) {
  return DATA_NODE_TYPES.includes(type);
}

// ---------------------------------------------------------------------------
// THE VETTED PALETTE (deliverable 1 — Floor-2 class-a)
// ---------------------------------------------------------------------------

/**
 * The palette is the set of building blocks a human (drag-n-drop) or bot (emit)
 * may place into a form-document. Each entry is a VALIDATED descriptor, not code:
 *   - `type`        — the node type it produces (∈ ALL_NODE_TYPES).
 *   - `floorClass`  — 'a' (vetted declarative) | 'b' (custom code-escape).
 *   - `data`        — true iff it binds to a record_schema field (needs fieldKey).
 *   - `contract`    — for data nodes: which binding-contract kind it draws/writes
 *                     through (PD-18). null for layout/custom.
 *   - `label` / `summary` — Russian product copy for the palette UI.
 *   - `paletteGroup`— grouping for the drag-n-drop palette ('layout' | 'data' | 'code').
 *
 * The `custom` entry is class-b: it is in the palette (so the human/bot can reach
 * the escape) but it is flagged 'code' and renders in the sandbox-iframe.
 *
 * T-0544: PALETTE is now DERIVED from the ONE widget registry (widget-registry.js)
 * — not a parallel literal (FF-REG-1: one source of truth). The export shape is
 * unchanged (type/floorClass/data/contract/paletteGroup/label/summary), so every
 * importer (paletteByGroup / isPaletteType / isClassBType / validateDocument)
 * keeps working byte-identically. Adding a block is now ONE registry entry.
 */
export const PALETTE = Object.freeze(paletteFromRegistry());

/** Palette entries grouped for the drag-n-drop palette UI. */
export function paletteByGroup() {
  const groups = { layout: [], data: [], code: [] };
  for (const entry of Object.values(PALETTE)) {
    groups[entry.paletteGroup].push(entry);
  }
  return groups;
}

/** True iff `type` is a member of the vetted palette. */
export function isPaletteType(type) {
  return Object.prototype.hasOwnProperty.call(PALETTE, type);
}

/** True iff the node type is the class-b (sandbox) escape. */
export function isClassBType(type) {
  return PALETTE[type]?.floorClass === 'b';
}

// ---------------------------------------------------------------------------
// type → widget compatibility (form-document-format.spec §6)
// ---------------------------------------------------------------------------

/**
 * Allowed widgets per live-schema field type. The drag-n-drop palette shows ONLY
 * these for the chosen field; the authoring validator rejects an incompatible
 * pair (e.g. `money` on a string). `null` = the node type carries no per-cell
 * widget (table is the widget itself; readout is always read-only).
 *
 * Mirrors §6 of form-document-format.spec.md. The field types are the codes
 * parseRecordSchema (apps-schema.js) emits: string / number / integer / boolean /
 * select / date / relation / collection / computed.
 *
 * T-0544: DERIVED from the ONE widget registry (WIDGET_COMPAT_TABLE) so there is
 * a single compatibility source. Export shape unchanged (frozen type→widgets map).
 */
export const WIDGET_COMPAT = Object.freeze(WIDGET_COMPAT_TABLE);

/** Default widget for a field type (first compatible). */
export function defaultWidgetForType(type) {
  const allowed = WIDGET_COMPAT[type];
  return Array.isArray(allowed) && allowed.length > 0 ? allowed[0] : 'text';
}

/** True iff `widget` is compatible with the live-schema field `type`. */
export function isWidgetCompatible(type, widget) {
  const allowed = WIDGET_COMPAT[type];
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(widget);
}

/**
 * The node type a given live-schema field type maps to when dropped into the
 * document. collection → table, computed → readout, relation → relation, the
 * rest → field. This is what the palette uses to turn "the user dragged field X"
 * into the correct node — so the SAME field always becomes the SAME node type,
 * whether placed by a human or emitted by a bot.
 */
export function nodeTypeForFieldType(type) {
  switch (type) {
    case 'collection': return 'table';
    case 'computed': return 'readout';
    case 'relation': return 'relation';
    default: return 'field';
  }
}

// ---------------------------------------------------------------------------
// Per-step field MODE (form-document-format.spec §5)
// ---------------------------------------------------------------------------

/** The CLOSED set of document-node modes (distinct from the binding-field mode). */
export const NODE_MODES = Object.freeze(['editable', 'readonly', 'hidden', 'required']);

/** True iff `mode` is a known node mode. */
export function isNodeMode(mode) {
  return typeof mode === 'string' && NODE_MODES.includes(mode);
}

// ---------------------------------------------------------------------------
// Document construction (deliverable 2 — the SAME doc a bot emits)
// ---------------------------------------------------------------------------

/** The current document schema version. */
export const FORM_DOCUMENT_SCHEMA_VERSION = 1;

let __nodeIdSeq = 0;
/**
 * Deterministic, dependency-free node id. Stable within a session for keys; the
 * id is editor-local (NOT a binding) so it does not affect KEY_SET or round-trip
 * equality of the binding contract. A bot may omit ids entirely.
 */
export function newNodeId(prefix = 'n') {
  __nodeIdSeq += 1;
  return `${prefix}${__nodeIdSeq}`;
}

/**
 * Build a data node for one live-schema field. This is the single function the
 * human palette AND the AI default-emitter both use to turn a schema field into
 * a node — guaranteeing the two drivers produce byte-identical nodes for the
 * same field (deliverable 2, driver-agnostic).
 *
 * @param {{key:string, type:string, title?:string, label?:string, subFields?:Array}} field
 * @param {{mode?:string, withId?:boolean}} [opts]
 */
export function nodeForField(field, opts = {}) {
  const nodeType = nodeTypeForFieldType(field.type);
  const label = field.label || field.title || field.key;
  const base = { type: nodeType, fieldKey: field.key, label };
  if (opts.withId) base.id = newNodeId(nodeType[0]);
  if (isNodeMode(opts.mode)) base.mode = opts.mode;

  if (nodeType === 'field') {
    base.widget = defaultWidgetForType(field.type);
    return base;
  }
  if (nodeType === 'relation') {
    base.widget = 'record-picker';
    return base;
  }
  if (nodeType === 'readout') {
    // readout is always read-only; widget is implied
    return base;
  }
  // table (collection): derive columns from subFields
  if (nodeType === 'table') {
    const subs = Array.isArray(field.subFields) ? field.subFields : [];
    base.columns = subs.map((sf) => ({
      subKey: sf.key,
      widget: defaultWidgetForType(sf.type),
      label: sf.label || sf.title || sf.key,
    }));
    return base;
  }
  return base;
}

/**
 * Build the default form-document for a field set — exactly what the AI emitter
 * would produce as a baseline (a flat list of nodes inside one root section).
 * The drag-n-drop editor then reorders / groups; the bot may emit a richer tree
 * directly. Both share THIS shape (deliverable 2).
 *
 * @param {{applicationId?:string, registryDefId?:string}} source
 * @param {Array} fields  parseRecordSchema(...) output (live schema view)
 * @param {{step?:object, withIds?:boolean}} [opts]
 */
export function buildDefaultDocument(source, fields, opts = {}) {
  const list = Array.isArray(fields) ? fields : [];
  const children = list.map((f) => nodeForField(f, { withId: opts.withIds }));
  const root = { type: 'section', children };
  if (opts.withIds) root.id = newNodeId('s');
  const doc = {
    schemaVersion: FORM_DOCUMENT_SCHEMA_VERSION,
    source: {
      applicationId: source?.applicationId,
      registryDefId: source?.registryDefId,
    },
    root,
  };
  if (opts.step && typeof opts.step === 'object') doc.step = opts.step;
  return doc;
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/** Return the children array of a node, or [] (tabs flattens its tab children). */
export function childrenOf(node) {
  if (!node || typeof node !== 'object') return [];
  if (node.type === 'tabs') {
    const tabs = Array.isArray(node.tabs) ? node.tabs : [];
    return tabs.flatMap((t) => (Array.isArray(t?.children) ? t.children : []));
  }
  return Array.isArray(node.children) ? node.children : [];
}

/**
 * Depth-first walk over every node in the document tree, root first.
 * @param {object} doc
 * @param {(node:object, depth:number)=>void} visit
 */
export function walkDocument(doc, visit) {
  const root = doc?.root;
  if (!root) return;
  const stack = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    visit(node, depth);
    const kids = childrenOf(node);
    // push in reverse so children are visited in array order
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push({ node: kids[i], depth: depth + 1 });
    }
  }
}

/**
 * KEY_SET(doc) — the complete set of record_schema keys the document binds to,
 * across all THREE binding channels (floor-boundary.spec §3.2 R-4):
 *   1. fieldKey on every field / table / readout / relation node;
 *   2. table.columns[].subKey on every table node;
 *   3. relation.displayField on every relation node (if present).
 * custom-node bindings[] are also collected (a class-b widget binds through the
 * contract too) so the validator can confirm they reference live schema.
 *
 * @returns {{ primary:Set<string>, subKeys:Set<string>, displayFields:Set<string>, customBindings:Set<string> }}
 */
export function keySet(doc) {
  const primary = new Set();
  const subKeys = new Set();
  const displayFields = new Set();
  const customBindings = new Set();
  walkDocument(doc, (node) => {
    if (!node || typeof node !== 'object') return;
    if (isDataNodeType(node.type) && typeof node.fieldKey === 'string') {
      primary.add(node.fieldKey);
    }
    if (node.type === 'table' && Array.isArray(node.columns)) {
      for (const col of node.columns) {
        if (col && typeof col.subKey === 'string') subKeys.add(col.subKey);
      }
    }
    if (node.type === 'relation' && typeof node.displayField === 'string' && node.displayField) {
      displayFields.add(node.displayField);
    }
    if (node.type === 'custom' && Array.isArray(node.bindings)) {
      for (const b of node.bindings) {
        if (typeof b === 'string') customBindings.add(b);
      }
    }
  });
  return { primary, subKeys, displayFields, customBindings };
}

/** True iff the document contains any class-b (custom) node — a code signal. */
export function hasCustomNode(doc) {
  let found = false;
  walkDocument(doc, (node) => {
    if (node && node.type === 'custom') found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Live-schema view (what the validator/renderer resolve types from)
// ---------------------------------------------------------------------------

/**
 * Index a parseRecordSchema(...) field list into a lookup the validator/renderer
 * use. Captures, per key: the field type, its options (enum), and — for
 * collection fields — the sub-field type map (so table column subKeys can be
 * type-checked and the relation displayField channel resolved).
 *
 * @param {Array} fields parseRecordSchema output
 * @returns {{ byKey: Map<string,object>, subByKey: Map<string,Map<string,object>> }}
 */
export function indexSchema(fields) {
  const byKey = new Map();
  const subByKey = new Map();
  const list = Array.isArray(fields) ? fields : [];
  for (const f of list) {
    if (!f || typeof f.key !== 'string') continue;
    byKey.set(f.key, f);
    if (f.type === 'collection' && Array.isArray(f.subFields)) {
      const subMap = new Map();
      for (const sf of f.subFields) {
        if (sf && typeof sf.key === 'string') subMap.set(sf.key, sf);
      }
      subByKey.set(f.key, subMap);
    }
  }
  return { byKey, subByKey };
}

// ---------------------------------------------------------------------------
// Authoring validator (deliverable 3 — binding discipline)
// ---------------------------------------------------------------------------

/**
 * Validate a form-document against the LIVE schema view. This is the authoring
 * gate (phase a of form-document-format.spec §8): it runs for BOTH drivers — the
 * human editor before persist AND the AI emitter before save — so neither can
 * produce a document that violates the named-binding contract.
 *
 * Checks:
 *   V-NODE   every node's type ∈ ALL_NODE_TYPES (palette membership).
 *   V-KEY    every data-node fieldKey exists in the live schema (R-4 channel 1).
 *   V-SUBKEY every table column subKey exists in the collection's sub-schema
 *            (R-4 channel 2).
 *   V-WIDGET every field/table-column widget is compatible with the field type
 *            (form-document-format §6).
 *   V-CONTRACT a node's palette contract matches the field's contract kind
 *            (e.g. a `table` node must bind a `collection` field; a `readout` a
 *            computed/rollup field) — so a widget draws through the RIGHT
 *            binding contract, never a mismatched one.
 *   V-CUSTOM a custom node must carry a componentId and every binding it lists
 *            must exist in the live schema (class-b binds through the contract).
 *
 * @param {object} doc        the form-document
 * @param {Array}  fields     parseRecordSchema(...) — live schema view
 * @returns {{ ok:boolean, errors:Array<{code:string, path:string, message:string}>,
 *             brokenKeys:string[] }}
 */
export function validateDocument(doc, fields) {
  const errors = [];
  const brokenKeys = [];
  const { byKey, subByKey } = indexSchema(fields);

  if (!doc || typeof doc !== 'object' || !doc.root) {
    return { ok: false, errors: [{ code: 'V-DOC', path: '', message: 'Документ пуст или без корня.' }], brokenKeys };
  }

  let idx = 0;
  walkDocument(doc, (node) => {
    const path = `node[${idx}]`;
    idx += 1;
    if (!node || typeof node !== 'object') return;
    const { type } = node;

    // V-NODE: palette membership.
    if (!isPaletteType(type)) {
      errors.push({ code: 'V-NODE', path, message: `Неизвестный тип узла «${type}» (вне палитры).` });
      return;
    }

    // class-b custom node.
    if (type === 'custom') {
      if (typeof node.componentId !== 'string' || !node.componentId) {
        errors.push({ code: 'V-CUSTOM', path, message: 'Код-виджет без componentId.' });
      }
      const bindings = Array.isArray(node.bindings) ? node.bindings : [];
      for (const b of bindings) {
        if (!byKey.has(b)) {
          errors.push({ code: 'V-CUSTOM-KEY', path, message: `Код-виджет привязан к несуществующему полю «${b}».` });
          brokenKeys.push(b);
        }
      }
      return;
    }

    // layout nodes: no binding to check (columns count sanity only).
    if (!isDataNodeType(type)) {
      if (type === 'columns') {
        const count = Number(node.count);
        if (!(count >= 2 && count <= 4)) {
          errors.push({ code: 'V-COLUMNS', path, message: 'Число колонок должно быть 2–4.' });
        }
      }
      return;
    }

    // ---- data node: named-binding discipline ----
    const fieldKey = node.fieldKey;
    if (typeof fieldKey !== 'string' || !fieldKey) {
      errors.push({ code: 'V-KEY', path, message: `Узел «${type}» без fieldKey.` });
      return;
    }
    const schemaField = byKey.get(fieldKey);
    if (!schemaField) {
      // R-4: dangling binding → broken (highlighted on authoring, never silent).
      errors.push({ code: 'V-KEY', path, message: `Поле «${fieldKey}» отсутствует в схеме (битая привязка).` });
      brokenKeys.push(fieldKey);
      return;
    }

    // V-CONTRACT: the palette node's contract must match the field's contract.
    const paletteEntry = PALETTE[type];
    const fieldContract = resolveFieldContract({ type: schemaField.type, options: schemaField.options }).contractKind;
    // A `field` node hosts every live-schema field type that nodeTypeForFieldType
    // routes to a `field` node — i.e. the flat scalar/enum contracts PLUS the flat
    // structural scalars (money/multi-select/person/file). The three types that
    // route AWAY from a field node (relation→relation, collection→table,
    // computed→readout) each keep their own node-type contract gate below.
    //
    // T-0678 (P0, capstone T-0629): this used to be a hardcoded `scalar || enum`
    // whitelist, which REJECTED a `money`/`multi-select`/`person`/`file` field on a
    // `field` node even though nodeForField/nodeTypeForFieldType had ALREADY placed
    // it there — the "Узел «Поле» нельзя привязать к полю (тип «money»)" the
    // capstone hit live. Gating on nodeTypeForFieldType keeps the "where does this
    // field go" and "what may this node host" answers from EVER drifting apart
    // (ONE source of truth, not two parallel literals).
    const contractOk = type === 'field'
      ? nodeTypeForFieldType(schemaField.type) === 'field'
      : fieldContract === paletteEntry.contract;
    if (!contractOk) {
      errors.push({
        code: 'V-CONTRACT', path,
        message: `Узел «${paletteEntry.label}» нельзя привязать к полю «${fieldKey}» (тип «${schemaField.type}»).`,
      });
      return;
    }

    // V-WIDGET (field nodes): widget must be compatible with the field type.
    if (type === 'field' && typeof node.widget === 'string') {
      if (!isWidgetCompatible(schemaField.type, node.widget)) {
        errors.push({
          code: 'V-WIDGET', path,
          message: `Виджет «${node.widget}» несовместим с полем «${fieldKey}» (тип «${schemaField.type}»).`,
        });
      }
    }
    if (type === 'relation' && typeof node.widget === 'string' && node.widget !== 'record-picker') {
      errors.push({ code: 'V-WIDGET', path, message: `Связь рисуется только record-picker (узел «${fieldKey}»).` });
    }

    // V-SUBKEY (table): every column subKey must exist in the collection's sub-schema.
    //
    // T-0680: a table column's subKey is a SUB-KEY of the parent collection — it
    // lives in the collection's nested sub-schema, NOT the flat top-level schema.
    // When the parent collection field IS present in the live schema (already
    // asserted above: schemaField exists + V-CONTRACT matched `collection`) but the
    // schema view arrived WITHOUT the collection's `subFields` (the round-trip that
    // rebuilds `fields` can drop them — the exact LIVE-defect T-0678, where a form
    // with a «Позиции» table hit a false dangling-binding), the columns are COVERED
    // by the parent collection binding and must NOT be flagged. A sub-schema is only
    // enforced when it is KNOWN (subByKey has an entry for this collection). This
    // does NOT weaken the real dangling check: a genuinely bad column (subKey not in
    // a KNOWN sub-schema) still errors; a top-level dangling fieldKey is caught by
    // V-KEY above.
    if (type === 'table') {
      const subMap = subByKey.get(fieldKey);
      const subSchemaKnown = subMap instanceof Map && subMap.size > 0;
      const cols = Array.isArray(node.columns) ? node.columns : [];
      for (const col of cols) {
        if (!col || typeof col.subKey !== 'string') {
          errors.push({ code: 'V-SUBKEY', path, message: `Колонка таблицы «${fieldKey}» без subKey.` });
          continue;
        }
        // Sub-schema unknown (collection present but its sub-fields didn't survive
        // the schema round-trip) → the column is covered by the parent binding.
        if (!subSchemaKnown) continue;
        const subField = subMap.get(col.subKey);
        if (!subField) {
          errors.push({ code: 'V-SUBKEY', path, message: `Колонка «${col.subKey}» отсутствует в схеме таблицы «${fieldKey}».` });
          brokenKeys.push(`${fieldKey}.${col.subKey}`);
          continue;
        }
        if (typeof col.widget === 'string' && !isWidgetCompatible(subField.type, col.widget)) {
          errors.push({
            code: 'V-WIDGET', path,
            message: `Виджет «${col.widget}» несовместим с колонкой «${col.subKey}» (тип «${subField.type}»).`,
          });
        }
      }
    }

    // V-MODE: mode must be a known node mode (if present).
    if (node.mode !== undefined && !isNodeMode(node.mode)) {
      errors.push({ code: 'V-MODE', path, message: `Неизвестный режим «${node.mode}» на узле «${fieldKey}».` });
    }
  });

  return { ok: errors.length === 0, errors, brokenKeys };
}

/**
 * Compute the set of broken (dangling) keys for highlighting in the editor —
 * keys the document binds to that are NOT in the live schema. A thin wrapper over
 * validateDocument that returns only the dangling keys (form-document-format §4:
 * "снятое из схемы поле → узел становится битым и подсвечивается").
 */
export function brokenBindings(doc, fields) {
  return validateDocument(doc, fields).brokenKeys;
}
