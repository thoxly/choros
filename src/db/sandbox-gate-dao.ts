/**
 * src/db/sandbox-gate-dao.ts — T-0557: DB resolver for the sandbox-gate actor
 * privilege (consumed by core/sandbox-gate.ts and, at runtime, by T-0558).
 *
 * THIN composition over the EXISTING, tenant-scoped, fail-closed authz machinery —
 * no new resolution path, no new table:
 *   - loadAdminContext (org.ts) → the actor's AdminContext (isGenesisOwner +
 *     delegable mgmt_object:* grants). It already runs inside a withTenant RLS tx
 *     and resolves the genesis-owner / admin facts from the DB (never assumed).
 *   - getGrantsForSubject (grants-dao.ts) → the actor's CONFIRMED, in-window
 *     Grant[] (the DAO applies confirmed_by IS NOT NULL + the validity window).
 *     We inspect it for an effective `authoring_draft` grant.
 *
 * Tenant isolation: BOTH helpers run inside SET LOCAL choros.tenant_id RLS txns;
 * neither trusts a header — the actor's slug is the only identity input and it
 * comes from the AUTHENTICATED claim (caller's contract). Fail-closed: an unknown
 * actor resolves to no owner/admin authority and no grants → not privileged.
 */

import pg from "pg";
import { loadAdminContext } from "./org.js";
import { getGrantsForSubject } from "./grants-dao.js";
import { AUTHORING_DRAFT } from "../core/capability-authz.js";

/**
 * The resolved privilege facts consumed by core/sandbox-gate.ts. Shape matches
 * `DraftVisibilityInput["actor"]` exactly so the caller (T-0558) can pass it
 * straight through.
 */
export interface ActorPrivilege {
  /**
   * Genesis owner OR a tenant admin: the actor holds at least one delegable
   * `mgmt_object:*` grant (the admin surface loadAdminContext resolves), OR is the
   * un-parented genesis owner.
   */
  isOwnerOrAdmin: boolean;
  /** Holds an effective `authoring_draft` capability grant (T-0462, migration 088). */
  hasAuthoringDraftGrant: boolean;
}

/**
 * resolveActorPrivilege — resolve the actor's sandbox-gate privilege.
 *
 * @param pool       pg pool.
 * @param tenantId   The caller's tenant (UUID). RLS-scoped on both reads.
 * @param actorSlug  The AUTHENTICATED actor's employee slug (never a header).
 * @param nowMs      Evaluation instant for grant validity windows (default now).
 * @returns          { isOwnerOrAdmin, hasAuthoringDraftGrant } — fail-closed.
 *
 * Reuses loadAdminContext (owner/admin) and getGrantsForSubject (authoring_draft);
 * does NOT reinvent grant resolution. Both DB reads are tenant-scoped and resolve
 * facts from the DB — an unknown actor yields { false, false }.
 */
export async function resolveActorPrivilege(
  pool: pg.Pool,
  tenantId: string,
  actorSlug: string,
  nowMs: number = Date.now(),
): Promise<ActorPrivilege> {
  const [admin, grants] = await Promise.all([
    loadAdminContext(pool, tenantId, actorSlug, nowMs),
    getGrantsForSubject(pool, tenantId, actorSlug, nowMs),
  ]);

  const isOwnerOrAdmin = admin.isGenesisOwner || admin.adminGrants.length > 0;
  const hasAuthoringDraftGrant = grants.some(
    (g) => g.resourceType === AUTHORING_DRAFT,
  );

  return { isOwnerOrAdmin, hasAuthoringDraftGrant };
}
