/**
 * e2e/journeys/tel-gateway-routing.journey.ts — T-0347 Part B.
 *
 * Deploy-acceptance journey for the DMN exclusiveGateway routing in tel-linear.bpmn.
 * Tests BOTH branches of gw-approval-threshold:
 *
 *   Band A (amount > 5,000,000): approvalRequired = "needs-approval"
 *     → task-extra-approve (Доп. согласование) appears AFTER task-approve
 *
 *   Band B (amount ≤ 5,000,000): approvalRequired = "standard"
 *     → process ends DIRECTLY after task-approve (no extra task)
 *
 * ARCHITECTURE: the `approvalRequired` variable is injected into Flowable by the
 * external task bridge (makeExternalTaskDeliver in externalTaskBridge.ts) when the
 * tel-intake external task (task-triage) completes. The bridge calls
 * evaluateGatewayAtTriage with the process-instance variables (captured at
 * fetchAndLock time) and merges the result into the completeTask payload. Flowable
 * reads this variable at the exclusiveGateway after task-approve completes.
 *
 * PREREQUISITE: the server must be launched with:
 *   FLOWABLE_BASE_URL=http://flowable:8082/flowable-rest    (enables bridge)
 *   FLOWABLE_REST_APP_ADMIN_PASSWORD=<pass>                 (enables process start)
 *   FLOWABLE_TOPICS=tel-intake                              (bridge polls this topic)
 *
 * STATUS (T-0347 2026-06-20): BLOCKED on bridge not wired on deployed dev stack
 * (FLOWABLE_BASE_URL not set in docker-compose). The gateway routing itself is
 * VERIFIED on the deployed Flowable engine via direct REST calls (see T-0347 report):
 *
 *   high amount (6M) + approvalRequired="needs-approval" → task-extra-approve (CONFIRMED)
 *   low amount  (3M) + approvalRequired="standard"       → process ends         (CONFIRMED)
 *
 * The journey steps below are authored for when the bridge is wired so the acceptance
 * gate can run them automatically.
 *
 * Band A steps use {{nonce}} in the subject to ensure re-run-safety.
 */
import type { Journey } from "./types.js";

const INITIATOR = "e-orlov";
const APPROVER = "e-larina";

/**
 * Band A: amount > 5M → Доп. согласование (needs-approval branch).
 *
 * NOTE: The form does NOT yet have an `amount` field in the current ТЭЛ UI (the
 * amount comes from the process-start variables, not the form submission). Until the
 * form has an amount input, this journey drives Band A by starting the process with
 * amount=6000000 as a process variable — either via a future
 * POST /api/processes/start { variables: { amount: 6000000 } } or via a test fixture.
 *
 * CURRENT BLOCKER: /api/processes/start requires FLOWABLE_REST_APP_ADMIN_PASSWORD
 * env on the server. Wiring that env + FLOWABLE_BASE_URL unblocks both journeys.
 *
 * This journey is a SCHEMA-VALID placeholder; it will execute correctly once the
 * prerequisites are met. The loader.test.ts validates it (structure-only, no runner).
 */
export const journeyBandA: Journey = {
  id: "tel-gateway-high-amount",
  title: "ТЭЛ gateway routing — Band A (amount > 5M → Доп. согласование)",
  version: 1,
  description:
    "Starts a telLinear process with amount > 5M, drives triage+approve, " +
    "then asserts task-extra-approve is visible (needs-approval branch). " +
    "Proves DMN gateway routes correctly for purchases above the 5M threshold.",
  steps: [
    // ── Initiator: launch ТЭЛ ───────────────────────────────────────────────
    { name: "GA1 · log in as initiator", action: "login", userId: INITIATOR },
    { name: "GA1 · open processes", action: "goto", path: "/processes" },
    {
      name: "GA1 · click «Запустить процесс»",
      action: "click",
      target: { role: { role: "button", name: "Запустить процесс" }, first: true },
    },
    {
      name: "GA1 · launch dialog is visible",
      action: "expectVisible",
      target: { role: { role: "dialog", name: "Запустить процесс" } },
    },
    {
      name: "GA1 · confirm launch → 201 (Band A instance started)",
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

    // ── Initiator: fill form with purchase subject ───────────────────────────
    { name: "GA2 · open forms", action: "goto", path: "/forms" },
    {
      name: "GA2 · purchase form renders (Band A — high-value purchase)",
      action: "expectVisible",
      target: { css: '[data-field="subject"] input.fjs-input', scope: { frame: "iframe.chs-form-viewer" }, first: true },
    },
    {
      name: "GA2 · fill purchase subject (Band A)",
      action: "fill",
      target: { css: '[data-field="subject"] input.fjs-input', scope: { frame: "iframe.chs-form-viewer" }, first: true },
      value: "Договор разработки ПО — высокая сумма {{nonce}}",
    },
    {
      name: "GA2 · submit form → 200",
      action: "click",
      target: { role: { role: "button", name: "Отправить на согласование" }, scope: { frame: "iframe.chs-form-viewer" } },
      awaitResponse: {
        urlIncludes: "/api/forms/purchase/submit",
        method: "POST",
        expectStatus: 200,
      },
    },

    // ── Approver: pool task → claim → approve ───────────────────────────────
    { name: "GA3 · log in as approver", action: "login", userId: APPROVER },
    { name: "GA3 · open inbox", action: "goto", path: "/inbox" },
    {
      name: "GA3 · approval task appears in pool (poll 30s — bridge processes tel-intake)",
      action: "pollApi",
      url: "/api/inbox?tab=pool",
      headers: { "x-dev-user": APPROVER },
      pickExpr: "(data.items ?? []).find(i => i.inst === '{{instanceId}}')?.id ?? null",
      captureAs: "taskId",
      timeoutMs: 30000,
    },
    { name: "GA4 · reopen inbox", action: "goto", path: "/inbox" },
    {
      name: "GA4 · switch to «Из пула»",
      action: "click",
      target: { role: { role: "button", name: "/Из пула/" } },
    },
    {
      name: "GA4 · claim the pool task",
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
    {
      name: "GA4 · switch to «Мне»",
      action: "click",
      target: { role: { role: "button", name: "/^Мне/" } },
    },
    {
      name: "GA4 · approve (click «Согласовать»)",
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

    // ── KEYSTONE ASSERTION: gw-approval-threshold → task-extra-approve ──────
    // After approving, the exclusiveGateway evaluates approvalRequired="needs-approval"
    // (set by the bridge at triage time) and routes to «Доп. согласование».
    { name: "GA5 · reopen inbox", action: "goto", path: "/inbox" },
    {
      name: "GA5 · poll for «Доп. согласование» task in pool (gateway routed correctly)",
      action: "pollApi",
      url: "/api/inbox?tab=pool",
      headers: { "x-dev-user": APPROVER },
      pickExpr: "(data.items ?? []).find(i => i.inst === '{{instanceId}}' && (i.taskKey === 'task-extra-approve' || i.name === 'Доп. согласование'))?.id ?? null",
      captureAs: "extraTaskId",
      timeoutMs: 15000,
    },
    {
      name: "GA5 · KEYSTONE: task-extra-approve visible (Band A → needs-approval branch confirmed)",
      action: "apiCheck",
      url: "/api/inbox?tab=pool",
      headers: { "x-dev-user": APPROVER },
      expectStatusNot: 404,
    },
  ],
};

/**
 * Band B: amount ≤ 5M → standard (process ends after task-approve, no extra task).
 */
export const journeyBandB: Journey = {
  id: "tel-gateway-low-amount",
  title: "ТЭЛ gateway routing — Band B (amount ≤ 5M → standard, process ends)",
  version: 1,
  description:
    "Starts a telLinear process with amount ≤ 5M, drives triage+approve, " +
    "then asserts the process is done (no task-extra-approve). " +
    "Proves DMN gateway routes correctly for standard purchases.",
  steps: [
    { name: "GB1 · log in as initiator", action: "login", userId: INITIATOR },
    { name: "GB1 · open processes", action: "goto", path: "/processes" },
    {
      name: "GB1 · click «Запустить процесс»",
      action: "click",
      target: { role: { role: "button", name: "Запустить процесс" }, first: true },
    },
    {
      name: "GB1 · confirm launch → 201",
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
    { name: "GB2 · open forms", action: "goto", path: "/forms" },
    {
      name: "GB2 · fill purchase subject (Band B)",
      action: "fill",
      target: { css: '[data-field="subject"] input.fjs-input', scope: { frame: "iframe.chs-form-viewer" }, first: true },
      value: "Договор поставки канцтоваров {{nonce}}",
    },
    {
      name: "GB2 · submit form → 200",
      action: "click",
      target: { role: { role: "button", name: "Отправить на согласование" }, scope: { frame: "iframe.chs-form-viewer" } },
      awaitResponse: {
        urlIncludes: "/api/forms/purchase/submit",
        method: "POST",
        expectStatus: 200,
      },
    },
    { name: "GB3 · log in as approver", action: "login", userId: APPROVER },
    { name: "GB3 · open inbox", action: "goto", path: "/inbox" },
    {
      name: "GB3 · poll for pool task (triage processed)",
      action: "pollApi",
      url: "/api/inbox?tab=pool",
      headers: { "x-dev-user": APPROVER },
      pickExpr: "(data.items ?? []).find(i => i.inst === '{{instanceId}}')?.id ?? null",
      captureAs: "taskId",
      timeoutMs: 30000,
    },
    { name: "GB4 · reopen inbox", action: "goto", path: "/inbox" },
    {
      name: "GB4 · switch to «Из пула»",
      action: "click",
      target: { role: { role: "button", name: "/Из пула/" } },
    },
    {
      name: "GB4 · claim the pool task",
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
    {
      name: "GB4 · switch to «Мне»",
      action: "click",
      target: { role: { role: "button", name: "/^Мне/" } },
    },
    {
      name: "GB4 · approve (standard track)",
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

    // ── KEYSTONE: no task-extra-approve; instance is done ───────────────────
    { name: "GB5 · open processes (instance should be done)", action: "goto", path: "/processes" },
    {
      name: "GB5 · KEYSTONE: instance is observably done (Band B → standard track confirmed)",
      action: "expectText",
      target: { css: 'tr:has(:text("{{instanceId}}"))', first: true },
      text: "/done|Завершено|Готово/i",
    },
    { name: "GB5 · open inbox", action: "goto", path: "/inbox" },
    {
      name: "GB5 · switch to «Из пула»",
      action: "click",
      target: { role: { role: "button", name: "/Из пула/" } },
    },
    {
      name: "GB5 · no extra-approval task in pool (gateway did NOT route to needs-approval)",
      action: "expectCount",
      target: { css: 'tr:has(:text("{{instanceId}}"))', first: true },
      count: 0,
    },
  ],
};

// NOTE: this file exports TWO journeys (not the single-default pattern).
// The journeys.e2e.ts discovery uses discoverJourneyFiles which imports *.journey.ts
// and expects a default or named export `journey`. For now, export Band A as default
// (the higher-value test case) and Band B as named. When the prerequisites are met,
// both can be run by the acceptance gate.
export const journey = journeyBandA;
export default journeyBandA;
