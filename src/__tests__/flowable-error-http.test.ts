/**
 * T-0483: Unit tests for flowableErrorToHttp().
 *
 * The publish + start-instance routes proxy the Flowable engine. When the engine
 * is unreachable, the client must see a CLEAR, TYPED error (not an opaque 502).
 * This pure mapping is the single source of truth for that contract — covered here
 * exhaustively (one assertion per FlowableErrorCode).
 */
import { describe, it, expect } from "vitest";
import {
  flowableErrorToHttp,
  type FlowableErrorCode,
} from "../core/flowable-client.js";

describe("T-0483 flowableErrorToHttp", () => {
  it("ENGINE_UNAVAILABLE → 503 + typed code + honest Russian message", () => {
    const r = flowableErrorToHttp("ENGINE_UNAVAILABLE");
    expect(r.status).toBe(503);
    expect(r.code).toBe("ENGINE_UNAVAILABLE");
    expect(r.message).toContain("Движок процессов недоступен");
    // Honest: tells the user their work is preserved as a draft.
    expect(r.message).toContain("черновик");
  });

  it("TIMEOUT collapses to the same transient 503 ENGINE_UNAVAILABLE state", () => {
    const r = flowableErrorToHttp("TIMEOUT");
    expect(r.status).toBe(503);
    expect(r.code).toBe("ENGINE_UNAVAILABLE");
  });

  it("BAD_BPMN → 422 (client-correctable, not an engine outage)", () => {
    const r = flowableErrorToHttp("BAD_BPMN");
    expect(r.status).toBe(422);
    expect(r.code).toBe("BAD_BPMN");
  });

  it("CONFLICT → 409", () => {
    expect(flowableErrorToHttp("CONFLICT").status).toBe(409);
  });

  it("UNAUTHORIZED → 502 (server-side engine auth, not the user's fault)", () => {
    const r = flowableErrorToHttp("UNAUTHORIZED");
    expect(r.status).toBe(502);
    expect(r.code).toBe("UNAUTHORIZED");
  });

  it("NOT_FOUND → 502", () => {
    expect(flowableErrorToHttp("NOT_FOUND").status).toBe(502);
  });

  it("UNKNOWN and RECORD_IN_PAYLOAD → opaque-but-honest 502 UNKNOWN", () => {
    for (const code of ["UNKNOWN", "RECORD_IN_PAYLOAD"] as FlowableErrorCode[]) {
      const r = flowableErrorToHttp(code);
      expect(r.status).toBe(502);
      expect(r.code).toBe("UNKNOWN");
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it("every FlowableErrorCode maps to a valid HTTP status (no gaps)", () => {
    const codes: FlowableErrorCode[] = [
      "ENGINE_UNAVAILABLE",
      "NOT_FOUND",
      "CONFLICT",
      "UNAUTHORIZED",
      "BAD_BPMN",
      "RECORD_IN_PAYLOAD",
      "TIMEOUT",
      "UNKNOWN",
    ];
    for (const code of codes) {
      const r = flowableErrorToHttp(code);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(600);
      expect(typeof r.message).toBe("string");
    }
  });
});
