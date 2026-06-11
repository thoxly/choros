// T-0025 · BYO-LLM secret-handle custody — live Postgres DB probes.
//
// Run in the `db` CI job / locally:
//   DATABASE_URL=... npm run fitness:db
//
// Covers (behavioral, requires live Postgres):
//   AC-1  — POST sets agent_card.llm_secret_handle; DB read-back confirms non-NULL value
//   AC-7  — PUT atomically overwrites the handle (rotate); old value gone, new value present
//   AC-8  — DELETE sets llm_secret_handle = NULL; GET /status returns {bound:false}
//   AC-9  — GET /status when bound: returns {bound:true, summary:...} WITHOUT full handle
//   AC-10 — Cross-tenant write returns 404; target tenant row stays unchanged
//   AC-12 — POST writes audit_event row with type='set_llm_secret_handle', payload has NO handle value
//   AC-13 — PUT  writes audit_event row with type='rotate_llm_secret_handle', payload has NO handle value
//   AC-14 — DELETE writes audit_event row with type='revoke_llm_secret_handle', payload has NO handle value
//
// Additionally covers nit R-2:
//   AC-11 (HTTP path) — stdout capture during HTTP call contains no handle value
//
// Pattern: createServer() + fetch against a random test port + real DB (mirrors grant-editor.test.ts)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migratorUrl, appUrl, withClient, uuid } from './_helpers.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// ---------------------------------------------------------------------------
// Dev silo constants (stable UUIDs from migrations)
// ---------------------------------------------------------------------------

const DEV_TENANT  = 'a0000000-0000-0000-0000-000000000001';
// a-recon: first seeded agent in 032_agent_card.sql (kc_client_id='agent-recon')
const DEV_AGENT   = 'd0000000-0000-0000-0000-000000000002'; // a-recon
// a-invoice: second seeded agent (for cross-tenant target proof)
const DEV_AGENT2  = 'd0000000-0000-0000-0000-000000000003'; // a-invoice
// A UUID that is NOT in DEV_TENANT (cross-tenant probe)
const OTHER_TENANT = '55550000-0000-0000-0000-000000000001';

// A well-formed opaque handle that passes all validateSecretHandleShape rules:
//   ✓ len >= 8
//   ✓ no vendor prefix
//   ✓ not bare-hex-32+
//   ✓ not JWT-shaped
const HANDLE_A = 'vault://secret/choros/test/agent-recon-a';
const HANDLE_B = 'vault://secret/choros/test/agent-recon-b';

// ---------------------------------------------------------------------------
// Shared server lifecycle — one server for all HTTP-level tests
// ---------------------------------------------------------------------------

let server: http.Server;
let serverPort: number;

beforeAll(async () => {
  const { createServer } = await import(join(REPO_ROOT, 'src', 'server.js'));
  server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const addr = server.address() as { port: number };
  serverPort = addr.port;

  // Ensure a-recon starts with NULL handle (cleanup from any previous aborted run)
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `UPDATE choros.agent_card SET llm_secret_handle = NULL
         WHERE tenant_id = $1 AND employee_id = $2`,
      [DEV_TENANT, DEV_AGENT],
    );
  });
});

afterAll(async () => {
  // Restore the agent to NULL so the seed invariant (AC-19) holds for subsequent runs
  await withClient(migratorUrl(), async (c) => {
    await c.query(
      `UPDATE choros.agent_card SET llm_secret_handle = NULL
         WHERE tenant_id = $1 AND employee_id = $2`,
      [DEV_TENANT, DEV_AGENT],
    );
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Helper: count audit_event rows for this agent since a given seq threshold
// ---------------------------------------------------------------------------

async function latestAuditForAgent(sinceOccurredAt: number): Promise<Array<{
  type: string;
  payload: Record<string, unknown>;
  subject: string;
}>> {
  return withClient(migratorUrl(), async (c) => {
    const { rows } = await c.query<{
      type: string;
      payload: Record<string, unknown>;
      subject: string;
    }>(
      `SELECT type, payload, subject
         FROM choros.audit_event
        WHERE tenant_id = $1
          AND subject = $2
          AND occurred_at >= $3
        ORDER BY seq DESC`,
      [DEV_TENANT, DEV_AGENT, sinceOccurredAt],
    );
    return rows;
  });
}

// ---------------------------------------------------------------------------
// AC-1: POST sets llm_secret_handle in DB; read-back via migrator confirms non-NULL
// AC-12: audit_event row written with type='set_llm_secret_handle', payload has no handle value
// AC-11 (R-2): stdout during POST contains no handle value
// ---------------------------------------------------------------------------

describe('AC-1 / AC-12 / AC-11(R-2): POST /api/agents/:id/secret-handle — set', () => {
  it('POST writes handle to DB and emits set audit event with no handle in payload', async () => {
    const t0 = Date.now();

    // Capture stdout/stderr during the HTTP call (R-2: AC-11 HTTP-path check)
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalErrWrite = process.stderr.write.bind(process.stderr);
    const capturedOutput: string[] = [];
    const captureWrite = (chunk: unknown) => {
      if (typeof chunk === 'string') capturedOutput.push(chunk);
      else if (Buffer.isBuffer(chunk)) capturedOutput.push(chunk.toString('utf8'));
      return true;
    };
    // @ts-expect-error — monkey-patch for capture
    process.stdout.write = captureWrite;
    // @ts-expect-error — monkey-patch for capture
    process.stderr.write = captureWrite;

    let resStatus: number;
    let resBody: unknown;
    try {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/agents/${DEV_AGENT}/secret-handle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dev-user': 'e-owner',
        },
        body: JSON.stringify({ handle_value: HANDLE_A }),
      });
      resStatus = res.status;
      resBody = await res.json();
    } finally {
      process.stdout.write = originalWrite;
      process.stderr.write = originalErrWrite;
    }

    // R-2 (AC-11 HTTP path): captured stdout/stderr must not contain the handle value
    const combined = capturedOutput.join('');
    expect(combined, 'R-2: handle value must not appear in stdout/stderr during POST').not.toContain(HANDLE_A);

    // HTTP response
    expect(resStatus, `POST secret-handle: expected 200, got ${resStatus}`).toBe(200);
    expect((resBody as { ok?: boolean }).ok).toBe(true);

    // AC-1: DB read-back confirms column is non-NULL and equals the submitted handle
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query<{ llm_secret_handle: string | null }>(
        `SELECT llm_secret_handle
           FROM choros.agent_card
          WHERE tenant_id = $1 AND employee_id = $2`,
        [DEV_TENANT, DEV_AGENT],
      );
      expect(rows.length, 'AC-1: agent_card row must exist').toBe(1);
      expect(rows[0].llm_secret_handle, 'AC-1: llm_secret_handle must be non-NULL after POST').not.toBeNull();
      expect(rows[0].llm_secret_handle, 'AC-1: DB value must match submitted handle').toBe(HANDLE_A);
    });

    // AC-12: audit_event row with correct type; payload must not contain handle value
    const auditRows = await latestAuditForAgent(t0);
    const setEvent = auditRows.find((r) => r.type === 'set_llm_secret_handle');
    expect(setEvent, 'AC-12: audit_event row with type=set_llm_secret_handle must exist').toBeDefined();
    expect(setEvent!.subject, 'AC-12: audit subject must be agentId').toBe(DEV_AGENT);
    const payloadStr = JSON.stringify(setEvent!.payload);
    expect(payloadStr, 'AC-12: audit payload must not contain the handle value').not.toContain(HANDLE_A);
    // Confirm payload only has agentEmployeeId (ADR §2.3 exact shape)
    expect(payloadStr, 'AC-12: payload must contain agentEmployeeId').toContain('agentEmployeeId');
  });
});

// ---------------------------------------------------------------------------
// AC-7: PUT atomically overwrites the handle
// AC-13: audit_event written with type='rotate_llm_secret_handle', payload has no handle value
// ---------------------------------------------------------------------------

describe('AC-7 / AC-13: PUT /api/agents/:id/secret-handle — rotate', () => {
  it('PUT overwrites handle atomically; rotateAudit event written with no handle in payload', async () => {
    // Precondition: handle should be HANDLE_A from the previous test (same shared server lifecycle).
    // We re-set it explicitly to make this test independent.
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `UPDATE choros.agent_card SET llm_secret_handle = $2
           WHERE tenant_id = $1 AND employee_id = $3`,
        [DEV_TENANT, HANDLE_A, DEV_AGENT],
      );
    });

    const t0 = Date.now();

    const res = await fetch(`http://127.0.0.1:${serverPort}/api/agents/${DEV_AGENT}/secret-handle`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-dev-user': 'e-owner',
      },
      body: JSON.stringify({ handle_value: HANDLE_B }),
    });
    expect(res.status, `PUT secret-handle: expected 200, got ${res.status}`).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);

    // AC-7: DB must contain HANDLE_B (not HANDLE_A — atomic overwrite)
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query<{ llm_secret_handle: string | null }>(
        `SELECT llm_secret_handle
           FROM choros.agent_card
          WHERE tenant_id = $1 AND employee_id = $2`,
        [DEV_TENANT, DEV_AGENT],
      );
      expect(rows.length, 'AC-7: agent_card row must exist').toBe(1);
      expect(rows[0].llm_secret_handle, 'AC-7: handle must be updated to HANDLE_B').toBe(HANDLE_B);
      expect(rows[0].llm_secret_handle, 'AC-7: old handle HANDLE_A must be gone').not.toBe(HANDLE_A);
    });

    // AC-13: audit event with correct type; payload has no handle value
    const auditRows = await latestAuditForAgent(t0);
    const rotateEvent = auditRows.find((r) => r.type === 'rotate_llm_secret_handle');
    expect(rotateEvent, 'AC-13: audit_event row with type=rotate_llm_secret_handle must exist').toBeDefined();
    expect(rotateEvent!.subject, 'AC-13: audit subject must be agentId').toBe(DEV_AGENT);
    const payloadStr = JSON.stringify(rotateEvent!.payload);
    expect(payloadStr, 'AC-13: audit payload must not contain HANDLE_A').not.toContain(HANDLE_A);
    expect(payloadStr, 'AC-13: audit payload must not contain HANDLE_B').not.toContain(HANDLE_B);
    expect(payloadStr, 'AC-13: payload must contain agentEmployeeId').toContain('agentEmployeeId');
  });
});

// ---------------------------------------------------------------------------
// AC-9: GET /status when bound: returns {bound:true, summary:...} without full handle
// ---------------------------------------------------------------------------

describe('AC-9: GET /api/agents/:id/secret-handle/status — bound agent', () => {
  it('status returns {bound:true, summary} without echoing the full handle', async () => {
    // Precondition: ensure a handle is set (HANDLE_B from previous test or re-set)
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `UPDATE choros.agent_card SET llm_secret_handle = $2
           WHERE tenant_id = $1 AND employee_id = $3`,
        [DEV_TENANT, HANDLE_B, DEV_AGENT],
      );
    });

    const res = await fetch(
      `http://127.0.0.1:${serverPort}/api/agents/${DEV_AGENT}/secret-handle/status`,
      { headers: { 'x-dev-user': 'e-owner' } },
    );
    expect(res.status, `GET /status: expected 200, got ${res.status}`).toBe(200);

    const body = (await res.json()) as { bound?: boolean; summary?: string };
    expect(body.bound, 'AC-9: bound must be true when handle is set').toBe(true);
    expect(body.summary, 'AC-9: summary must be present').toBeTruthy();
    // The full handle value must NOT appear in the response body
    const bodyStr = JSON.stringify(body);
    expect(bodyStr, 'AC-9: full handle value must not appear in status response').not.toContain(HANDLE_B);
  });
});

// ---------------------------------------------------------------------------
// AC-8: DELETE sets llm_secret_handle = NULL; GET /status returns {bound:false}
// AC-14: audit_event written with type='revoke_llm_secret_handle', payload has no handle value
// ---------------------------------------------------------------------------

describe('AC-8 / AC-14: DELETE /api/agents/:id/secret-handle — revoke', () => {
  it('DELETE sets column NULL; GET /status returns {bound:false}; revoke audit event written', async () => {
    // Precondition: handle must be set
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `UPDATE choros.agent_card SET llm_secret_handle = $2
           WHERE tenant_id = $1 AND employee_id = $3`,
        [DEV_TENANT, HANDLE_B, DEV_AGENT],
      );
    });

    const t0 = Date.now();

    const delRes = await fetch(
      `http://127.0.0.1:${serverPort}/api/agents/${DEV_AGENT}/secret-handle`,
      {
        method: 'DELETE',
        headers: { 'x-dev-user': 'e-owner' },
      },
    );
    expect(delRes.status, `DELETE secret-handle: expected 200, got ${delRes.status}`).toBe(200);
    expect(((await delRes.json()) as { ok?: boolean }).ok).toBe(true);

    // AC-8: DB column must be NULL
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query<{ llm_secret_handle: string | null }>(
        `SELECT llm_secret_handle
           FROM choros.agent_card
          WHERE tenant_id = $1 AND employee_id = $2`,
        [DEV_TENANT, DEV_AGENT],
      );
      expect(rows.length, 'AC-8: agent_card row must exist').toBe(1);
      expect(rows[0].llm_secret_handle, 'AC-8: llm_secret_handle must be NULL after DELETE').toBeNull();
    });

    // AC-8: GET /status must return {bound:false}
    const statusRes = await fetch(
      `http://127.0.0.1:${serverPort}/api/agents/${DEV_AGENT}/secret-handle/status`,
      { headers: { 'x-dev-user': 'e-owner' } },
    );
    expect(statusRes.status, `GET /status after DELETE: expected 200, got ${statusRes.status}`).toBe(200);
    const statusBody = (await statusRes.json()) as { bound?: boolean };
    expect(statusBody.bound, 'AC-8: GET /status must return {bound:false} after DELETE').toBe(false);
    // No 'summary' key expected when unbound
    expect((statusBody as { summary?: unknown }).summary, 'AC-8: no summary when unbound').toBeUndefined();

    // AC-14: audit event with correct type; payload has no handle value
    const auditRows = await latestAuditForAgent(t0);
    const revokeEvent = auditRows.find((r) => r.type === 'revoke_llm_secret_handle');
    expect(revokeEvent, 'AC-14: audit_event row with type=revoke_llm_secret_handle must exist').toBeDefined();
    expect(revokeEvent!.subject, 'AC-14: audit subject must be agentId').toBe(DEV_AGENT);
    const payloadStr = JSON.stringify(revokeEvent!.payload);
    expect(payloadStr, 'AC-14: audit payload must not contain any handle value').not.toContain('vault://');
    expect(payloadStr, 'AC-14: payload must contain agentEmployeeId').toContain('agentEmployeeId');
  });
});

// ---------------------------------------------------------------------------
// AC-10: Cross-tenant write → 404; target tenant row unchanged
// ---------------------------------------------------------------------------

describe('AC-10: cross-tenant write → 404, target row unchanged', () => {
  it('POST with a non-existent tenant context returns 404 and leaves DEV_TENANT row intact', async () => {
    // The server always uses DEV_TENANT_ID (from env or default).
    // AC-10 probes that an agentId not belonging to DEV_TENANT → 0 rows → 404.
    // We use a freshly-generated UUID that definitely has no agent_card row in DEV_TENANT.
    const ghostAgentId = uuid(); // random, no row in any tenant

    // Ensure DEV_AGENT starts at a known value
    await withClient(migratorUrl(), async (c) => {
      await c.query(
        `UPDATE choros.agent_card SET llm_secret_handle = $2
           WHERE tenant_id = $1 AND employee_id = $3`,
        [DEV_TENANT, HANDLE_A, DEV_AGENT],
      );
    });

    // Attempt to set handle for non-existent agent (cross-tenant: ghost UUID)
    const res = await fetch(
      `http://127.0.0.1:${serverPort}/api/agents/${ghostAgentId}/secret-handle`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dev-user': 'e-owner',
        },
        body: JSON.stringify({ handle_value: HANDLE_B }),
      },
    );
    expect(res.status, `AC-10: cross-tenant write must return 404, got ${res.status}`).toBe(404);

    // Target tenant (DEV_TENANT) DEV_AGENT row must be UNCHANGED (still HANDLE_A)
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query<{ llm_secret_handle: string | null }>(
        `SELECT llm_secret_handle
           FROM choros.agent_card
          WHERE tenant_id = $1 AND employee_id = $2`,
        [DEV_TENANT, DEV_AGENT],
      );
      expect(rows.length, 'AC-10: DEV_TENANT DEV_AGENT row must still exist').toBe(1);
      expect(
        rows[0].llm_secret_handle,
        'AC-10: DEV_TENANT row must be unchanged (HANDLE_A) after cross-tenant attempt',
      ).toBe(HANDLE_A);
    });

    // Also verify ghost agent has no agent_card row in DEV_TENANT (sanity)
    await withClient(migratorUrl(), async (c) => {
      const { rows } = await c.query(
        `SELECT employee_id FROM choros.agent_card
          WHERE tenant_id = $1 AND employee_id = $2`,
        [DEV_TENANT, ghostAgentId],
      );
      expect(rows.length, 'AC-10: ghost agent must have no row in DEV_TENANT').toBe(0);
    });
  });
});
