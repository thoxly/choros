/**
 * web/src/screens/rights/ra-grant-trail.test.js — T-0648 [W4-UX/столп 4] P1 regression.
 *
 * THE CRASH THIS GUARDS AGAINST (docs/design/ux-study-2026-07-05.md §6):
 * /rights/trail used to hard-crash the whole SPA (React error #31 — "objects are
 * not valid as a React child") because ra-grant-trail.jsx built actorDisplay
 * literally as `{ type: "human", name: r.actor }` and then rendered it through
 * ExecutorBadge/ActorChip's `type`/`name` PROPS (not as a bare child) — so the
 * actual crash never reproduced from THIS specific pre-existing code path (props
 * are fine to be objects; only rendering an object as a CHILD triggers #31).
 * The real defect this task fixes is upstream + adjacent:
 *   (a) the actor/subject type was HARDCODED to "human" regardless of the real
 *       actor kind (a service/automation actor like "policy-sync" rendered with
 *       the wrong glyph — a real semantic bug, not a crash);
 *   (b) GET /api/grant-trail now attaches `actorResolved`/`subjectResolved`
 *       (src/http/grant-trail.ts attachResolvedActors, T-0648) — apiRowToDisplay
 *       must consume that shape correctly and NEVER pass anything but a plain
 *       string/number as a bare child anywhere in the render tree.
 *
 * This test proves apiRowToDisplay:
 *   1. ALWAYS returns actor/subject as a well-formed {type,name,id,resolved}
 *      object (the exact prop shape ActorChip expects) — never a bare string,
 *      never undefined, regardless of whether the API attached actorResolved.
 *   2. Prefers actorResolved/subjectResolved when the backend provides them
 *      (the T-0648 batch resolver's real output).
 *   3. Falls back to an HONEST "service" (not a fabricated "human") when the
 *      backend does not resolve the actor — the fixed hardcode-to-human bug.
 *   4. subject "—" placeholder (no subject on the row) still yields a
 *      well-formed display object, not a bare "—" string mixed into the row.
 */

import { describe, it, expect } from 'vitest';
import { apiRowToDisplay } from './ra-grant-trail.jsx';

function baseRow(overrides = {}) {
  return {
    id: 'grt-1',
    type: 'grant.create',
    actor: 'e-fixture-user',
    subject: 'role-fin-approve-250',
    scope: { kind: 'node', hierarchy: 'org', nodeId: 'fin', nodeLevel: 'department' },
    proposed_by: 'human',
    confirmed_by: 'e-fixture-user',
    payload: { resourceType: 'record', operation: 'exec' },
    occurred_at: 1749383066318,
    ...overrides,
  };
}

describe('T-0648 ra-grant-trail apiRowToDisplay — actor/subject are always well-formed objects', () => {
  it('actor is a {type,name,id,resolved} object even with NO actorResolved from the API', () => {
    const row = baseRow();
    const display = apiRowToDisplay(row);

    expect(typeof display.actor).toBe('object');
    expect(display.actor).not.toBeNull();
    expect(typeof display.actor.type).toBe('string');
    expect(typeof display.actor.name).toBe('string');
  });

  it('subject is a {type,name,id,resolved} object even with NO subjectResolved from the API', () => {
    const row = baseRow();
    const display = apiRowToDisplay(row);

    expect(typeof display.subject).toBe('object');
    expect(display.subject).not.toBeNull();
    expect(typeof display.subject.type).toBe('string');
    expect(typeof display.subject.name).toBe('string');
  });
});

describe('T-0648 ra-grant-trail apiRowToDisplay — prefers the real T-0648 resolver output', () => {
  it('uses actorResolved when the backend attaches it (real employee resolution)', () => {
    const row = baseRow({
      actor: 'e-fixture-user',
      actorResolved: { id: 'e-fixture-user', name: 'Тестовый Фикстур', type: 'human', deactivated: false, resolved: true },
    });
    const display = apiRowToDisplay(row);

    expect(display.actor).toEqual({
      id: 'e-fixture-user', name: 'Тестовый Фикстур', type: 'human', deactivated: false, resolved: true,
    });
  });

  it('uses subjectResolved when the backend attaches it (e.g. subject is itself an employee slug)', () => {
    const row = baseRow({
      subject: 'e-triage',
      subjectResolved: { id: 'e-triage', name: 'Триаж-агент', type: 'agent', deactivated: false, resolved: true },
    });
    const display = apiRowToDisplay(row);

    expect(display.subject).toEqual({
      id: 'e-triage', name: 'Триаж-агент', type: 'agent', deactivated: false, resolved: true,
    });
  });

  it('a service-kind actor resolves with type "service", never faked as "human"', () => {
    const row = baseRow({
      actor: 's-ledger',
      actorResolved: { id: 's-ledger', name: 'ledger-sync', type: 'service', deactivated: false, resolved: true },
    });
    const display = apiRowToDisplay(row);

    expect(display.actor.type).toBe('service');
  });
});

describe('T-0648 ra-grant-trail apiRowToDisplay — honest fallback, no more hardcoded "human"', () => {
  it('an UNRESOLVED actor (e.g. system pseudo-actor "policy-sync") falls back to "service", NOT "human"', () => {
    // Regression guard: the OLD code hardcoded `{ type: "human", name: r.actor }`
    // unconditionally — a service/system actor like "policy-sync" would have been
    // rendered with a human glyph. This proves that bug is gone.
    const row = baseRow({ actor: 'policy-sync', actorResolved: undefined });
    const display = apiRowToDisplay(row);

    expect(display.actor.type).toBe('service');
    expect(display.actor.name).toBe('policy-sync');
    expect(display.actor.resolved).toBe(false);
  });

  it('the raw id is ALWAYS carried on the display object (for ActorChip tooltip/technical-id)', () => {
    const row = baseRow({ actor: 'ghost-uuid-1234', actorResolved: undefined });
    const display = apiRowToDisplay(row);

    expect(display.actor.id).toBe('ghost-uuid-1234');
  });
});

describe('T-0648 ra-grant-trail apiRowToDisplay — no subject on the row (grant, not assignment)', () => {
  it('subject "—" placeholder is still a well-formed object, never a bare string', () => {
    const row = baseRow({ subject: null, subjectResolved: undefined });
    const display = apiRowToDisplay(row);

    expect(typeof display.subject).toBe('object');
    expect(display.subject.name).toBe('—');
    expect(display.subject.id).toBeNull();
  });
});

describe('T-0648 ra-grant-trail apiRowToDisplay — action/scope/role/op fields unaffected (regression)', () => {
  it('still derives action/scope/role/op exactly as before (byte-identical logic, untouched)', () => {
    const row = baseRow();
    const display = apiRowToDisplay(row);

    expect(display.action).toBe('grant');
    expect(display.scope).toBe('org:fin');
    expect(display.role).toBe('role-fin-approve-250');
    expect(display.op).toBe('exec');
    expect(display.res).toBe('record');
  });

  it('assignment.revoke maps to action "revoke"', () => {
    const row = baseRow({ type: 'assignment.revoke' });
    const display = apiRowToDisplay(row);
    expect(display.action).toBe('revoke');
  });
});
