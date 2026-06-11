import { describe, it, expect, afterAll } from "vitest";
import * as http from "node:http";
import { EventEmitter } from "node:events";
import os from "node:os";
import fs from "node:fs";
import { join } from "node:path";

/**
 * Pin static dist to an empty temp directory to make 404 assertions deterministic.
 * This ensures AC-2 (GET /unknown) and AC-3 (POST /health) always 404 regardless
 * of whether web/dist exists in the worktree. Must set env var BEFORE importing
 * server.js, since the static handler reads env at router-construction time
 * (module load of server.js builds _defaultRouter at line 64).
 */
const EMPTY_DIST = fs.mkdtempSync(join(os.tmpdir(), "choros-empty-dist-"));
process.env["CHOROS_WEB_DIST"] = EMPTY_DIST;

// Now import handleRequest after env is set
// T-0186: StoreMode imported so tests can pin in-memory store regardless of
// ambient DATABASE_URL (D-056 — tests must not depend on env absence).
import { handleRequest, type StoreMode } from "../server.js";

// Pin all handleRequest calls in this suite to in-memory mode. This prevents the
// async race (health handler awaiting PostgresJobStore.getQueueHealth) that causes
// capture.body to be empty when DATABASE_URL is set in the environment.
const TEST_STORE_MODE: StoreMode = "memory";

/**
 * Minimal stub for http.IncomingMessage — only the fields handleRequest reads.
 */
function makeReq(
  method: string,
  url: string
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = url;
  return req;
}

/**
 * Minimal stub for http.ServerResponse — captures statusCode, headers, and body.
 */
interface ResponseCapture {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function makeRes(): { res: http.ServerResponse; capture: ResponseCapture } {
  const capture: ResponseCapture = { statusCode: 200, headers: {}, body: "" };
  const res = new EventEmitter() as unknown as http.ServerResponse;
  Object.defineProperty(res, "statusCode", {
    get: () => capture.statusCode,
    set: (v: number) => {
      capture.statusCode = v;
    },
  });
  res.setHeader = (name: string, value: string) => {
    capture.headers[name.toLowerCase()] = value;
    return res;
  };
  res.end = (chunk?: unknown) => {
    if (typeof chunk === "string") capture.body = chunk;
    else if (Buffer.isBuffer(chunk)) capture.body = chunk.toString();
    return res;
  };
  return { res, capture };
}

describe("handleRequest", () => {
  it("AC-1: GET /health → 200 with body { status: 'ok' }", () => {
    const req = makeReq("GET", "/health");
    const { res, capture } = makeRes();
    // T-0186: pin to memory so handler is synchronous regardless of ambient DATABASE_URL.
    handleRequest(req, res, TEST_STORE_MODE);
    expect(capture.statusCode).toBe(200);
    const parsed = JSON.parse(capture.body) as { status: string; timer?: { timerLagMs: unknown } };
    expect(parsed.status).toBe("ok");
    // FF-T7: response schema contains timer.timerLagMs (T-0116 backward-compatible extension)
    expect(parsed).toHaveProperty("timer");
    expect(parsed.timer).toHaveProperty("timerLagMs");
    // In memory mode timerLagMs is null (no timer store).
    expect(parsed.timer!.timerLagMs).toBeNull();
  });

  it("AC-2: GET /unknown → 404", () => {
    const req = makeReq("GET", "/unknown");
    const { res, capture } = makeRes();
    // T-0186: pin to memory (consistent with AC-1/AC-3/AC-4).
    handleRequest(req, res, TEST_STORE_MODE);
    expect(capture.statusCode).toBe(404);
  });

  it("AC-3: POST /health → 404", () => {
    const req = makeReq("POST", "/health");
    const { res, capture } = makeRes();
    // T-0186: pin to memory (consistent with AC-1/AC-2/AC-4).
    handleRequest(req, res, TEST_STORE_MODE);
    expect(capture.statusCode).toBe(404);
  });

  it("AC-4: GET /health → Content-Type contains application/json", () => {
    const req = makeReq("GET", "/health");
    const { res, capture } = makeRes();
    // T-0186: pin to memory so handler is synchronous regardless of ambient DATABASE_URL.
    handleRequest(req, res, TEST_STORE_MODE);
    expect(capture.headers["content-type"]).toContain("application/json");
  });

  afterAll(() => {
    fs.rmSync(EMPTY_DIST, { recursive: true, force: true });
  });
});
