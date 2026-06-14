/**
 * Unit tests for the T-0123 competence layer (impl-child of ADR T-0123).
 *
 * Covers (static-now, no live DB):
 *  - diffInstruction: semantic per-field changelog, never the raw body (FF-COMP-8/AC-7)
 *  - saveDraft: writes tier='draft', emits agent.instruction.draft_saved, never
 *    tier='published' and never choros.promoting (FF-COMP-4/FF-COMP-7)
 *  - published-lock: saveDraft on a published row throws PUBLISHED_LOCKED, no write,
 *    no audit (FF-COMP-7/AC-5)
 *  - clear: deletes + emits agent.instruction.cleared (AC-14)
 *  - decidePromote (T-0087 reuse): agent self-promote forbidden (AC-6)
 *
 * The DAO runs inside a caller tx; here we inject a FakePgTx that records SQL and
 * simulates the single instruction row, so the app-layer logic is exercised without
 * a database. A recording InMemory-style audit writer captures emitted events.
 */

import { describe, it, expect } from "vitest";
import {
  diffInstruction,
  type AgentInstruction,
  type AgentInstructionDraft,
} from "../core/agent-instruction.js";
import { decidePromote } from "../core/env-tier.js";
import {
  saveDraft,
  clear,
  InstructionPublishedLockedError,
} from "../db/agent-instruction-store.js";
import type { AuditWriter, PgClientLike } from "../db/audit-writer.js";
import type { AuditEventInput } from "../core/audit-grant-encoder.js";

const TENANT = "a0000000-0000-0000-0000-000000000001";
const AGENT = "d0000000-0000-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRow {
  tenant_id: string;
  id: string;
  employee_id: string;
  employee_kind: string;
  tier: string;
  instruction_text: string;
  answer_form: string | null;
  instruction_meta: Record<string, unknown>;
  bundle_id: string | null;
  created_at: number;
  updated_at: number;
}

/** A tiny fake of a tenant tx holding a single agent_instruction row in memory. */
class FakePgTx implements PgClientLike {
  row: FakeRow | null = null;
  readonly executed: string[] = [];

  constructor(initial?: FakeRow) {
    this.row = initial ?? null;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.executed.push(sql);

    if (sql.includes("current_setting('choros.tenant_id', false)") && sql.trim().startsWith("SELECT")) {
      return { rows: [{ tenant_id: TENANT }] };
    }
    if (sql.startsWith("SELECT")) {
      // readByTier / readCurrent
      if (sql.includes("AND tier = $2")) {
        const tier = params[1] as string;
        return { rows: this.row && this.row.tier === tier ? [this.row] : [] };
      }
      return { rows: this.row ? [this.row] : [] };
    }
    if (sql.includes("INSERT INTO choros.agent_instruction")) {
      const [id, employeeId, text, form, metaJson, bundleId, now] = params as [
        string, string, string, string | null, string, string | null, number,
      ];
      this.row = {
        tenant_id: TENANT,
        id,
        employee_id: employeeId,
        employee_kind: "agent",
        tier: "draft",
        instruction_text: text,
        answer_form: form,
        instruction_meta: JSON.parse(metaJson) as Record<string, unknown>,
        bundle_id: bundleId,
        created_at: now,
        updated_at: now,
      };
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM choros.agent_instruction")) {
      this.row = null;
      return { rows: [] };
    }
    return { rows: [] };
  }
}

class RecordingAuditWriter implements AuditWriter {
  readonly events: AuditEventInput[] = [];
  async appendAuditEvent(_tx: PgClientLike, input: AuditEventInput) {
    this.events.push(input);
    return { seq: this.events.length, rowHash: Buffer.alloc(32) };
  }
}

function draftEdition(over: Partial<AgentInstructionDraft> = {}): AgentInstructionDraft {
  return {
    tenantId: TENANT,
    id: "11111111-1111-1111-1111-111111111111",
    employeeId: AGENT,
    instructionText: "Reconcile invoices; answer with the total.",
    answerForm: "sum",
    instructionMeta: {},
    bundleId: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// diffInstruction — semantic changelog (FF-COMP-8 / AC-7)
// ---------------------------------------------------------------------------

describe("diffInstruction (FF-COMP-8 / AC-7)", () => {
  it("first publication: reports changed fields without leaking the body", () => {
    const draft = draftEdition({ instructionText: "do X", answerForm: "sum" });
    const changes = diffInstruction(null, draft);
    const text = changes.find((c) => c.field === "instruction_text");
    expect(text).toEqual({ field: "instruction_text", changed: true });
    // The full body must NOT appear anywhere in the change set.
    expect(JSON.stringify(changes)).not.toContain("do X");
  });

  it("answer_form change surfaces from/to (short form codes, safe)", () => {
    const published: AgentInstruction = {
      tenantId: TENANT, id: "x", employeeId: AGENT, employeeKind: "agent",
      tier: "published", instructionText: "same", answerForm: "sum",
      instructionMeta: {}, bundleId: null, createdAt: 0, updatedAt: 0,
    };
    const draft = draftEdition({ instructionText: "same", answerForm: "sum_with_breakdown" });
    const changes = diffInstruction(published, draft);
    expect(changes).toContainEqual({ field: "answer_form", from: "sum", to: "sum_with_breakdown" });
    // instruction_text unchanged ⇒ not reported.
    expect(changes.find((c) => c.field === "instruction_text")).toBeUndefined();
  });

  it("no changes ⇒ empty set", () => {
    const published: AgentInstruction = {
      tenantId: TENANT, id: "x", employeeId: AGENT, employeeKind: "agent",
      tier: "published", instructionText: "T", answerForm: "sum",
      instructionMeta: { a: 1 }, bundleId: null, createdAt: 0, updatedAt: 0,
    };
    const draft = draftEdition({ instructionText: "T", answerForm: "sum", instructionMeta: { a: 1 } });
    expect(diffInstruction(published, draft)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// saveDraft — draft write + audit (FF-COMP-4 / FF-COMP-7)
// ---------------------------------------------------------------------------

describe("saveDraft (draft write + audit)", () => {
  it("creates a draft row, emits draft_saved, never writes tier='published'", async () => {
    const tx = new FakePgTx();
    const writer = new RecordingAuditWriter();

    const res = await saveDraft(tx, writer, {
      draft: draftEdition(),
      actor: "admin-1",
      actorType: "human",
      nowMs: 1000,
    });

    expect(tx.row?.tier).toBe("draft");
    expect(res.changes.some((c) => c.field === "instruction_text")).toBe(true);

    // Audit emitted with the semantic type + changes payload (not raw body).
    expect(writer.events).toHaveLength(1);
    expect(writer.events[0]!.type).toBe("agent.instruction.draft_saved");
    expect(JSON.stringify(writer.events[0]!.payload)).not.toContain("Reconcile invoices");

    // No SQL ever set tier='published' (promote is promoteTier's job only).
    expect(tx.executed.some((s) => /tier\s*=\s*'published'/.test(s))).toBe(false);
    // No choros.promoting bypass.
    expect(tx.executed.some((s) => /choros\.promoting/.test(s))).toBe(false);
  });

  it("config-agent author leaves confirmed_by null (draft is not a promote)", async () => {
    const tx = new FakePgTx();
    const writer = new RecordingAuditWriter();
    await saveDraft(tx, writer, {
      draft: draftEdition(),
      actor: "config-agent",
      actorType: "agent",
      nowMs: 1,
    });
    expect(writer.events[0]!.confirmed_by).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// published-lock — fail-closed (FF-COMP-7 / AC-5)
// ---------------------------------------------------------------------------

describe("published-lock (FF-COMP-7 / AC-5)", () => {
  it("saveDraft on a published instruction throws PUBLISHED_LOCKED, no write, no audit", async () => {
    const published: FakeRow = {
      tenant_id: TENANT, id: "p", employee_id: AGENT, employee_kind: "agent",
      tier: "published", instruction_text: "locked", answer_form: "sum",
      instruction_meta: {}, bundle_id: null, created_at: 0, updated_at: 0,
    };
    const tx = new FakePgTx(published);
    const writer = new RecordingAuditWriter();

    await expect(
      saveDraft(tx, writer, { draft: draftEdition({ instructionText: "new" }), actor: "admin-1", actorType: "human", nowMs: 2 }),
    ).rejects.toBeInstanceOf(InstructionPublishedLockedError);

    // Row unchanged; no INSERT/UPDATE executed; no audit.
    expect(tx.row?.instruction_text).toBe("locked");
    expect(tx.executed.some((s) => s.includes("INSERT INTO choros.agent_instruction"))).toBe(false);
    expect(writer.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// clear — RED-LINES delete + audit (AC-14)
// ---------------------------------------------------------------------------

describe("clear (AC-14)", () => {
  it("deletes the instruction and emits agent.instruction.cleared", async () => {
    const existing: FakeRow = {
      tenant_id: TENANT, id: "c", employee_id: AGENT, employee_kind: "agent",
      tier: "draft", instruction_text: "x", answer_form: null,
      instruction_meta: {}, bundle_id: null, created_at: 0, updated_at: 0,
    };
    const tx = new FakePgTx(existing);
    const writer = new RecordingAuditWriter();

    const res = await clear(tx, writer, { employeeId: AGENT, actor: "admin-1", nowMs: 3 });
    expect(res.cleared).toBe(true);
    expect(tx.row).toBeNull();
    expect(writer.events[0]!.type).toBe("agent.instruction.cleared");
    expect(writer.events[0]!.confirmed_by).toBe("admin-1");
  });

  it("clearing an absent instruction is a no-op (no audit)", async () => {
    const tx = new FakePgTx();
    const writer = new RecordingAuditWriter();
    const res = await clear(tx, writer, { employeeId: AGENT, actor: "admin-1", nowMs: 4 });
    expect(res.cleared).toBe(false);
    expect(writer.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// promote reuse — agent self-promote forbidden (T-0087, AC-6)
// ---------------------------------------------------------------------------

describe("promote reuses T-0087 decidePromote (AC-6)", () => {
  it("agent actor cannot self-promote the instruction", () => {
    expect(decidePromote({ currentTier: "draft", actorType: "agent" })).toEqual({
      ok: false,
      code: "FORBIDDEN_AGENT_SELF_PROMOTE",
    });
  });
  it("human promotes a draft instruction", () => {
    expect(decidePromote({ currentTier: "draft", actorType: "human" })).toEqual({
      ok: true,
      from: "draft",
      to: "published",
    });
  });
});
