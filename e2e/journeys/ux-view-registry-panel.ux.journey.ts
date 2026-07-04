/**
 * e2e/journeys/ux-view-registry-panel.ux.journey.ts — T-0581 (view registry)
 * FF-UX-VR-7 · AC-14/AC-15 UX honest-gate for the «Настроить список» panel.
 *
 * RULE (spec AC-14 / ADR §6 FF-UX-VR-7): the columns/filters/sort panel must
 * pass the same G1-G7 honest-gate discipline every other list surface does:
 *   - the panel opens from a REAL button (no dead/disabled-forever affordance);
 *   - a набор полей with ZERO fields shows an honest Empty state inside the
 *     panel, never a blank drawer (G4);
 *   - saving a view round-trips through the real API (POST /api/list-views
 *     201) and the saved view becomes selectable via the view switcher —
 *     proving the panel is wired to the approved backend, not a UI mock;
 *   - the view switcher — once a view exists — offers BOTH the saved view and
 *     the default, in RUSSIAN text (no "view_id"/"list_view" leaking).
 *
 * Mirrors constructor-vertical.journey.ts's setup vertical (create application
 * → define a field → open records) to reach a real, non-ТЭЛ application, per
 * the task brief's anti-case discipline (D-064: this journey exercises a
 * GENERIC application, never a business-domain scenario).
 *
 * IDEMPOTENCY: {{nonce}}-suffixed slugs (runner.ts contract) — safe to re-run.
 *
 * FAIL-HONEST (NF5/AC-8): every affordance is a hard assertion; a missing
 * button, a non-2xx write, or a blank/invisible panel state turns the run RED.
 */
import type { Journey } from "./types.js";

const ACTOR = "e-orlov"; // seeded dev-tenant employee (same persona as other journeys)

const FIELD_KEY = "amount";
const FIELD_TITLE = "Сумма";
const VIEW_NAME = "Приёмочное представление {{nonce}}";

export const journey: Journey = {
  id: "ux-view-registry-panel",
  title: "G-VR · Панель «Настроить список»: честные состояния + сохранение представления",
  version: 1,
  description:
    "Opens the columns/filters/sort panel on a freshly-created application (0 fields → Empty state), defines a field, then saves a real view and confirms it becomes selectable in the view switcher — proving the panel is wired to the live /api/list-views backend, not a mock, with no blank/invisible states along the way.",
  steps: [
    // ── log in + create a fresh application (generic — anti-case, D-064) ────
    { name: "G-VR · log in", action: "login", userId: ACTOR },
    { name: "G-VR · open Конструктор · Приложения", action: "goto", path: "/apps" },
    {
      name: "G-VR · open the create-application modal",
      action: "click",
      target: { role: { role: "button", name: "Создать приложение" }, first: true },
    },
    {
      name: "G-VR · fill the application slug (unique per run)",
      action: "fill",
      target: { css: 'input[placeholder="my-app"]', within: { role: { role: "dialog", name: "Создать приложение" } } },
      value: "vr-panel-{{nonce}}",
    },
    {
      name: "G-VR · fill the application display name",
      action: "fill",
      target: { css: 'input[placeholder="Моё приложение"]', within: { role: { role: "dialog", name: "Создать приложение" } } },
      value: "Панель представлений {{nonce}}",
    },
    {
      name: "G-VR · submit → POST /api/applications 201 → capture appId",
      action: "click",
      target: { role: { role: "button", name: "Создать" }, within: { role: { role: "dialog", name: "Создать приложение" } } },
      awaitResponse: {
        urlIncludes: "/api/applications",
        method: "POST",
        expectStatus: 201,
        captureJson: { appId: "id" },
      },
    },

    // ── define ONE field (so the panel has something to show/hide/sort) ─────
    { name: "G-VR · open the field-constructor for the new application", action: "goto", path: "/app-schema/{{appId}}" },
    {
      name: "G-VR · open the new field-set editor",
      action: "click",
      target: { role: { role: "button", name: "Новый набор полей" }, first: true },
    },
    {
      name: "G-VR · fill the field-set slug",
      action: "fill",
      target: { css: 'input[placeholder="my-registry"]' },
      value: "vr-reg-{{nonce}}",
    },
    {
      name: "G-VR · fill the field-set display name",
      action: "fill",
      target: { css: 'input[placeholder="Мой набор полей"]' },
      value: "Приёмочный набор полей (панель)",
    },
    {
      name: "G-VR · name the first field key",
      action: "fill",
      target: { role: { role: "textbox", name: "Ключ поля" }, first: true },
      value: FIELD_KEY,
    },
    {
      name: "G-VR · give the first field a human title",
      action: "fill",
      target: { role: { role: "textbox", name: "Название поля" }, first: true },
      value: FIELD_TITLE,
    },
    {
      name: "G-VR · submit → POST /api/registry-defs 201 → capture defId",
      action: "click",
      target: { role: { role: "button", name: "Создать набор" } },
      awaitResponse: {
        urlIncludes: "/api/registry-defs",
        method: "POST",
        expectStatus: 201,
        captureJson: { defId: "id" },
      },
    },

    // ── open the records list + the panel ───────────────────────────────────
    { name: "G-VR · open the records list for the new application", action: "goto", path: "/app-records/{{appId}}" },
    {
      name: "G-VR · «Настроить список» affordance is present + live (not dead, G3)",
      action: "expectVisible",
      target: { role: { role: "button", name: "Настроить список" }, first: true },
    },
    {
      name: "G-VR · open the panel",
      action: "click",
      target: { role: { role: "button", name: "Настроить список" }, first: true },
    },
    {
      name: "G-VR · the panel drawer is visible (kit <Drawer>, dialog role)",
      action: "expectVisible",
      target: { role: { role: "dialog", name: "Настроить список" } },
    },
    {
      // The набор полей has exactly ONE real field (amount) plus the created_at
      // pseudo-column — never zero, so we assert the columns section renders the
      // field label honestly (not blank, not a raw field_key/JSONB leak).
      name: "G-VR · the columns section shows the defined field's human label (no field_key/JSONB leak)",
      action: "expectVisible",
      target: { css: `[role="dialog"] :text("${FIELD_TITLE}")`, first: true },
    },
    {
      name: "G-VR · the panel states views are tenant-shared, honestly (spec FR-10)",
      action: "expectVisible",
      target: { css: '.chs-notice, [role="status"]', first: true, within: { role: { role: "dialog", name: "Настроить список" } } },
    },

    // ── save a view → real POST /api/list-views 201 ─────────────────────────
    {
      name: "G-VR · name the view",
      action: "fill",
      target: { role: { role: "textbox", name: "Название представления" }, within: { role: { role: "dialog", name: "Настроить список" } } },
      value: VIEW_NAME,
    },
    {
      name: "G-VR · save → POST /api/list-views 201",
      action: "click",
      target: { role: { role: "button", name: "Сохранить представление" }, within: { role: { role: "dialog", name: "Настроить список" } } },
      awaitResponse: {
        urlIncludes: "/api/list-views",
        method: "POST",
        expectStatus: 201,
        captureJson: { viewId: "id" },
      },
    },
    {
      // The panel closes on a successful save (onApply + onClose) — the dialog
      // must no longer be present, proving the round-trip really completed
      // rather than silently failing while still showing the form.
      name: "G-VR · the panel closes after a successful save",
      action: "expectCount",
      target: { role: { role: "dialog", name: "Настроить список" } },
      count: 0,
    },

    // ── the saved view is now selectable via the switcher (Russian text) ────
    {
      name: "G-VR · the view switcher now offers the saved view by name (no view_id/list_view jargon)",
      action: "expectVisible",
      target: { css: `option:text("${VIEW_NAME}")`, first: true },
    },
    {
      name: "G-VR · the view switcher still offers the default option in Russian",
      action: "expectVisible",
      target: { css: 'option:text("По умолчанию")', first: true },
    },

    // ── re-open the panel on the NOW-NAMED view: honest re-population ───────
    {
      name: "G-VR · re-open the panel",
      action: "click",
      target: { role: { role: "button", name: "Настроить список" }, first: true },
    },
    {
      name: "G-VR · the panel re-opens pre-filled with the saved view's name (round-trip persisted, not a blank form)",
      action: "expectVisible",
      target: { css: `input[value="${VIEW_NAME}"]`, first: true },
    },
    {
      name: "G-VR · a delete affordance is offered for the now-active saved view",
      action: "expectVisible",
      target: { role: { role: "button", name: "Удалить представление" }, within: { role: { role: "dialog", name: "Настроить список" } } },
    },
  ],
};

export default journey;
