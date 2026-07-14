/**
 * web/src/screens/list-view-panel.server-mirror.test.js — T-0581 (view registry)
 * anti-drift gate for the client/server operator-table mirror.
 *
 * CONTEXT: list-view-panel.js's operatorsForFieldType/isServerSortable are a
 * MANUALLY maintained byte-mirror of src/core/view-config.ts's tables (see the
 * "kept in sync manually — both sides are pure lookup tables, no shared runtime
 * import across the client/server boundary is possible for a browser bundle"
 * comment in list-view-panel.js). The existing list-view-panel.test.js only
 * asserts the CLIENT table against hardcoded literals — it would stay green
 * even if the server table changed and the client mirror silently drifted
 * (BUG-016-class defect: UI offers an operator the server now rejects, or
 * hides one the server now accepts). No test anywhere previously imported
 * BOTH sides and compared them.
 *
 * This file closes that gap: it imports the server's pure, IO-free
 * src/core/view-config.ts DIRECTLY (relative import — feasible at vitest-time
 * via esbuild TS transform even though the SHIPPED browser bundle never
 * imports server code; the Docker/bundle isolation is a BUILD-time property,
 * not a test-time one) and asserts, for every ViewFieldType, that the client
 * mirror produces the IDENTICAL (same members, same order) operator list and
 * IDENTICAL sortability boolean as the server source of truth.
 *
 * If this test ever goes red, the fix is to update list-view-panel.js's
 * mirror to match view-config.ts (or vice versa if the drift was intentional
 * and both need a coordinated change) — NOT to loosen this test.
 */

import { describe, it, expect } from 'vitest';
import { operatorsForFieldType as clientOperatorsForFieldType, isServerSortable as clientIsServerSortable } from './list-view-panel.js';
// eslint-disable-next-line import/no-relative-packages -- intentional cross-boundary
// parity check; see file header. Server module is pure/IO-free (no pg/http/fs).
import { operatorsForFieldType as serverOperatorsForFieldType, isServerSortable as serverIsServerSortable } from '../../../src/core/view-config.ts';

// The full ViewFieldType union from src/core/view-config.ts, kept as a literal
// list here (not imported — it's a TS type, erased at runtime) so this test
// exhaustively walks every kind the server recognizes, INCLUDING the synthetic
// 'created_at' pseudo-column and the never-filterable/never-sortable
// 'computed'/'collection' kinds.
const ALL_VIEW_FIELD_TYPES = [
  'string',
  'url',
  'email',
  'number',
  'integer',
  'money',
  'date',
  'boolean',
  'select',
  'multi-select',
  'person',
  'relation',
  'computed',
  'collection',
  'created_at',
];

describe('list-view-panel.js mirror vs src/core/view-config.ts (anti-drift, BUG-016 class)', () => {
  it.each(ALL_VIEW_FIELD_TYPES)(
    'operatorsForFieldType(%s): client === server (same members, same order)',
    (fieldType) => {
      const clientOps = clientOperatorsForFieldType(fieldType);
      const serverOps = serverOperatorsForFieldType(fieldType);
      expect(clientOps).toEqual(serverOps);
    },
  );

  it.each(ALL_VIEW_FIELD_TYPES)('isServerSortable(%s): client === server', (fieldType) => {
    expect(clientIsServerSortable(fieldType)).toBe(serverIsServerSortable(fieldType));
  });

  it('covers the FULL server ViewFieldType union — no kind silently unchecked', () => {
    // Guards the guard: if src/core/view-config.ts ever adds a new
    // ViewFieldType member, ALL_VIEW_FIELD_TYPES above must be updated too, or
    // this drift check silently stops covering the new kind. This assertion
    // documents the expected count so an unnoticed server-side addition is at
    // least visible as "this test's own list looks stale" during review.
    expect(ALL_VIEW_FIELD_TYPES).toHaveLength(15);
  });

  it('every operator the client ever offers is legal to SOME server field type (no orphan client-only op)', () => {
    const serverLegalOps = new Set();
    for (const t of ALL_VIEW_FIELD_TYPES) {
      for (const op of serverOperatorsForFieldType(t)) serverLegalOps.add(op);
    }
    const clientOps = new Set();
    for (const t of ALL_VIEW_FIELD_TYPES) {
      for (const op of clientOperatorsForFieldType(t)) clientOps.add(op);
    }
    for (const op of clientOps) {
      expect(serverLegalOps.has(op)).toBe(true);
    }
  });
});
