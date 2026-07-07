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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// P0 (re-verify fix-forward №3): mock the shared auth helper so fetchGrantTrail's
// header wiring is observable. authHeaders() is mode-aware in prod (keycloak→
// Bearer, dev→X-Dev-User); here it returns a sentinel we assert reaches fetch.
vi.mock('../../app-shell/dev-auth.js', () => ({
  authHeaders: () => ({ Authorization: 'Bearer test-token-123' }),
  devHeaders: () => ({ Authorization: 'Bearer test-token-123' }),
}));

import { apiRowToDisplay, GrantTrailRow, fetchGrantTrail, rowsToCsv, csvEscape } from './ra-grant-trail.jsx';
import { TRAIL as TRAIL_SEED } from './ra-data.jsx';

// REV-N1 fix-forward source-presence check (see describe block near EOF):
// module-level await, matching the pattern in screen-rights.test.jsx.
const fs = await import('fs');
const path = await import('path');
const screenSrcPath = path.default.resolve(new URL(import.meta.url).pathname, '../ra-grant-trail.jsx');
const screenSrc = fs.default.readFileSync(screenSrcPath, 'utf-8');

// ---------------------------------------------------------------------------
// Tree-walk helpers (mirror web/src/forms/field-renderer.test.jsx) — render a
// component as a plain function and recurse its element tree WITHOUT a DOM.
// This is what catches React #31: an OBJECT reaching a bare JSX child.
// ---------------------------------------------------------------------------

/**
 * A real React element is tagged with $$typeof === Symbol.for('react.element')
 * — NOT merely by having a `.type` property. This distinction is load-bearing
 * here: the exact crash shape is `{ type: "human", name: "…" }`, whose `.type`
 * is the STRING "human" — a naive `if (node.type)` check would mistake it for a
 * React element and skip it (false-GREEN). We identify elements by $$typeof.
 */
const REACT_ELEMENT = Symbol.for('react.element');
function isReactElement(node) {
  return node !== null && typeof node === 'object' && node.$$typeof === REACT_ELEMENT;
}

/**
 * Collect every bare CHILD that is a non-null, non-array plain object that is
 * NOT a React element — exactly the value React refuses to render ("Objects are
 * not valid as a React child", minified error #31). Props that are objects
 * (e.g. name={obj} passed to ActorChip) are fine — only `children` positions
 * are rendered — so we only descend through `children`.
 */
function collectObjectChildren(node, bad = []) {
  if (node === null || node === undefined) return bad;
  if (Array.isArray(node)) {
    for (const c of node) collectObjectChildren(c, bad);
    return bad;
  }
  if (typeof node !== 'object') return bad; // string/number/bool — renderable
  if (!isReactElement(node)) {
    // A plain object sitting in a child position — THIS is the React #31 crash.
    bad.push(node);
    return bad;
  }
  // React element — descend into its children only.
  const kids = node.props ? node.props.children : undefined;
  if (kids !== undefined) collectObjectChildren(kids, bad);
  return bad;
}

/**
 * flattenVisibleText — T-0685: collect the VISIBLE primary text leaves of a
 * rendered tree (recursing into function components by calling them), SKIPPING
 * aria-hidden decorations and chs-sr-only screen-reader-only spans. This is the
 * text a sighted operator actually reads in the «КОМУ»/«КТО-ВЫДАЛ» columns —
 * exactly where the capstone T-0647 saw the raw employee-UUID leak. We exclude
 * sr-only/title so the assertion is specifically about the PRIMARY label, not
 * the (legitimately id-bearing) tooltip/accessible-name.
 */
function flattenVisibleText(node, acc = []) {
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const c of node) flattenVisibleText(c, acc);
    return acc;
  }
  if (typeof node === 'object' && node.type) {
    if (node.props && node.props['aria-hidden']) return acc; // decorative glyph
    const cls = (node.props && node.props.className) || '';
    if (typeof cls === 'string' && cls.includes('chs-sr-only')) return acc; // AT-only
    if (typeof node.type === 'function') {
      flattenVisibleText(node.type(node.props || {}), acc);
      return acc;
    }
    flattenVisibleText(node.props && node.props.children, acc);
  }
  return acc;
}

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

// ===========================================================================
// T-0648 LIVE_PROOF regression — the ACTUAL React #31 crash on /rights/trail.
//
// ROOT CAUSE: when GET /api/grant-trail fails / returns a non-array, the screen
// falls back to `TRAIL_SEED.map(apiRowToDisplay)`. Seed rows (ra-data.jsx TRAIL)
// carry `actor`/`subject` as {type,name} OBJECTS (not strings). The old
// apiRowToDisplay assumed strings, so:
//   • role = r.subject ?? "—"  →  a {type,name} OBJECT
//   • that object was rendered as a BARE child  <span>{r.role}</span>
//   → React error #31: "object with keys {type, name}".
//
// These tests feed the REAL seed shape and (1) prove apiRowToDisplay produces
// only primitives, (2) RENDER GrantTrailRow and walk the tree to prove NO object
// reaches a bare JSX child. They RED on the pre-fix code (role/name were objects).
// ===========================================================================

describe('T-0648 LIVE_PROOF · SEED-shape rows (actor/subject are {type,name} objects) never leak into JSX', () => {
  // The exact shape ra-data.jsx TRAIL uses (this is what the fallback maps over).
  const SEED_ROW = {
    ts: '2026-06-08 14:21:06.318', id: 'grt-9f4a2c', action: 'grant',
    actor: { type: 'human', name: 'М. Соколов' },
    subject: { type: 'human', name: 'Е. Ларина' },
    role: 'Роль-грант ≤ ₽250 000', res: 'mcp://payments.initiate', op: 'invoke',
    scope: '≤ ₽250 000', proposed: 'human', confirmed: ['М. Соколов', 'Д. Гаврилов'], crit: true,
  };

  it('apiRowToDisplay on a seed row: role/op/res/scope/ts are all PRIMITIVE strings (not objects)', () => {
    const d = apiRowToDisplay(SEED_ROW);
    expect(typeof d.role).toBe('string');       // was a {type,name} object pre-fix
    expect(typeof d.op).toBe('string');
    expect(typeof d.res).toBe('string');
    expect(typeof d.scope).toBe('string');
    expect(typeof d.ts).toBe('string');
  });

  it('F-1: the "Роль · грант" column shows the seed ROLE LABEL, not the actor name', () => {
    // F-1 regression: the seed carries its OWN distinct grant/role label in
    // `role` — that is the whole point of the "Роль · грант" column. The role
    // must be that LABEL ("Роль-грант ≤ ₽250 000"), NOT subject.name ("Е. Ларина",
    // which is already shown in the neighbouring "Кому" column — showing it twice
    // is data loss on the exact fallback path a real user hits when the API is down).
    const d = apiRowToDisplay(SEED_ROW);
    expect(d.role).toBe('Роль-грант ≤ ₽250 000');
    expect(d.role).not.toBe(d.subject.name); // never duplicate the actor name
  });

  it('F-1: with NO explicit role (API-shape row) the label falls back to the subject slug', () => {
    // API rows have no distinct `role` field — there the role IS the subject
    // (a role slug). The subject-derivation fallback must still work.
    const apiRow = baseRow({ subject: 'role-fin-approve-250', subjectResolved: undefined });
    const d = apiRowToDisplay(apiRow);
    expect(d.role).toBe('role-fin-approve-250');
  });

  it('apiRowToDisplay on a seed row: actor/subject carry their OWN type + a STRING name (never nested)', () => {
    const d = apiRowToDisplay(SEED_ROW);
    expect(d.actor.type).toBe('human');
    expect(typeof d.actor.name).toBe('string');
    expect(d.actor.name).toBe('М. Соколов');   // was the whole {type,name} object pre-fix
    expect(d.subject.type).toBe('human');
    expect(d.subject.name).toBe('Е. Ларина');
  });

  it('a SERVICE-type seed actor (policy-sync) keeps its service type from the seed object', () => {
    const d = apiRowToDisplay({ ...SEED_ROW, actor: { type: 'service', name: 'policy-sync' } });
    expect(d.actor.type).toBe('service');
    expect(d.actor.name).toBe('policy-sync');
  });

  it('RENDER GrantTrailRow on a seed row → NO object reaches a bare JSX child (the React #31 crash)', () => {
    const tree = GrantTrailRow({ r: apiRowToDisplay(SEED_ROW) });
    const badChildren = collectObjectChildren(tree);
    expect(badChildren).toEqual([]); // pre-fix: [{type,name}] from <span>{r.role}</span>
  });

  it('RENDER GrantTrailRow across EVERY real TRAIL seed row → never a bare object child', () => {
    for (const seed of TRAIL_SEED) {
      const tree = GrantTrailRow({ r: apiRowToDisplay(seed) });
      const badChildren = collectObjectChildren(tree);
      expect(badChildren, `seed row ${seed.id} leaked an object into JSX`).toEqual([]);
    }
  });
});

describe('T-0648 LIVE_PROOF · API-shape rows (the resolver output) also render without object children', () => {
  it('RENDER GrantTrailRow on a resolved API row → no bare object child, name+chip present', () => {
    const row = baseRow({
      actor: 'e-fixture-user',
      actorResolved: { id: 'e-fixture-user', name: 'Тестовый Фикстур', type: 'human', deactivated: false, resolved: true },
      subject: 'e-triage',
      subjectResolved: { id: 'e-triage', name: 'Триаж-агент', type: 'agent', deactivated: false, resolved: true },
    });
    const tree = GrantTrailRow({ r: apiRowToDisplay(row) });
    expect(collectObjectChildren(tree)).toEqual([]);
  });
});

// ===========================================================================
// T-0685 LIVE_PROOF — /rights/trail «КОМУ» (subject) and «КТО-ВЫДАЛ» (granter)
// must NEVER surface a raw employee-UUID as the PRIMARY text.
//
// THE CAPSTONE T-0647 DEFECT: the batch actor resolver (src/db/actor-resolver.ts)
// resolves an actor/subject id → a human name when the id maps to an employee
// row. But when it does NOT (a stale/cross-tenant employee UUID, or a subject
// that is a grant/assignment TARGET uuid, not an employee), the server attaches
// no *Resolved field and apiRowToDisplay's honest fallback carries the raw id AS
// the name (name === id === a UUID). Pre-fix ActorChip rendered that UUID as the
// PRIMARY label — a bare machine key in the operator's face. Post-fix (T-0685)
// ActorChip demotes any UUID/machine-key primary to the tooltip + mono chip and
// shows the honest generic type label instead — exactly like ProcessRef/RecordRef.
//
// MUTATION: revert the ActorChip demotion and these RED (the UUID returns as the
// primary visible text). A neutral UUID + generic names keep the anti-case gate
// happy (no role-slug / person-name literals are introduced here).
// ===========================================================================

describe('T-0685 · unresolved actor UUID is NEVER the primary «КОМУ»/«КТО-ВЫДАЛ» text', () => {
  const RAW_ID_A = 'a1b2c3d4-0000-4000-8000-000000000001';
  const RAW_ID_B = 'a1b2c3d4-0000-4000-8000-000000000002';

  it('granter (actor) unresolved UUID → primary column text is NOT the raw UUID', () => {
    // No actorResolved from the server (resolver miss) → apiRowToDisplay falls
    // back to { name: <uuid>, id: <uuid> }. The rendered PRIMARY text must not be
    // the UUID — it must be an honest generic label.
    const row = baseRow({ actor: RAW_ID_A, actorResolved: undefined, subject: 'role-x' });
    const tree = GrantTrailRow({ r: apiRowToDisplay(row) });
    const visible = flattenVisibleText(tree).join(' ');
    expect(visible).not.toContain(RAW_ID_A); // the leak the capstone saw
  });

  it('subject (КОМУ) unresolved UUID → primary column text is NOT the raw UUID', () => {
    const row = baseRow({ subject: RAW_ID_B, subjectResolved: undefined });
    const tree = GrantTrailRow({ r: apiRowToDisplay(row) });
    const visible = flattenVisibleText(tree).join(' ');
    expect(visible).not.toContain(RAW_ID_B);
  });

  it('BOTH granter and subject unresolved UUIDs → neither UUID is primary text', () => {
    const row = baseRow({
      actor: RAW_ID_A, actorResolved: undefined,
      subject: RAW_ID_B, subjectResolved: undefined,
    });
    const tree = GrantTrailRow({ r: apiRowToDisplay(row) });
    const visible = flattenVisibleText(tree).join(' ');
    expect(visible).not.toContain(RAW_ID_A);
    expect(visible).not.toContain(RAW_ID_B);
    // The honest generic type label stands in for the missing human name — an
    // unresolved actor coerces to the "service" kind (never a fabricated human),
    // so its label is the generic kind word, not the raw UUID.
    expect(visible).toContain('Сервис');
  });

  it('the raw UUID stays REACHABLE — it is demoted to the tooltip, not dropped', () => {
    // Столп-honesty: we hide the UUID from the PRIMARY, we do not erase it.
    const row = baseRow({ actor: RAW_ID_A, actorResolved: undefined });
    const tree = GrantTrailRow({ r: apiRowToDisplay(row) });
    // Find the granter ActorChip (first ActorChip element) and assert its
    // wrapper title carries the raw id for auditability.
    const chips = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (isReactElement(n)) {
        const t = typeof n.props?.title === 'string' ? n.props.title : '';
        if (t.includes(RAW_ID_A)) chips.push(n);
        walk(n.props && n.props.children);
        if (typeof n.type === 'function') walk(n.type(n.props || {}));
      }
    })(tree);
    expect(chips.length).toBeGreaterThan(0); // UUID present in a tooltip somewhere
  });

  it('a RESOLVED actor still shows its human name (no false-positive demotion)', () => {
    // Guard: the demotion must fire ONLY on machine-key names — a real resolved
    // human name must still render as the primary text.
    const row = baseRow({
      actor: 'e-fixture-x',
      actorResolved: { id: 'e-fixture-x', name: 'Фикстур Один', type: 'human', deactivated: false, resolved: true },
    });
    const tree = GrantTrailRow({ r: apiRowToDisplay(row) });
    const visible = flattenVisibleText(tree).join(' ');
    expect(visible).toContain('Фикстур Один');
  });

  it('confirmer (КТО-ПОДТВЕРДИЛ) unresolved UUID → NOT rendered raw in the provenance column', () => {
    // The THIRD identifier column the capstone T-0647 live-proof caught leaking a
    // raw employee-UUID: confirmed_by. Unresolved machine-key → honest generic.
    const row = baseRow({ confirmed_by: RAW_ID_A, confirmedResolved: undefined });
    const tree = GrantTrailRow({ r: apiRowToDisplay(row) });
    const visible = flattenVisibleText(tree).join(' ');
    expect(visible).not.toContain(RAW_ID_A);
  });

  it('confirmer WITH confirmedResolved (server T-0685 resolve) shows the human name', () => {
    const row = baseRow({
      confirmed_by: 'e-fixture-y',
      confirmedResolved: { id: 'e-fixture-y', name: 'Фикстур Два', type: 'human', deactivated: false, resolved: true },
    });
    const display = apiRowToDisplay(row);
    expect(display.confirmed).toEqual(['Фикстур Два']);
  });

  it('LIVE_PROOF (exact capstone UUID shapes) — owner+orlov raw employee-UUIDs never primary', () => {
    // The precise scenario the capstone T-0647 acceptance surfaced: an assignment
    // event whose actor (granter), subject (КОМУ) and confirmed_by (КТО-ПОДТВЕРДИЛ)
    // all carry raw employee-UUIDs the batch resolver MISSED. NONE may appear as
    // visible primary text. (Neutral UUID literals — no case-lock content.)
    const OWNER = '3462410f-c98a-4a11-9b2e-000000000001';
    const ORLOV = 'e0000000-0000-4000-8000-000000000007';
    const row = {
      id: 'grt-live', type: 'assignment.create',
      actor: OWNER, actorResolved: undefined,
      subject: ORLOV, subjectResolved: undefined,
      confirmed_by: OWNER, confirmedResolved: undefined,
      scope: { kind: 'node', hierarchy: 'org', nodeId: 'fin', nodeLevel: 'department' },
      proposed_by: 'human',
      payload: { roleId: 'role-x' }, occurred_at: 1749383066318,
    };
    const tree = GrantTrailRow({ r: apiRowToDisplay(row) });
    const visible = flattenVisibleText(tree).join(' ');
    expect(visible).not.toContain(OWNER);
    expect(visible).not.toContain(ORLOV);
  });
});

// ===========================================================================
// T-0648 re-verify fix-forward №3 (P0) — /rights/trail must send the AUTH HEADER.
//
// ROOT CAUSE: both fetch('/api/grant-trail') call sites sent NO auth header →
// a live browser request 401'd ("missing Authorization header") → the screen
// ALWAYS fell to the TRAIL_SEED fallback (fake seed data, not the tenant's live
// grant-trail). /rights/trail was the only screen not using the shared helper.
// fetchGrantTrail() now carries authHeaders() on BOTH the initial load and the
// "load more" cursor request. These tests assert the header is present and that
// the URL is built correctly for both forms. They RED on a fetch() without headers.
// ===========================================================================

describe('T-0648 re-verify №3 · fetchGrantTrail sends the auth header (P0: 401→seed fallback)', () => {
  let lastCall;
  let fetchMock;

  beforeEach(() => {
    lastCall = null;
    fetchMock = vi.fn(async (url, init) => {
      lastCall = { url, init };
      return { ok: true, status: 200, json: async () => ({ rows: [], hasMore: false }) };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initial load: GET /api/grant-trail carries the Authorization header from authHeaders()', async () => {
    await fetchGrantTrail(undefined, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall.url).toBe('/api/grant-trail');
    // The exact header authHeaders() would produce (mocked above) must be passed.
    expect(lastCall.init).toBeDefined();
    expect(lastCall.init.headers).toEqual({ Authorization: 'Bearer test-token-123' });
  });

  it('load more: the before_seq cursor request ALSO carries the auth header', async () => {
    await fetchGrantTrail('before_seq=42', fetchMock);
    expect(lastCall.url).toBe('/api/grant-trail?before_seq=42');
    expect(lastCall.init.headers).toEqual({ Authorization: 'Bearer test-token-123' });
  });

  it('the request is NEVER sent header-less (the P0 that forced the seed fallback)', async () => {
    await fetchGrantTrail(undefined, fetchMock);
    // Regression guard: a bare fetch(url) with no init / no headers is the bug.
    expect(lastCall.init && lastCall.init.headers).toBeTruthy();
    expect(Object.keys(lastCall.init.headers).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T-0652 (§6.2): CSV export of the grant trail. The «Экспорт» button was DEAD
// (no onClick). It now serialises the ALREADY-LOADED display rows to CSV — no
// new endpoint, no bare fetch (data came via fetchGrantTrail, which carries
// authHeaders()). These tests exercise the pure serialiser + RFC4180 escaping.
// ---------------------------------------------------------------------------

describe('T-0652 · grant-trail CSV export (rowsToCsv / csvEscape)', () => {
  it('csvEscape: leaves a plain field untouched', () => {
    expect(csvEscape('abc')).toBe('abc');
    expect(csvEscape('')).toBe('');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('csvEscape: quotes a field with a COMMA and wraps it in double quotes (RFC4180)', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
  });

  it('csvEscape: DOUBLES an inner double-quote and wraps the field', () => {
    // RFC4180: `he said "hi"` → `"he said ""hi"""`
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('csvEscape: quotes a field containing a newline (would otherwise break a row)', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('rowsToCsv: emits a header row + one data row per display row', () => {
    const rows = [apiRowToDisplay({
      id: 'g1', occurred_at: 0, type: 'grant.create',
      actor: 'e-owner', subject: 'role-x', op: 'invoke', res: 'mcp://payments.initiate',
      scope: '—', confirmed: ['Иванов'],
    })];
    const csv = rowsToCsv(rows);
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines.length).toBe(2); // header + 1 data row
    // header carries the human-readable column names
    expect(lines[0]).toContain('Кто выдал');
    expect(lines[0]).toContain('Кому');
    // res is stripped of the mcp:// prefix (mirrors the on-screen rendering)
    expect(lines[1]).toContain('payments.initiate');
    expect(lines[1]).not.toContain('mcp://');
  });

  it('rowsToCsv: escapes a name that contains a comma so the column count is preserved', () => {
    // A display row whose subject NAME carries a comma must not split into extra
    // columns — the comma-bearing field is quoted.
    const row = {
      ts: '2026-01-01', id: 'g2', action: 'grant',
      actor: { type: 'human', name: 'Соколов, М.' },
      subject: { type: 'human', name: 'Ларина' },
      role: 'Роль', op: 'invoke', res: 'x', scope: '—', proposed: 'human', confirmed: [],
    };
    const csv = rowsToCsv([row]);
    const dataLine = csv.replace(/^﻿/, '').trim().split('\r\n')[1];
    expect(dataLine).toContain('"Соколов, М."');
  });

  it('rowsToCsv: actor/subject rendered by NAME (not the {type,name} object)', () => {
    const row = {
      ts: 't', id: 'g3', action: 'revoke',
      actor: { type: 'service', name: 'policy-sync' },
      subject: { type: 'agent', name: 'Юрист-прекчек' },
      role: 'R', op: 'o', res: 'r', scope: 's', proposed: 'agent', confirmed: ['подтверждено'],
    };
    const dataLine = rowsToCsv([row]).replace(/^﻿/, '').trim().split('\r\n')[1];
    expect(dataLine).toContain('policy-sync');
    expect(dataLine).toContain('Юрист-прекчек');
    expect(dataLine).not.toContain('[object Object]');
  });

  it('rowsToCsv: starts with a UTF-8 BOM so Excel reads Cyrillic correctly', () => {
    expect(rowsToCsv([]).charCodeAt(0)).toBe(0xFEFF);
  });

  // -------------------------------------------------------------------------
  // F-1 (live-proof on the deployed stand, T-0652 follow-up): the CSV export
  // must match what ActorChip already shows ON SCREEN (T-0648/T-0685) — an
  // UNRESOLVED machine actor (batch resolver miss → name === id === raw UUID)
  // is demoted to the honest generic type label, never the bare UUID. Before
  // this fix, `nameOf` returned `v.name` unconditionally, re-leaking the exact
  // machine-UUID the on-screen demotion closes — into the exported FILE.
  // -------------------------------------------------------------------------
  it('rowsToCsv: unresolved machine-UUID subject ("Кому") is demoted to a type label, not the raw UUID', () => {
    const RAW_ID = 'a1b2c3d4-0000-4000-8000-000000000002';
    const row = apiRowToDisplay({
      id: 'g4', occurred_at: 0, type: 'grant.create',
      actor: 'e-owner', subject: RAW_ID, subjectResolved: undefined,
      op: 'invoke', res: 'x', scope: '—', confirmed: [],
    });
    const dataLine = rowsToCsv([row]).replace(/^﻿/, '').trim().split('\r\n')[1];
    expect(dataLine).not.toContain(RAW_ID);
    expect(dataLine).toContain('Сервис'); // coerceActorField's honest fallback kind
  });

  it('rowsToCsv: unresolved machine-UUID actor ("Кто выдал") is demoted to a type label, not the raw UUID', () => {
    const RAW_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
    const row = apiRowToDisplay({
      id: 'g5', occurred_at: 0, type: 'grant.create',
      actor: RAW_ID, actorResolved: undefined, subject: 'role-x',
      op: 'invoke', res: 'x', scope: '—', confirmed: [],
    });
    const dataLine = rowsToCsv([row]).replace(/^﻿/, '').trim().split('\r\n')[1];
    expect(dataLine).not.toContain(RAW_ID);
    expect(dataLine).toContain('Сервис');
  });

  it('rowsToCsv: an "agent:" machine key is demoted to "Агент" (not the raw key)', () => {
    const row = {
      ts: 't', id: 'g6', action: 'grant',
      actor: { type: 'agent', name: 'agent:юрист-прекчек-42' },
      subject: { type: 'human', name: 'Ларина' },
      role: 'R', op: 'o', res: 'r', scope: 's', proposed: 'agent', confirmed: [],
    };
    const dataLine = rowsToCsv([row]).replace(/^﻿/, '').trim().split('\r\n')[1];
    expect(dataLine).not.toContain('agent:юрист-прекчек-42');
    expect(dataLine).toContain('Агент');
  });

  it('rowsToCsv: a resolved HUMAN name is unaffected (not demoted)', () => {
    const row = {
      ts: 't', id: 'g7', action: 'grant',
      actor: { type: 'human', name: 'Ларина' },
      subject: { type: 'human', name: 'Иванов' },
      role: 'R', op: 'o', res: 'r', scope: 's', proposed: 'human', confirmed: ['Ларина'],
    };
    const dataLine = rowsToCsv([row]).replace(/^﻿/, '').trim().split('\r\n')[1];
    expect(dataLine).toContain('Ларина');
    expect(dataLine).toContain('Иванов');
  });

  it('rowsToCsv: a human-legible SLUG (not a UUID) stays primary — mirrors ActorChip (no false positive)', () => {
    const row = {
      ts: 't', id: 'g8', action: 'grant',
      actor: { type: 'service', name: 'policy-sync' },
      subject: { type: 'human', name: 'Ларина' },
      role: 'R', op: 'o', res: 'r', scope: 's', proposed: 'human', confirmed: [],
    };
    const dataLine = rowsToCsv([row]).replace(/^﻿/, '').trim().split('\r\n')[1];
    expect(dataLine).toContain('policy-sync');
  });
});

// ---------------------------------------------------------------------------
// REV-P1-CSV-FORMULA-INJECTION (fix-forward): RFC4180 quoting alone does NOT
// stop a cell whose value begins with = + - @ (or leading TAB/CR) from being
// evaluated as a formula when the CSV is opened in Excel/LibreOffice/Sheets.
// Role names and resolved display names are user/admin-authored and flow
// un-guarded into cell starts — csvEscape must prefix a leading apostrophe
// (OWASP mitigation) BEFORE RFC4180-quoting, and force-quote such a cell.
// ---------------------------------------------------------------------------
describe('T-0652 fix-forward · CSV formula-injection neutralization (csvEscape / rowsToCsv)', () => {
  it('csvEscape: a value starting with "=" is prefixed with an apostrophe and quoted', () => {
    expect(csvEscape('=HYPERLINK("http://evil","click")')).toBe('"\'=HYPERLINK(""http://evil"",""click"")"');
  });

  it('csvEscape: values starting with + - @ are each neutralized', () => {
    expect(csvEscape('+cmd|/c calc')).toBe('"\'+cmd|/c calc"');
    expect(csvEscape('-2+3')).toBe('"\'-2+3"');
    expect(csvEscape('@SUM(A1:A2)')).toBe('"\'@SUM(A1:A2)"');
  });

  it('csvEscape: a leading TAB or CR is also neutralized', () => {
    expect(csvEscape('\t=1+1')).toBe('"\'\t=1+1"');
    expect(csvEscape('\rmalicious')).toBe('"\'\rmalicious"');
  });

  it('csvEscape: a formula char NOT in leading position is left alone (no false positive)', () => {
    expect(csvEscape('a=b+c')).toBe('a=b+c');
    expect(csvEscape('Иванов (=менеджер)')).toBe('Иванов (=менеджер)');
  });

  it('csvEscape: plain values and RFC4180 cases are unaffected by the new guard', () => {
    expect(csvEscape('abc')).toBe('abc');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
  });

  it('rowsToCsv: a ROLE name beginning with "=HYPERLINK(...)" is neutralized in the emitted CSV', () => {
    const row = {
      ts: '2026-01-01', id: 'g10', action: 'grant',
      actor: { type: 'human', name: 'Иванов' },
      subject: { type: 'human', name: 'Ларина' },
      role: '=HYPERLINK("http://evil.example","click me")',
      op: 'invoke', res: 'x', scope: '—', proposed: 'human', confirmed: [],
    };
    const dataLine = rowsToCsv([row]).replace(/^﻿/, '').trim().split('\r\n')[1];
    // Not raw-executable: the field must not start with a bare "=" — it is
    // quoted and apostrophe-prefixed.
    expect(dataLine).not.toMatch(/(^|,)=HYPERLINK/);
    expect(dataLine).toContain("'=HYPERLINK(\"\"http://evil.example\"\",\"\"click me\"\")");
  });

  it('rowsToCsv: a display NAME beginning with "+cmd|" (DDE injection) is neutralized', () => {
    const row = {
      ts: '2026-01-01', id: 'g11', action: 'revoke',
      actor: { type: 'human', name: '+cmd|\' /C calc\'!A1' },
      subject: { type: 'human', name: 'Ларина' },
      role: 'Роль', op: 'invoke', res: 'x', scope: '—', proposed: 'human', confirmed: [],
    };
    const dataLine = rowsToCsv([row]).replace(/^﻿/, '').trim().split('\r\n')[1];
    expect(dataLine).not.toMatch(/(^|,)\+cmd\|/);
    expect(dataLine).toContain("'+cmd|");
  });

  // ---- existing RFC4180 behaviour must remain green alongside the new guard ----
  it('rowsToCsv: still escapes a name that contains a comma (RFC4180 unaffected)', () => {
    const row = {
      ts: '2026-01-01', id: 'g2', action: 'grant',
      actor: { type: 'human', name: 'Соколов, М.' },
      subject: { type: 'human', name: 'Ларина' },
      role: 'Роль', op: 'invoke', res: 'x', scope: '—', proposed: 'human', confirmed: [],
    };
    const csv = rowsToCsv([row]);
    const dataLine = csv.replace(/^﻿/, '').trim().split('\r\n')[1];
    expect(dataLine).toContain('"Соколов, М."');
  });

  it('rowsToCsv: still starts with a UTF-8 BOM', () => {
    expect(rowsToCsv([]).charCodeAt(0)).toBe(0xFEFF);
  });
});

// ---------------------------------------------------------------------------
// REV-N1-EXPORT-USES-FILTERED-ROWS-BUT-GUARD-ON-ALL (fix-forward): the export
// button serialises the FILTERED set (`rows`), but the disabled guard used to
// test `displayRows.length===0` (ALL loaded rows). A filter that matches zero
// rows left the button active and exported a header-only CSV while the UI
// still showed "нет записей" (a lie — displayRows was non-empty). Source-
// presence check (project convention — see screen-rights.test.jsx): the
// screen component isn't render-tested at this node tier (no jsdom), so the
// guard's wiring is asserted structurally against the actual source text.
// ---------------------------------------------------------------------------
describe('T-0652 fix-forward · export guard follows the FILTERED row set (REV-N1)', () => {
  it('the export disabled-guard tests rows.length (filtered), not displayRows.length (all)', () => {
    // The stub/disabled BRANCH SWITCH (the ternary that decides stub-vs-live
    // button) must be keyed off the filtered set that is actually handed to
    // downloadCsv/rowsToCsv — not the unfiltered displayRows. (displayRows
    // is still legitimately read INSIDE the stub branch, to pick the honest
    // empty-state wording — that's a separate, narrower check below.)
    expect(screenSrc).toMatch(/\{rows\.length === 0 \? \(\s*<span className="chs-trail__stub">/);
    expect(screenSrc).not.toMatch(/\{displayRows\.length === 0 \? \(\s*<span className="chs-trail__stub">/);
  });

  it('the live export button still serialises the filtered `rows`, not `displayRows`', () => {
    expect(screenSrc).toMatch(/downloadCsv\(rowsToCsv\(rows\), 'grant-trail\.csv'\)/);
  });

  it('the empty-state reason distinguishes "no rows at all" from "filter matched nothing" (honest cause)', () => {
    // Two distinct human-readable reasons must exist, gated on whether
    // displayRows (unfiltered) is itself empty.
    expect(screenSrc).toMatch(/displayRows\.length === 0 \? .Нет записей для экспорта./);
    expect(screenSrc).toMatch(/Фильтр не даёт совпадений/);
  });
});

