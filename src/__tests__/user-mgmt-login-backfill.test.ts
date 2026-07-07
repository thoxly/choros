/**
 * src/__tests__/user-mgmt-login-backfill.test.ts — T-0652 (§6.4 «backfill login»)
 *
 * GET /api/users/accounts used to surface a raw KC user UUID as an account's
 * "login" for any account created before migration 126 (login=NULL, slug=KC
 * UUID) — seen live in /users as «2e082a32-25ff-…». That is the machine-layer
 * leak §3/§6 outlaws. mapAccountRow now chooses an HONEST login and never
 * leaks a UUID. These are pure-function tests (no DB, no live KC).
 */

import { describe, it, expect } from "vitest";
import { mapAccountRow, type AccountRow } from "../http/user-mgmt.js";

const KC_UUID = "2e082a32-25ff-4a1b-9c3d-0f1e2d3c4b5a";

function baseRow(over: Partial<AccountRow>): AccountRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "e-kravtsova",
    login: null,
    display_name: "А. Кравцова",
    position_title: null,
    department_name: null,
    deactivated_at: null,
    ...over,
  };
}

describe("mapAccountRow — honest login, never a KC-UUID (T-0652 §6.4)", () => {
  it("login present → uses it (post-126 account)", () => {
    const v = mapAccountRow(baseRow({ login: "ivan.petrov", slug: KC_UUID }));
    expect(v.login).toBe("ivan.petrov");
    expect(v.login_missing).toBe(false);
  });

  it("login NULL + slug is a KC UUID → login=null + login_missing (NO UUID leak)", () => {
    const v = mapAccountRow(baseRow({ login: null, slug: KC_UUID }));
    expect(v.login).toBeNull();
    expect(v.login_missing).toBe(true);
    // The exact leak this closes: the UUID must NOT appear anywhere as the login.
    expect(v.login).not.toBe(KC_UUID);
  });

  it("login NULL + slug is a human-readable slug (seed human) → falls back to slug", () => {
    const v = mapAccountRow(baseRow({ login: null, slug: "e-kravtsova" }));
    expect(v.login).toBe("e-kravtsova");
    expect(v.login_missing).toBe(false);
  });

  it("carries display_name / position / department / active through unchanged", () => {
    const v = mapAccountRow(baseRow({
      login: "u", slug: KC_UUID,
      display_name: "Имя", position_title: "Менеджер", department_name: "Продажи",
      deactivated_at: null,
    }));
    expect(v.display_name).toBe("Имя");
    expect(v.position).toBe("Менеджер");
    expect(v.department).toBe("Продажи");
    expect(v.active).toBe(true);
  });

  it("deactivated_at set → active=false", () => {
    const v = mapAccountRow(baseRow({ deactivated_at: "2026-01-01T00:00:00Z" }));
    expect(v.active).toBe(false);
  });

  it("null position/department → empty strings (never null in the view)", () => {
    const v = mapAccountRow(baseRow({ position_title: null, department_name: null }));
    expect(v.position).toBe("");
    expect(v.department).toBe("");
  });
});
