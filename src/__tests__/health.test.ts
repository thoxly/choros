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
import { handleRequest } from "../server.js";

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
    handleRequest(req, res);
    expect(capture.statusCode).toBe(200);
    const parsed = JSON.parse(capture.body) as { status: string };
    expect(parsed.status).toBe("ok");
  });

  it("AC-2: GET /unknown → 404", () => {
    const req = makeReq("GET", "/unknown");
    const { res, capture } = makeRes();
    handleRequest(req, res);
    expect(capture.statusCode).toBe(404);
  });

  it("AC-3: POST /health → 404", () => {
    const req = makeReq("POST", "/health");
    const { res, capture } = makeRes();
    handleRequest(req, res);
    expect(capture.statusCode).toBe(404);
  });

  it("AC-4: GET /health → Content-Type contains application/json", () => {
    const req = makeReq("GET", "/health");
    const { res, capture } = makeRes();
    handleRequest(req, res);
    expect(capture.headers["content-type"]).toContain("application/json");
  });

  afterAll(() => {
    fs.rmSync(EMPTY_DIST, { recursive: true, force: true });
  });
});
