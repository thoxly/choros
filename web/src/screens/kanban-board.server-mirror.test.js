/**
 * web/src/screens/kanban-board.server-mirror.test.js — T-0582 (kanban view)
 * anti-drift gate for the client/server select-enum-reading mirror.
 *
 * CONTEXT: kanban-board.js's `readSelectEnum` is a MANUALLY maintained mirror
 * of src/core/view-config.ts's `enumValuesForSelectField` (see kanban-board.js's
 * own header comment: "readSelectEnum — mirror of src/core/view-config.ts's
 * enumValuesForSelectField"). This mirror is exactly the BUG-016-class risk
 * the T-0581 server-mirror test (list-view-panel.server-mirror.test.js) was
 * written to close for operatorsForFieldType/isServerSortable — the same
 * pattern applies here: kanban-board.js's own pr-handoff deviation note says
 * it deliberately chose the byte-mirror precedent over a direct .ts import,
 * "the mirrored logic is a 4-line pure read with no drift risk" — a claim this
 * test makes ENFORCED rather than asserted-in-prose. Before this file, no test
 * imported BOTH sides and compared them: kanban-board.test.js only exercises
 * readSelectEnum in isolation against hardcoded fixtures.
 *
 * If this test ever goes red, the fix is to update kanban-board.js's
 * readSelectEnum to match view-config.ts's enumValuesForSelectField (or vice
 * versa if the divergence was an intentional, coordinated change) — NOT to
 * loosen this test.
 */

import { describe, it, expect } from 'vitest';
import { readSelectEnum as clientReadSelectEnum } from './kanban-board.js';
// eslint-disable-next-line import/no-relative-packages -- intentional cross-boundary
// parity check; see file header. Server module is pure/IO-free (no pg/http/fs).
import { enumValuesForSelectField as serverEnumValuesForSelectField } from '../../../src/core/view-config.ts';

const SCHEMAS = [
  {
    name: 'well-formed select field with a populated enum',
    schema: { properties: { status: { type: 'string', enum: ['open', 'won', 'lost'] } } },
    key: 'status',
  },
  {
    name: 'non-select field (no enum present)',
    schema: { properties: { amount: { type: 'number' } } },
    key: 'amount',
  },
  {
    name: 'field key absent from properties entirely',
    schema: { properties: { status: { type: 'string', enum: ['a'] } } },
    key: 'ghost',
  },
  {
    name: 'enum array containing non-string members (mixed/malformed tenant data)',
    schema: { properties: { status: { type: 'string', enum: ['open', 42, null, 'won'] } } },
    key: 'status',
  },
  {
    name: 'empty enum array',
    schema: { properties: { status: { type: 'string', enum: [] } } },
    key: 'status',
  },
  {
    name: 'enum present but not an array (malformed)',
    schema: { properties: { status: { type: 'string', enum: 'open' } } },
    key: 'status',
  },
  {
    name: 'properties missing entirely',
    schema: {},
    key: 'status',
  },
  {
    name: 'recordSchema is null',
    schema: null,
    key: 'status',
  },
  {
    name: 'recordSchema is an array (not a plain object)',
    schema: [1, 2, 3],
    key: 'status',
  },
  {
    name: 'property definition itself is not an object',
    schema: { properties: { status: 'not-an-object' } },
    key: 'status',
  },
];

describe('kanban-board.js readSelectEnum vs src/core/view-config.ts enumValuesForSelectField (anti-drift, BUG-016 class)', () => {
  it.each(SCHEMAS.map((s) => [s.name, s.schema, s.key]))(
    '%s: client === server output',
    (_name, schema, key) => {
      const clientResult = clientReadSelectEnum(schema, key);
      const serverResult = serverEnumValuesForSelectField(schema, key);
      expect(clientResult).toEqual(serverResult);
    },
  );

  it('both sides return [] (not throw) for every malformed-input case above', () => {
    for (const { schema, key } of SCHEMAS) {
      expect(() => clientReadSelectEnum(schema, key)).not.toThrow();
      expect(() => serverEnumValuesForSelectField(schema, key)).not.toThrow();
    }
  });

  it('a large mixed-content enum array produces identical filtered output on both sides', () => {
    const schema = {
      properties: {
        status: { type: 'string', enum: ['a', 1, 'b', false, 'c', {}, 'd', [], 'e', null, undefined] },
      },
    };
    expect(clientReadSelectEnum(schema, 'status')).toEqual(serverEnumValuesForSelectField(schema, 'status'));
    // Pin the actual expected shape too, so a coordinated-but-wrong change to
    // BOTH sides at once (which the differential check alone can't catch)
    // still fails loudly.
    expect(clientReadSelectEnum(schema, 'status')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
