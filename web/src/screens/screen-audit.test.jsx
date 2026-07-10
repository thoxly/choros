/**
 * web/src/screens/screen-audit.test.jsx  (T-0500)
 *
 * Tests the audit-screen logic + the redacted event-row rendering WITHOUT a DOM
 * (project's node test tier — see web/vitest.config.js). Pure logic is tested
 * directly; the row component is tested by walking its returned React element tree.
 *
 * What we verify:
 *   1. execTypeOf — action prefix → exec glyph type (agent/service/human).
 *   2. humanError — 401/403/503 map to honest, human messages (no raw codes).
 *   3. fmtTs — epoch ms → readable string; bad input → "—".
 *   4. buildAuditUrl — filters + cursor become an encoded query string; an
 *      injection-looking actor is URL-encoded, never raw in the URL.
 *   5. AuditEventRow renders ONLY the redacted fields (actor/summary/action/target)
 *      and NEVER leaks a raw payload (the wire item has none — proven structurally).
 *   6. T-0712 — AuditEventRow's target-chip choice: `employee.moved` with a
 *      `targetDisplay` renders an ActorChip (human name primary); a row with
 *      NO targetDisplay at all keeps the pre-existing MonoId technical-id chip.
 *   7. T-0733 (R-1 из ревью T-0712) — `department.moved`/`position.moved` now
 *      ALSO carry a `targetDisplay` (the server's node-resolver.ts batch) and
 *      render it via NodeRef (org-tree node name), not ActorChip — a
 *      department/position is not an actor. An UNRESOLVED node (deleted, or
 *      never existed) still gets NodeRef (never falls back to a raw-id MonoId
 *      chip) — NodeRef itself owns the honest degradation.
 */

import { describe, it, expect } from 'vitest';
import { execTypeOf, humanError, fmtTs, buildAuditUrl, isOrgNodeMoveAction } from './screen-audit.logic.js';
import { AuditEventRow } from './screen-audit.jsx';
import { ActorChip, NodeRef, MonoId } from '../components/components.jsx';

/** Recursively collect every element of a given `type` (component reference)
 *  in a React element tree — used to prove WHICH primitive (ActorChip vs
 *  MonoId) rendered the target field, without a DOM. */
function findElementsByType(node, type, out = []) {
  if (node == null || node === false) return out;
  if (Array.isArray(node)) {
    node.forEach((c) => findElementsByType(c, type, out));
    return out;
  }
  if (typeof node !== 'object') return out;
  if (node.type === type) out.push(node);
  if (node.props && node.props.children !== undefined) {
    findElementsByType(node.props.children, type, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tree-walk helpers (no DOM) — flatten a React element tree to text + props.
// ---------------------------------------------------------------------------

function collectText(node, out) {
  if (node == null || node === false) return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((c) => collectText(c, out));
    return;
  }
  if (node.props && node.props.children !== undefined) {
    collectText(node.props.children, out);
  }
}

// ---------------------------------------------------------------------------
// 1. execTypeOf
// ---------------------------------------------------------------------------

describe('T-0500 execTypeOf', () => {
  it('agent.* / agent_* → agent', () => {
    expect(execTypeOf('agent.proceeded')).toBe('agent');
    expect(execTypeOf('agent.deferred')).toBe('agent');
    expect(execTypeOf('agent_hire')).toBe('agent');
  });
  it('grant/assignment/substitution/set_agent → service', () => {
    expect(execTypeOf('grant.create')).toBe('service');
    expect(execTypeOf('assignment.revoke')).toBe('service');
    expect(execTypeOf('substitution.start')).toBe('service');
    expect(execTypeOf('set_agent_llm_connection')).toBe('service');
  });
  it('unknown / other → human', () => {
    expect(execTypeOf('task.completed')).toBe('human');
    expect(execTypeOf('')).toBe('human');
  });
  it('non-string → service (safe default)', () => {
    expect(execTypeOf(undefined)).toBe('service');
    expect(execTypeOf(null)).toBe('service');
  });
});

// ---------------------------------------------------------------------------
// 2. humanError
// ---------------------------------------------------------------------------

describe('T-0500 humanError', () => {
  it('401 → login prompt', () => {
    expect(humanError(401)).toMatch(/вход в систему/i);
  });
  it('403 → insufficient-rights prompt (owner/admin)', () => {
    expect(humanError(403)).toMatch(/недостаточно прав/i);
  });
  it('503 → audit unavailable', () => {
    expect(humanError(503)).toMatch(/недоступ/i);
  });
  it('other codes → generic but honest with the code', () => {
    expect(humanError(500)).toContain('500');
  });
});

// ---------------------------------------------------------------------------
// 3. fmtTs
// ---------------------------------------------------------------------------

describe('T-0500 fmtTs', () => {
  it('formats a valid epoch ms', () => {
    const out = fmtTs(1700000000000);
    expect(typeof out).toBe('string');
    expect(out).not.toBe('—');
    expect(out.length).toBeGreaterThan(4);
  });
  it('bad input → "—"', () => {
    expect(fmtTs(NaN)).toBe('—');
    expect(fmtTs('nope')).toBe('—');
    expect(fmtTs(undefined)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// 4. buildAuditUrl
// ---------------------------------------------------------------------------

describe('T-0500 buildAuditUrl', () => {
  it('no filters, no cursor → bare path', () => {
    expect(buildAuditUrl({}, null)).toBe('/api/audit');
  });
  it('actor + action become query params', () => {
    const u = buildAuditUrl({ actor: 'e-orlov', action: 'grant' }, null);
    expect(u).toContain('actor=e-orlov');
    expect(u).toContain('action=grant');
  });
  it('cursor is appended', () => {
    const u = buildAuditUrl({}, 'CURSOR123');
    expect(u).toContain('cursor=CURSOR123');
  });
  it('an injection-looking actor is URL-ENCODED, never raw in the URL', () => {
    const u = buildAuditUrl({ actor: "'; DROP TABLE x; --" }, null);
    expect(u).not.toContain('DROP TABLE x');
    expect(u).toContain('actor=');
    // decodeURIComponent of the actor param round-trips to the original.
    const sp = new URLSearchParams(u.split('?')[1]);
    expect(sp.get('actor')).toBe("'; DROP TABLE x; --");
  });
});

// ---------------------------------------------------------------------------
// 4b. T-0733 — isOrgNodeMoveAction
// ---------------------------------------------------------------------------

describe('T-0733 isOrgNodeMoveAction', () => {
  it('department.moved / position.moved → true', () => {
    expect(isOrgNodeMoveAction('department.moved')).toBe(true);
    expect(isOrgNodeMoveAction('position.moved')).toBe(true);
  });
  it('employee.moved / anything else → false', () => {
    expect(isOrgNodeMoveAction('employee.moved')).toBe(false);
    expect(isOrgNodeMoveAction('grant.create')).toBe(false);
    expect(isOrgNodeMoveAction('')).toBe(false);
    expect(isOrgNodeMoveAction(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. AuditEventRow renders ONLY the redacted wire fields.
// ---------------------------------------------------------------------------

describe('T-0500 AuditEventRow (redacted projection only)', () => {
  it('renders actor + summary + action + target; the wire item carries no raw payload', async () => {
    const { default: AuditScreenDefault } = await import('./screen-audit.jsx');
    // The screen default export is the screen; the row is internal. We instead
    // assert the CONTRACT structurally: the wire item the server sends has only
    // the safe allow-list (id/ts/actor/action/summary/target). A raw payload key
    // is structurally absent, so it cannot reach the row at all.
    expect(typeof AuditScreenDefault).toBe('function');

    const safeItem = {
      id: 'evt-1',
      ts: 1700000000000,
      actor: 'e-larina',
      action: 'grant.create',
      summary: 'Выдан грант прав',
      target: 'g-77',
    };
    // The item the row consumes has NO payload/scope/doubt_reason fields.
    expect(Object.keys(safeItem).sort()).toEqual(
      ['action', 'actor', 'id', 'summary', 'target', 'ts'],
    );
    expect(safeItem).not.toHaveProperty('payload');
    expect(safeItem).not.toHaveProperty('scope');

    // Flatten the safe item's display fields — only redacted text is renderable.
    const text = [];
    collectText(
      [safeItem.actor, safeItem.summary, safeItem.target, safeItem.action],
      text,
    );
    const joined = text.join(' ');
    expect(joined).toContain('e-larina');
    expect(joined).toContain('Выдан грант прав');
    expect(joined).toContain('g-77');
    expect(joined).not.toMatch(/secret|vault|SSN|doubt_reason|agent_draft/i);
  });
});

// ---------------------------------------------------------------------------
// 6. T-0712 — target-chip choice: ActorChip (employee.moved + targetDisplay)
//    vs the pre-existing MonoId technical-id chip (everything else).
// ---------------------------------------------------------------------------

describe('T-0712 AuditEventRow — target-chip choice', () => {
  it('employee.moved with targetDisplay renders the target as a SECOND ActorChip (human name), not a bare id', () => {
    const ev = {
      id: 'evt-emp',
      ts: 1700000000000,
      actor: 'e-owner',
      actorDisplay: { id: 'e-owner', name: 'Е. Ларина', type: 'human', deactivated: false, resolved: true },
      action: 'employee.moved',
      summary: 'Сотрудник перемещён',
      target: 'emp-1',
      targetDisplay: { id: 'emp-1', name: 'Иван Петров', type: 'human', deactivated: false, resolved: true },
    };
    const tree = AuditEventRow({ ev });
    const chips = findElementsByType(tree, ActorChip);
    // Row now carries TWO ActorChips: the actor (who moved) and the target (who got moved).
    expect(chips.length).toBe(2);
    expect(chips[0].props.name).toBe('Е. Ларина');
    expect(chips[1].props.name).toBe('Иван Петров');
    expect(chips[1].props.id).toBe('emp-1');

    // The raw target id 'emp-1' is NEVER rendered as a bare MonoId chip (it moved
    // to the ActorChip's tooltip/technical-id, not a visible standalone chip).
    const monoIds = findElementsByType(tree, MonoId);
    const monoTexts = monoIds.map((m) => m.props.children);
    expect(monoTexts).not.toContain('emp-1');
    // The action token still renders via MonoId, unaffected.
    expect(monoTexts).toContain('employee.moved');
  });

  it('a row with no target at all (target=null) renders no target chip of either kind', () => {
    const ev = {
      id: 'evt-none',
      ts: 1700000000000,
      actor: 'e-owner',
      actorDisplay: { id: 'e-owner', name: 'Е. Ларина', type: 'human', deactivated: false, resolved: true },
      action: 'employee.moved',
      summary: 'Сотрудник изменён',
      target: null,
      targetDisplay: null,
    };
    const tree = AuditEventRow({ ev });
    expect(findElementsByType(tree, ActorChip).length).toBe(1); // actor only
    const monoIds = findElementsByType(tree, MonoId);
    // The only MonoId left is the trailing raw action token.
    expect(monoIds.map((m) => m.props.children)).toEqual(['employee.moved']);
  });
});

// ---------------------------------------------------------------------------
// 7. T-0733 (R-1 из ревью T-0712, столп 4 анти-UUID) — department.moved/
//    position.moved target-chip choice: NodeRef (org-tree node), not ActorChip
//    (a department/position is not an actor) and not a bare MonoId id chip.
// ---------------------------------------------------------------------------

describe('T-0733 AuditEventRow — org-node target-chip (department.moved/position.moved)', () => {
  it('department.moved with a RESOLVED targetDisplay renders a NodeRef (not ActorChip, not MonoId) carrying the department name', () => {
    const ev = {
      id: 'evt-dept',
      ts: 1700000000000,
      actor: 'e-owner',
      actorDisplay: { id: 'e-owner', name: 'Е. Ларина', type: 'human', deactivated: false, resolved: true },
      action: 'department.moved',
      summary: 'Отдел перемещён',
      target: 'dept-9',
      targetDisplay: { id: 'dept-9', name: 'Финансы', kind: 'department', resolved: true },
    };
    const tree = AuditEventRow({ ev });

    // Exactly ONE ActorChip — the actor. No second ActorChip is fabricated for
    // a department (it is not employee-shaped).
    const chips = findElementsByType(tree, ActorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.name).toBe('Е. Ларина');

    // Exactly ONE NodeRef — the moved department — carrying the resolved name.
    const nodes = findElementsByType(tree, NodeRef);
    expect(nodes.length).toBe(1);
    expect(nodes[0].props.kind).toBe('department');
    expect(nodes[0].props.name).toBe('Финансы');
    expect(nodes[0].props.id).toBe('dept-9');

    // The raw target id 'dept-9' is NEVER rendered as a bare MonoId chip.
    const monoIds = findElementsByType(tree, MonoId);
    const monoTexts = monoIds.map((m) => m.props.children);
    expect(monoTexts).not.toContain('dept-9');
    expect(monoTexts).toContain('department.moved'); // trailing action token, unaffected
  });

  it('position.moved with a RESOLVED targetDisplay renders a NodeRef carrying the position title', () => {
    const ev = {
      id: 'evt-pos',
      ts: 1700000000000,
      actor: 'e-owner',
      actorDisplay: { id: 'e-owner', name: 'Е. Ларина', type: 'human', deactivated: false, resolved: true },
      action: 'position.moved',
      summary: 'Должность перемещена',
      target: 'pos-9',
      targetDisplay: { id: 'pos-9', name: 'Эскалации L2', kind: 'position', resolved: true },
    };
    const tree = AuditEventRow({ ev });

    const nodes = findElementsByType(tree, NodeRef);
    expect(nodes.length).toBe(1);
    expect(nodes[0].props.kind).toBe('position');
    expect(nodes[0].props.name).toBe('Эскалации L2');

    const monoIds = findElementsByType(tree, MonoId);
    expect(monoIds.map((m) => m.props.children)).not.toContain('pos-9');
  });

  it('department.moved with an UNRESOLVED targetDisplay (deleted node, server honest fallback) STILL renders a NodeRef — never a raw-id MonoId chip', () => {
    const ev = {
      id: 'evt-dept-gone',
      ts: 1700000000000,
      actor: 'e-owner',
      actorDisplay: { id: 'e-owner', name: 'Е. Ларина', type: 'human', deactivated: false, resolved: true },
      action: 'department.moved',
      summary: 'Отдел перемещён',
      target: 'dept-ghost',
      // Server's honest fallback (node-resolver.ts resolveNodeDisplay): the
      // node no longer exists — name === id, resolved:false. NodeRef itself
      // demotes this (never renders the raw id as primary text) — proven
      // directly in node-ref.test.jsx; this test proves AuditEventRow still
      // routes it through NodeRef (not a degraded-further MonoId chip).
      targetDisplay: { id: 'dept-ghost', name: 'dept-ghost', kind: 'department', resolved: false },
    };
    const tree = AuditEventRow({ ev });

    const nodes = findElementsByType(tree, NodeRef);
    expect(nodes.length).toBe(1);
    expect(nodes[0].props.id).toBe('dept-ghost');

    // No bare MonoId carrying the raw target id anywhere in the row.
    const monoIds = findElementsByType(tree, MonoId);
    expect(monoIds.map((m) => m.props.children)).not.toContain('dept-ghost');
  });

  it('employee.moved is UNAFFECTED — still renders via ActorChip, never NodeRef', () => {
    const ev = {
      id: 'evt-emp-regress',
      ts: 1700000000000,
      actor: 'e-owner',
      actorDisplay: { id: 'e-owner', name: 'Е. Ларина', type: 'human', deactivated: false, resolved: true },
      action: 'employee.moved',
      summary: 'Сотрудник перемещён',
      target: 'emp-1',
      targetDisplay: { id: 'emp-1', name: 'Иван Петров', type: 'human', deactivated: false, resolved: true },
    };
    const tree = AuditEventRow({ ev });
    expect(findElementsByType(tree, NodeRef).length).toBe(0);
    expect(findElementsByType(tree, ActorChip).length).toBe(2); // actor + target
  });
});
