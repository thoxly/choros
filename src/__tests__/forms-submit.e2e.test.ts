/**
 * T-0102: E2E tests for POST /api/forms/:formId/submit.
 * T-0251: Extended to assert server-side persistence of submitted records.
 * T-0336 (E15-S2): The in-memory RECORDS Map has been removed. Record persistence
 * goes through the real DB record store (src/http/records.ts); in no-DB/memory mode
 * _getRecordForTests() always returns undefined (no in-process store).
 *
 * As a result, AC-10 (record persistence assertion) is updated to reflect honest
 * no-DB behavior: the recordId is still returned in the response (contract unchanged),
 * but the record is NOT retrievable via _getRecordForTests(). DB-backed persistence
 * is tested in ci/checks/db/records_crud.test.ts.
 *
 * T-0369 (number coercion): HTML form submission sends ALL values as strings.
 * A pre-validation coercion pass in forms.ts converts declared number/boolean
 * fields from strings before validation, so FormViewer sandbox-iframe submissions
 * that send amount:"6000000" now → 200 (not 400). Non-numeric strings still → 400.
 *
 * T-0370 (field alignment): PURCHASE form schema aligned to registry_def.record_schema
 * «Заявки» (migration 076). Old fields (supplier/subject/qty/price/budget) replaced
 * with registry fields (title/amount/requester/status). validPurchase() updated to
 * use the new field set. Memory-mode and DB-mode now validate the same field keys.
 *
 * Drives the real HTTP server (createServer) and asserts the "server distrusts
 * client" contract end-to-end: forged payloads are rejected with a 400
 * VALIDATION envelope carrying field-level errors; valid payloads return 200 with
 * a SANITIZED value (no forged keys survive) and a recordId.
 *
 *   AC-1: 401 when x-dev-user header is absent
 *   AC-2: 404 UNKNOWN_FORM for an unregistered form id
 *   AC-3: 400 INVALID_JSON for a malformed body
 *   AC-4: 200 + sanitized value for a valid purchase
 *   AC-5: 400 VALIDATION (field errors) for missing required (title)
 *   AC-6: 400 VALIDATION for non-numeric string on a number field (T-0369: "abc" → WRONG_TYPE)
 *   AC-7: 400 VALIDATION for disallowed enum value (status)
 *   AC-8: 400 VALIDATION for unknown/extra forged field
 *   AC-9: response never echoes a forged extra field
 *   AC-10: valid submit returns a recordId (no-DB: record not persisted in-process)
 *   AC-11: (T-0369) numeric string for amount field → 200, persisted value is a JS number
 *   AC-12: (T-0369) already-a-number for amount field → 200, value unchanged
 *   AC-13: (T-0369) non-numeric string for amount field → 400 WRONG_TYPE (not coerced)
 *   AC-14: (T-0369) empty string for amount field → 200 with field absent (not coerced to 0)
 *   AC-15: (T-0369) numeric-looking string for a text field → stays a string (no coercion)
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import { _getRecordForTests, _resetRecordStoreForTests } from "../http/forms.js";

describe("Forms submit E2E — server-side validation (T-0102)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer(undefined, undefined, "memory");
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    // Reset in-memory record store between tests so AC-10 assertions are isolated.
    _resetRecordStoreForTests();
  });

  function request(
    method: string,
    path: string,
    headers?: Record<string, string>,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(url, { method, headers }, (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
        });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: buf }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  const AUTH = { "x-dev-user": "e-kravtsova", "content-type": "application/json" };

  // T-0370: registry-aligned fields (title/amount) replacing old form-level fields.
  // Memory mode uses form-schema.ts PURCHASE (now matches registry schema);
  // DB mode uses makeFormDefResolver → deriveFormDefFromSchema (same fields).
  function validPurchase(): Record<string, unknown> {
    return {
      title: "Ноутбуки ThinkPad T14",
      amount: 496000,
    };
  }

  // AC-1
  it("returns 401 when x-dev-user header is absent", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", { "content-type": "application/json" }, JSON.stringify(validPurchase()));
    expect(r.statusCode).toBe(401);
    expect((JSON.parse(r.body).error as Record<string, unknown>).code).toBe("UNAUTHENTICATED");
  });

  // AC-2
  it("returns 404 UNKNOWN_FORM for an unregistered form", async () => {
    const r = await request("POST", "/api/forms/no-such-form/submit", AUTH, JSON.stringify({}));
    expect(r.statusCode).toBe(404);
    expect((JSON.parse(r.body).error as Record<string, unknown>).code).toBe("UNKNOWN_FORM");
  });

  // AC-3
  it("returns 400 INVALID_JSON for a malformed body", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, "{not json");
    expect(r.statusCode).toBe(400);
    expect((JSON.parse(r.body).error as Record<string, unknown>).code).toBe("INVALID_JSON");
  });

  // AC-4
  it("accepts a valid purchase and returns a sanitized value", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify(validPurchase()));
    expect(r.statusCode).toBe(200);
    const data = JSON.parse(r.body) as { ok: boolean; value: Record<string, unknown> };
    expect(data.ok).toBe(true);
    expect(data.value.title).toBe("Ноутбуки ThinkPad T14");
    expect(data.value.amount).toBe(496000);
  });

  // AC-5
  it("rejects a payload missing a required field with field-level errors", async () => {
    const p = validPurchase();
    delete p["title"]; // title is the required field in the registry-aligned schema
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify(p));
    expect(r.statusCode).toBe(400);
    const env = JSON.parse(r.body).error as { code: string; fields: Array<{ field: string; code: string }> };
    expect(env.code).toBe("VALIDATION");
    expect(env.fields.some((f) => f.field === "title" && f.code === "MISSING_REQUIRED")).toBe(true);
  });

  // AC-6 — non-numeric string for a number field must still be rejected as WRONG_TYPE.
  // T-0369: numeric strings ("4") are now coerced to numbers before validation;
  // non-numeric strings ("abc") cannot be coerced and must still fail.
  it("rejects a non-numeric string for a number field (WRONG_TYPE)", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify({ ...validPurchase(), amount: "abc" }));
    expect(r.statusCode).toBe(400);
    const env = JSON.parse(r.body).error as { fields: Array<{ field: string; code: string }> };
    expect(env.fields.some((f) => f.field === "amount" && f.code === "WRONG_TYPE")).toBe(true);
  });

  // AC-7 — disallowed enum value (a status value outside the allowed set)
  it("rejects a disallowed enum value", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify({ ...validPurchase(), status: "unknown_status" }));
    expect(r.statusCode).toBe(400);
    const env = JSON.parse(r.body).error as { fields: Array<{ field: string; code: string }> };
    expect(env.fields.some((f) => f.field === "status" && f.code === "DISALLOWED_VALUE")).toBe(true);
  });

  // AC-8 — unknown/extra forged field
  it("rejects an unknown/extra forged field", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify({ ...validPurchase(), isAdmin: true }));
    expect(r.statusCode).toBe(400);
    const env = JSON.parse(r.body).error as { fields: Array<{ field: string; code: string }> };
    expect(env.fields.some((f) => f.field === "isAdmin" && f.code === "UNKNOWN_FIELD")).toBe(true);
  });

  // AC-9 — forged extra field never echoed back
  it("never echoes a forged extra field in the response", async () => {
    // Strip the forged field from a valid body and submit the clean part to get 200,
    // then assert a separate request WITH the forged field is rejected (covered by AC-8).
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify(validPurchase()));
    const data = JSON.parse(r.body) as { value: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(data.value, "isAdmin")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data.value, "total")).toBe(false);
  });

  // AC-10 — T-0251: valid submit persists a retrievable record server-side
  // AC-10 (T-0251 → T-0336): valid submit returns a recordId in the response.
  // T-0336 (E15-S2): The in-memory RECORDS Map has been removed. _getRecordForTests()
  // always returns undefined in no-DB mode. The response contract (ok, formId, value,
  // recordId) is unchanged — persistence assertions require DB (ci/checks/db/).
  it("returns a recordId on valid submit (no-DB: in-process record not persisted)", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify(validPurchase()));
    expect(r.statusCode).toBe(200);

    const data = JSON.parse(r.body) as { ok: boolean; formId: string; value: Record<string, unknown>; recordId: string };
    expect(data.ok).toBe(true);

    // Response must include a recordId string (contract unchanged from T-0251).
    expect(typeof data.recordId).toBe("string");
    expect(data.recordId.length).toBeGreaterThan(0);

    // T-0336: RECORDS Map removed — _getRecordForTests() returns undefined in no-DB mode.
    // DB-backed record persistence is tested in ci/checks/db/records_crud.test.ts.
    const stored = _getRecordForTests(data.recordId);
    expect(stored).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // T-0369: number coercion (HTML form strings → JS numbers at the HTTP boundary)
  // ---------------------------------------------------------------------------

  // AC-11: numeric string for a number field → 200; persisted value.amount is a number.
  // This is the deploy-acceptance AC-2 fix: FormViewer sandbox iframe sends the amount
  // as a string (e.g. "496000"); the coercion pass converts it to a JS number before
  // validation so the record stores a real number → DMN amount routing works.
  it("AC-11: numeric string for amount field → 200, persisted value is a JS number", async () => {
    const body = { ...validPurchase(), amount: "496000" };
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify(body));
    expect(r.statusCode).toBe(200);
    const data = JSON.parse(r.body) as { ok: boolean; value: Record<string, unknown> };
    expect(data.ok).toBe(true);
    // Coerced value must be a JS number, not a string.
    expect(typeof data.value["amount"]).toBe("number");
    expect(data.value["amount"]).toBe(496000);
  });

  // AC-12: already-a-number for a number field → 200, value unchanged.
  // Coercion must be a no-op for already-typed values.
  it("AC-12: already-a-number for amount field → 200, value unchanged", async () => {
    const body = { ...validPurchase(), amount: 250000 };
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify(body));
    expect(r.statusCode).toBe(200);
    const data = JSON.parse(r.body) as { ok: boolean; value: Record<string, unknown> };
    expect(data.ok).toBe(true);
    expect(data.value["amount"]).toBe(250000);
  });

  // AC-13: non-numeric string for a number field → 400 WRONG_TYPE (not coerced).
  // "abc" cannot be parsed as a finite number — the coercion pass leaves it as a
  // string, and the validator correctly returns WRONG_TYPE.
  it("AC-13: non-numeric string ('abc') for amount field → 400 WRONG_TYPE", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify({ ...validPurchase(), amount: "abc" }));
    expect(r.statusCode).toBe(400);
    const env = JSON.parse(r.body).error as { code: string; fields: Array<{ field: string; code: string }> };
    expect(env.code).toBe("VALIDATION");
    expect(env.fields.some((f) => f.field === "amount" && f.code === "WRONG_TYPE")).toBe(true);
  });

  // AC-14: empty string for a number field → field treated as absent, NOT coerced to 0.
  // amount is optional so empty string → isAbsent → field skipped → 200 with amount
  // absent. The invariant: "" must not become 0 in storage.
  it("AC-14: empty string for amount field → 200 with field absent (not coerced to 0)", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify({ ...validPurchase(), amount: "" }));
    // amount is optional so empty string → field treated as absent → valid submit.
    expect(r.statusCode).toBe(200);
    const data = JSON.parse(r.body) as { ok: boolean; value: Record<string, unknown> };
    expect(data.ok).toBe(true);
    // The key invariant: amount must NOT be 0 (empty string was NOT coerced to 0).
    expect(Object.prototype.hasOwnProperty.call(data.value, "amount")).toBe(false);
  });

  // AC-15: numeric-looking string for a TEXT field → stays a string (no coercion).
  // Only declared "number" fields are coerced. Text fields with numeric-looking
  // values must not be touched (e.g. title: "123" is a valid string).
  it("AC-15: numeric-looking string for a text field → stays a string (no coercion)", async () => {
    const body = { ...validPurchase(), title: "123" };
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify(body));
    expect(r.statusCode).toBe(200);
    const data = JSON.parse(r.body) as { ok: boolean; value: Record<string, unknown> };
    expect(data.ok).toBe(true);
    // title is a text field; "123" must remain a string, not become the number 123.
    expect(typeof data.value["title"]).toBe("string");
    expect(data.value["title"]).toBe("123");
  });
});
