/**
 * Unit tests for src/core/user-task-role-mapper.ts — T-0642 [столп1/P0].
 *
 * LIVE_PROOF T-0588: a userTask with a panel-assigned role (choros:assignedRoleId,
 * a role UUID) published WITHOUT flowable:candidateGroups — the task landed in an
 * empty Flowable pool, unreachable by any inbox.
 *
 * Contract under test:
 *   - extractUserTaskRoleRefs: read choros:assignedRoleId off <userTask> elements
 *     that do NOT already carry candidateGroups (explicit/lane/timer wins).
 *   - mapUserTaskRoleToCandidateGroups: resolve each ref's UUID via an INJECTED
 *     async port (DB-backed in production — process-defs.ts wires
 *     resolveRoleSlugsByIds from grants-dao.ts) and inject
 *     flowable:candidateGroups="<slug>"; degrade (leave unrouted) when the port
 *     returns null; ensureFlowableNamespace (T-0635, reused not duplicated) is
 *     called only when something was actually wired.
 *
 * The resulting candidateGroups value is what executor-resolver.ts consumes as
 * `roleSlug` — these tests assert the fix writes the SLUG, never the UUID.
 */

import { describe, it, expect, vi } from "vitest";
import {
  extractUserTaskRoleRefs,
  mapUserTaskRoleToCandidateGroups,
  type ResolveRoleSlug,
} from "../user-task-role-mapper.js";
import { FLOWABLE_NAMESPACE_URI } from "../agent-task-external-mapper.js";
import { lintBpmn } from "../bpmn-linter.js";

const ROLE_ID_BUH = "e0000000-0000-0000-0000-000000000002";
const ROLE_SLUG_BUH = "budget-approver";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Hand-authored XML with xmlns:flowable already declared. */
const NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:flowable="http://flowable.org/bpmn" ' +
  'xmlns:choros="http://choros.io/bpmn"';

function proc(body: string): string {
  return `<definitions ${NS}><process id="p1">${body}</process></definitions>`;
}

// T-0642: mirrors the T-0635 discipline — the REALISTIC modeler-exported shape
// carries NO xmlns:flowable (choros-moddle-extension.js registers only the
// choros namespace). These fixtures reproduce that reality so the namespace
// guard is exercised honestly (not hand-waved by an always-present xmlns).
const MODELER_NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
  'xmlns:choros="http://choros.io/bpmn"';

function modelerProc(body: string): string {
  return `<definitions ${MODELER_NS}><process id="p1">${body}</process></definitions>`;
}

/** A userTask with a panel-assigned role, no candidateGroups yet (modeler shape). */
const ONE_ROLE_XML = modelerProc(
  `<startEvent id="start"/>` +
    `<userTask id="Activity_approve" name="Согласовать счёт" choros:assignedRoleId="${ROLE_ID_BUH}"/>` +
    `<endEvent id="end"/>`,
);

/** A userTask with assignedRoleId AND an already-explicit candidateGroups. */
const EXPLICIT_WINS_XML = modelerProc(
  `<userTask id="Task_explicit" choros:assignedRoleId="${ROLE_ID_BUH}" flowable:candidateGroups="already-set"/>`,
);

/** A userTask with no assignedRoleId at all — regression baseline. */
const NO_ROLE_XML = modelerProc(`<userTask id="Task_plain" name="Обычный шаг"/>`);

/** A serviceTask (agentTask shape) carrying assignedRoleId — must NOT be touched. */
const AGENT_TASK_XML = modelerProc(
  `<serviceTask id="Task_agent" choros:executorType="agent" choros:agentRef="agent-1" choros:assignedRoleId="${ROLE_ID_BUH}"/>`,
);

/** Always-resolving stub port. */
function stubResolver(map: Record<string, string>): ResolveRoleSlug {
  return async (roleId: string) => map[roleId] ?? null;
}

// ---------------------------------------------------------------------------
// extractUserTaskRoleRefs
// ---------------------------------------------------------------------------

describe("extractUserTaskRoleRefs", () => {
  it("extracts a userTask carrying assignedRoleId with no candidateGroups", () => {
    const refs = extractUserTaskRoleRefs(ONE_ROLE_XML);
    expect(refs).toEqual([{ userTaskId: "Activity_approve", roleId: ROLE_ID_BUH }]);
  });

  it("skips a userTask that already carries candidateGroups (explicit wins)", () => {
    expect(extractUserTaskRoleRefs(EXPLICIT_WINS_XML)).toEqual([]);
  });

  it("skips a userTask with no assignedRoleId", () => {
    expect(extractUserTaskRoleRefs(NO_ROLE_XML)).toEqual([]);
  });

  it("skips a serviceTask (agentTask) even when it carries assignedRoleId", () => {
    expect(extractUserTaskRoleRefs(AGENT_TASK_XML)).toEqual([]);
  });

  it("returns [] on a document with no userTask at all", () => {
    expect(extractUserTaskRoleRefs(modelerProc(`<startEvent id="s"/>`))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapUserTaskRoleToCandidateGroups
// ---------------------------------------------------------------------------

describe("mapUserTaskRoleToCandidateGroups", () => {
  it("injects candidateGroups with the RESOLVED SLUG (not the UUID)", async () => {
    const resolver = stubResolver({ [ROLE_ID_BUH]: ROLE_SLUG_BUH });
    const out = await mapUserTaskRoleToCandidateGroups(ONE_ROLE_XML, resolver);
    expect(out).toMatch(
      /<userTask\b[^>]*id="Activity_approve"[^>]*flowable:candidateGroups="budget-approver"/,
    );
    expect(out).not.toContain(`candidateGroups="${ROLE_ID_BUH}"`);
  });

  it("declares xmlns:flowable on the definitions root when something was wired", async () => {
    const resolver = stubResolver({ [ROLE_ID_BUH]: ROLE_SLUG_BUH });
    const out = await mapUserTaskRoleToCandidateGroups(ONE_ROLE_XML, resolver);
    expect(out).toMatch(new RegExp(`xmlns:flowable="${FLOWABLE_NAMESPACE_URI}"`));
  });

  it("does NOT call the resolver when there is nothing to resolve (additive)", async () => {
    const resolver = vi.fn(async () => ROLE_SLUG_BUH);
    const out = await mapUserTaskRoleToCandidateGroups(NO_ROLE_XML, resolver);
    expect(out).toBe(NO_ROLE_XML);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("does not add xmlns:flowable when nothing was wired", async () => {
    const resolver = stubResolver({});
    const out = await mapUserTaskRoleToCandidateGroups(NO_ROLE_XML, resolver);
    expect(out).toBe(NO_ROLE_XML);
    expect(out).not.toContain("xmlns:flowable");
  });

  it("degrades (leaves userTask unrouted) when the role does not resolve", async () => {
    const resolver = stubResolver({}); // ROLE_ID_BUH is NOT in the map → null
    const out = await mapUserTaskRoleToCandidateGroups(ONE_ROLE_XML, resolver);
    expect(out).not.toContain("candidateGroups");
    // Even though nothing wired, the source XML must be otherwise unchanged.
    expect(out).toContain(`choros:assignedRoleId="${ROLE_ID_BUH}"`);
  });

  it("does not overwrite an existing explicit candidateGroups", async () => {
    const resolver = stubResolver({ [ROLE_ID_BUH]: ROLE_SLUG_BUH });
    const out = await mapUserTaskRoleToCandidateGroups(EXPLICIT_WINS_XML, resolver);
    expect(out).toBe(EXPLICIT_WINS_XML); // unchanged — nothing to resolve
    expect(out).toContain('flowable:candidateGroups="already-set"');
    expect(out).not.toContain(ROLE_SLUG_BUH);
  });

  it("does not touch a serviceTask (agentTask) even with assignedRoleId", async () => {
    const resolver = stubResolver({ [ROLE_ID_BUH]: ROLE_SLUG_BUH });
    const out = await mapUserTaskRoleToCandidateGroups(AGENT_TASK_XML, resolver);
    expect(out).toBe(AGENT_TASK_XML);
    expect(out).not.toMatch(/<serviceTask\b[^>]*candidateGroups/);
  });

  it("is idempotent — a second pass (same resolver) changes nothing further", async () => {
    const resolver = stubResolver({ [ROLE_ID_BUH]: ROLE_SLUG_BUH });
    const once = await mapUserTaskRoleToCandidateGroups(ONE_ROLE_XML, resolver);
    const twice = await mapUserTaskRoleToCandidateGroups(once, resolver);
    expect(twice).toBe(once);
    const matches = twice.match(/candidateGroups=/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("returns the document unchanged (byte-identical) when there is nothing to wire", async () => {
    const resolver = vi.fn(async () => null);
    expect(await mapUserTaskRoleToCandidateGroups(NO_ROLE_XML, resolver)).toBe(NO_ROLE_XML);
  });

  it("resolves multiple userTasks independently (per-id lookups)", async () => {
    const ROLE_ID_DIR = "e0000000-0000-0000-0000-000000000003";
    const xml = modelerProc(
      `<userTask id="T1" choros:assignedRoleId="${ROLE_ID_BUH}"/>` +
        `<userTask id="T2" choros:assignedRoleId="${ROLE_ID_DIR}"/>`,
    );
    const resolver = stubResolver({
      [ROLE_ID_BUH]: "budget-approver",
      [ROLE_ID_DIR]: "director",
    });
    const out = await mapUserTaskRoleToCandidateGroups(xml, resolver);
    expect(out).toMatch(/<userTask\b[^>]*id="T1"[^>]*flowable:candidateGroups="budget-approver"/);
    expect(out).toMatch(/<userTask\b[^>]*id="T2"[^>]*flowable:candidateGroups="director"/);
  });

  it("cross-check: the wired userTask passes lintBpmn", async () => {
    const resolver = stubResolver({ [ROLE_ID_BUH]: ROLE_SLUG_BUH });
    const out = await mapUserTaskRoleToCandidateGroups(ONE_ROLE_XML, resolver);
    const lintResult = lintBpmn(out);
    expect(lintResult.ok).toBe(true);
  });

  it("regression: a diagram already carrying xmlns:flowable is left untouched by the guard (idempotent)", async () => {
    const xmlWithNs = proc(
      `<userTask id="Activity_approve" choros:assignedRoleId="${ROLE_ID_BUH}"/>`,
    );
    const resolver = stubResolver({ [ROLE_ID_BUH]: ROLE_SLUG_BUH });
    const out = await mapUserTaskRoleToCandidateGroups(xmlWithNs, resolver);
    const nsMatches = out.match(/xmlns:flowable=/g) ?? [];
    expect(nsMatches).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // T-0642 fix-forward — blocking adversarial finding: role.slug (resolved via
  // the injected port, ultimately sourced from choros.role.slug — attacker-
  // controlled via POST /api/roles) was written into the candidateGroups
  // attribute WITHOUT XML-escaping, letting a crafted slug break out of the
  // attribute and inject arbitrary flowable:* attributes (e.g. a hard
  // flowable:assignee) onto the userTask. Proves the fix (escapeXml at the
  // injection site) closes the hole, and that a normal slug is unaffected.
  // -------------------------------------------------------------------------
  describe("security: XML injection via resolved role slug (T-0642)", () => {
    const ROLE_ID_ATTACK = "e0000000-0000-0000-0000-00000000dead";

    it("escapes a slug carrying a double-quote + injected attribute (probe payload)", async () => {
      const maliciousSlug = 'x" flowable:assignee="attacker';
      const xml = modelerProc(
        `<userTask id="Activity_hack" choros:assignedRoleId="${ROLE_ID_ATTACK}"/>`,
      );
      const resolver = stubResolver({ [ROLE_ID_ATTACK]: maliciousSlug });
      const out = await mapUserTaskRoleToCandidateGroups(xml, resolver);

      // The rogue attribute must NOT appear as a real, separately-parsed attribute.
      expect(out).not.toContain('flowable:assignee="attacker"');
      // The payload must be escaped inside the candidateGroups value.
      expect(out).toContain(
        'flowable:candidateGroups="x&quot; flowable:assignee=&quot;attacker"',
      );
      // The output must still be well-formed enough for the tokenizer/linter
      // to see ONE attribute (candidateGroups), not two.
      const reparsed = extractUserTaskRoleRefs(out);
      expect(reparsed).toEqual([]); // no unresolved refs left — nothing new to inject
    });

    it("escapes &, <, > and \" in a resolved slug", async () => {
      const trickySlug = `a&b<c>d"e`;
      const xml = modelerProc(
        `<userTask id="Activity_tricky" choros:assignedRoleId="${ROLE_ID_ATTACK}"/>`,
      );
      const resolver = stubResolver({ [ROLE_ID_ATTACK]: trickySlug });
      const out = await mapUserTaskRoleToCandidateGroups(xml, resolver);

      expect(out).toContain(
        'flowable:candidateGroups="a&amp;b&lt;c&gt;d&quot;e"',
      );
      expect(out).not.toContain(`candidateGroups="${trickySlug}"`);
    });

    it("leaves a normal, charset-clean slug byte-for-byte unescaped (regression)", async () => {
      const resolver = stubResolver({ [ROLE_ID_BUH]: ROLE_SLUG_BUH });
      const out = await mapUserTaskRoleToCandidateGroups(ONE_ROLE_XML, resolver);
      expect(out).toContain(`flowable:candidateGroups="${ROLE_SLUG_BUH}"`);
    });

    it("escaped output still passes lintBpmn (well-formed XML)", async () => {
      const maliciousSlug = 'x" flowable:assignee="attacker';
      const xml = modelerProc(
        `<userTask id="Activity_hack" choros:assignedRoleId="${ROLE_ID_ATTACK}"/>`,
      );
      const resolver = stubResolver({ [ROLE_ID_ATTACK]: maliciousSlug });
      const out = await mapUserTaskRoleToCandidateGroups(xml, resolver);
      const lintResult = lintBpmn(out);
      expect(lintResult.ok).toBe(true);
    });
  });
});
