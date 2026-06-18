/**
 * e2e/journeys/tel-linear.journey.ts — T-0257.
 *
 * The canonical ТЭЛ linear U1→U5 acceptance journey, MIGRATED from the hardcoded
 * e2e/tel-linear.e2e.ts into DATA. This is the proof the generic runner works: the
 * SAME click-through that the s31 harness ran imperatively is now an ordered list of
 * declarative steps, executed by e2e/journeys/runner.ts. The ТЭЛ acceptance must
 * still pass exactly as before (AC: migrated journey still green).
 *
 * Steps map 1:1 to the original AC-1..AC-6 assertions:
 *   U1 (AC-1) — initiator launches the canonical ТЭЛ → 201 → instance visible.
 *   U2 (AC-2) — initiator fills + submits the purchase form → 200 + success panel.
 *   U3/U4 (AC-3/AC-4) — approver sees the pool task, claims it → 200.
 *   U4 (AC-5) — approver clicks «Согласовать» → 200 { status: "done" }.
 *   U5 (AC-6) — instance observably done; task gone from the pool.
 *
 * Adding another journey = drop a sibling *.journey.ts file. Zero runner change.
 */
import type { Journey } from "./types.js";

// dev tenant uuid — matches the UI LaunchModal hardcoded x-tenant-id
// (web/src/screens/screen-processes.jsx) and the `dev` tenant id (migration 013).
const DEV_TENANT_ID = "a0000000-0000-0000-0000-000000000001";
const INITIATOR = "e-orlov"; // К. Орлов (role-initiator)
const APPROVER = "e-larina"; // Е. Ларина (role-approver)

export const journey: Journey = {
  id: "tel-linear",
  title: "ТЭЛ deploy-acceptance — linear click-through U1→U5",
  version: 1,
  description:
    "Initiator launches the canonical ТЭЛ, submits the purchase form; approver claims and approves; the instance reaches done — all by REAL clicks against the deployed product.",
  steps: [
    // ───────────────────────────────────────────── U1 · Запуск (AC-1)
    { name: "U1 · log in as initiator", action: "login", userId: INITIATOR },
    { name: "U1 · open processes", action: "goto", path: "/processes" },
    {
      name: "U1 · «Запустить процесс» button is present and enabled",
      action: "expectVisible",
      target: { role: { role: "button", name: "Запустить процесс" }, first: true },
    },
    {
      // Open the launch dialog (no write yet).
      name: "U1 · open the launch dialog",
      action: "click",
      target: { role: { role: "button", name: "Запустить процесс" }, first: true },
    },
    {
      name: "U1 · the launch dialog is visible",
      action: "expectVisible",
      target: { role: { role: "dialog", name: "Запустить процесс" } },
    },
    {
      // Confirm the launch inside the dialog → POST /api/processes/start → 201.
      // Capture the created instanceId for the rest of the journey.
      name: "U1 · confirm launch → start-route returns 201 (AC-1)",
      action: "click",
      target: {
        role: { role: "button", name: "Запустить" },
        within: { role: { role: "dialog", name: "Запустить процесс" } },
      },
      awaitResponse: {
        urlIncludes: "/api/processes/start",
        method: "POST",
        expectStatus: 201,
        captureJson: { instanceId: "instanceId" },
      },
    },
    {
      name: "U1 · started instance visible on the processes screen (AC-1)",
      action: "expectVisible",
      target: { css: 'tr:has(:text("{{instanceId}}"))', first: true },
    },
    {
      name: "U1 · started row names the canonical ТЭЛ (AC-1)",
      action: "expectText",
      target: { css: 'tr:has(:text("{{instanceId}}"))', first: true },
      text: "Канонический линейный ТЭЛ",
    },

    // ───────────────────────────────────────────── U2 · Подача (AC-2)
    { name: "U2 · open forms", action: "goto", path: "/forms" },
    {
      name: "U2 · purchase form renders in the sandbox iframe (AC-2)",
      action: "expectVisible",
      target: { css: '[data-field="subject"] input.fjs-input', scope: { frame: "iframe.chs-form-viewer" }, first: true },
    },
    {
      name: "U2 · type the purchase subject into the live form",
      action: "fill",
      target: { css: '[data-field="subject"] input.fjs-input', scope: { frame: "iframe.chs-form-viewer" }, first: true },
      value: "Договор оказания услуг по разработке ПО (годовой)",
    },
    {
      // REAL click on the in-iframe submit → sandbox postMessage → parent POST
      // /api/forms/purchase/submit → 200. (recordId is asserted via the success panel.)
      name: "U2 · click «Отправить на согласование» → form submit returns 200 (AC-2)",
      action: "click",
      target: { role: { role: "button", name: "Отправить на согласование" }, scope: { frame: "iframe.chs-form-viewer" } },
      awaitResponse: {
        urlIncludes: "/api/forms/purchase/submit",
        method: "POST",
        expectStatus: 200,
      },
    },
    {
      name: "U2 · success panel visible after the real submit click (AC-2)",
      action: "expectText",
      target: { css: ".chs-form-result--success" },
      text: "Форма отправлена",
    },

    // ───────────────────────────────────── U3→U4 · Инбокс/пул (AC-3/AC-4)
    { name: "U3 · log in as approver", action: "login", userId: APPROVER },
    { name: "U3 · open inbox", action: "goto", path: "/inbox" },
    {
      // Poll the live inbox API (as the approver) for THIS instance's waiting
      // approval task; capture its task id (== process.started audit_event id).
      name: "U3 · approval task lands in the approver pool (AC-3)",
      action: "pollApi",
      url: "/api/inbox?tab=pool",
      headers: { "x-dev-user": APPROVER },
      pickExpr: "(data.items ?? []).find(i => i.inst === '{{instanceId}}')?.id ?? null",
      captureAs: "taskId",
      timeoutMs: 15000,
    },
    { name: "U4 · reopen inbox", action: "goto", path: "/inbox" },
    {
      name: "U4 · switch to the «Из пула» tab",
      action: "click",
      target: { role: { role: "button", name: "/Из пула/" } },
    },
    {
      name: "U4 · claimable pool row for the instance is visible (AC-4)",
      action: "expectVisible",
      target: { css: 'tr:has(:text("{{instanceId}}"))', first: true },
    },
    {
      // Click «Взять» INSIDE the instance row → POST /api/inbox/:id/claim → 200.
      name: "U4 · click «Взять» → claim returns 200 (AC-4)",
      action: "click",
      target: {
        role: { role: "button", name: "/Взять/" },
        within: { css: 'tr:has(:text("{{instanceId}}"))', first: true },
      },
      awaitResponse: {
        urlIncludes: "/api/inbox/{{taskId}}/claim",
        method: "POST",
        expectStatus: 200,
      },
    },

    // ───────────────────────────────── U4 · Approve (card-action, AC-5)
    {
      name: "U4 · switch to the «Мне» tab (claimed task lands here)",
      action: "click",
      target: { role: { role: "button", name: "/^Мне/" } },
    },
    {
      name: "U4 · «Согласовать» card-action visible after claim (AC-5)",
      action: "expectVisible",
      target: {
        role: { role: "button", name: "Согласовать" },
        within: {
          css: 'tr:has(:text("{{instanceId}}"))',
          has: { role: { role: "button", name: "Согласовать" } },
          first: true,
        },
      },
    },
    {
      // Click «Согласовать» INSIDE the claimed row → POST /api/inbox/:id/action
      // {approve} → 200 { status: "done" }.
      name: "U4 · click «Согласовать» → approve returns 200 (AC-5)",
      action: "click",
      target: {
        role: { role: "button", name: "Согласовать" },
        within: {
          css: 'tr:has(:text("{{instanceId}}"))',
          has: { role: { role: "button", name: "Согласовать" } },
          first: true,
        },
      },
      awaitResponse: {
        urlIncludes: "/api/inbox/{{taskId}}/action",
        method: "POST",
        expectStatus: 200,
      },
    },

    // ───────────────────────────────────────────── U5 · Завершение (AC-6)
    { name: "U5 · open processes", action: "goto", path: "/processes" },
    {
      name: "U5 · completed instance still visible (AC-6)",
      action: "expectVisible",
      target: { css: 'tr:has(:text("{{instanceId}}"))', first: true },
    },
    {
      name: "U5 · instance is observably done after approval (AC-6)",
      action: "expectText",
      target: { css: 'tr:has(:text("{{instanceId}}"))', first: true },
      text: "/done|Завершено|Готово/i",
    },
    { name: "U5 · reopen inbox", action: "goto", path: "/inbox" },
    {
      name: "U5 · switch to the «Из пула» tab",
      action: "click",
      target: { role: { role: "button", name: "/Из пула/" } },
    },
    {
      name: "U5 · approved task no longer waiting in the pool (AC-6)",
      action: "expectCount",
      target: { css: 'tr:has(:text("{{taskId}}"))' },
      count: 0,
    },
  ],
};

export default journey;
export { DEV_TENANT_ID };
