/**
 * web/src/forms/form-document-ops-parity.test.js  (T-0656)
 *
 * The CLIENT half of the ops-parity proof. Runs the SHARED op vectors
 * (src/core/__fixtures__/form-document-op-vectors.json — the SAME file the
 * server parity test reads) through the client JS ops (form-document-ops.js) and
 * asserts the documented results. Both tiers proving the same fixture is the
 * mechanical guarantee that the human canvas (these JS ops) and the agent seam
 * (the TS port) never drift (ADR-T0656 §4.2).
 *
 * The client canvas dispatches ops by kind inside FormDesigner.handleDrop; here
 * we replay the same kind→op mapping the server's applyDocumentOp performs, so
 * the two dispatchers are compared against one fixture too.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  insertNode, removeNode, reorderNode, updateNode, moveNode, nodeAtPath,
} from './form-document-ops.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, '../../../src/core/__fixtures__/form-document-op-vectors.json'), 'utf8'),
);

/** Mirror of the server applyDocumentOp kind→op dispatch (client JS ops). */
function applyOp(doc, op) {
  switch (op.kind) {
    case 'insert': return insertNode(doc, op.containerPath, op.node, op.index, op.tabIndex);
    case 'remove': return removeNode(doc, op.containerPath, op.index, op.tabIndex);
    case 'reorder': return reorderNode(doc, op.containerPath, op.fromIndex, op.toIndex, op.tabIndex);
    case 'update': return updateNode(doc, op.containerPath, op.index, op.patch, op.tabIndex);
    case 'move': return moveNode(doc, op.fromPath, op.toPath, op.fromTab, op.toTab);
    default: throw new Error(`unknown op kind ${op.kind}`);
  }
}

const childTypes = (doc, path) => (nodeAtPath(doc, path)?.children ?? []).map((n) => n.type);
const columnsFieldKeys = (doc, path = [1]) => (nodeAtPath(doc, path)?.children ?? []).map((n) => n.fieldKey);
const tabFieldKeys = (doc, tab) => (nodeAtPath(doc, [2])?.tabs?.[tab]?.children ?? []).map((n) => n.fieldKey);

describe('form-document ops parity (client) — shared fixture', () => {
  for (const v of fixture.vectors) {
    it(v.name, () => {
      const before = JSON.stringify(fixture.baseDoc);
      const doc = applyOp(fixture.baseDoc, v.op);

      // input never mutated
      expect(JSON.stringify(fixture.baseDoc)).toBe(before);

      if (v.expectedRootChildTypes) expect(childTypes(doc, [])).toEqual(v.expectedRootChildTypes);
      if (v.expectedColumnsFieldKeys) expect(columnsFieldKeys(doc, v.columnsPath ?? [1])).toEqual(v.expectedColumnsFieldKeys);
      if (v.expectedTab0FieldKeys) expect(tabFieldKeys(doc, 0)).toEqual(v.expectedTab0FieldKeys);
      if (v.expectedTab1FieldKeys) expect(tabFieldKeys(doc, 1)).toEqual(v.expectedTab1FieldKeys);
      if (v.expectedRootChild0Label !== undefined) expect(nodeAtPath(doc, [0]).label).toBe(v.expectedRootChild0Label);
      if (v.expectedMovedFieldKeyAtRootEnd !== undefined) {
        const rootKids = doc.root.children ?? [];
        expect(rootKids[rootKids.length - 1].fieldKey).toBe(v.expectedMovedFieldKeyAtRootEnd);
      }
    });
  }
});
