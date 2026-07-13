import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  Router,
  HttpError,
  mapDomainError,
  readJsonBody,
  type RouteHandler,
} from "../http/router.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeReq(
  method: string,
  url: string,
  body?: string
): http.IncomingMessage {
  let req: http.IncomingMessage;
  if (body !== undefined) {
    const readable = Readable.from([Buffer.from(body, "utf8")]);
    req = readable as unknown as http.IncomingMessage;
  } else {
    req = new EventEmitter() as unknown as http.IncomingMessage;
    // Simulate an end-of-stream immediately for empty-body requests
    setImmediate(() => (req as EventEmitter).emit("end"));
  }
  req.method = method;
  req.url = url;
  return req;
}

interface ResponseCapture {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function makeRes(): { res: http.ServerResponse; capture: ResponseCapture } {
  const capture: ResponseCapture = {
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
  };
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
    capture.ended = true;
    if (typeof chunk === "string") capture.body = chunk;
    else if (Buffer.isBuffer(chunk)) capture.body = chunk.toString();
    return res;
  };
  return { res, capture };
}

// ---------------------------------------------------------------------------
// Router: basic matching
// ---------------------------------------------------------------------------

describe("Router", () => {
  it("AC-3: extracts :param segment correctly", () => {
    const router = new Router();
    let capturedParams: Record<string, string> = {};
    const handler: RouteHandler = (_req, res, params) => {
      capturedParams = params;
      res.statusCode = 200;
      res.end("ok");
    };
    router.register("GET", "/items/:id/info", handler);

    const req = makeReq("GET", "/items/abc-123/info");
    const { res } = makeRes();
    router.dispatch(req, res);

    expect(capturedParams).toEqual({ id: "abc-123" });
  });

  it("AC-4a: wrong method (POST) does not match GET route", () => {
    const router = new Router();
    router.register("GET", "/items/:id/info", (_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });

    const req = makeReq("POST", "/items/abc-123/info");
    const { res, capture } = makeRes();
    router.dispatch(req, res);

    expect(capture.statusCode).toBe(404);
  });

  it("AC-4b: wrong trailing segment does not match", () => {
    const router = new Router();
    router.register("GET", "/items/:id/info", (_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });

    const req = makeReq("GET", "/items/abc-123/other");
    const { res, capture } = makeRes();
    router.dispatch(req, res);

    expect(capture.statusCode).toBe(404);
  });

  it("AC-2: no route match returns 404 JSON envelope", () => {
    const router = new Router();
    const req = makeReq("GET", "/no-such-path");
    const { res, capture } = makeRes();
    router.dispatch(req, res);

    expect(capture.statusCode).toBe(404);
    const parsed = JSON.parse(capture.body) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("NOT_FOUND");
    expect(typeof parsed.error.message).toBe("string");
    expect(parsed.error.message.length).toBeGreaterThan(0);
  });

  it("first-match-wins: first registered route handles ambiguous URL", () => {
    const router = new Router();
    let first = false;
    let second = false;
    router.register("GET", "/test/path", (_req, res) => {
      first = true;
      res.statusCode = 200;
      res.end("first");
    });
    router.register("GET", "/test/path", (_req, res) => {
      second = true;
      res.statusCode = 200;
      res.end("second");
    });

    const req = makeReq("GET", "/test/path");
    const { res } = makeRes();
    router.dispatch(req, res);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HttpError
// ---------------------------------------------------------------------------

describe("HttpError", () => {
  it("AC-8: handler throwing HttpError yields correct status + envelope", async () => {
    const router = new Router();
    router.register("GET", "/fail", async () => {
      throw new HttpError(409, "LOCK_EXPIRED", "lock has expired");
    });

    const req = makeReq("GET", "/fail");
    const { res, capture } = makeRes();
    router.dispatch(req, res);

    // Wait for async error handling
    await new Promise((r) => setTimeout(r, 10));

    expect(capture.statusCode).toBe(409);
    const parsed = JSON.parse(capture.body) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("LOCK_EXPIRED");
    expect(parsed.error.message).toBe("lock has expired");
  });

  it("AC-10: async handler rejection (non-HttpError) → 500 no stacktrace", async () => {
    const router = new Router();
    router.register("GET", "/async-fail", async () => {
      throw new Error("something went wrong\n  at fn (file.ts:10:5)");
    });

    const req = makeReq("GET", "/async-fail");
    const { res, capture } = makeRes();
    router.dispatch(req, res);

    await new Promise((r) => setTimeout(r, 10));

    expect(capture.statusCode).toBe(500);
    const parsed = JSON.parse(capture.body) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("INTERNAL");
    // No stack trace in body
    expect(parsed.error.message).not.toContain("at fn");
    expect(parsed.error.message).not.toContain("file.ts");
  });
});

// ---------------------------------------------------------------------------
// T-0763: non-HttpError → server-side log, client response stays generic
// ---------------------------------------------------------------------------
//
// Follow-up to T-0249 CE-1's live-wire finding: before this task a non-HttpError
// thrown by a handler was discarded silently — the ONLY trace was the generic
// {code:"INTERNAL"} envelope, which is indistinguishable for a genuine bug
// (e.g. 22P02 invalid-uuid) vs. anything else. These tests pin BOTH halves of
// the fix: (a) the server-side console.error now carries the error's message
// AND stack (diagnosable), and (b) the HTTP response the client receives is
// UNCHANGED — still the generic INTERNAL envelope, never the error message or
// stack (no internals leak over the wire).
describe("T-0763: non-HttpError server-side logging", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("async handler non-HttpError: console.error carries message+stack; HTTP body stays generic", async () => {
    const router = new Router();
    router.register("GET", "/boom", async () => {
      throw new Error("db write failed: invalid input syntax for type uuid");
    });

    const req = makeReq("GET", "/boom");
    const { res, capture } = makeRes();
    router.dispatch(req, res);
    await new Promise((r) => setTimeout(r, 10));

    // (a) server-side diagnostic was logged
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0]?.join(" ") ?? "";
    expect(logged).toContain("db write failed: invalid input syntax for type uuid");
    expect(logged).toContain("GET");
    expect(logged).toContain("/boom");

    // (b) HTTP response is still the generic envelope — no leak
    expect(capture.statusCode).toBe(500);
    const parsed = JSON.parse(capture.body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("INTERNAL");
    expect(parsed.error.message).toBe("internal server error");
    expect(capture.body).not.toContain("invalid input syntax for type uuid");
  });

  it("sync handler throw (non-HttpError, caught via Promise.reject wrap): logged, response generic", async () => {
    const router = new Router();
    router.register("GET", "/boom-sync", () => {
      throw new TypeError("cannot read property 'x' of undefined");
    });

    const req = makeReq("GET", "/boom-sync");
    const { res, capture } = makeRes();
    router.dispatch(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0]?.join(" ") ?? "";
    expect(logged).toContain("cannot read property 'x' of undefined");

    expect(capture.statusCode).toBe(500);
    expect(capture.body).not.toContain("cannot read property");
  });

  it("HttpError path: console.error is NOT called (no log-spam on expected errors)", async () => {
    const router = new Router();
    router.register("GET", "/expected-fail", async () => {
      throw new HttpError(409, "CONFLICT", "already locked");
    });

    const req = makeReq("GET", "/expected-fail");
    const { res, capture } = makeRes();
    router.dispatch(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(errSpy).not.toHaveBeenCalled();
    expect(capture.statusCode).toBe(409);
  });

  it("fallback sync throw (non-HttpError): logged, response generic INTERNAL", () => {
    const router = new Router();
    router.setFallback(() => {
      throw new Error("fallback exploded: secret-looking-but-not token=abc123");
    });

    const req = makeReq("GET", "/no-such-route");
    const { res, capture } = makeRes();
    router.dispatch(req, res);

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0]?.join(" ") ?? "";
    expect(logged).toContain("fallback exploded");

    expect(capture.statusCode).toBe(500);
    const parsed = JSON.parse(capture.body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("INTERNAL");
    expect(capture.body).not.toContain("fallback exploded");
    expect(capture.body).not.toContain("token=abc123");
  });

  it("fallback async rejection (non-HttpError): logged, response generic INTERNAL", async () => {
    const router = new Router();
    router.setFallback(async () => {
      throw new Error("async fallback failure");
    });

    const req = makeReq("GET", "/no-such-route-async");
    const { res, capture } = makeRes();
    router.dispatch(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0]?.join(" ") ?? "";
    expect(logged).toContain("async fallback failure");

    expect(capture.statusCode).toBe(500);
    expect(capture.body).not.toContain("async fallback failure");
  });

  it("fallback HttpError path: console.error is NOT called", () => {
    const router = new Router();
    router.setFallback(() => {
      throw new HttpError(400, "VALIDATION", "bad request");
    });

    const req = makeReq("GET", "/no-such-route-httperror");
    const { res, capture } = makeRes();
    router.dispatch(req, res);

    expect(errSpy).not.toHaveBeenCalled();
    expect(capture.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// mapDomainError
// ---------------------------------------------------------------------------

describe("mapDomainError", () => {
  it("AC-9: NOT_FOUND → 404", () => {
    const err = mapDomainError("NOT_FOUND");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("AC-9: NOT_OWNER → 403", () => {
    expect(mapDomainError("NOT_OWNER").statusCode).toBe(403);
  });

  it("AC-9: LOCK_EXPIRED → 409", () => {
    expect(mapDomainError("LOCK_EXPIRED").statusCode).toBe(409);
  });

  it("AC-9: VALIDATION → 400", () => {
    expect(mapDomainError("VALIDATION").statusCode).toBe(400);
  });

  it("AC-9: CONFLICT → 409", () => {
    expect(mapDomainError("CONFLICT").statusCode).toBe(409);
  });

  it("AC-9: INTERNAL → 500", () => {
    expect(mapDomainError("INTERNAL").statusCode).toBe(500);
  });

  it("AC-9: unknown code → 500", () => {
    const err = mapDomainError("TOTALLY_UNKNOWN_CODE");
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("TOTALLY_UNKNOWN_CODE");
    expect(err instanceof HttpError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readJsonBody
// ---------------------------------------------------------------------------

describe("readJsonBody", () => {
  it("AC-5: valid JSON body resolves to parsed object", async () => {
    const req = makeReq("POST", "/test", '{"key":"value"}');
    const result = await readJsonBody(req);
    expect(result).toEqual({ key: "value" });
  });

  it("AC-6: invalid JSON rejects with INVALID_JSON", async () => {
    const req = makeReq("POST", "/test", "not-json");
    await expect(readJsonBody(req)).rejects.toMatchObject({
      code: "INVALID_JSON",
      statusCode: 400,
    });
  });

  it("AC-6: empty body rejects with INVALID_JSON", async () => {
    const req = makeReq("POST", "/test", "");
    await expect(readJsonBody(req)).rejects.toMatchObject({
      code: "INVALID_JSON",
      statusCode: 400,
    });
  });

  it("AC-7: body exceeding maxBytes rejects with PAYLOAD_TOO_LARGE", async () => {
    const largeBody = "x".repeat(101);
    const req = makeReq("POST", "/test", largeBody);
    await expect(readJsonBody(req, 100)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      statusCode: 413,
    });
  });

  it("AC-7: body at exactly maxBytes succeeds if valid JSON", async () => {
    const body = '"hello"'; // 7 bytes, valid JSON string
    const req = makeReq("POST", "/test", body);
    const result = await readJsonBody(req, body.length);
    expect(result).toBe("hello");
  });
});
