/**
 * e2e/journeys/constructor-vertical.journey.ts — T-0268 (Journey #2).
 *
 * The CONSTRUCTOR-vertical deploy-acceptance journey: the proof that Stage 2 of the
 * reality-gap fix actually CLICKS on the running stack. Where tel-linear proves the
 * pre-built ТЭЛ process clicks, THIS journey proves the user can BUILD a solution out
 * of constructor primitives by REAL clicks against the deployed product (built
 * web/dist + live HTTP + Postgres — NO mocks, FF-3 / NF1 / D-056):
 *
 *   log in → create an application → define a field → create a record → see it listed.
 *
 * It exercises the E13 constructor screens end-to-end:
 *   • screen-apps.jsx       — «Создать приложение» modal → POST /api/applications 201
 *   • screen-app-schema.jsx — «Новый реестр» field-editor → POST /api/registry-defs 201
 *   • screen-app-records.jsx— «Создать запись» dynamic form → POST /api/records 201
 *
 * IDEMPOTENCY: the application + registry slugs use the built-in per-run {{nonce}}
 * (runner.ts) so a repeat run never 409s on UNIQUE (tenant_id, slug) — WITHOUT a
 * destructive bootstrap (the acceptance bootstrap stays read-only by construction).
 *
 * FAIL-HONEST (NF5 / AC-8): every affordance is a hard assertion. A missing button, a
 * non-2xx write, a mis-serialized field value, or a record that does not land in the
 * list turns the run RED — the whole point of the founder's anti-"agents lie that
 * it's done" gate. No assertion is weakened to force green.
 *
 * Adding this journey is dropping this file — zero runner change (T-0257 contract).
 */
import type { Journey } from "./types.js";

// The dev-tenant actor we click as. The constructor APIs gate the happy create-path
// on a valid x-dev-user actor + RLS tenant resolution (NOT a special permission —
// the PDP gate on registry-defs is only the destructive force-PUT path, T-0191), so
// the seeded initiator persona (migrations 013) is a real, sufficient actor.
const ACTOR = "e-orlov"; // К. Орлов — seeded dev-tenant employee

// The field key the journey defines + the value it enters into the new record. The
// record list renders a column per schema field (records-form.schemaToColumns), so
// asserting the entered value is visible in the table proves the round-trip persisted.
const FIELD_KEY = "subject";
const FIELD_TITLE = "Тема";
const RECORD_VALUE = "Приёмочная запись конструктора";

export const journey: Journey = {
  id: "constructor-vertical",
  title: "Конструктор — вертикаль: приложение → поле → запись (clicked)",
  version: 1,
  description:
    "Log in, create an application, define a required field, create a record, and see it in the list — all by REAL clicks against the deployed constructor (E13).",
  steps: [
    // ───────────────────────────────────── login + open Конструктор · Приложения
    { name: "log in as the constructor actor", action: "login", userId: ACTOR },
    { name: "open Конструктор · Приложения", action: "goto", path: "/apps" },
    {
      name: "«Создать приложение» button is present",
      action: "expectVisible",
      target: { role: { role: "button", name: "Создать приложение" }, first: true },
    },

    // ───────────────────────────────────── create an application
    {
      name: "open the create-application modal",
      action: "click",
      target: { role: { role: "button", name: "Создать приложение" }, first: true },
    },
    {
      name: "the create-application dialog is visible",
      action: "expectVisible",
      target: { role: { role: "dialog", name: "Создать приложение" } },
    },
    {
      name: "fill the application slug (unique per run via {{nonce}})",
      action: "fill",
      target: {
        css: 'input[placeholder="my-app"]',
        within: { role: { role: "dialog", name: "Создать приложение" } },
      },
      value: "acc-app-{{nonce}}",
    },
    {
      name: "fill the application display name",
      action: "fill",
      target: {
        css: 'input[placeholder="Моё приложение"]',
        within: { role: { role: "dialog", name: "Создать приложение" } },
      },
      value: "Приёмочное приложение {{nonce}}",
    },
    {
      // REAL submit click inside the dialog → POST /api/applications → 201.
      // Capture the created application id to drive the field-editor + records routes.
      name: "click «Создать» → applications POST returns 201",
      action: "click",
      target: {
        role: { role: "button", name: "Создать" },
        within: { role: { role: "dialog", name: "Создать приложение" } },
      },
      awaitResponse: {
        urlIncludes: "/api/applications",
        method: "POST",
        expectStatus: 201,
        captureJson: { appId: "id" },
      },
    },
    {
      name: "the new application appears in the list",
      action: "expectVisible",
      target: { css: 'tr:has(:text("acc-app-{{nonce}}"))', first: true },
    },

    // ───────────────────────────────────── define a field (registry_def)
    {
      // Jump into the field-constructor for the just-created app (the «Настроить
      // поля» affordance navigates to /app-schema/:appId — we go there by id).
      name: "open the field-constructor for the new application",
      action: "goto",
      path: "/app-schema/{{appId}}",
    },
    {
      name: "«Новый набор полей» button is present",
      action: "expectVisible",
      target: { role: { role: "button", name: "Новый набор полей" }, first: true },
    },
    {
      name: "open the new field-set editor",
      action: "click",
      target: { role: { role: "button", name: "Новый набор полей" }, first: true },
    },
    {
      name: "fill the field-set slug (unique per run)",
      action: "fill",
      target: { css: 'input[placeholder="my-registry"]' },
      value: "acc-reg-{{nonce}}",
    },
    {
      name: "fill the field-set display name",
      action: "fill",
      target: { css: 'input[placeholder="Мой набор полей"]' },
      value: "Приёмочный набор полей",
    },
    {
      name: "name the first field key",
      action: "fill",
      target: { role: { role: "textbox", name: "Ключ поля" }, first: true },
      value: FIELD_KEY,
    },
    {
      name: "give the first field a human title",
      action: "fill",
      target: { role: { role: "textbox", name: "Название поля" }, first: true },
      value: FIELD_TITLE,
    },
    {
      // Mark the field required so the record form enforces it (a string field is the
      // default type — no type change needed; the dropdown defaults to «Текст»).
      name: "mark the field required",
      action: "click",
      target: { role: { role: "checkbox", name: "Обязательное поле" }, first: true },
    },
    {
      // REAL submit click → POST /api/registry-defs → 201. Capture the registry id.
      name: "click «Создать набор» → registry-defs POST returns 201",
      action: "click",
      target: { role: { role: "button", name: "Создать набор" } },
      awaitResponse: {
        urlIncludes: "/api/registry-defs",
        method: "POST",
        expectStatus: 201,
        captureJson: { defId: "id" },
      },
    },
    {
      name: "the new field-set appears in the application's field-set list",
      action: "expectVisible",
      target: { css: 'tr:has(:text("acc-reg-{{nonce}}"))', first: true },
    },
    {
      // API-level fail-honest invariant: the field is actually persisted on the
      // registry_def's record_schema (not just an optimistic UI echo). The GET must
      // return our field key in properties.
      name: "the defined field is persisted in record_schema (read-back)",
      action: "pollApi",
      url: "/api/registry-defs/{{defId}}",
      headers: { "x-dev-user": ACTOR },
      pickExpr:
        "(data && data.record_schema && data.record_schema.properties && ('" +
        FIELD_KEY +
        "' in data.record_schema.properties)) ? '" +
        FIELD_KEY +
        "' : null",
      captureAs: "persistedFieldKey",
      timeoutMs: 10000,
    },

    // ───────────────────────────────────── create a record
    {
      // Jump into the records list for the app (the «Записи» affordance →
      // /app-records/:appId). With exactly one registry_def the screen auto-selects
      // it, so «Создать запись» is enabled.
      name: "open the records list for the new application",
      action: "goto",
      path: "/app-records/{{appId}}",
    },
    {
      name: "«Создать запись» button is present + enabled",
      action: "expectVisible",
      target: { role: { role: "button", name: "Создать запись" }, first: true },
    },
    {
      name: "open the create-record dynamic form",
      action: "click",
      target: { role: { role: "button", name: "Создать запись" }, first: true },
    },
    {
      // The Drawer uses role=dialog with the title «Новая запись» (T-0319 OBLIK:
      // create-record was moved from Modal → Drawer; title changed to «Новая запись»).
      name: "the create-record drawer is visible",
      action: "expectVisible",
      target: { role: { role: "dialog", name: "Новая запись" } },
    },
    {
      // The form is GENERATED from the registry_def schema — one input per field,
      // labelled by the field title. Fill the required string field.
      name: "fill the schema-generated field",
      action: "fill",
      target: {
        role: { role: "textbox", name: FIELD_TITLE },
        within: { role: { role: "dialog", name: "Новая запись" } },
      },
      value: RECORD_VALUE,
    },
    {
      // REAL submit click → POST /api/records → 201. Capture the created record id.
      name: "click «Создать запись» → records POST returns 201",
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

    // ───────────────────────────────────── see it in the list (the round-trip proof)
    {
      // The record list renders a column per schema field; the entered value lands in
      // a real <tr>. Asserting the row that CONTAINS the value is visible proves the
      // create round-tripped through POST → DB → GET → render (not an optimistic echo:
      // handleCreated calls loadRecords() which re-fetches GET /api/records).
      name: "the new record row is visible in the records list",
      action: "expectVisible",
      target: { css: `table.chs-itable tbody tr:has(:text("${RECORD_VALUE}"))`, first: true },
    },
    {
      name: "the record list shows the entered field value (round-trip persisted)",
      action: "expectText",
      target: { css: "table.chs-itable tbody", first: true },
      text: RECORD_VALUE,
    },
  ],
};

export default journey;
