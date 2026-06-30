/**
 * e2e/journeys/ux-creation-path-light.ux.journey.ts — OBLIK G1 sub-check (T-0314).
 *
 * CREATION-PATH in LIGHT THEME: login → create an application → add a field → create
 * a record — all in light theme — and assert the typed value is VISIBLE in the form
 * (closes the specific audit finding: "тёмный текст на тёмном фоне — ввод не виден"
 * in FormViewer when the SPA is in light mode).
 *
 * This exercises the FormViewer iframe theme-propagation bug (ux-quality-system.md
 * §1 / Корень A): `FormViewer.jsx:153` defaulted the iframe to `theme || 'dark'`
 * regardless of the SPA theme. The fix is: FormViewer inherits the SPA theme.
 *
 * HOW: after filling the create-record form field in light theme we:
 *   a) assert the input field is visible (not invisible/occluded)
 *   b) assert the typed value is readable in the input (expectText on the field)
 *   c) run checkContrast on the dialog scope (axe colour-contrast in light theme)
 *
 * SERVER-GATED: requires deployed Choros with FormViewer rendering the record form.
 * Fail-honest (NF5 / AC-8): any contrast violation or invisible input → RED.
 *
 * STATUS (D-056): informational; flip to --required after Фаза 0 fix of FormViewer
 * theme propagation lands (ThemeProvider + FormViewer inherits-theme). The journey
 * is the MACHINERY; flip is server-gated.
 */
import type { Journey } from "./types.js";

const ACTOR = "e-orlov";
const FIELD_KEY = "subject";
const FIELD_TITLE = "Тема (G1 probe)";
const RECORD_VALUE = "G1-приёмочный-ввод-{{nonce}}";

export const journey: Journey = {
  id: "ux-creation-path-light",
  title: "G1 · Creation-path в СВЕТЛОЙ теме — ввод виден (не тёмный на тёмном)",
  version: 1,
  description:
    "Login → create app → add field → open create-record form in LIGHT theme → assert typed value is visible and contrast passes axe AA. Closes FormViewer dark-default bug.",
  steps: [
    // ── authenticate + force light theme ──────────────────────────────────
    { name: "G1-light · log in", action: "login", userId: ACTOR },
    { name: "G1-light · navigate to /apps", action: "goto", path: "/apps" },
    { name: "G1-light · switch to LIGHT theme", action: "toggleTheme", theme: "light" },

    // ── create an application ────────────────────────────────────────────
    {
      name: "G1-light · open create-application modal",
      action: "click",
      target: { role: { role: "button", name: "Создать приложение" }, first: true },
    },
    {
      name: "G1-light · fill app slug",
      action: "fill",
      target: { css: 'input[placeholder="my-app"]', within: { role: { role: "dialog", name: "Создать приложение" } } },
      value: "g1lt-app-{{nonce}}",
    },
    {
      name: "G1-light · fill app display name",
      action: "fill",
      target: { css: 'input[placeholder="Моё приложение"]', within: { role: { role: "dialog", name: "Создать приложение" } } },
      value: "G1-Light Probe {{nonce}}",
    },
    {
      name: "G1-light · submit → POST /api/applications 201 → capture appId",
      action: "click",
      target: { role: { role: "button", name: "Создать" }, within: { role: { role: "dialog", name: "Создать приложение" } } },
      awaitResponse: {
        urlIncludes: "/api/applications",
        method: "POST",
        expectStatus: 201,
        captureJson: { appId: "id" },
      },
    },

    // ── define a field ────────────────────────────────────────────────────
    {
      name: "G1-light · open field-constructor for the new app",
      action: "goto",
      path: "/app-schema/{{appId}}",
    },
    {
      name: "G1-light · open new field-set editor",
      action: "click",
      target: { role: { role: "button", name: "Новый набор полей" }, first: true },
    },
    {
      name: "G1-light · fill field-set slug",
      action: "fill",
      target: { css: 'input[placeholder="my-registry"]' },
      value: "g1lt-reg-{{nonce}}",
    },
    {
      name: "G1-light · fill field-set display name",
      action: "fill",
      target: { css: 'input[placeholder="Мой набор полей"]' },
      value: "G1-Light Поля",
    },
    {
      name: "G1-light · set field key",
      action: "fill",
      target: { role: { role: "textbox", name: "Ключ поля" }, first: true },
      value: FIELD_KEY,
    },
    {
      name: "G1-light · set field title",
      action: "fill",
      target: { role: { role: "textbox", name: "Название поля" }, first: true },
      value: FIELD_TITLE,
    },
    {
      name: "G1-light · submit field-set → POST /api/registry-defs 201 → capture defId",
      action: "click",
      target: { role: { role: "button", name: "Создать набор" } },
      awaitResponse: {
        urlIncludes: "/api/registry-defs",
        method: "POST",
        expectStatus: 201,
        captureJson: { defId: "id" },
      },
    },

    // ── create a record in LIGHT THEME — the critical probe ───────────────
    {
      name: "G1-light · navigate to records list for the new app",
      action: "goto",
      path: "/app-records/{{appId}}",
    },
    // Re-assert light theme on the records page (navigation must not lose theme).
    {
      name: "G1-light · re-confirm LIGHT theme is active on records page",
      action: "toggleTheme",
      theme: "light",
    },
    {
      name: "G1-light · open the create-record form",
      action: "click",
      target: { role: { role: "button", name: "Создать запись" }, first: true },
    },
    {
      name: "G1-light · the create-record drawer is visible",
      action: "expectVisible",
      target: { role: { role: "dialog", name: "Новая запись" } },
    },
    // ── THE KEY ASSERTION: fill the field and assert the typed value is visible ──
    {
      name: "G1-light · fill the schema-generated field in LIGHT theme",
      action: "fill",
      target: {
        role: { role: "textbox", name: FIELD_TITLE },
        within: { role: { role: "dialog", name: "Новая запись" } },
      },
      value: RECORD_VALUE,
    },
    {
      // The typed value must be visible in the input. If FormViewer rendered dark-on-dark
      // (the audit bug) the input text would be invisible — axe would catch it below, but
      // this explicit expectText proves the VALUE is read back (not silently eaten).
      name: "G1-light · typed value is readable in the input (not invisible on dark-on-dark)",
      action: "expectText",
      target: {
        role: { role: "textbox", name: FIELD_TITLE },
        within: { role: { role: "dialog", name: "Новая запись" } },
      },
      text: "G1-приёмочный-ввод-",
    },
    {
      // axe-core contrast check on the dialog scope only (the form + field area).
      // If the FormViewer iframe renders dark-on-dark in light mode, axe will catch it.
      name: "G1-light · axe colour-contrast AA — dialog/form scope — LIGHT theme",
      action: "checkContrast",
      scope: '[role="dialog"]',
      wcagLevel: "AA",
    },
    // ── submit and verify the record landed (round-trip) ─────────────────
    {
      name: "G1-light · submit → POST /api/records 201",
      action: "click",
      target: {
        role: { role: "button", name: "Создать запись" },
        within: { role: { role: "dialog", name: "Новая запись" } },
      },
      awaitResponse: {
        urlIncludes: "/api/records",
        method: "POST",
        expectStatus: 201,
        captureJson: { recordId: "id" },
      },
    },
    {
      name: "G1-light · new record row is visible in the list (round-trip persisted)",
      action: "expectVisible",
      target: { css: "table.chs-itable tbody tr", first: true },
    },
  ],
};

export default journey;
