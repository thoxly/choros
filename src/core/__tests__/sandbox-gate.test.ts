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
