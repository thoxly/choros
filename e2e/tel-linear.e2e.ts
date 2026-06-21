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
    //
    // T-0370: form-defs.js PURCHASE now uses registry-aligned field keys:
    //   data-field="title"  (text, required) — was data-field="subject"
    //   data-field="amount" (number)         — was data-field="price"
    // The server in DB mode validates against registry_def.record_schema (title/amount)
    // via makeFormDefResolver → deriveFormDefFromSchema. Memory mode uses the updated
    // form-schema.ts PURCHASE (same title/amount fields). Both paths now accept the
    // same payload shape, fixing the UNKNOWN_FIELD → 400 root cause.
    await page.goto("/forms");
    const frame: FrameLocator = page.frameLocator("iframe.chs-form-viewer");
    // The `title` field (data-field="title") is the required text field; fill it
    // to exercise the real typing path and satisfy the required constraint.
    const titleInput = frame.locator('[data-field="title"] input.fjs-input').first();
    await expect(titleInput, "AC-2: purchase form renders in the iframe (title field)").toBeVisible();
    await titleInput.fill("Договор оказания услуг по разработке ПО (годовой)");

    // The `amount` field (data-field="amount") is the number field. Fill it with a
    // numeric string to exercise the T-0369 coercion path: sandbox posts "496000"
    // as a string; coerceFormPayload converts it to 496000 (number) before validation
    // so the record stores a real number (DMN amount routing works).
    const amountInput = frame.locator('[data-field="amount"] input.fjs-input').first();
    await expect(amountInput, "AC-2: amount field visible").toBeVisible();
    await amountInput.fill("496000");

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
    // T-0370+T-0369: also assert amount is a JS number (not a string) to confirm
    // the coercion path is exercised end-to-end.
    const formBody = (await formResp.json()) as {
      ok: boolean;
      recordId?: string;
      value?: { amount?: unknown };
    };
    expect(formBody.ok, "AC-2: server-side validation passed").toBe(true);
    expect(formBody.recordId, "AC-2: a record was persisted").toBeTruthy();
    expect(typeof formBody.value?.amount, "AC-2: amount coerced to number (T-0369)").toBe("number");
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

// ─────────────────────────────────────────────────────────────────────────────
// T-0368 (E16): create=start DMN routing acceptance
//
// Verifies end-to-end that creating a «Заявки» (purchases) record via
// POST /api/records fires the telLinear process via the on_create binding,
// skips the «Подача заявки» user task (dissolve-double-submit), runs triage,
// and the DMN gateway routes correctly:
//   CS-1 (6 000 000 ₽ > 5 000 000 threshold) → needs-approval → «Доп. согласование»
//   CS-2 (3 000 000 ₽ ≤ 5 000 000 threshold) → standard track → done after base approve
//
// Additionally verifies:
//   CS-3: after base approve on the CS-1 instance, the «Согласование» record was
//         created with data.purchase_ref == the originating «Заявки» record id
//         (cross_app_ref seed from migration 089 closes the pointer gap).
//
// These tests call the API directly (no UI form submission) because the goal is
// to prove the process-engine routing — not the form rendering — works via the
// create=start code path. HARD assertions only (no green-faking).
//
// Requires a LIVE stack (Postgres + Flowable). If the stack is not up, tests are
// skipped via the SKIP_CREATE_START_E2E env var so CI can gate selectively.
// ─────────────────────────────────────────────────────────────────────────────

// Stable UUIDs from seed migrations (076, 083, 085, 087).
const TEL_APP_ID = "a7000000-0000-0000-0000-000000000001";    // tel-approval application
const PURCHASES_REG_ID = "a7000000-0000-0000-0000-000000000002"; // «Заявки» registry_def
const SOGLASOVANIE_REG_ID = "a7000000-0000-0000-0000-000000000003"; // «Согласование» registry_def

/**
 * Create a «Заявки» record via POST /api/records as the given actor.
 * Returns { recordId, instanceId } on 201, throws on non-201.
 *
 * The on_create binding (migration 087) fires telLinear start in-tx;
 * the process.started audit_event carries record_id (T-0356).
 */
async function createPurchaseRecord(
  page: Page,
  actor: string,
  amount: number,
  title: string,
): Promise<{ recordId: string; instanceId: string }> {
  const result = await page.evaluate(
    async ({
      appId,
      regId,
      actor: act,
      data,
      tenant,
    }: {
      appId: string;
      regId: string;
      actor: string;
      data: Record<string, unknown>;
      tenant: string;
    }) => {
      const res = await fetch("/api/records", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-user": act,
          "x-tenant-id": tenant,
        },
        body: JSON.stringify({
          application_id: appId,
          registry_def_id: regId,
          data,
        }),
      });
      const body = await res.json();
      return { status: res.status, body };
    },
    {
      appId: TEL_APP_ID,
      regId: PURCHASES_REG_ID,
      actor,
      data: { title, amount },
      tenant: DEV_TENANT_ID,
    },
  );

  if (result.status !== 201) {
    throw new Error(
      `createPurchaseRecord failed: HTTP ${result.status} ${JSON.stringify(result.body)}`,
    );
  }

  // The 201 response carries the record. The process.started audit event is written
  // in the same tx (records.ts + appendProcessStarted T-0356). The instanceId is
  // resolved by polling the audit_event log via the inbox projection.
  const recordId = (result.body as { id?: string }).id ?? "";
  if (!recordId) throw new Error("createPurchaseRecord: no id in response body");

  // Poll the process projection (audit_event log) for the started instance whose
  // payload.record_id matches our new record id. The projection writes in the same
  // tx as the record insert, so it should be immediately visible.
  const instanceId = await page.evaluate(
    async ({
      recId,
      tenant,
      actor: act,
    }: {
      recId: string;
      tenant: string;
      actor: string;
    }) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const res = await fetch("/api/processes", {
          headers: { "x-dev-user": act, "x-tenant-id": tenant },
        });
        if (!res.ok) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        const data = await res.json();
        const instances: Array<{ id?: string; payload?: { record_id?: string } }> =
          data.instances ?? [];
        const match = instances.find(
          (inst) => inst.payload?.record_id === recId,
        );
        if (match?.id) return match.id;
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    },
    { recId: recordId, tenant: DEV_TENANT_ID, actor },
  );

  if (!instanceId) {
    throw new Error(
      `createPurchaseRecord: no process instance found for record ${recordId} after 15s`,
    );
  }

  return { recordId, instanceId: instanceId as string };
}

/**
 * Claim + approve a pool task for the given instance as the approver (e-larina).
 * Returns the «Согласование» soglasovanie record id written by the step-applier
 * (read from GET /api/records filtered by registry_def_id).
 *
 * For CS-1 (needs-approval path), the step-applier fires before the gateway
 * routes to «Доп. согласование» — so the soglasovanie record exists after approve.
 */
async function claimAndApproveTask(
  page: Page,
  taskId: string,
): Promise<void> {
  // Claim the pool task.
  const claimResult = await page.evaluate(
    async ({ tid }: { tid: string }) => {
      const res = await fetch(`/api/inbox/${tid}/claim`, {
        method: "POST",
        headers: { "x-dev-user": "e-larina" },
      });
      return res.status;
    },
    { tid: taskId },
  );
  expect(claimResult, `CS: claim task ${taskId} must return 200`).toBe(200);

  // Approve the claimed task.
  const approveResult = await page.evaluate(
    async ({ tid }: { tid: string }) => {
      const res = await fetch(`/api/inbox/${tid}/action`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-user": "e-larina",
        },
        body: JSON.stringify({ action: "approve" }),
      });
      const body = await res.json();
      return { status: res.status, body };
    },
    { tid: taskId },
  );
  expect(approveResult.status, `CS: approve task ${taskId} must return 200`).toBe(200);
}

test.describe("T-0368 create=start DMN routing (on_create → triage → gateway)", () => {
  test.skip(
    process.env["SKIP_CREATE_START_E2E"] === "1",
    "create=start DMN routing e2e skipped (set SKIP_CREATE_START_E2E=0 with live stack)",
  );

  // ──────────────────────────────────────────────────── CS-1: 6M → needs-approval
  // Creating a purchase with amount > 5_000_000 must:
  //   1. Trigger on_create → telLinear starts → task-submit auto-completed (skip-submit)
  //   2. Triage (external task) fires deterministically → sets approvalRequired=needs-approval
  //   3. Base «Согласование» task appears in approver pool
  //   4. After claim + approve: gateway reads approvalRequired=needs-approval → routes to
  //      «Доп. согласование» (task-extra-approve) — NOT to end
  //   5. «Доп. согласование» task is visible in the approver pool (instance not done yet)
  test(
    "CS-1: amount=6_000_000 → on_create starts process → DMN needs-approval → Доп.согласование",
    async ({ page }) => {
      await loginAs(page, INITIATOR);

      // Step 1: Create the purchase record (fires on_create → telLinear start).
      const { recordId, instanceId } = await createPurchaseRecord(
        page,
        INITIATOR.id,
        6_000_000,
        "Договор на 6 млн — должен уйти на доп.согласование",
      );
      expect(recordId, "CS-1: purchase record must be persisted").toBeTruthy();
      expect(instanceId, "CS-1: process must have started (on_create binding)").toBeTruthy();

      // Step 2: Wait for the base «Согласование» task to appear in the approver pool.
      // The task-submit auto-completion + triage (external task) must have run.
      const taskId = await waitForInstanceTask(page, instanceId);
      expect(taskId, "CS-1: base approval task must appear in approver pool after triage").toBeTruthy();

      // Step 3: Claim + approve the base task as e-larina.
      // After approve the gateway reads approvalRequired; for 6M it must be 'needs-approval'.
      await loginAs(page, APPROVER);
      await claimAndApproveTask(page, taskId);

      // Step 4: After the base approve, the gateway routes to «Доп. согласование».
      // The instance is NOT done yet — assert by polling for a second pool task
      // for this instance (the «Доп. согласование» task-extra-approve).
      const extraTaskId = await waitForInstanceTask(page, instanceId);
      expect(
        extraTaskId,
        "CS-1: after base approve with 6M, «Доп. согласование» task must appear in pool",
      ).toBeTruthy();
      // The second task must be a DIFFERENT task id (not the same as the approved one).
      expect(extraTaskId, "CS-1: extra approval task must be a new task").not.toBe(taskId);

      // Step 5 (CS-3): Assert cross_app_ref pointer — the «Согласование» record
      // created by the step-applier must have data.purchase_ref == recordId.
      // The record is created at approve time by applyStepResult in step-applier.ts.
      const crossRefOk = await page.evaluate(
        async ({
          regId,
          purchaseRecId,
          tenant,
        }: {
          regId: string;
          purchaseRecId: string;
          tenant: string;
        }) => {
          const res = await fetch(`/api/records?registry_def_id=${regId}`, {
            headers: { "x-dev-user": "e-larina", "x-tenant-id": tenant },
          });
          if (!res.ok) return { found: false, details: `HTTP ${res.status}` };
          const data = await res.json();
          const records: Array<{ data?: Record<string, unknown> }> = data.records ?? [];
          // Find a «Согласование» record whose purchase_ref matches our purchase record id.
          const match = records.find((r) => r.data?.["purchase_ref"] === purchaseRecId);
          return {
            found: !!match,
            details: match
              ? `found purchase_ref=${purchaseRecId}`
              : `no match; records=${JSON.stringify(records.map((r) => r.data?.["purchase_ref"]))}`,
          };
        },
        { regId: SOGLASOVANIE_REG_ID, purchaseRecId: recordId, tenant: DEV_TENANT_ID },
      );
      expect(
        crossRefOk.found,
        `CS-3: «Согласование» record must have purchase_ref=${recordId} — ${crossRefOk.details}`,
      ).toBe(true);
    },
  );

  // ──────────────────────────────────────────────────── CS-2: 3M → standard track
  // Creating a purchase with amount ≤ 5_000_000 must:
  //   1. Trigger on_create → telLinear starts → task-submit auto-completed
  //   2. Triage fires → sets approvalRequired=standard (or absent → default)
  //   3. Base «Согласование» task appears
  //   4. After claim + approve: gateway routes to end (standard) — instance is DONE
  //   5. No «Доп. согласование» task exists for this instance
  test(
    "CS-2: amount=3_000_000 → on_create starts process → DMN standard track → done after base approve",
    async ({ page }) => {
      await loginAs(page, INITIATOR);

      // Step 1: Create the purchase record.
      const { recordId, instanceId } = await createPurchaseRecord(
        page,
        INITIATOR.id,
        3_000_000,
        "Договор на 3 млн — стандартный трек",
      );
      expect(recordId, "CS-2: purchase record must be persisted").toBeTruthy();
      expect(instanceId, "CS-2: process must have started (on_create binding)").toBeTruthy();

      // Step 2: Wait for the base «Согласование» task in the approver pool.
      const taskId = await waitForInstanceTask(page, instanceId);
      expect(taskId, "CS-2: base approval task must appear in approver pool after triage").toBeTruthy();

      // Step 3: Claim + approve as e-larina.
      // For 3M, approvalRequired = standard → gateway takes the default branch → end.
      await loginAs(page, APPROVER);

      const claimStatus = await page.evaluate(
        async ({ tid }: { tid: string }) => {
          const res = await fetch(`/api/inbox/${tid}/claim`, {
            method: "POST",
            headers: { "x-dev-user": "e-larina" },
          });
          return res.status;
        },
        { tid: taskId },
      );
      expect(claimStatus, "CS-2: claim must return 200").toBe(200);

      const approveResult = await page.evaluate(
        async ({ tid }: { tid: string }) => {
          const res = await fetch(`/api/inbox/${tid}/action`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-dev-user": "e-larina",
            },
            body: JSON.stringify({ action: "approve" }),
          });
          const body = await res.json();
          return { status: res.status, body };
        },
        { tid: taskId },
      );
      expect(approveResult.status, "CS-2: approve must return 200").toBe(200);

      // Step 4: After approve, the instance should be done (standard track → end).
      // The approve action returns { status: "done" } for the standard path.
      expect(
        (approveResult.body as { status?: string }).status,
        "CS-2: approve on 3M instance must return status=done (standard gateway → end)",
      ).toBe("done");

      // Step 5: Assert no «Доп. согласование» task appeared for this instance.
      // Poll the pool inbox for 3 seconds — it must stay empty for this instance.
      const hasExtraTask = await page.evaluate(
        async ({ inst }: { inst: string }) => {
          // Wait 3s then check — triage + gateway are near-instant; if a task
          // appeared it would already be there.
          await new Promise((r) => setTimeout(r, 3_000));
          const res = await fetch("/api/inbox?tab=pool", {
            headers: { "x-dev-user": "e-larina" },
          });
          if (!res.ok) return false;
          const data = await res.json();
          return (data.items ?? []).some((i: { inst: string }) => i.inst === inst);
        },
        { inst: instanceId },
      );
      expect(
        hasExtraTask,
        "CS-2: standard track (3M) must NOT produce a «Доп. согласование» task",
      ).toBe(false);
    },
  );
});
