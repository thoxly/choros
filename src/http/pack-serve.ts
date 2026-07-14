/**
 * src/http/pack-serve.ts — T-0141
 *
 * Thin module to load and cache the showcase pack file for display-plane serve.
 * Deliberately zero pg / src/db/* imports — display plane is read-only file serve
 * (I-1 exception per T-0140 ADR §2.4 / FF-DISPLAY-4).
 *
 * MUST NOT import pg or any module from src/db/* (FF-DISPLAY-4 enforces this).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pack types (subset used by display plane)
// ---------------------------------------------------------------------------

export type PackRightsCard = {
  role_slug: string;
  name: string;
  dept: string;
  scope: string;
  holders: Array<{ type: "human" | "agent" | "service"; name: string }>;
  grants: Array<{ res: string; uri: string; ops: string[]; scope: string }>;
  fields: Array<{ name: string; a: "read" | "write" | "hidden" }>;
};

export type PackProcessInstance = {
  id: string;
  name: string;
  procId: string;
  status: "running" | "waiting" | "done" | "failed";
  node: string;
  started: string;
  elapsed: string;
  progress: { done: number; total: number };
  execs: Array<"human" | "agent" | "service">;
};

export type ShowcasePack = {
  meta: { name: string; version: string; description: string };
  tenant: { slug: string; display_name: string };
  rights_cards: PackRightsCard[];
  process_instances: PackProcessInstance[];
  // Other sections exist but are not needed at display-plane serve time
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Pack loader — lazy singleton (loaded once per process start)
// CHOROS_PACK_DIR env override allows CI to point at a mock pack directory
// (follows the same pattern as CHOROS_WEB_DIST in src/http/static.ts).
// Legacy PACK_DIR is accepted as a fallback so existing test environments
// continue to work without change.
// When neither is set, resolves relative to the module's own location
// (dist/http/ → ../../seed/) so the server works from any CWD.
// ---------------------------------------------------------------------------

let _cachedPack: ShowcasePack | null = null;

export function resolvePackDir(): string {
  // Priority: CHOROS_PACK_DIR (canonical) > PACK_DIR (legacy compat) > module-relative default
  const envDir = process.env["CHOROS_PACK_DIR"] ?? process.env["PACK_DIR"];
  if (envDir) {
    return envDir;
  }
  // Resolve from module location: dist/http/pack-serve.js → ../../seed
  // Use import.meta.url for ESM (Node16 / Node ESM).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "..", "seed");
  } catch {
    // Fallback to cwd-relative (legacy / test environments)
    return "seed";
  }
}

/**
 * tryLoadShowcasePack — returns null if the pack file is absent or unreadable.
 * Use this in callers that must NOT 500 when the file is missing (e.g. in the
 * deployed container where the seed directory is not shipped).
 */
export function tryLoadShowcasePack(): ShowcasePack | null {
  if (_cachedPack !== null) {
    return _cachedPack;
  }
  const packDir = resolvePackDir();
  const packPath = join(packDir, "showcase", "pack.json");
  try {
    const raw = readFileSync(packPath, "utf-8");
    _cachedPack = JSON.parse(raw) as ShowcasePack;
    return _cachedPack;
  } catch {
    // File absent (container deployment without seed dir, or CHOROS_PACK_DIR
    // pointing at a missing location). Return null so callers can degrade
    // gracefully instead of propagating a 500 (T-0259).
    return null;
  }
}

export function loadShowcasePack(): ShowcasePack {
  if (_cachedPack !== null) {
    return _cachedPack;
  }
  const packDir = resolvePackDir();
  const packPath = join(packDir, "showcase", "pack.json");
  const raw = readFileSync(packPath, "utf-8");
  _cachedPack = JSON.parse(raw) as ShowcasePack;
  return _cachedPack;
}

/**
 * clearPackCache — test helper to reset the lazy cache between tests.
 * Not exported in production flow; only used by test files.
 */
export function clearPackCache(): void {
  _cachedPack = null;
}
