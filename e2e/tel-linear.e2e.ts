/**
 * e2e/tel-linear.e2e.ts — T-0283 (introduce) / T-0284 (real-click finalize).
 * (ADR T-0278 §E / §2.4 / §G, AC-1..AC-6, FF-3).
 *
 * The deploy-acceptance HAPPY click-through: a browser walks the canonical linear
 * ТЭЛ U1→U5 against the REAL stack (built web/dist + live HTTP + Postgres + Flowable
 * — NO mocks, FF-3 / NF1 / D-056). Each user step is a hard assertion (AC-1..AC-6);
 * a step that is not reachable from the UI fails the gate (fail-honest, AC-8).
 *
 * This proves the product is CLICKABLE — the antidote to the "read-only витрина"
 * defect (spec §1): the deployed Choros must let a user start a process, submit a
 * form, see the work land in the role inbox, claim it, approve it, and observe the
 * instance reach done — by interacting with the SAME artifact a user sees.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * T-0284 — CHICKEN-AND-EGG CLOSED (ADR §2.5 / §G): every step is now a REAL mouse
 * click. The two affordances that were missing when T-0283 introduced this gate as
 * informational are now built and exercised through the UI:
 *   • U2 (form submit): web/src/forms/FormViewer.jsx now mounts the sandbox-iframe
 *     with sandbox="allow-scripts allow-forms" (T-0286), so the native form submit
 *     fires → sandbox postMessage → parent fetch /api/forms/purchase/submit. The
 *     spec clicks the real «Отправить на согласование» button and waits for the
 *     200 + the success panel (.chs-form-result--success).
 *   • U4 (approve): web/src/screens/screen-inbox.jsx now renders a primary
 *     «Согласовать» button for a claimed, role-approver, own task (T-0287). The
 *     spec clicks it and waits for the 200 { status: "done" }.
 * No in-browser fetch shims remain on the click-through — the gate is now full
 * proof of mouse-clickability end-to-end, and CI flips it to required (D-056).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { test, expect, type Page, type FrameLocator } from "@playwright/test";

// dev tenant uuid — matches the UI LaunchModal hardcoded x-tenant-id
// (web/src/screens/screen-processes.jsx) and the `dev` tenant id (migration 013).
const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";

const INITIATOR = { id: "e-orlov", name: "К. Орлов" };
const APPROVER = { id: "e-larina", name: "Е. Ларина" };

/** Log in as a dev user by writing the localStorage session the SPA reads. */
async function loginAs(page: Page, user: { id: string; name: string }): Promise<void> {
  await page.goto("/");
  // Fetch the full user record from the live picker so name/position are real.
  const record = await page.evaluate(async (id: string) => {
    const res = await fetch("/api/users");
    const data = await res.json();
    return (data.users ?? []).find((u: { id: string }) => u.id === id) ?? null;
  }, user.id);
  expect(record, `login picker must list ${user.id}`).not.toBeNull();
  await page.evaluate((rec) => {
    localStorage.setItem("chs-dev-user", JSON.stringify(rec));
  }, record);
}

test.describe("ТЭЛ deploy-acceptance — linear click-through U1→U5", () => {
  // T-0257: this imperative happy spec is now MIRRORED by the declarative
  // e2e/journeys/tel-linear.journey.ts (run by e2e/journeys.e2e.ts). It is kept as
  // the load-bearing fail-honest reference the acceptance fitness checks grep
  // (toBe(201)/toBe(200), the AC-1..AC-6 wording). To avoid double-running the same
  // U1→U5 flow when the declarative path drives it, set ACCEPTANCE_LEGACY_TEL=skip.
  test.skip(
    process.env["ACCEPTANCE_LEGACY_TEL"] === "skip",
    "legacy imperative ТЭЛ happy spec skipped (declarative journey drives U1→U5)",
  );
  test("initiator launches → form → approver claims+approves → instance done", async ({
    page,
  }) => {
    // ───────────────────────────────────────────────────────────── U1 · Запуск
    // Initiator opens processes, clicks the ENABLED «Запустить процесс» button,
    // launches the canonical ТЭЛ → 201 → instance appears in the list (AC-1).
    await loginAs(page, INITIATOR);
    await page.goto("/processes");

    // The launch affordance must exist and be enabled (the very gap spec §1 found).
    const launchBtn = page.getByRole("button", { name: "Запустить процесс" }).first();
    await expect(launchBtn, "AC-1: enabled «Запустить процесс» button must exist").toBeVisible();
    await expect(launchBtn).toBeEnabled();

    // Capture the 201 from the frozen start-route (§2.2) as the launch is clicked.
    const [startResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/processes/start") && r.request().method() === "POST",
      ),
      (async () => {
        await launchBtn.click();
        const dialog = page.getByRole("dialog", { name: "Запустить процесс" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Запустить" }).click();
      })(),
    ]);
    expect(startResp.status(), "AC-1: start-route must return 201").toBe(201);
    const startBody = (await startResp.json()) as {
      instanceId: string;
      processKey: string;
      tenantId: string;
    };
    expect(startBody.processKey).toBe("telLinear");
    expect(startBody.tenantId).toBe(DEV_TENANT_ID);
    const instanceId = startBody.instanceId;
    expect(instanceId, "AC-1: a real Flowable instance id").toBeTruthy();

    // On 201 the screen auto-reloads the processes list (handleLaunched → load()),
    // so the started instance becomes visible in the table (AC-1). Assert the new
    // instance row directly (the modal closes itself on success — no manual close).
    const startedRow = page.locator(`tr:has(:text("${instanceId}"))`).first();
    await expect(
      startedRow,
      "AC-1: started instance visible on processes screen",
    ).toBeVisible();
    await expect(startedRow).toContainText("Канонический линейный ТЭЛ");

    // ───────────────────────────────────────────────────────────── U2 · Подача
    // Initiator fills + submits the purchase form (E9) by a REAL mouse click on the
    // form's «Отправить на согласование» button. The FormViewer runs inside a
    // sandbox-iframe with allow-forms (T-0286), so the native submit fires →
    // sandbox postMessage → parent fetch /api/forms/purchase/submit; assert the 200
    // + recordId (server-side validation passed, record persisted) (AC-2) AND the
    // in-UI success panel (.chs-form-result--success) — proof the click landed.
    await page.goto("/forms");
    const frame: FrameLocator = page.frameLocator("iframe.chs-form-viewer");
    // The purchase form (FormViewer sandbox-iframe) ships valid defaults for all
    // three required schema fields (supplier «ООО «Вектор»», subject, budget
    // «ИТ-инфраструктура · CAPEX»; form-defs.js). The user types the subject (real
    // typing into the live form), then clicks «Отправить на согласование».
    const subjectInput = frame.locator('[data-field="subject"] input.fjs-input').first();
    await expect(subjectInput, "AC-2: purchase form renders in the iframe").toBeVisible();
    await subjectInput.fill("Договор оказания услуг по разработке ПО (годовой)");

    // REAL click on the in-iframe submit button. With allow-forms the native submit
    // is no longer blocked: the sandbox script's submit handler (form-defs.js) runs,
    // collects the field values, and postMessages {type:'fjs-submit', value} to the
    // parent FormViewer, which POSTs /api/forms/purchase/submit. Wait for that POST.
    const submitBtn = frame.getByRole("button", { name: "Отправить на согласование" });
    await expect(submitBtn, "AC-2: form submit button is clickable").toBeVisible();
    const [formResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/forms/purchase/submit") &&
          r.request().method() === "POST",
      ),
      submitBtn.click(),
    ]);
    expect(formResp.status(), "AC-2: form submit must return 200").toBe(200);
    // Frozen response contract (src/http/forms.ts): { ok, formId, value, recordId }
    // — recordId is top-level (the persisted record's id), value is the sanitized
    // payload. Assert both: server-side validation passed AND a record persisted.
    const formBody = (await formResp.json()) as { ok: boolean; recordId?: string };
    expect(formBody.ok, "AC-2: server-side validation passed").toBe(true);
    expect(formBody.recordId, "AC-2: a record was persisted").toBeTruthy();
    // The success panel renders in the parent SPA after the 200 — the user-visible
    // confirmation that the click submitted the form (FormViewer success state).
    await expect(
      page.locator(".chs-form-result--success"),
      "AC-2: success panel visible after real submit click",
    ).toContainText("Форма отправлена");

    // ──────────────────────────────────────────────────────── U3→U4 · Инбокс/пул
    // Switch to the approver. The U4 approval task is addressed to the ROLE
    // (role-approver, candidateGroups → role) and appears as a POOL task in her
    // inbox (AC-3) — surfaced by the engine→screen projection, not a seed row.
    await loginAs(page, APPROVER);
    await page.goto("/inbox");

    // The approval task for THIS instance must be a pool row addressed to the role.
    const taskId = await waitForInstanceTask(page, instanceId);
    expect(taskId, "AC-3: U4 approval task visible in approver's inbox").toBeTruthy();

    // ───────────────────────────────────────────────────────────── U4 · Claim
    // Approver claims the pool task via the «Взять» button (AC-4). Capture the 200.
    await page.goto("/inbox");
    const poolTab = page.getByRole("button", { name: /Из пула/ });
    await poolTab.click();
    const taskRow = page.locator(`tr:has(:text("${instanceId}"))`).first();
    await expect(taskRow, "AC-4: claimable pool row for the instance").toBeVisible();
    const [claimResp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/api/inbox/${taskId}/claim`) && r.request().method() === "POST",
      ),
      taskRow.getByRole("button", { name: /Взять/ }).click(),
    ]);
    expect(claimResp.status(), "AC-4: claim must return 200").toBe(200);

    // ──────────────────────────────────────────────── U4 · Approve (card-action)
    // The approve transition (AC-5) by a REAL mouse click on the «Согласовать»
    // button. After the claim, the task leaves the POOL (server clears item.pool on
    // claim — inbox.ts inTab/pool) and lands on the «Мне» tab (item.mine === true).
    // screen-inbox.jsx renders the primary «Согласовать» button only for a claimed,
    // own, role-approver task (T-0287: isTaken && t.mine && role-approver) — which is
    // exactly the «Мне» view. So switch to «Мне» before locating the approve action.
    // The button POSTs /api/inbox/:id/action {approve} → 200 { status: "done" }.
    const mineTab = page.getByRole("button", { name: /^Мне/ });
    await mineTab.click();
    const claimedRow = page
      .locator(`tr:has(:text("${instanceId}"))`)
      .filter({ has: page.getByRole("button", { name: "Согласовать" }) })
      .first();
    const approveBtn = claimedRow.getByRole("button", { name: "Согласовать" });
    await expect(
      approveBtn,
      "AC-5: «Согласовать» card-action visible after claim",
    ).toBeVisible();
    const [approveResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/inbox/${taskId}/action`) &&
          r.request().method() === "POST",
      ),
      approveBtn.click(),
    ]);
    expect(approveResp.status(), "AC-5: approve card-action must return 200").toBe(200);
    expect(
      ((await approveResp.json()) as { status?: string } | null)?.status,
      "AC-5: approve advances the instance to done",
    ).toBe("done");

    // ───────────────────────────────────────────────────────── U5 · Завершение
    // The instance reaches `done` and is observable in the UI (AC-6). Reload the
    // processes list and assert the instance row shows the done status.
    await page.goto("/processes");
    const doneRow = page.locator(`tr:has(:text("${instanceId}"))`).first();
    await expect(doneRow, "AC-6: completed instance still visible").toBeVisible();
    // The projection maps approved → status "done" (process-projection.ts); the row's
    // status chip renders the done state.
    await expect(
      doneRow,
      "AC-6: instance is observably done after approval",
    ).toContainText(/done|Завершено|Готово/i);

    // The U4 task drops from the approver pool once its instance is done (AC-6 — the
    // chain is consistent: nothing left to act on).
    await page.goto("/inbox");
    await page.getByRole("button", { name: /Из пула/ }).click();
    await expect(
      page.locator(`tr:has(:text("${taskId}"))`),
      "AC-6: approved task no longer waiting in the pool",
    ).toHaveCount(0);
  });
});

/**
 * Poll the live inbox API (through the SPA origin, as the logged-in approver) for
 * the started instance's waiting approval task and return its task id. Read-only —
 * this resolves the projection-minted task id (== process.started audit_event id)
 * that the claim/approve routes key on. Throws via the caller's expect if absent.
 */
async function waitForInstanceTask(page: Page, instanceId: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const id = await page.evaluate(async (inst: string) => {
      const res = await fetch("/api/inbox?tab=pool", {
        headers: { "x-dev-user": "e-larina" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const row = (data.items ?? []).find((i: { inst: string }) => i.inst === inst);
      return row ? row.id : null;
    }, instanceId);
    if (id) return id as string;
    await page.waitForTimeout(500);
  }
  return "";
}
