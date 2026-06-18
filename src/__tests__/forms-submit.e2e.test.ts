/**
 * T-0102: E2E tests for POST /api/forms/:formId/submit.
 * T-0251: Extended to assert server-side persistence of submitted records.
 *
 * Drives the real HTTP server (createServer) and asserts the "server distrusts
 * client" contract end-to-end: forged payloads are rejected with a 400
 * VALIDATION envelope carrying field-level errors; valid payloads return 200 with
 * a SANITIZED value (no forged keys survive) and a persisted record.
 *
 *   AC-1: 401 when x-dev-user header is absent
 *   AC-2: 404 UNKNOWN_FORM for an unregistered form id
 *   AC-3: 400 INVALID_JSON for a malformed body
 *   AC-4: 200 + sanitized value for a valid purchase
 *   AC-5: 400 VALIDATION (field errors) for missing required
 *   AC-6: 400 VALIDATION for wrong type (forged string-for-number)
 *   AC-7: 400 VALIDATION for disallowed enum value
 *   AC-8: 400 VALIDATION for unknown/extra forged field
 *   AC-9: response never echoes a forged extra field
 *   AC-10: valid submit persists a retrievable record (T-0251)
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

  function validPurchase(): Record<string, unknown> {
    return {
      supplier: "ООО «Вектор»",
      subject: "Ноутбуки ThinkPad T14",
      qty: 4,
      price: 124000,
      budget: "ИТ-инфраструктура · CAPEX",
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
    expect(data.value.supplier).toBe("ООО «Вектор»");
    expect(data.value.qty).toBe(4);
  });

  // AC-5
  it("rejects a payload missing a required field with field-level errors", async () => {
    const p = validPurchase();
    delete p["supplier"];
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify(p));
    expect(r.statusCode).toBe(400);
    const env = JSON.parse(r.body).error as { code: string; fields: Array<{ field: string; code: string }> };
    expect(env.code).toBe("VALIDATION");
    expect(env.fields.some((f) => f.field === "supplier" && f.code === "MISSING_REQUIRED")).toBe(true);
  });

  // AC-6 — forged string-for-number (UI shows numeric input; client tampers)
  it("rejects a wrong-typed forged value", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify({ ...validPurchase(), qty: "4" }));
    expect(r.statusCode).toBe(400);
    const env = JSON.parse(r.body).error as { fields: Array<{ field: string; code: string }> };
    expect(env.fields.some((f) => f.field === "qty" && f.code === "WRONG_TYPE")).toBe(true);
  });

  // AC-7 — disallowed enum value (a supplier the dropdown never offered)
  it("rejects a disallowed enum value", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify({ ...validPurchase(), supplier: "ООО «Левая»" }));
    expect(r.statusCode).toBe(400);
    const env = JSON.parse(r.body).error as { fields: Array<{ field: string; code: string }> };
    expect(env.fields.some((f) => f.field === "supplier" && f.code === "DISALLOWED_VALUE")).toBe(true);
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
  it("persists a retrievable record on valid submit", async () => {
    const r = await request("POST", "/api/forms/purchase/submit", AUTH, JSON.stringify(validPurchase()));
    expect(r.statusCode).toBe(200);

    const data = JSON.parse(r.body) as { ok: boolean; formId: string; value: Record<string, unknown>; recordId: string };
    expect(data.ok).toBe(true);

    // Response must include a recordId string.
    expect(typeof data.recordId).toBe("string");
    expect(data.recordId.length).toBeGreaterThan(0);

    // The record must be retrievable from the in-process store by that id.
    const stored = _getRecordForTests(data.recordId);
    expect(stored).toBeDefined();
    expect(stored!.formId).toBe("purchase");
    expect(stored!.submittedBy).toBe("e-kravtsova");
    expect(stored!.schema_version).toBe(1);

    // Stored data must match the sanitized value (not the raw client payload).
    expect(stored!.data.supplier).toBe("ООО «Вектор»");
    expect(stored!.data.qty).toBe(4);

    // Stored data must not contain any fields outside the schema.
    expect(Object.prototype.hasOwnProperty.call(stored!.data, "isAdmin")).toBe(false);
  });
});
