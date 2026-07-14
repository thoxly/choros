/**
 * src/core/__tests__/sandbox-gate.test.ts — T-0557
 *
 * Exhaustive coverage of the PURE sandbox-gate decision layer (no IO):
 *   - decideDraftVisibility: full truth table over artifactTier × actor privilege
 *     (published → visible to all; draft → owner/admin OR authoring_draft only).
 *   - sandboxReadPredicate: privileged → unrestricted tautology; non-privileged →
 *     published-only fragment, params shape, parameter-index neutrality.
 *
 * The DB DAO (db/sandbox-gate-dao.resolveActorPrivilege) is a thin reuse of the
 * already-tested loadAdminContext / getGrantsForSubject helpers and is covered by
 * T-0558's integration tests (it needs a live tenant/grant fixture); no DB harness
 * is exercised here.
 */

import { describe, it, expect } from "vitest";
import {
  decideDraftVisibility,
  sandboxReadPredicate,
} from "../sandbox-gate.js";

// --- decideDraftVisibility truth table ------------------------------------

describe("T-0557 decideDraftVisibility — published artifact", () => {
  const cases: Array<{ isOwnerOrAdmin: boolean; hasAuthoringDraftGrant: boolean }> = [
    { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false },
    { isOwnerOrAdmin: true, hasAuthoringDraftGrant: false },
    { isOwnerOrAdmin: false, hasAuthoringDraftGrant: true },
    { isOwnerOrAdmin: true, hasAuthoringDraftGrant: true },
  ];

  for (const actor of cases) {
    it(`visible to all regardless of privilege (${JSON.stringify(actor)})`, () => {
      expect(
        decideDraftVisibility({ artifactTier: "published", actor }),
      ).toEqual({ visible: true, reason: "published_visible_to_all" });
    });
  }
});

describe("T-0557 decideDraftVisibility — draft artifact", () => {
  it("owner/admin → visible (owner reason)", () => {
    expect(
      decideDraftVisibility({
        artifactTier: "draft",
        actor: { isOwnerOrAdmin: true, hasAuthoringDraftGrant: false },
      }),
    ).toEqual({ visible: true, reason: "draft_visible_owner_admin" });
  });

  it("authoring_draft grant holder (not owner) → visible (grant reason)", () => {
    expect(
      decideDraftVisibility({
        artifactTier: "draft",
        actor: { isOwnerOrAdmin: false, hasAuthoringDraftGrant: true },
      }),
    ).toEqual({ visible: true, reason: "draft_visible_authoring_grant" });
  });

  it("owner AND grant → visible, owner reason wins (strongest authority)", () => {
    expect(
      decideDraftVisibility({
        artifactTier: "draft",
        actor: { isOwnerOrAdmin: true, hasAuthoringDraftGrant: true },
      }),
    ).toEqual({ visible: true, reason: "draft_visible_owner_admin" });
  });

  it("neither owner/admin nor grant → hidden (fail-closed)", () => {
    expect(
      decideDraftVisibility({
        artifactTier: "draft",
        actor: { isOwnerOrAdmin: false, hasAuthoringDraftGrant: false },
      }),
    ).toEqual({ visible: false, reason: "draft_hidden_unprivileged" });
  });
});

// --- sandboxReadPredicate --------------------------------------------------

describe("T-0557 sandboxReadPredicate", () => {
  it("privileged → unrestricted tautology, empty params", () => {
    const pred = sandboxReadPredicate({ tierColumn: "a.tier", actorIsPrivileged: true });
    expect(pred).toEqual({ sql: "TRUE", params: [] });
  });

  it("non-privileged → published-only restriction on the given column, empty params", () => {
    const pred = sandboxReadPredicate({ tierColumn: "a.tier", actorIsPrivileged: false });
    expect(pred).toEqual({ sql: "a.tier = 'published'", params: [] });
  });

  it("respects the caller-provided trusted column identifier", () => {
    const pred = sandboxReadPredicate({ tierColumn: "art.tier", actorIsPrivileged: false });
    expect(pred.sql).toBe("art.tier = 'published'");
  });

  it("fragment carries no $-placeholders → parameter-index neutral", () => {
    for (const actorIsPrivileged of [true, false]) {
      const pred = sandboxReadPredicate({ tierColumn: "a.tier", actorIsPrivileged });
      expect(pred.sql).not.toMatch(/\$\d/);
      expect(pred.params).toEqual([]);
    }
  });

  it("only references the published tier value, never 'draft'", () => {
    const pred = sandboxReadPredicate({ tierColumn: "a.tier", actorIsPrivileged: false });
    expect(pred.sql).toContain("'published'");
    expect(pred.sql).not.toContain("draft");
  });
});

// --- T-0623 creatorEscape (столп-4: create must not create an object invisible to
//     its own author) --------------------------------------------------------------

describe("T-0623 sandboxReadPredicate — creatorEscape (creator-own floor)", () => {
  it("privileged → tautology, creatorEscape ignored (privileged already sees all)", () => {
    const pred = sandboxReadPredicate({
      tierColumn: "a.tier",
      actorIsPrivileged: true,
      creatorEscape: { ownerColumn: "r.created_by", ownerParam: "$5" },
    });
    // A privileged actor is unrestricted; the escape is unnecessary and MUST NOT
    // widen or narrow anything — still the plain tautology, no placeholder.
    expect(pred).toEqual({ sql: "TRUE", params: [] });
  });

  it("non-privileged + creatorEscape → published OR own-record, actor slug as a bind param", () => {
    const pred = sandboxReadPredicate({
      tierColumn: "a.tier",
      actorIsPrivileged: false,
      creatorEscape: { ownerColumn: "r.created_by", ownerParam: "$3" },
    });
    // Additive OR: published rows (for everyone) PLUS the actor's own rows (via the
    // bound $3 param). The tier value stays a literal; the ONLY caller-derived value
    // (the actor slug) is a bind param, never inlined.
    expect(pred.sql).toBe("(a.tier = 'published' OR r.created_by = $3)");
    expect(pred.params).toEqual([]);
  });

  it("non-privileged WITHOUT creatorEscape → byte-identical to pre-T-0623 (published-only, no placeholder)", () => {
    const pred = sandboxReadPredicate({ tierColumn: "a.tier", actorIsPrivileged: false });
    expect(pred.sql).toBe("a.tier = 'published'");
    expect(pred.sql).not.toMatch(/\$\d/);
  });

  it("creatorEscape never inlines the actor slug (no SQL-injection surface — value stays a param)", () => {
    const pred = sandboxReadPredicate({
      tierColumn: "a.tier",
      actorIsPrivileged: false,
      creatorEscape: { ownerColumn: "r.created_by", ownerParam: "$7" },
    });
    // The fragment references the placeholder, never an interpolated value.
    expect(pred.sql).toContain("$7");
    expect(pred.sql).not.toMatch(/created_by = '/); // never a string literal RHS
  });
});
