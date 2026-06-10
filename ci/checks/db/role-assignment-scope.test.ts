// T-0022 · AC-21 (FF-16) — org_scope shape conformance.
//
// Every seeded role_assignment.org_scope MUST parse as the EXISTING
// grant-lattice.ts `ScopeElement` (a node or a set of nodes) with
// hierarchy === 'org' and nodeLevel ∈ {department, position}. This proves there
// is NO second scope grammar — org_scope reuses the lattice shape (NF-3).
//
// The lattice TYPES are imported from the frozen module (NOT edited — AC-20);
// the runtime guard below is a test-local structural check against those types,
// it introduces no new parser into src/core.
//
// Run under `npm run fitness:db` (live Postgres).

import { describe, it, expect } from 'vitest';
import { migratorUrl, withClient } from './_helpers.js';
import type { ScopeElement, Hierarchy, NodeLevel } from '../../../src/core/grant-lattice.js';

const ORG_NODE_LEVELS: NodeLevel[] = ['department', 'position'];

/** Test-local structural validator: is `x` an org-hierarchy ScopeElement (node or set)? */
function isOrgScopeElement(x: unknown): x is ScopeElement {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (e.kind === 'node') {
    return (
      (e.hierarchy as Hierarchy) === 'org' &&
      typeof e.nodeId === 'string' &&
      ORG_NODE_LEVELS.includes(e.nodeLevel as NodeLevel)
    );
  }
  if (e.kind === 'set') {
    return Array.isArray(e.members) && e.members.every((m) => isOrgScopeElement(m));
  }
  return false;
}

describe('AC-21 · FF-16: every seeded role_assignment.org_scope is a lattice org ScopeElement', () => {
  it('all seeded org_scope values parse as node/set with hierarchy=org, nodeLevel∈{department,position}', async () => {
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT tenant_id, id, org_scope FROM choros.role_assignment`,
      );
      expect(rows.length, 'at least the dev seed assignment must be present').toBeGreaterThanOrEqual(1);
      for (const r of rows) {
        // pg returns jsonb as a parsed JS object already.
        expect(
          isOrgScopeElement(r.org_scope),
          `role_assignment ${r.id}: org_scope is not a valid org ScopeElement: ${JSON.stringify(r.org_scope)}`,
        ).toBe(true);
      }
    });
  });
});
