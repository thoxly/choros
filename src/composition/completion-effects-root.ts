/**
 * src/composition/completion-effects-root.ts — T-0249 (review CE-1: the LIVE wire)
 *
 * The PRODUCTION assembly of the completion-effect registry — the single
 * function server.ts calls to build the registry it passes into
 * registerInboxRoutes (InboxWriteDeps.completionEffectRegistry). Before this
 * module, the primitive was dead in prod ("green over a dead circuit", D-064):
 * makeCompletionEffectRegistry / makeCustomerOnboardingEffectBindings existed
 * but no production code invoked them.
 *
 * ALWAYS REGISTERED, NO ENV GATE ON THE WIRE (review CE-1 directive): the
 * registry is built whenever a DB pool exists. The inbox seam is a strict no-op
 * for every (process, step) without a registered effect, so wiring the bindings
 * unconditionally changes NOTHING for existing processes. What env controls is
 * the ENTITLEMENT PORT inside the bindings (makeEntitlementWiring: live under
 * CUSTOMER_ONBOARDING_LIVE=true + key paths, dormant otherwise) — with the
 * dormant port the issue-key step FAILS VISIBLY (422 STEP_EFFECT_FAILED,
 * CE-2), never silently.
 *
 * PDP WIRING (single-resolver, T-0331): resolverDepsFor composes the SAME
 * authorities the rest of the PDP uses —
 *   grants   → makeDbGrantSource(pool)          (getGrantsForSubject DAO)
 *   records  → tenant-scoped choros.record read (mirrors pdp-explain's fetch)
 *   ancestry → loadTenantOrgAncestry + makeResourceAncestryOracle
 *              (BYTE-IDENTICAL composition to server.ts's resolveReadVisibility)
 * No second authority path is introduced.
 *
 * ACTOR-EVENT SINK: PgSodSource(pool, tenantId).writer — the SAME PgActorEventWriter
 * the SoD substrate uses (guarded append, per-tenant seq).
 */

import pg from "pg";
import { makePgAuditWriter } from "../db/audit-writer.js";
import { makeDbGrantSource } from "../db/grants-dao.js";
import { loadTenantOrgAncestry } from "../db/org-ancestry.js";
import { makeResourceAncestryOracle } from "../db/resource-ancestry.js";
import type { RowAncestry } from "../core/read-visibility.js";
import { PgSodSource } from "../db/sod-dao.js";
import type { ActorEventWriter } from "../core/actor-event.js";
import type { ResolverDeps } from "../core/grant-resolver.js";
import type { ResourceRef } from "../core/object-handle.js";
import {
  makeCompletionEffectRegistry,
  type CompletionEffectRegistry,
} from "../core/completion-effect.js";
import { makeEntitlementWiring } from "./issue-key-live.js";
import { makeCustomerOnboardingEffectBindings } from "./customer-onboarding-effects.js";

// ---------------------------------------------------------------------------
// Record fetch for the PDP (mirrors pdp-explain.ts fetchRecordForExplain)
// ---------------------------------------------------------------------------

async function fetchRecordData(
  pool: pg.Pool,
  tenantId: string,
  ref: ResourceRef,
): Promise<Record<string, unknown> | null> {
  if (ref.kind !== "record") {
    // runIssueKey only ever resolves record handles; a non-record ref here is a
    // programming error — return null (resolveFor fails closed on record_fetch).
    return null;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
    await client.query("SET LOCAL search_path TO choros");
    const { rows } = await client.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM choros.record
        WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, ref.recordId],
    );
    await client.query("COMMIT");
    return rows.length === 0 ? null : rows[0]!.data;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Slug→UUID resolving ActorEventWriter adapter (LIVE-WIRE FINDING, T-0249 CE-1)
// ---------------------------------------------------------------------------

/**
 * runIssueKey (T-0244) appends its T-0019 guarded-transition actor_event with
 * `actor` = the SUBJECT SLUG and `roleAtEvent` = a ROLE SLUG. That matched the
 * in-memory ActorEventStore every prior test used — but the PRODUCTION
 * actor_event substrate (migration 013, PgActorEventWriter) types `actor` /
 * `role_at_event` / `on_behalf_of` as UUID columns (employee.id / role.id).
 * The incompatibility was INVISIBLE until this task wired the effect live
 * (D-064 «зелёное над мёртвым контуром» — the exact defect class CE-1 names):
 * the first real append died with 22P02 invalid-uuid.
 *
 * This adapter resolves the slugs to their tenant-scoped UUIDs before
 * delegating to the real PgActorEventWriter. Resolution is FAIL-CLOSED: an
 * unresolvable actor or role slug throws (→ the effect fails → CE-2 maps it to
 * a visible 422; the approve tx rolls back) — never a silently skipped
 * guarded-transition event.
 *
 * NOTE (pre-existing PgActorEventWriter semantics, unchanged): the append runs
 * in its OWN tenant tx on the pool, not the caller's effect tx — a later
 * write-back failure would roll back the effect but not this event.
 */
function makeSlugResolvingActorEventWriter(
  pool: pg.Pool,
  tenantId: string,
): ActorEventWriter {
  const delegate = new PgSodSource(pool, tenantId).writer;

  async function resolveUuid(
    table: "employee" | "role",
    slug: string,
  ): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL choros.tenant_id = '${tenantId}'`);
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM choros.${table} WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
        [tenantId, slug],
      );
      await client.query("COMMIT");
      const id = rows[0]?.id;
      if (!id) {
        throw new Error(
          `actor-event slug resolution failed: no ${table} with slug ${JSON.stringify(slug)} in tenant ${tenantId}`,
        );
      }
      return id;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    async appendActorEvent(input) {
      const [actorId, roleId, onBehalfOfId] = await Promise.all([
        resolveUuid("employee", input.actor),
        resolveUuid("role", input.roleAtEvent),
        input.onBehalfOf ? resolveUuid("employee", input.onBehalfOf) : Promise.resolve(null),
      ]);
      return delegate.appendActorEvent({
        ...input,
        actor: actorId,
        roleAtEvent: roleId,
        onBehalfOf: onBehalfOfId,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// buildCompletionEffectRegistry — THE production assembly (called by server.ts)
// ---------------------------------------------------------------------------

/**
 * Assemble the production completion-effect registry over a DB pool. `env` is
 * injectable for tests (defaults to process.env — the same env-read boundary
 * makeEntitlementWiring already owns; this module itself reads no env keys).
 */
export function buildCompletionEffectRegistry(
  pool: pg.Pool,
  env: NodeJS.ProcessEnv = process.env,
): CompletionEffectRegistry {
  const wiring = makeEntitlementWiring(env);

  const bindings = makeCustomerOnboardingEffectBindings({
    entitlement: wiring.entitlement,
    liveEnabled: wiring.liveEnabled,
    auditWriter: makePgAuditWriter(),
    resolverDepsFor: async (tenantId, _actor): Promise<ResolverDeps> => {
      // BYTE-IDENTICAL ancestry composition to server.ts resolveReadVisibility
      // (getGrantsForSubject via makeDbGrantSource + loadTenantOrgAncestry →
      // makeResourceAncestryOracle over an empty row index).
      const orgOracle = await loadTenantOrgAncestry(pool, tenantId);
      const emptyRowIndex = new Map<string, RowAncestry>();
      return {
        grants: makeDbGrantSource(pool),
        records: {
          getRecord: (ref) => fetchRecordData(pool, tenantId, ref),
        },
        ancestry: makeResourceAncestryOracle(orgOracle, emptyRowIndex),
      };
    },
    // Slug→UUID adapter over PgSodSource's writer (see doc-comment above —
    // runIssueKey speaks slugs; the actor_event substrate speaks UUIDs).
    actorEventWriterFor: (tenantId) => makeSlugResolvingActorEventWriter(pool, tenantId),
  });

  return makeCompletionEffectRegistry(bindings);
}
