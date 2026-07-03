/**
 * T-0335 [E15-S1b] — Unit tests for applyStepResult (step-applier.ts)
 *
 * Pure unit — no live Postgres. All pg.PoolClient interactions are stubbed with
 * in-memory query interceptors, following the established pattern from
 * process-instance-resolver.test.ts and transition-payload.test.ts.
 *
 * Note on DATABASE_URL (FE-s27-0002): this file does NOT construct a pg.Pool
 * or pg.Client. All DB interactions go through a stub PoolClient that never
 * opens a real connection.
 *
 * Test matrix:
 *   SA-1  A-class step → appends ONE «Согласование» record + enqueues ONE outbox 'step_applied'
 *   SA-2  unresolved (no_process_started_event) + explicit 'A' marker → throws (fail-closed FF-G3)
 *   SA-3  unresolved (no_app_binding) → returns skipped (approval still commits)
 *   SA-4  default/no marker (stepClass=null) → routes to A; no update path taken
 *   SA-5  stepClass='B' → returns skipped with T-0344 deferral reason (no update)
 *   SA-6  duration_ms is threaded: positive int from nowMs−occurredAt reaches outbox payload
 *   SA-7  cross_app_ref present → ref_field is set on the record data
 *   SA-8  cross_app_ref absent → record created without ref_field (no throw)
 *   SA-9  no «Согласование» registry seeded for the app → throws (fail-closed FF-G3)
 */

import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import {
  applyStepResult,
  SOGLASOVANIE_SLUG,
  STEP_APPLIED_EVENT,
  SYSTEM_ACTOR,
  StepTargetUnresolvedError,
  type ApplyStepResultArgs,
  type AppliedA,
  type Skipped,
  type OutboxEnqueuePort,
} from "../db/step-applier.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const INSTANCE_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const TASK_ID = "cccccccc-0000-0000-0000-000000000003";
const APPLICATION_ID = "dddddddd-0000-0000-0000-000000000004";
const PRIMARY_REGISTRY_ID = "eeeeeeee-0000-0000-0000-000000000005";
const APPROVALS_REGISTRY_ID = "ffffffff-0000-0000-0000-000000000006";
const CROSS_APP_REF_ID = "11111111-0000-0000-0000-000000000007";
const PROC_KEY = "purchase-approval";
const ACTIVITY = "task.approved";
const ACTOR = "e-larina";
const NOW_MS = 1700000000000;
const OCCURRED_AT = 1700000000000 - 5000; // 5 seconds before approve

// ---------------------------------------------------------------------------
// Stub infrastructure
// ---------------------------------------------------------------------------

/**
 * A call record captured by the stub client. Each query that is NOT a
 * transaction-control command (BEGIN/COMMIT/ROLLBACK/SET LOCAL) is logged here.
 */
interface QueryCall {
  sql: string;
  values: unknown[];
}

/**
 * Build a stub pg.PoolClient that:
 *   - Silently absorbs BEGIN / COMMIT / ROLLBACK / SET LOCAL / SET search_path.
 *   - For the audit chain queries (current_setting, audit_head, audit_event),
 *     returns the bare minimum to let the PgAuditWriter succeed.
 *   - For registry_def + record + cross_app_ref queries, returns canned rows
 *     supplied by `queryResponder`.
 *   - Records every non-TCL query in the returned `calls` array.
 *
 * The audit writer (makePgAuditWriter) issues:
 *   1. SELECT current_setting('choros.tenant_id', false)::uuid AS tenant_id
 *   2. INSERT INTO choros.audit_head ... ON CONFLICT DO NOTHING
 *   3. SELECT seq, row_hash FROM choros.audit_head FOR UPDATE
 *   4. INSERT INTO choros.audit_event ...
 *   5. UPDATE choros.audit_head ...
 *
 * We absorb all of these so the unit test does not need to replicate the full
 * hash-chain state machine (that is tested separately in lifecycle-audit.test.ts
 * and audit-*.test.ts). The audit writer itself is the source of truth for that.
 */
function makeStubClient(
  queryResponder: (sql: string, values: unknown[]) => unknown[],
): { client: PoolClient; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const client = {
    query: async (sql: unknown, valuesArg?: unknown[]): Promise<{ rows: unknown[] }> => {
      const sqlText: string =
        typeof sql === "string" ? sql : ((sql as { text?: string }).text ?? "");
      const values = valuesArg ?? [];
      const upper = sqlText.trimStart().toUpperCase();

      // Absorb transaction-control statements
      if (
        upper.startsWith("BEGIN") ||
        upper.startsWith("COMMIT") ||
        upper.startsWith("ROLLBACK") ||
        upper.startsWith("SET LOCAL") ||
        upper.startsWith("SET SEARCH_PATH")
      ) {
        return { rows: [] };
      }

      // Absorb audit chain machinery: return stub values so the writer can proceed.
      // IMPORTANT: order matters — the FOR UPDATE query also contains current_setting,
      // so the specific head-lock query must be checked BEFORE the generic current_setting
      // branch (otherwise head.seq comes back undefined → NaN in canonicalPreimage).
      if (/INSERT INTO choros\.audit_head/i.test(sqlText)) {
        return { rows: [] };
      }
      if (/FROM choros\.audit_head/i.test(sqlText) && /FOR UPDATE/i.test(sqlText)) {
        return { rows: [{ seq: 0, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
      }
      if (/UPDATE choros\.audit_head/i.test(sqlText)) {
        return { rows: [] };
      }
      if (/INSERT INTO choros\.audit_event/i.test(sqlText)) {
        return { rows: [] };
      }
      // Tenant GUC read (must come AFTER the audit_head checks above)
      if (/current_setting\('choros\.tenant_id'/.test(sqlText)) {
        return { rows: [{ tenant_id: TENANT_ID }] };
      }

      // Record non-system queries for assertion
      calls.push({ sql: sqlText, values });
      return { rows: queryResponder(sqlText, values) };
    },
    release: () => {},
  } as unknown as PoolClient;

  return { client, calls };
}

/**
 * A minimal outbox enqueue port that records the enqueued row.
 */
function makeOutboxSpy(): { store: OutboxEnqueuePort; enqueued: unknown[] } {
  const enqueued: unknown[] = [];
  const store: OutboxEnqueuePort = {
    enqueueInTx: async (_client, row) => {
      enqueued.push(row);
    },
  };
  return { store, enqueued };
}

/**
 * Resolved instance target: resolveInstanceTargetOnClient returns a "resolved" result
 * by finding (1) audit_event with proc_key, (2) process_app_binding with applicationId,
 * (3) registry_def with PRIMARY_REGISTRY_ID.
 */
function auditStartedPayload() {
  return {
    payload: {
      inst: INSTANCE_ID,
      proc_key: PROC_KEY,
      task_role: "role-approver",
      task_step: "Согласование",
    },
  };
}

/**
 * Build base ApplyStepResultArgs (all fields populated for the A-path happy case).
 */
function baseArgs(
  over: Partial<ApplyStepResultArgs> = {},
): ApplyStepResultArgs & { outboxStore: OutboxEnqueuePort } {
  const { store } = makeOutboxSpy();
  return {
    tenantId: TENANT_ID,
    instanceId: INSTANCE_ID,
    procKey: PROC_KEY,
    activity: ACTIVITY,
    actor: ACTOR,
    taskId: TASK_ID,
    stepClass: "A",
    formData: { decision: "approve", approved_by: ACTOR },
    durationMs: NOW_MS - OCCURRED_AT,
    nowMs: NOW_MS,
    outboxStore: store,
    ...over,
  };
}

/**
 * Build a stub client for the full A-path:
 *   - resolveInstanceTargetOnClient → resolved (audit_event + binding + registry_def).
 *   - resolveApprovalsRegistry → APPROVALS_REGISTRY_ID (registry_def WHERE slug='soglasovanie').
 *   - getCrossAppRef → null by default (no cross-ref).
 *   - record INSERT → absorbed as { rows: [] }.
 *
 * T-0356: optional primaryRecordId simulates on_create path (record_id in audit payload).
 */
function makeHappyClient(opts?: {
  crossRef?: { id: string; ref_field: string; label: string } | null;
  /** T-0356: if set, embed record_id into the audit_event payload (create=start path). */
  primaryRecordId?: string;
}): ReturnType<typeof makeStubClient> {
  const crossRef = opts?.crossRef ?? null;
  const primaryRecordId = opts?.primaryRecordId;
  return makeStubClient((sql, values) => {
    // resolveInstanceTargetOnClient: audit_event → started payload
    if (/FROM choros\.audit_event/i.test(sql) && !/INSERT/i.test(sql)) {
      // T-0356: if primaryRecordId is set, embed record_id so the resolver
      // returns it as target.primaryRecordId (on_create path).
      const payload = {
        ...auditStartedPayload().payload,
        ...(primaryRecordId !== undefined ? { record_id: primaryRecordId } : {}),
      };
      return [{ payload }];
    }
    // resolveInstanceTargetOnClient: process_app_binding → applicationId
    if (/FROM choros\.process_app_binding/i.test(sql)) {
      return [{ application_id: APPLICATION_ID }];
    }
    // resolveInstanceTargetOnClient: registry_def for PRIMARY (NOT slug filter)
    // AND resolveApprovalsRegistry: registry_def WHERE slug='soglasovanie'
    if (/FROM choros\.registry_def/i.test(sql)) {
      // If query filters on slug (resolveApprovalsRegistry), return the approvals registry.
      if (Array.isArray(values) && values.includes(SOGLASOVANIE_SLUG)) {
        return [{ id: APPROVALS_REGISTRY_ID, application_id: APPLICATION_ID }];
      }
      // Otherwise: resolver's primary registry query (no slug filter).
      return [
        { id: PRIMARY_REGISTRY_ID, slug: "purchases", display_name: "Заявки" },
      ];
    }
    // cross_app_ref lookup
    if (/FROM choros\.cross_app_ref/i.test(sql)) {
      if (crossRef !== null && crossRef !== undefined) {
        return [crossRef];
      }
      return [];
    }
    // record INSERT — absorbed by the stub (not recorded as a call because it's
    // system infrastructure, but we still need to return { rows: [] }).
    if (/INSERT INTO choros\.record/i.test(sql)) {
      return [];
    }
    return [];
  });
}

// ---------------------------------------------------------------------------
// SA-1: A-class step → record + outbox
// ---------------------------------------------------------------------------

describe("applyStepResult — A-class step", () => {
  it("SA-1: appends ONE «Согласование» record and enqueues ONE step_applied outbox row", async () => {
    const { store, enqueued } = makeOutboxSpy();
    const { client, calls } = makeHappyClient();

    const result = await applyStepResult(client, {
      ...baseArgs({ outboxStore: store }),
    });

    // Result kind
    expect(result.kind).toBe("applied-A");
    const applied = result as AppliedA;
    expect(applied.recordId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // One record INSERT was issued
    const recordInsert = calls.find(
      (c) => /INSERT INTO choros\.record/i.test(c.sql),
    );
    expect(recordInsert).toBeDefined();
    // The record should target the APPROVALS registry (not the primary)
    expect(recordInsert?.values).toContain(APPROVALS_REGISTRY_ID);
    // System actor
    expect(recordInsert?.values).toContain(SYSTEM_ACTOR);

    // One outbox row enqueued
    expect(enqueued).toHaveLength(1);
    const outboxRow = enqueued[0] as {
      eventType: string;
      idempotencyKey: string;
      aggregateKind: string;
      payload: Record<string, unknown>;
    };
    expect(outboxRow.eventType).toBe(STEP_APPLIED_EVENT);
    expect(outboxRow.idempotencyKey).toBe(`step_applied:${INSTANCE_ID}:${TASK_ID}`);
    expect(outboxRow.aggregateKind).toBe("record");
    // The applied record's UUID must match the outbox aggregateId
    expect((enqueued[0] as { aggregateId: string }).aggregateId).toBe(
      applied.recordId,
    );
  });

  it("SA-11 (T-0606 [approval-registry-guard]): applyStepResult's direct DAO insert is STRUCTURALLY unaffected by registry_def.engine_managed — resolveApprovalsRegistry never selects that column, and the INSERT proceeds regardless", async () => {
    // This is the isolation proof required by ADR-T0606-approval-registry-guard.md
    // §5: the HTTP write-protection guard (src/http/records.ts's
    // assertNotEngineManaged) lives INSIDE createRecord/updateRecord/deleteRecord —
    // functions applyStepResult never calls. applyStepResult writes the
    // «Согласование» decision record via its OWN direct
    // `INSERT INTO choros.record` (this file, ~line 700), reached through
    // resolveApprovalsRegistry's `SELECT id, application_id FROM
    // choros.registry_def WHERE ... AND slug = $3` — a query that does not
    // (and, after this migration, still does not) select engine_managed at
    // all. This test proves BOTH halves: (a) the SQL text of every
    // registry_def query issued by this call never mentions engine_managed,
    // and (b) the record INSERT still succeeds and targets the approvals
    // registry — i.e. marking that registry engine_managed=true (as
    // migration 122's data-completion UPDATE does for the live ТЭЛ
    // «Согласование» row) cannot possibly block this path, by construction.
    const { store, enqueued } = makeOutboxSpy();
    const { client, calls } = makeHappyClient();

    const result = await applyStepResult(client, {
      ...baseArgs({ outboxStore: store }),
    });

    expect(result.kind).toBe("applied-A");
    const applied = result as AppliedA;

    // (a) No registry_def query issued by this path ever references
    // engine_managed — the column is invisible to this code path entirely.
    const registryDefQueries = calls.filter((c) =>
      /FROM choros\.registry_def/i.test(c.sql),
    );
    expect(registryDefQueries.length).toBeGreaterThan(0);
    for (const q of registryDefQueries) {
      expect(q.sql).not.toMatch(/engine_managed/i);
    }

    // (b) The record INSERT still landed in the approvals registry — proving
    // a hypothetical engine_managed=true on that row changes nothing here.
    const recordInsert = calls.find((c) => /INSERT INTO choros\.record/i.test(c.sql));
    expect(recordInsert).toBeDefined();
    expect(recordInsert?.values).toContain(APPROVALS_REGISTRY_ID);
    expect(enqueued).toHaveLength(1);
    expect(applied.recordId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SA-2: unresolved (no_process_started_event) + explicit 'A' → throws (FF-G3)
// ---------------------------------------------------------------------------

describe("applyStepResult — fail-closed (FF-G3)", () => {
  it("SA-2: unresolved (no_process_started_event) + stepClass='A' → throws", async () => {
    const { store } = makeOutboxSpy();
    // Stub: no audit_event row → resolver returns unresolved(no_process_started_event)
    const { client } = makeStubClient((sql) => {
      if (/FROM choros\.audit_event/i.test(sql) && !/INSERT/i.test(sql)) {
        return []; // no row
      }
      return [];
    });

    await expect(
      applyStepResult(client, baseArgs({ stepClass: "A", outboxStore: store })),
    ).rejects.toThrow(/unresolved/i);
  });

  it("SA-9: no «Согласование» registry seeded for the app → throws StepTargetUnresolvedError (T-0575 AC-7)", async () => {
    const { store } = makeOutboxSpy();
    const { client } = makeStubClient((sql, values) => {
      if (/FROM choros\.audit_event/i.test(sql) && !/INSERT/i.test(sql)) {
        return [auditStartedPayload()];
      }
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        return [{ application_id: APPLICATION_ID }];
      }
      if (/FROM choros\.registry_def/i.test(sql)) {
        // Primary registry returns OK; approvals registry returns empty
        if (Array.isArray(values) && values.includes(SOGLASOVANIE_SLUG)) {
          return []; // no approvals registry
        }
        return [{ id: PRIMARY_REGISTRY_ID, slug: "purchases", display_name: "Заявки" }];
      }
      return [];
    });

    // T-0575 [W1/деТЭЛ] BUG-017 (AC-7): the bare 500-worthy Error is now a
    // TYPED, structured error — STEP_TARGET_UNRESOLVED, HTTP 422 — not a
    // generic 500 with no diagnostic code (the BUG-017 "500 without a log"
    // symptom). The tx ROLLBACK / fail-closed semantics are unchanged; only
    // the error's shape/observability improved.
    await expect(
      applyStepResult(client, baseArgs({ stepClass: "A", outboxStore: store })),
    ).rejects.toThrow(StepTargetUnresolvedError);
    await expect(
      applyStepResult(client, baseArgs({ stepClass: "A", outboxStore: store })),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "STEP_TARGET_UNRESOLVED",
    });
  });

  it("SA-10 (T-0575 FF-4/AC-6): target resolved from process_app_binding.target_registry_slug — ARBITRARY slug, not the ТЭЛ-named 'soglasovanie'", async () => {
    const ARBITRARY_SLUG = "zakupki-rezultat";
    const { store, enqueued } = makeOutboxSpy();
    const { client, calls } = makeStubClient((sql, values) => {
      if (/FROM choros\.audit_event/i.test(sql) && !/INSERT/i.test(sql)) {
        return [auditStartedPayload()];
      }
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        // T-0575: binding row carries an EXPLICIT non-ТЭЛ target_registry_slug.
        return [{ application_id: APPLICATION_ID, target_registry_slug: ARBITRARY_SLUG }];
      }
      if (/FROM choros\.registry_def/i.test(sql)) {
        if (Array.isArray(values) && values.includes(ARBITRARY_SLUG)) {
          return [{ id: APPROVALS_REGISTRY_ID, application_id: APPLICATION_ID }];
        }
        // Must NOT be resolved by the old ТЭЛ literal.
        if (Array.isArray(values) && values.includes(SOGLASOVANIE_SLUG)) {
          return [];
        }
        return [{ id: PRIMARY_REGISTRY_ID, slug: "purchases", display_name: "Заявки" }];
      }
      if (/FROM choros\.cross_app_ref/i.test(sql)) return [];
      if (/INSERT INTO choros\.record/i.test(sql)) return [];
      return [];
    });

    const result = await applyStepResult(client, baseArgs({ outboxStore: store }));

    expect(result.kind).toBe("applied-A");
    const applied = result as AppliedA;
    const recordInsert = calls.find((c) => /INSERT INTO choros\.record/i.test(c.sql));
    expect(recordInsert?.values).toContain(APPROVALS_REGISTRY_ID);
    expect(enqueued).toHaveLength(1);
    expect(applied.recordId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------------------------------------------------------------------------
// SA-3: unresolved (no_app_binding) → skipped (sanctioned no-op)
// ---------------------------------------------------------------------------

describe("applyStepResult — sanctioned no-op", () => {
  it("SA-3: unresolved (no_app_binding) → returns skipped without throwing", async () => {
    const { store, enqueued } = makeOutboxSpy();
    const { client } = makeStubClient((sql) => {
      if (/FROM choros\.audit_event/i.test(sql) && !/INSERT/i.test(sql)) {
        return [auditStartedPayload()];
      }
      // no process_app_binding row → resolver returns unresolved(no_app_binding)
      if (/FROM choros\.process_app_binding/i.test(sql)) {
        return [];
      }
      return [];
    });

    const result = await applyStepResult(
      client,
      baseArgs({ stepClass: "A", outboxStore: store }),
    );

    // Must NOT throw — approval commit proceeds
    expect(result.kind).toBe("skipped");
    const skipped = result as Skipped;
    expect(skipped.reason).toMatch(/no app binding/i);

    // Zero outbox rows enqueued (skip path)
    expect(enqueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SA-4: null stepClass → routes to A (never update)
// ---------------------------------------------------------------------------

describe("applyStepResult — F1 default-to-A", () => {
  it("SA-4: stepClass=null → treated as A; record is appended, no update path", async () => {
    const { store, enqueued } = makeOutboxSpy();
    const { client, calls } = makeHappyClient();

    const result = await applyStepResult(
      client,
      baseArgs({ stepClass: null, outboxStore: store }),
    );

    expect(result.kind).toBe("applied-A");

    // One outbox entry — confirms A-path taken, not B (update)
    expect(enqueued).toHaveLength(1);
    expect((enqueued[0] as { eventType: string }).eventType).toBe(STEP_APPLIED_EVENT);

    // No UPDATE SQL was issued (B-path marker)
    const hasUpdate = calls.some((c) =>
      /^UPDATE/i.test(c.sql.trimStart()) && /record/i.test(c.sql),
    );
    expect(hasUpdate).toBe(false);
  });

  it("SA-4b: stepClass=undefined → same as null; routed to A", async () => {
    const { store } = makeOutboxSpy();
    const { client } = makeHappyClient();

    const result = await applyStepResult(
      client,
      baseArgs({ stepClass: undefined, outboxStore: store }),
    );

    expect(result.kind).toBe("applied-A");
  });
});

// ---------------------------------------------------------------------------
// SA-5: stepClass='B' → skipped (T-0344 deferral)
// ---------------------------------------------------------------------------

describe("applyStepResult — B-class deferral", () => {
  it("SA-5: stepClass='B' → returns skipped with T-0344 deferral reason; no INSERT or UPDATE", async () => {
    const { store, enqueued } = makeOutboxSpy();

    // Use a client that would fail if any DB query is issued (B must return before any DB call)
    let dbTouched = false;
    const { client } = makeStubClient(() => {
      dbTouched = true;
      return [];
    });

    const result = await applyStepResult(
      client,
      baseArgs({ stepClass: "B", outboxStore: store }),
    );

    expect(result.kind).toBe("skipped");
    const skipped = result as Skipped;
    expect(skipped.reason).toMatch(/T-0344/);
    expect(skipped.reason).toMatch(/deferred/i);

    // B returns BEFORE hitting the DB
    expect(dbTouched).toBe(false);
    // Zero outbox rows
    expect(enqueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SA-6: duration_ms is threaded into the outbox payload
// ---------------------------------------------------------------------------

describe("applyStepResult — F2 duration threading", () => {
  it("SA-6: durationMs (positive int) is carried in the step_applied outbox payload", async () => {
    const { store, enqueued } = makeOutboxSpy();
    const { client } = makeHappyClient();
    const expectedDuration = NOW_MS - OCCURRED_AT; // 5000 ms

    await applyStepResult(
      client,
      baseArgs({
        durationMs: expectedDuration,
        outboxStore: store,
      }),
    );

    expect(enqueued).toHaveLength(1);
    const payload = (enqueued[0] as { payload: Record<string, unknown> }).payload;
    expect(typeof payload["duration_ms"]).toBe("number");
    expect(payload["duration_ms"]).toBeGreaterThan(0);
    expect(payload["duration_ms"]).toBe(expectedDuration);
  });
});

// ---------------------------------------------------------------------------
// SA-7: cross_app_ref present → ref_field set on record data
// ---------------------------------------------------------------------------

describe("applyStepResult — cross_app_ref write-side", () => {
  it("SA-7: cross_app_ref present → ref_field key inserted in the record INSERT values", async () => {
    const { store } = makeOutboxSpy();
    const { client, calls } = makeHappyClient({
      crossRef: { id: CROSS_APP_REF_ID, ref_field: "purchase_ref", label: "Заявка" },
    });

    const result = await applyStepResult(client, baseArgs({ outboxStore: store }));

    expect(result.kind).toBe("applied-A");

    // The record INSERT should have received JSON that contains purchase_ref
    const recordInsert = calls.find((c) => /INSERT INTO choros\.record/i.test(c.sql));
    expect(recordInsert).toBeDefined();
    // The data JSON param (4th positional param: $4::jsonb)
    const dataJsonParam = recordInsert?.values[3];
    expect(typeof dataJsonParam).toBe("string");
    const data = JSON.parse(dataJsonParam as string);
    expect(data).toHaveProperty("purchase_ref");
    // The ref value must be the instanceId (the correlation key in T-0335)
    expect(data["purchase_ref"]).toBe(INSTANCE_ID);
  });

  it("SA-8: cross_app_ref absent → record created normally, no throw, no ref_field set", async () => {
    const { store, enqueued } = makeOutboxSpy();
    const { client, calls } = makeHappyClient({ crossRef: null });

    const result = await applyStepResult(client, baseArgs({ outboxStore: store }));

    expect(result.kind).toBe("applied-A");
    expect(enqueued).toHaveLength(1);

    const recordInsert = calls.find((c) => /INSERT INTO choros\.record/i.test(c.sql));
    expect(recordInsert).toBeDefined();
    const data = JSON.parse(recordInsert?.values[3] as string);
    // formData fields present (decision, approved_by) — but NO purchase_ref
    expect(data).toHaveProperty("decision", "approve");
    expect(data).not.toHaveProperty("purchase_ref");
  });

  // T-0356 (E16): primaryRecordId path — cross_app_ref uses real record id, not instanceId.
  it("SA-7b: T-0356 — cross_app_ref present + primaryRecordId → ref_field set to primaryRecordId (real record UUID)", async () => {
    const ORIGINATING_RECORD_ID = "aa111111-0000-0000-0000-000000000001";
    const { store } = makeOutboxSpy();
    const { client, calls } = makeHappyClient({
      crossRef: { id: CROSS_APP_REF_ID, ref_field: "purchase_ref", label: "Заявка" },
      primaryRecordId: ORIGINATING_RECORD_ID, // on_create path: resolver carries real record id
    });

    const result = await applyStepResult(client, baseArgs({ outboxStore: store }));

    expect(result.kind).toBe("applied-A");

    const recordInsert = calls.find((c) => /INSERT INTO choros\.record/i.test(c.sql));
    expect(recordInsert).toBeDefined();
    const data = JSON.parse(recordInsert?.values[3] as string);
    expect(data).toHaveProperty("purchase_ref");
    // T-0356: must be the real record id, NOT the instance id (T-0344 gap closed)
    expect(data["purchase_ref"]).toBe(ORIGINATING_RECORD_ID);
    expect(data["purchase_ref"]).not.toBe(INSTANCE_ID);
  });

  it("SA-7c: T-0356 — cross_app_ref present + no primaryRecordId → ref_field falls back to instanceId (launcher path compat)", async () => {
    const { store } = makeOutboxSpy();
    const { client, calls } = makeHappyClient({
      crossRef: { id: CROSS_APP_REF_ID, ref_field: "purchase_ref", label: "Заявка" },
      // No primaryRecordId → launcher path (process-start.ts does not set record_id)
    });

    const result = await applyStepResult(client, baseArgs({ outboxStore: store }));

    expect(result.kind).toBe("applied-A");

    const recordInsert = calls.find((c) => /INSERT INTO choros\.record/i.test(c.sql));
    expect(recordInsert).toBeDefined();
    const data = JSON.parse(recordInsert?.values[3] as string);
    expect(data).toHaveProperty("purchase_ref");
    // Backward-compat: falls back to instanceId when primaryRecordId absent
    expect(data["purchase_ref"]).toBe(INSTANCE_ID);
  });
});
