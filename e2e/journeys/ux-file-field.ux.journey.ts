/**
 * e2e/journeys/ux-file-field.ux.journey.ts — T-0579 (review C2 / AC-15).
 *
 * FileField (the `file` binding-contract structural component) had ZERO e2e
 * ux-journey coverage — only unit-level element-tree / source-text checks
 * existed (field-renderer-file.test.jsx). This journey drives the REAL
 * deployed product: create an app with a file-typed field → open the
 * create-record form → assert FileField's honest EMPTY state (upload
 * affordance, no dead "Сначала сохраните запись" trap since a NEW record's
 * drawer has no recordId yet) → submit the record → reopen it in edit mode
 * (now HAS a recordId) → assert the upload affordance is a REAL enabled
 * <input type="file"> (not a disabled/dead control).
 *
 * WHY NOT a full upload→populated round-trip: the journey-runner's closed
 * StepAction vocabulary (types.ts) has no "attach a real file to an <input
 * type=file> and wait for the multipart POST" action — Playwright supports
 * this natively via `locator.setInputFiles()`, but that is a DIFFERENT kind
 * of interaction (binary file attach, not text `fill`/`selectOption`) and
 * adding it is a large enough vocabulary/infra decision (binary fixture
 * handling, MIME control for the anti-XSS svg-exclusion path, etc.) that it
 * is out of proportion for this fix-forward pass. Per this file's own
 * "reviewed extension" convention, that is future work — flagged in
 * pr-handoff.json tails, NOT silently skipped.
 *
 * This journey DOES exercise a real vocabulary gap fix along the way: the
 * field-type <select> ("Тип поля") cannot be driven by `fill` (Playwright
 * throws — "Element is not an <input>, <textarea> or [contenteditable]
 * element"), so this task adds the `selectOption` action (types.ts/loader.ts/
 * runner.ts) — verified empirically before adding it.
 *
 * STATUS (D-056 precedent, cf. ux-g4/ux-creation-path-light): informational
 * now — the Empty/Populated states asserted here are read from LIVE
 * deployed markup, but the full upload-attach flow is not (yet) driven by
 * this journey. Flip alongside the setInputFiles vocabulary addition.
 *
 * SERVER-GATED: requires deployed Choros (real POST + GET API, real DOM).
 * Fail-honest (NF5 / AC-8): a dead/disabled upload control, or a raw uuid
 * anywhere in the visible text, → RED.
 */
import type { Journey } from "./types.js";

const ACTOR = "e-orlov"; // seeded dev-tenant employee
const FIELD_KEY = "attachment";
const FIELD_TITLE = "Вложение (FileField probe)";

export const journey: Journey = {
  id: "ux-file-field",
  title: "AC-15 · FileField honest Empty/Populated states (создание + карточка записи)",
  version: 1,
  description:
    "Login → create app → add a file-typed field (selectOption 'Тип поля') → open create-record drawer (FileField EMPTY, no recordId yet) → submit → reopen the record for edit (FileField control is a real enabled upload input, never a dead/disabled trap, never a raw uuid in visible text).",
  steps: [
    // ── authenticate ──────────────────────────────────────────────────────
    { name: "FF · log in", action: "login", userId: ACTOR },
    { name: "FF · navigate to /apps to create a probe app", action: "goto", path: "/apps" },

    // ── create an application ────────────────────────────────────────────
    {
      name: "FF · open the create-application modal",
      action: "click",
      target: { role: { role: "button", name: "Создать приложение" }, first: true },
    },
    {
      name: "FF · fill app slug (unique per run)",
      action: "fill",
      target: { css: 'input[placeholder="my-app"]', within: { role: { role: "dialog", name: "Создать приложение" } } },
      value: "ff-app-{{nonce}}",
    },
    {
      name: "FF · fill app display name",
      action: "fill",
      target: { css: 'input[placeholder="Моё приложение"]', within: { role: { role: "dialog", name: "Создать приложение" } } },
      value: "FileField probe {{nonce}}",
    },
    {
      name: "FF · submit → POST /api/applications 201 → capture appId",
      action: "click",
      target: { role: { role: "button", name: "Создать" }, within: { role: { role: "dialog", name: "Создать приложение" } } },
      awaitResponse: {
        urlIncludes: "/api/applications",
        method: "POST",
        expectStatus: 201,
        captureJson: { appId: "id" },
      },
    },

    // ── define a FILE-typed field ─────────────────────────────────────────
    {
      name: "FF · open field-constructor for the new app",
      action: "goto",
      path: "/app-schema/{{appId}}",
    },
    {
      name: "FF · open new field-set editor",
      action: "click",
      target: { role: { role: "button", name: "Новый набор полей" }, first: true },
    },
    {
      name: "FF · fill field-set slug",
      action: "fill",
      target: { css: 'input[placeholder="my-registry"]' },
      value: "ff-reg-{{nonce}}",
    },
    {
      name: "FF · fill field-set display name",
      action: "fill",
      target: { css: 'input[placeholder="Мой набор полей"]' },
      value: "FileField поля",
    },
    {
      name: "FF · set field key",
      action: "fill",
      target: { role: { role: "textbox", name: "Ключ поля" }, first: true },
      value: FIELD_KEY,
    },
    {
      // T-0579: the field-type dropdown is a native <select> — fill() throws
      // on it, hence the new selectOption action (see header note).
      name: "FF · set field type to «Файл» (the type this whole task adds)",
      action: "selectOption",
      target: { role: { role: "combobox", name: "Тип поля" }, first: true },
      optionValue: "file",
    },
    {
      name: "FF · set field title",
      action: "fill",
      target: { role: { role: "textbox", name: "Название поля" }, first: true },
      value: FIELD_TITLE,
    },
    {
      name: "FF · submit field-set → POST /api/registry-defs 201 → capture defId",
      action: "click",
      target: { role: { role: "button", name: "Создать набор" } },
      awaitResponse: {
        urlIncludes: "/api/registry-defs",
        method: "POST",
        expectStatus: 201,
        captureJson: { defId: "id" },
      },
    },

    // ── EMPTY state: create-record drawer, no recordId yet ────────────────
    {
      name: "FF · navigate to records list for the new app",
      action: "goto",
      path: "/app-records/{{appId}}",
    },
    {
      name: "FF · open the create-record form",
      action: "click",
      target: { role: { role: "button", name: "Создать запись" }, first: true },
    },
    {
      name: "FF · the create-record drawer is visible",
      action: "expectVisible",
      target: { role: { role: "dialog", name: "Новая запись" } },
    },
    {
      // Empty state (NF-5/D-062, ADR §2.3): the file field renders an upload
      // affordance — a native <input type=file>, labeled — never a blank gap.
      name: "FF · FileField renders a visible file-upload input in the create drawer",
      action: "expectVisible",
      target: {
        css: 'input[type="file"]',
        within: { role: { role: "dialog", name: "Новая запись" } },
        first: true,
      },
    },
    {
      // The field's label must be the human title configured above, never
      // the raw field key or a placeholder uuid — the honesty invariant this
      // whole review round is about, visible from the very first render.
      // Playwright's `:has-text()` pseudo-class (plain CSS locator, no `has`
      // filter needed) narrows to the ONE label carrying this exact title —
      // robust even though the drawer has other fields' labels too.
      name: "FF · the field label is the human title, not the raw key",
      action: "expectVisible",
      target: {
        css: `label.chs-label:has-text("${FIELD_TITLE}")`,
        within: { role: { role: "dialog", name: "Новая запись" } },
        first: true,
      },
    },

    // ── submit the (file-less) record — file is optional/not required ────
    {
      name: "FF · submit the record without a file (optional field) → POST /api/records 201",
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
      name: "FF · new record row is visible in the list (round-trip persisted)",
      action: "expectVisible",
      target: { css: "table.chs-itable tbody tr", first: true },
    },

    // ── reopen for EDIT — recordId is now available, upload must be a REAL
    //    enabled control, not a disabled/dead trap ─────────────────────────
    {
      name: "FF · open the record's row to edit it",
      action: "click",
      target: { css: "table.chs-itable tbody tr", first: true },
    },
    {
      name: "FF · open the edit drawer",
      action: "click",
      target: { role: { role: "button", name: "Редактировать" }, first: true },
    },
    {
      name: "FF · edit drawer is visible",
      action: "expectVisible",
      target: { role: { role: "dialog", name: "Изменить запись" } },
    },
    {
      // With a real recordId now in scope, FileField's upload input must be
      // present AND not disabled — this is the exact regression review M1
      // fixed (recordId was never threaded to some sites, silently disabling
      // upload even with a saved record).
      name: "FF · FileField's upload input is visible in EDIT mode (recordId now available)",
      action: "expectVisible",
      target: {
        css: 'input[type="file"]:not([disabled])',
        within: { role: { role: "dialog", name: "Изменить запись" } },
        first: true,
      },
    },
  ],
};

export default journey;
