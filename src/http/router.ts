/**
 * src/http/router.ts
 *
 * Zero-external-dep HTTP routing layer for Choros.
 * Only depends on node:http (stdlib).
 */
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// RouteHandler type
// ---------------------------------------------------------------------------

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// HttpError
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// mapDomainError
// ---------------------------------------------------------------------------

const DOMAIN_ERROR_MAP: Record<string, number> = {
  NOT_FOUND: 404,
  NOT_OWNER: 403,
  LOCK_EXPIRED: 409,
  NOT_LOCKED: 409,
  CONFLICT: 409,
  VALIDATION: 400,
  INVALID_JSON: 400,
  INTERNAL: 500,
};

export function mapDomainError(code: string): HttpError {
  const statusCode = DOMAIN_ERROR_MAP[code] ?? 500;
  return new HttpError(statusCode, code, code.toLowerCase().replace(/_/g, " "));
}

// ---------------------------------------------------------------------------
// readRawBody — mirrors readJsonBody but returns the raw Buffer (no JSON.parse)
// ---------------------------------------------------------------------------

/** Default max for file uploads: 25 MiB. */
export const DEFAULT_RAW_MAX_BYTES = 26_214_400; // 25 MiB

/**
 * Read raw (non-JSON) request body bytes into a Buffer.
 * Rejects with 413 if the body exceeds maxBytes (default 25 MiB).
 * Callers receive the raw Buffer — content-type interpretation is their concern.
 */
export function readRawBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_RAW_MAX_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let done = false;

    const finish = (err: HttpError): void => {
      if (done) return;
      done = true;
      req.resume();
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        finish(new HttpError(413, "PAYLOAD_TOO_LARGE", "request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", () => {
      finish(new HttpError(400, "READ_ERROR", "request read error"));
    });

    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

// ---------------------------------------------------------------------------
// readJsonBody
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB

export function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BYTES
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let done = false;

    const finish = (err: HttpError): void => {
      if (done) return;
      done = true;
      // Drain/destroy the stream so the connection is not left hanging
      req.resume();
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        finish(new HttpError(413, "PAYLOAD_TOO_LARGE", "request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", () => {
      finish(new HttpError(400, "INVALID_JSON", "request read error"));
    });

    req.on("end", () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        reject(new HttpError(400, "INVALID_JSON", "request body is empty"));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "request body is not valid JSON"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Internal route entry
// ---------------------------------------------------------------------------

interface RouteEntry {
  method: string;
  segments: string[];
  paramIndex: number | null;
  paramName: string | null;
  // T-0072 additive: multi-param support (paramIndices/paramNames supersede
  // paramIndex/paramName when present; existing single-param routes are unaffected).
  paramIndices?: number[];
  paramNames?: string[];
  handler: RouteHandler;
}

// ---------------------------------------------------------------------------
// Error envelope helper
// ---------------------------------------------------------------------------

// T-0573: exported so call-sites outside the router (e.g. assistant.ts's
// LLM-unavailable 503) can emit the SAME canonical {error:{code,message}}
// envelope instead of hand-rolling their own shape (ADR-T0573 §2.2 B3).
export function sendErrorEnvelope(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string
): void {
  const body = JSON.stringify({ error: { code, message } });
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(body);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class Router {
  private readonly routes: RouteEntry[] = [];
  private fallback: RouteHandler | null = null;

  register(method: string, pattern: string, handler: RouteHandler): void {
    const upperMethod = method.toUpperCase();
    const segments = pattern.split("/");
    let paramIndex: number | null = null;
    let paramName: string | null = null;

    // T-0072 additive: collect ALL :param positions (multi-param support).
    const paramIndices: number[] = [];
    const paramNames: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg !== undefined && seg.startsWith(":")) {
        paramIndices.push(i);
        paramNames.push(seg.slice(1));
        // Preserve legacy single-param behaviour: first param sets paramIndex/paramName.
        if (paramIndex === null) {
          paramIndex = i;
          paramName = seg.slice(1);
        }
      }
    }

    this.routes.push({
      method: upperMethod,
      segments,
      paramIndex,
      paramName,
      // Multi-param: only stored when there is more than one param segment.
      ...(paramIndices.length > 1 ? { paramIndices, paramNames } : {}),
      handler,
    });
  }

  setFallback(handler: RouteHandler): void {
    this.fallback = handler;
  }

  dispatch(req: IncomingMessage, res: ServerResponse): void {
    const method = (req.method ?? "GET").toUpperCase();
    // Strip query string for routing
    const rawUrl = req.url ?? "/";
    const questionIdx = rawUrl.indexOf("?");
    const pathname = questionIdx === -1 ? rawUrl : rawUrl.slice(0, questionIdx);
    const urlSegments = pathname.split("/");

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== urlSegments.length) continue;

      let matched = true;
      const params: Record<string, string> = {};

      // T-0072 additive: use paramIndices/paramNames (multi-param) when present;
      // fall back to legacy paramIndex/paramName for single-param routes.
      const paramIdxSet: Set<number> = route.paramIndices
        ? new Set(route.paramIndices)
        : route.paramIndex !== null
          ? new Set([route.paramIndex])
          : new Set();
      const paramNameMap: Map<number, string> = new Map();
      if (route.paramIndices && route.paramNames) {
        for (let pi = 0; pi < route.paramIndices.length; pi++) {
          paramNameMap.set(route.paramIndices[pi] as number, route.paramNames[pi] as string);
        }
      } else if (route.paramIndex !== null && route.paramName !== null) {
        paramNameMap.set(route.paramIndex, route.paramName);
      }

      for (let i = 0; i < route.segments.length; i++) {
        const routeSeg = route.segments[i] as string;
        const urlSeg = urlSegments[i] as string;

        if (paramIdxSet.has(i)) {
          // Named param segment — match any non-empty string
          if (urlSeg.length === 0) {
            matched = false;
            break;
          }
          const pName = paramNameMap.get(i);
          if (pName !== undefined) {
            params[pName] = urlSeg;
          }
        } else {
          if (routeSeg !== urlSeg) {
            matched = false;
            break;
          }
        }
      }

      if (matched) {
        const result = (() => {
          try {
            return route.handler(req, res, params);
          } catch (err) {
            return Promise.reject(err);
          }
        })();

        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            if (err instanceof HttpError) {
              sendErrorEnvelope(res, err.statusCode, err.code, err.message);
            } else {
              sendErrorEnvelope(res, 500, "INTERNAL", "internal server error");
            }
          });
        }
        return;
      }
    }

    // No route matched — try fallback if set
    if (this.fallback) {
      let result: void | Promise<void>;
      try {
        result = this.fallback(req, res, {});
      } catch (err) {
        // Handle sync errors immediately
        if (err instanceof HttpError) {
          sendErrorEnvelope(res, err.statusCode, err.code, err.message);
        } else {
          sendErrorEnvelope(res, 500, "INTERNAL", "internal server error");
        }
        return;
      }

      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          if (err instanceof HttpError) {
            sendErrorEnvelope(res, err.statusCode, err.code, err.message);
          } else {
            sendErrorEnvelope(res, 500, "INTERNAL", "internal server error");
          }
        });
      }
      return;
    }

    // No route matched and no fallback → 404
    sendErrorEnvelope(res, 404, "NOT_FOUND", "route not found");
  }
}
