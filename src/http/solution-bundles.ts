/**
 * src/http/solution-bundles.ts — T-0465 (D8-G4): BUNDLE-PROMOTE.
 *
 * The text-first solution builder (bot) generates a whole solution in one
 * confirmed turn — an application (+ its section), cascaded related applications,
 * and a process — all DRAFT, tagged with a shared bundle_id (migration 103).
 *
 * This endpoint promotes the WHOLE bundle as ONE unit:
 *   POST /api/solution-bundles/:bundleId/promote
 *
 * Co-equal with promoting each item one-by-one in the sections:
 *   - application + registry_def (config tier) → promoteTier (artifacts.ts) — the
 *     SAME draft→published flip the per-artifact promote endpoint uses. FF-10:
 *     tier='published' is assigned ONLY in env-tier.ts / artifacts.ts, so this file
 *     NEVER writes tier='published' itself — it calls promoteTier per item.
 *   - process_definition (publish status) → publishProcessByKey (process-defs.ts) —
 *     the SAME lint → deploy → persist flow the per-process publish route uses.
 *
 * HUMAN-GATED: actorType comes from the AUTHENTICATED identity (getAuthContext in
 * keycloak mode, employee.type in dev mode) — NEVER from the body. An agent actor
 * → 403 (promoteTier enforces FORBIDDEN_AGENT_SELF_PROMOTE on each config item).
 *
 * ATOMICITY NOTE: promoteTier and publishProcessByKey each run their own tx. A
 * bundle promote is therefore best-effort-sequential: items that succeed are
 * published; a failure on one item is reported per-item (the response lists each
 * item's outcome) without rolling back already-published siblings. This mirrors
 * the reality that the visual constructor publishes items independently too —
 * the bundle just drives them together from one click.
 */

import type { IncomingMessage } from "node:http";
import pg from "pg";
import { HttpError, type Router } from "./router.js";
import { DEV_USER_HEADER, getAuthContext, withAuth } from "./auth.js";
import { resolveActorSlugFromAuth } from "../db/org.js";
import { promoteTier } from "./artifacts.js";
import { publishProcessByKey } from "./process-defs.js";
import type { FlowableClient } from "../core/flowable-client.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SolutionBundleDeps {
  readonly pool: pg.Pool;
  readonly flowable: FlowableClient;
  readonly resolveActorTenant: (actorSlug: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// withTenantTx — same RLS pattern as process-defs / artifacts.
// ---------------------------------------------------------------------------

async function withTenantTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Actor resolution: slug + actorType (human/agent) + tenant — from AUTHENTICATED
// identity ONLY (never the body). actorType gates promote (agents → 403).
// ---------------------------------------------------------------------------

async function extractActor(req: IncomingMessage, pool: pg.Pool): Promise<string> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    const slug = await resolveActorSlugFromAuth(pool, ctx.sub, ctx.preferredUsername);
    if (slug === null) {
      throw new HttpError(401, "UNAUTHENTICATED", "no employee matches authenticated identity");
    }
    return slug;
  }
  let devUser = req.headers[DEV_USER_HEADER];
  if (Array.isArray(devUser)) devUser = devUser[0];
  if (!devUser || typeof devUser !== "string") {
    throw new HttpError(401, "UNAUTHENTICATED", "missing x-dev-user header");
  }
  return devUser;
}

/**
 * Derive actorType. Keycloak: from the validated claim. Dev: look up the
 * employee row's type in the actor's tenant (RLS-scoped). Defaults to 'human'
 * when no row is found (same conservative default as artifacts.ts).
 */
async function resolveActorType(
  req: IncomingMessage,
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
): Promise<"human" | "agent"> {
  const ctx = getAuthContext(req);
  if (ctx !== undefined) {
    return ctx.actorType;
  }
  const res = await withTenantTx(pool, tenantId, async (client) => {
    return client.query<{ type: string }>(
      `SELECT type FROM choros.employee WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
      [tenantId, actorSlug],
    );
  });
  return res.rows[0]?.type === "agent" ? "agent" : "human";
}

// ---------------------------------------------------------------------------
// Bundle item resolution
// ---------------------------------------------------------------------------

interface BundleItems {
  readonly appIds: string[];
  readonly registryDefIds: string[];
  readonly processKeys: string[];
}

async function resolveBundleItems(
  pool: pg.Pool,
  tenantId: string,
  bundleId: string,
): Promise<BundleItems> {
  return withTenantTx(pool, tenantId, async (client) => {
    const apps = await client.query<{ id: string }>(
      `SELECT id FROM choros.application WHERE tenant_id = $1 AND bundle_id = $2`,
      [tenantId, bundleId],
    );
    const regs = await client.query<{ id: string }>(
      `SELECT id FROM choros.registry_def WHERE tenant_id = $1 AND bundle_id = $2`,
      [tenantId, bundleId],
    );
    const procs = await client.query<{ process_key: string }>(
      `SELECT DISTINCT process_key FROM choros.process_definition
         WHERE tenant_id = $1 AND bundle_id = $2`,
      [tenantId, bundleId],
    );
    return {
      appIds: apps.rows.map((r) => r.id),
      registryDefIds: regs.rows.map((r) => r.id),
      processKeys: procs.rows.map((r) => r.process_key),
    };
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSolutionBundleRoutes(router: Router, deps: SolutionBundleDeps): void {
  const { pool, flowable } = deps;

  /**
   * POST /api/solution-bundles/:bundleId/promote
   *
   * Promotes every DRAFT artifact tagged with this bundle_id as ONE unit:
   *   - apps + registry_defs → promoteTier (config tier flip + audit)
   *   - processes            → publishProcessByKey (lint → deploy → status='published')
   *
   * 404 NOT_FOUND when the bundle has no items. 403 when the actor is an agent
   * (config promote is human-only). Per-item outcomes are reported in `items`.
   */
  router.register(
    "POST",
    "/api/solution-bundles/:bundleId/promote",
    withAuth(async (req, res, params) => {
      const bundleId = params["bundleId"] ?? "";
      if (!UUID_RE.test(bundleId)) {
        throw new HttpError(400, "VALIDATION", "bundleId must be a valid UUID");
      }

      const actorSlug = await extractActor(req, pool);
      const tenantId = await deps.resolveActorTenant(actorSlug);
      const actorType = await resolveActorType(req, pool, tenantId, actorSlug);

      // Config promote is human-only — short-circuit agents before any write.
      if (actorType === "agent") {
        throw new HttpError(403, "FORBIDDEN_AGENT_SELF_PROMOTE", "agents cannot promote a bundle");
      }

      const items = await resolveBundleItems(pool, tenantId, bundleId);
      const totalItems =
        items.appIds.length + items.registryDefIds.length + items.processKeys.length;
      if (totalItems === 0) {
        throw new HttpError(404, "NOT_FOUND", `solution bundle '${bundleId}' has no draft items`);
      }

      const nowMs = Date.now();
      const results: Array<{
        kind: "application" | "registry_def" | "process";
        ref: string;
        ok: boolean;
        detail?: string;
      }> = [];

      // 1) Promote config artifacts (apps + sections) via the sanctioned promoteTier.
      for (const id of items.appIds) {
        try {
          await promoteTier({
            pool, tenantId, artifactTable: "application", artifactId: id,
            actor: actorSlug, actorType, nowMs,
          });
          results.push({ kind: "application", ref: id, ok: true });
        } catch (err) {
          results.push({
            kind: "application", ref: id, ok: false,
            detail: err instanceof HttpError ? err.message : String(err),
          });
        }
      }
      for (const id of items.registryDefIds) {
        try {
          await promoteTier({
            pool, tenantId, artifactTable: "registry_def", artifactId: id,
            actor: actorSlug, actorType, nowMs,
          });
          results.push({ kind: "registry_def", ref: id, ok: true });
        } catch (err) {
          results.push({
            kind: "registry_def", ref: id, ok: false,
            detail: err instanceof HttpError ? err.message : String(err),
          });
        }
      }

      // 2) Publish processes via the SAME publish path the modeler uses.
      for (const key of items.processKeys) {
        try {
          const pubResult = await publishProcessByKey(pool, flowable, tenantId, key);
          if (pubResult.status === "published") {
            results.push({ kind: "process", ref: key, ok: true });
          } else if (pubResult.status === "lint_failed") {
            results.push({ kind: "process", ref: key, ok: false, detail: "BPMN_LINT_FAILED" });
          } else if (pubResult.status === "engine_unavailable") {
            results.push({ kind: "process", ref: key, ok: false, detail: pubResult.code });
          } else {
            results.push({ kind: "process", ref: key, ok: false, detail: "not_found" });
          }
        } catch (err) {
          results.push({
            kind: "process", ref: key, ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const promotedCount = results.filter((r) => r.ok).length;
      const allOk = promotedCount === totalItems;

      res.statusCode = allOk ? 200 : 207; // 207 Multi-Status: partial promote
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        bundleId,
        promoted: allOk,
        itemCount: totalItems,
        promotedCount,
        items: results,
      }));
    }),
  );
}
