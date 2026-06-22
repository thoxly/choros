/**
 * e2e/tel-linear-negative.e2e.ts — T-0283 (ADR T-0278 §2.4 NF5, AC-8, FF-5).
 *
 * FAIL-HONEST self-test specs. The deploy-acceptance gate is only trustworthy if it
 * goes RED (exit≠0) when an affordance is broken — never green-by-omission (NF5).
 * These specs encode that contract as positive assertions about the gate's own
 * red-detection: each asserts a property that, if the wiring regressed, would make
 * the happy click-through impossible to complete — so a regression turns the gate
 * red instead of silently passing.
 *
 * The CI wrapper ci/checks/acceptance/fail-honest.sh --self-test drives the
 * COMPLEMENTARY direction: it points the gate at a broken stand (no start-route /
 * disabled button) and asserts `acceptance:tel` exits non-zero — proving the gate
 * cannot be green when the product is a read-only витрина.
 */
import { test, expect, type Page } from "@playwright/test";

const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const FOREIGN_TENANT_ID = "b0000000-0000-0000-0000-0000000000ff";

async function loginAs(page: Page, id: string): Promise<void> {
  await page.goto("/");
  const record = await page.evaluate(async (uid: string) => {
    const res = await fetch("/api/users");
    const data = await res.json();
    return (data.users ?? []).find((u: { id: string }) => u.id === uid) ?? null;
  }, id);
  expect(record, `picker must list ${id}`).not.toBeNull();
  await page.evaluate((rec) => {
    localStorage.setItem("chs-dev-user", JSON.stringify(rec));
  }, record);
}

test.describe("ТЭЛ deploy-acceptance — fail-honest invariants (NF5 / AC-8)", () => {
  // The processes screen MUST offer a real write affordance and be enabled (not a
  // read-only витрина — spec §1). T-0374 removed the generic hardcoded «Запустить
  // процесс» launcher button (D2 de-hardcoding): processes now start via configured
  // business entry points (on_create / record_action / launcher / auto). The gate
  // still asserts that the screen is actionable: the «Новый процесс» button in the
  // ProcessCatalogSection is always present + enabled and opens the modeler where an
  // admin can design a launchable process — the prerequisite for any «Запустить
  // процесс» entry point to exist. If this regresses to disabled/absent the product
  // is again a read-only витрина and the gate must go red.
  test("launch affordance is present and clickable (else gate is red)", async ({ page }) => {
    await loginAs(page, "e-orlov");
    await page.goto("/processes");
    // «Новый процесс» is the always-present process-creation entry point on the
    // processes screen (ProcessCatalogSection, T-0323). It is always enabled regardless
    // of whether any definitions or applications exist yet. A disabled or absent button
    // means the screen regressed to a read-only state — the very «Запустить процесс»
    // gap this gate was introduced to catch (spec §1, AC-1).
    const launchBtn = page.getByRole("button", { name: "Новый процесс" }).first();
    await expect(launchBtn, "launch button must exist").toBeVisible();
    await expect(launchBtn, "launch button must be ENABLED (not the old disabled stub)").toBeEnabled();
  });

  // The start write-path MUST actually create an instance (a 2xx). A broken /missing
  // start-route would return non-2xx; the gate must reject that, not pass. Driven
  // through the SPA origin so it exercises the real served route.
  test("start-route returns 201 for a valid request (non-2xx ⇒ gate red)", async ({ page }) => {
    await loginAs(page, "e-orlov");
    const result = await page.evaluate(
      async ({ tenant }: { tenant: string }) => {
        const res = await fetch("/api/processes/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dev-user": "e-orlov",
            "x-tenant-id": tenant,
          },
          body: JSON.stringify({ processKey: "telLinear" }),
        });
        return res.status;
      },
      { tenant: DEV_TENANT_ID },
    );
    expect(result, "start-route must create an instance (201); non-2xx fails honestly").toBe(201);
  });

  // Tenant-scoping (AC-9) is a fail-honest invariant: a cross-tenant start MUST be
  // rejected (403), never silently succeed. If the scoping regressed (a foreign
  // start succeeded) the gate goes red here.
  test("cross-tenant start is rejected 403 (silent success ⇒ gate red)", async ({ page }) => {
    await loginAs(page, "e-orlov");
    const status = await page.evaluate(
      async ({ foreign }: { foreign: string }) => {
        const res = await fetch("/api/processes/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dev-user": "e-orlov",
            "x-tenant-id": foreign,
          },
          body: JSON.stringify({ processKey: "telLinear" }),
        });
        return res.status;
      },
      { foreign: FOREIGN_TENANT_ID },
    );
    expect(status, "cross-tenant start must be 403 NOT_ELIGIBLE").toBe(403);
  });

  // Approve moat (AC-5 / NF — structural deny-by-default): an actor who does NOT hold
  // role-approver must be denied the approve card-action (403). The initiator
  // (e-orlov, role-initiator only) must NOT be able to approve. If the moat regressed
  // (non-approver could approve) the gate goes red.
  test("non-approver cannot approve (moat) — 403/404, never 200", async ({ page }) => {
    await loginAs(page, "e-orlov");
    // Start an instance so a waiting approval task exists, then resolve its task id.
    const start = await page.evaluate(
      async ({ tenant }: { tenant: string }) => {
        const res = await fetch("/api/processes/start", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dev-user": "e-orlov",
            "x-tenant-id": tenant,
          },
          body: JSON.stringify({ processKey: "telLinear" }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { tenant: DEV_TENANT_ID },
    );
    expect(start.status).toBe(201);
    const inst = (start.body as { instanceId?: string } | null)?.instanceId ?? "";
    expect(inst).toBeTruthy();

    // Resolve the waiting task id as the approver would see it (read-only).
    const taskId = await page.evaluate(async (instanceId: string) => {
      const res = await fetch("/api/inbox?tab=pool", { headers: { "x-dev-user": "e-larina" } });
      const data = await res.json();
      const row = (data.items ?? []).find((i: { inst: string }) => i.inst === instanceId);
      return row ? row.id : null;
    }, inst);
    expect(taskId, "waiting approval task must exist").toBeTruthy();

    // The non-approver initiator attempts approve → MUST be denied (403 NOT_ELIGIBLE,
    // the structural moat) — anything in 2xx would be a real defect and turn red.
    const approveStatus = await page.evaluate(async (tid: string) => {
      const res = await fetch(`/api/inbox/${tid}/action`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dev-user": "e-orlov" },
        body: JSON.stringify({ action: "approve" }),
      });
      return res.status;
    }, taskId);
    expect(approveStatus, "non-approver approve must be denied (moat)").not.toBe(200);
    expect([403, 404]).toContain(approveStatus);
  });
});
