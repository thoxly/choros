/**
 * src/db/mcp-tool-dao.ts — T-0378 [D4] live McpToolSource (PD-2 dispatcher).
 *
 * The Postgres-backed implementation of the `McpToolSource` port declared in
 * `src/core/mcp-tool-registry.ts` (T-0043). `resolveAgentToolset` queries over an
 * agent's grants and needs the tenant's full `choros.mcp_tool` set; this DAO is the
 * missing read leaf (the T-0053 seam the registry header anticipated).
 *
 * Two shapes:
 *   makeDbMcpToolSource(pool)            — owns its own tenant-scoped read tx.
 *   listMcpToolsOnClient(client, ...)    — reads on a caller's ALREADY-open tx
 *                                          (so the dispatcher's context assembly
 *                                          shares ONE tenant tx with the motor +
 *                                          outcome write — atomic per job).
 *
 * Tenant isolation:
 *   - All reads run under SET LOCAL choros.tenant_id (RLS, FORCE).
 *   - tenant_id is UUID-validated before interpolation (defence-in-depth, T-0116 R-3,
 *     mirrors grants-dao.ts / org.ts).
 *   - Every SELECT also carries an explicit WHERE tenant_id = $1 BYPASSRLS guard.
 *
 * NOT imported: http, fs, net, fetch, process.env, grant-resolver (no PDP bypass).
 * The raw `declares`/`resource_ops` jsonb is mapped to the typed `McpToolRow`
 * mirror; this DAO trusts the write-path guard (validateMcpToolWrite) that produced
 * the rows and does not re-classify them on read.
 */

import pg from "pg";
import type {
  McpToolRow,
  McpToolSource,
  ResourceOp,
} from "../core/mcp-tool-registry.js";
import type { EffectDeclaration } from "../core/effect-resource.js";

// ---------------------------------------------------------------------------
// UUID shape guard (mirrors grants-dao.ts — defence-in-depth, T-0116 R-3)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID, got: ${JSON.stringify(value)}`);
  }
}

// ---------------------------------------------------------------------------
// Row shape from Postgres (snake_case DB → camelCase TS)
// ---------------------------------------------------------------------------

interface McpToolDbRow {
  tenant_id: string;
  id: string;
  name: string;
  description: string | null;
  declares: unknown;
  pure_compute: boolean;
  resource_ops: unknown;
  created_at: string | number;
  updated_at: string | number;
}

function rowToMcpTool(r: McpToolDbRow): McpToolRow {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    name: r.name,
    description: r.description,
    // declares/resource_ops are produced by the write-path guard; trust the jsonb.
    declares: Array.isArray(r.declares) ? (r.declares as EffectDeclaration[]) : [],
    pureCompute: r.pure_compute,
    resourceOps: Array.isArray(r.resource_ops) ? (r.resource_ops as ResourceOp[]) : [],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// SELECT (single source of truth so own-tx and caller-tx issue identical SQL)
// ---------------------------------------------------------------------------

const LIST_TOOLS_SQL = `SELECT tenant_id, id, name, description, declares,
                               pure_compute, resource_ops, created_at, updated_at
                          FROM choros.mcp_tool
                         WHERE tenant_id = $1
                         ORDER BY created_at ASC, name ASC`;

/**
 * Read all tools for a tenant on a caller-supplied client that is ALREADY inside an
 * open tenant-scoped tx (the dispatcher's per-job tx). The caller MUST have set the
 * GUC + validated tenantId; this overload neither opens nor commits a tx.
 */
export async function listMcpToolsOnClient(
  client: pg.PoolClient,
  tenantId: string,
): Promise<McpToolRow[]> {
  const { rows } = await client.query<McpToolDbRow>(LIST_TOOLS_SQL, [tenantId]);
  return rows.map(rowToMcpTool);
}

// ---------------------------------------------------------------------------
// withTenantReadTx — own-tx variant (mirrors grants-dao.ts)
// ---------------------------------------------------------------------------

async function withTenantReadTx<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  assertUuid(tenantId, "tenantId");
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

/**
 * Build a `McpToolSource` (T-0043 port) backed by a pg pool. Each `listTools` call
 * opens its own tenant-scoped read tx. Used where the toolset read is standalone
 * (not already inside the dispatcher's per-job tx).
 */
export function makeDbMcpToolSource(pool: pg.Pool): McpToolSource {
  return {
    async listTools(tenantId: string): Promise<McpToolRow[]> {
      return withTenantReadTx(pool, tenantId, (client) =>
        listMcpToolsOnClient(client, tenantId),
      );
    },
  };
}

/**
 * Build a `McpToolSource` bound to a caller's ALREADY-open tenant tx client. Lets
 * `resolveAgentToolset` run inside the dispatcher's single per-job tx (atomic with
 * the motor + outcome write). The `tenantId` passed to `listTools` MUST match the
 * GUC the caller already set.
 */
export function makeOnClientMcpToolSource(client: pg.PoolClient): McpToolSource {
  return {
    async listTools(tenantId: string): Promise<McpToolRow[]> {
      return listMcpToolsOnClient(client, tenantId);
    },
  };
}
