/**
 * src/http/static.ts
 *
 * Static file handler with SPA fallback for serving built web frontend.
 * Includes path-traversal guard and API route protection.
 * Zero external dependencies — only node stdlib (fs, path, url).
 */

import * as fs from "node:fs";
import {
  resolve,
  join,
  normalize,
  dirname,
  extname,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { HttpError, type RouteHandler } from "./router.js";

// ---------------------------------------------------------------------------
// MIME type map
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// ---------------------------------------------------------------------------
// Resolve default dist directory
// ---------------------------------------------------------------------------

/**
 * Returns the path to the built web SPA directory.
 * If CHOROS_WEB_DIST is set, use it; otherwise resolve relative to src/http/static.ts.
 * The path ../../web/dist is correct for both runtime (src/) and compiled (dist/http/).
 */
export function resolveDefaultDistDir(): string {
  if (process.env["CHOROS_WEB_DIST"]) {
    return process.env["CHOROS_WEB_DIST"];
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

// ---------------------------------------------------------------------------
// Static file handler
// ---------------------------------------------------------------------------

/**
 * Creates a RouteHandler that serves static files from distDir with SPA fallback.
 * - Routes starting with /api/ are rejected (404 JSON error, not SPA fallback).
 * - Files matching a real file in distDir are served with appropriate Content-Type.
 * - Paths outside distDir (traversal attempt) fall back to SPA.
 * - Everything else falls back to index.html (SPA routing).
 */
export function makeStaticHandler(distDir: string): RouteHandler {
  return (req, res) => {
    const rawUrl = req.url ?? "/";

    // Strip query string
    const questionIdx = rawUrl.indexOf("?");
    const pathname = questionIdx === -1 ? rawUrl : rawUrl.slice(0, questionIdx);

    // Decode URI component; on error → 400 envelope
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, "VALIDATION", "invalid URL encoding");
    }

    // API guard: reject unmatched /api/* routes with 404 (don't serve SPA/HTML)
    if (decodedPath.startsWith("/api/")) {
      throw new HttpError(404, "NOT_FOUND", "route not found");
    }

    // Map root to index.html
    const candidatePath = decodedPath === "/" ? "/index.html" : decodedPath;

    // Normalize to resolve . and .. in the path
    const candidate = normalize(join(distDir, candidatePath));

    // Path-traversal guard: ensure resolved path stays within distDir
    const root = resolve(distDir);
    const resolved = resolve(candidate);

    // Check if resolved is within root
    const isWithinRoot = resolved === root || resolved.startsWith(root + sep);

    if (!isWithinRoot) {
      // Traversal attempt — SPA fallback
      serveSpaFallback(res, root);
      return;
    }

    // Check if resolved path is an existing file
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      // Serve the file
      const buf = fs.readFileSync(resolved);
      const ext = extname(resolved).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.end(buf);
      return;
    }

    // File not found — SPA fallback
    serveSpaFallback(res, root);
  };
}

// ---------------------------------------------------------------------------
// SPA fallback helper
// ---------------------------------------------------------------------------

function serveSpaFallback(res: ServerResponse, distRoot: string): void {
  const indexPath = join(distRoot, "index.html");

  if (!fs.existsSync(indexPath)) {
    throw new HttpError(404, "NOT_FOUND", "not found");
  }

  const buf = fs.readFileSync(indexPath);
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES[".html"]);
  res.end(buf);
}
