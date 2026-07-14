/**
 * src/db/role-grant-dao.ts — T-0392 [D4-FU] production RoleGrantSource.
 *
 * Provides `makeDbRoleGrantSource(pool)` — a DB-backed implementation of the
 * `RoleGrantSource` port (core/role-criticality.ts). Used by the agent dispatch
 * loop's `buildAgentDispatchDeps` to resolve role criticality (gate B ceiling).
 *
 * SCOPE (FF-COMP-6 / FF-LP-4): this DAO lives in src/db/ (not src/runtime/) so
 * the runtime agent-dispatch/ directory does NOT import it directly — the
 * composition root (src/server/agent-dispatch-loop.ts) wires it in. The runtime
 * module receives only the abstract `RoleGrantSource` port.
 *
 * Query: reads confirmed grants for a role (tenant-scoped). The grants are the
 * same rows the PDP uses for `combineCriticality` — resource_type, operation,
 * scope fields determine the criticality bits (approve_or_transition, external_invoke,
 * sensitive_read). Confirmed = `confirmed_by IS NOT NULL` (migration 031 contract).
 *
 * Tenant-isolation: each call opens its own read tx with `SET LOCAL choros.tenant_id`
 * (mirrors getGrantsForSubject in grants-dao.ts). UUID-validated before GUC
 * interpolation (R-3 defence, образец pgJobStore / pgOutboxStore).
 */

import pg from "pg";
import type { Grant } from "../core/grant-lattice.js";
import type { RoleGrantSource } from "../core/role-criticality.js";

// UUID validation regex (mirrors grants-dao.ts / pgOutboxStore — R-3 defence).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

/**
 * Build a `RoleGrantSource` backed by a pg pool. Each `getRoleGrants` call opens
 * its own tenant-scoped read tx (BEGIN…COMMIT), mirroring getGrantsForSubject.
 * Returns [] (empty, no grants → routine criticality) when the role is unknown.
 */
export function makeDbRoleGrantSource(pool: pg.Pool): RoleGrantSource {
  return {
    async getRoleGrants(tenantId: string, roleId: string): Promise<Grant[]> {
      assertUuid(tenantId, "tenantId");
      assertUuid(roleId, "roleId");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SET LOCAL choros.tenant_id = '${tenantId.replace(/'/g, "''")}'`,
        );
        await client.query("SET LOCAL search_path TO choros");

        // Load confirmed grants for the role (same columns as getGrantsForSubject step 3).
        const { rows } = await client.query<{
          id: string;
          role_id: string;
          resource_type: string;
          resource_facet: unknown;
          operation: string;
          scope: unknown;
          constraint: unknown;
          delegable: boolean;
          granted_by: string;
          valid_from: string | null;
          valid_until: string | null;
          created_at: string;
        }>(
          `SELECT id, role_id, resource_type, resource_facet,
                  operation, scope, "constraint", delegable,
                  granted_by, valid_from, valid_until, created_at
             FROM choros."grant"
            WHERE tenant_id = $1
              AND role_id = $2
              AND confirmed_by IS NOT NULL`,
          [tenantId, roleId],
        );

        await client.query("COMMIT");

        return rows.map((g) => ({
          tenantId,
          id: g.id,
          roleId: g.role_id,
          resourceType: g.resource_type as Grant["resourceType"],
          resourceFacet: g.resource_facet ?? undefined,
          operation: g.operation as Grant["operation"],
          scope: g.scope as Grant["scope"],
          constraint: g.constraint ?? undefined,
          delegable: g.delegable,
          grantedBy: g.granted_by,
          validFrom: g.valid_from != null ? Number(g.valid_from) : undefined,
          validUntil: g.valid_until != null ? Number(g.valid_until) : undefined,
          createdAt: Number(g.created_at),
        }));
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {/* swallow */});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
