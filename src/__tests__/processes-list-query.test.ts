/**
 * T-0654 [part A / UX-study §5.1] — pure query pipeline for GET /api/processes.
 *
 * Unit-tests the exported, framework-free functions parseProcessListQuery +
 * selectProcessPage in isolation (no HTTP, no pg). These cover the filter/sort/paginate
 * contract deterministically (FF-3 total order, FF-4 honest pagination, FF-5 no visibility
 * widening) — the HTTP wiring over the seed fixture is proven separately in
 * processes.e2e.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  parseProcessListQuery,
  selectProcessPage,
  PROCESS_LIST_DEFAULT_LIMIT,
  PROCESS_LIST_MAX_LIMIT,
  type ProcessInstance,
} from "../http/processes.js";

// --- helpers ---------------------------------------------------------------

/** Minimal IncomingMessage stub — only `url` is read by parseProcessListQuery. */
function req(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

/** Build a ProcessInstance with sensible defaults; override per test. */
function inst(over: Partial<ProcessInstance> & { id: string }): ProcessInstance {
  return {
    name: "Процесс",
    procId: "PRC-X",
    status: "running",
    node: "Шаг",
    started: "01.01.2026 00:00:00",
    elapsed: "—",
    progress: { done: 0, total: 1 },
    execs: ["human"],
    ...over,
  };
}

// --- parseProcessListQuery -------------------------------------------------

describe("T-0654 · parseProcessListQuery", () => {
  it("empty query → all filters null, default pagination", () => {
    const q = parseProcessListQuery(req("/api/processes"), "e-me");
    expect(q).toEqual({
      q: null, definition: null, status: null,
      startedFrom: null, startedTo: null, mineActor: null, record: null,
      limit: PROCESS_LIST_DEFAULT_LIMIT, offset: 0,
    });
  });

  it("blank/whitespace params are treated as absent", () => {
    const q = parseProcessListQuery(req("/api/processes?q=%20&definition=&status=%20"), "e-me");
    expect(q.q).toBeNull();
    expect(q.definition).toBeNull();
    expect(q.status).toBeNull();
  });

  it("trims and captures each string filter", () => {
    const q = parseProcessListQuery(
      req("/api/processes?q=%20hello%20&definition=PRC-A&status=done&record=rec-1"),
      "e-me",
    );
    expect(q.q).toBe("hello");
    expect(q.definition).toBe("PRC-A");
    expect(q.status).toBe("done");
    expect(q.record).toBe("rec-1");
  });

  it("?mine=1|true binds the reading actor; absent/other → null", () => {
    expect(parseProcessListQuery(req("/api/processes?mine=1"), "e-me").mineActor).toBe("e-me");
    expect(parseProcessListQuery(req("/api/processes?mine=true"), "e-me").mineActor).toBe("e-me");
    expect(parseProcessListQuery(req("/api/processes?mine=0"), "e-me").mineActor).toBeNull();
    expect(parseProcessListQuery(req("/api/processes"), "e-me").mineActor).toBeNull();
  });

  it("?mine with a null actor → no mine filter (unauthenticated reader has no 'mine')", () => {
    expect(parseProcessListQuery(req("/api/processes?mine=1"), null).mineActor).toBeNull();
  });

  it("time bounds: epoch-ms integer AND ISO date both parse; junk → null", () => {
    const iso = parseProcessListQuery(req("/api/processes?started_from=2026-01-01T00:00:00Z"), "x");
    expect(iso.startedFrom).toBe(Date.parse("2026-01-01T00:00:00Z"));
    const ms = parseProcessListQuery(req("/api/processes?started_to=1735689600000"), "x");
    expect(ms.startedTo).toBe(1735689600000);
    const junk = parseProcessListQuery(req("/api/processes?started_from=notadate"), "x");
    expect(junk.startedFrom).toBeNull();
  });

  it("limit clamps to [1, MAX]; offset floors at 0; junk → defaults", () => {
    expect(parseProcessListQuery(req("/api/processes?limit=5&offset=10"), "x")).toMatchObject({ limit: 5, offset: 10 });
    expect(parseProcessListQuery(req("/api/processes?limit=99999"), "x").limit).toBe(PROCESS_LIST_MAX_LIMIT);
    expect(parseProcessListQuery(req("/api/processes?limit=0"), "x").limit).toBe(1);
    expect(parseProcessListQuery(req("/api/processes?offset=-5"), "x").offset).toBe(0);
    expect(parseProcessListQuery(req("/api/processes?limit=abc"), "x").limit).toBe(PROCESS_LIST_DEFAULT_LIMIT);
  });
});

// --- selectProcessPage: filters -------------------------------------------

const NONE = parseProcessListQuery(req("/api/processes"), null);
function withQ(url: string, actor: string | null = "e-me") {
  return parseProcessListQuery(req(url), actor);
}

describe("T-0654 · selectProcessPage filters", () => {
  const sample: ProcessInstance[] = [
    inst({ id: "INS-1", name: "Возврат средств", procId: "PRC-REFUND", status: "waiting", node: "Утверждение", startedAtMs: 100, starterId: "e-alice", recordId: "rec-a" }),
    inst({ id: "INS-2", name: "Обработка данных", procId: "PRC-INV", status: "running", node: "Оплата", startedAtMs: 300, starterId: "e-bob" }),
    inst({ id: "INS-3", name: "Закрытие месяца", procId: "PRC-INV", status: "done", node: "Готово", startedAtMs: 200, starterId: "e-alice", recordId: "rec-b" }),
  ];

  it("?q matches name / procId / id / node, case-insensitively", () => {
    expect(selectProcessPage(sample, withQ("/api/processes?q=возврат")).page.map((i) => i.id)).toEqual(["INS-1"]);
    expect(selectProcessPage(sample, withQ("/api/processes?q=prc-inv")).total).toBe(2);
    expect(selectProcessPage(sample, withQ("/api/processes?q=INS-3")).page.map((i) => i.id)).toEqual(["INS-3"]);
    expect(selectProcessPage(sample, withQ("/api/processes?q=оплата")).page.map((i) => i.id)).toEqual(["INS-2"]);
    expect(selectProcessPage(sample, withQ("/api/processes?q=zzz")).total).toBe(0);
  });

  it("?definition is an exact procId match", () => {
    expect(selectProcessPage(sample, withQ("/api/processes?definition=PRC-REFUND")).page.map((i) => i.id)).toEqual(["INS-1"]);
    expect(selectProcessPage(sample, withQ("/api/processes?definition=PRC-INV")).total).toBe(2);
  });

  it("?status is an exact status match", () => {
    expect(selectProcessPage(sample, withQ("/api/processes?status=done")).page.map((i) => i.id)).toEqual(["INS-3"]);
    expect(selectProcessPage(sample, withQ("/api/processes?status=failed")).total).toBe(0);
  });

  it("?mine keeps only instances the actor started; unknown-starter excluded", () => {
    const mine = selectProcessPage(sample, withQ("/api/processes?mine=1", "e-alice"));
    expect(mine.page.map((i) => i.id).sort()).toEqual(["INS-1", "INS-3"]);
    const noStarter = [inst({ id: "INS-9" })]; // no starterId
    expect(selectProcessPage(noStarter, withQ("/api/processes?mine=1", "e-alice")).total).toBe(0);
  });

  it("?record filters to that record only (FF-5: never widens)", () => {
    expect(selectProcessPage(sample, withQ("/api/processes?record=rec-a")).page.map((i) => i.id)).toEqual(["INS-1"]);
    expect(selectProcessPage(sample, withQ("/api/processes?record=rec-zzz")).total).toBe(0);
  });

  it("date bounds are inclusive; unknown-time instance passes a bound (cannot be judged)", () => {
    expect(selectProcessPage(sample, withQ("/api/processes?started_from=200")).total).toBe(2); // 200,300
    expect(selectProcessPage(sample, withQ("/api/processes?started_to=200")).total).toBe(2);   // 100,200
    expect(selectProcessPage(sample, withQ("/api/processes?started_from=150&started_to=250")).page.map((i) => i.id)).toEqual(["INS-3"]);
    const unknown = [inst({ id: "INS-U" })]; // no startedAtMs
    expect(selectProcessPage(unknown, withQ("/api/processes?started_from=999999")).total).toBe(1);
  });

  it("filters compose (definition ∧ status ∧ mine)", () => {
    const q = withQ("/api/processes?definition=PRC-INV&status=done&mine=1", "e-alice");
    expect(selectProcessPage(sample, q).page.map((i) => i.id)).toEqual(["INS-3"]);
  });
});

// --- selectProcessPage: sort + pagination ---------------------------------

describe("T-0654 · selectProcessPage sort + pagination (FF-3/FF-4)", () => {
  const items: ProcessInstance[] = [
    inst({ id: "INS-b", startedAtMs: 100 }),
    inst({ id: "INS-a", startedAtMs: 300 }),
    inst({ id: "INS-c", startedAtMs: 200 }),
    inst({ id: "INS-e" }), // unknown time
    inst({ id: "INS-d" }), // unknown time
  ];

  it("orders newest-first, unknown-time last, ties broken by id ASC — a TOTAL order", () => {
    const { page } = selectProcessPage(items, NONE);
    expect(page.map((i) => i.id)).toEqual(["INS-a", "INS-c", "INS-b", "INS-d", "INS-e"]);
  });

  it("is deterministic under input shuffling (FF-3)", () => {
    const shuffled = [items[3], items[1], items[4], items[0], items[2]] as ProcessInstance[];
    const a = selectProcessPage(items, NONE).page.map((i) => i.id);
    const b = selectProcessPage(shuffled, NONE).page.map((i) => i.id);
    expect(a).toEqual(b);
  });

  it("ties on equal startedAtMs break by id ASC", () => {
    const tied = [inst({ id: "INS-z", startedAtMs: 50 }), inst({ id: "INS-a", startedAtMs: 50 })];
    expect(selectProcessPage(tied, NONE).page.map((i) => i.id)).toEqual(["INS-a", "INS-z"]);
  });

  it("does not mutate the caller's array", () => {
    const original = items.map((i) => i.id);
    selectProcessPage(items, NONE);
    expect(items.map((i) => i.id)).toEqual(original);
  });

  it("paginates: total is the FILTERED size (before slice); page is a pure slice (FF-4)", () => {
    const p1 = selectProcessPage(items, withQ("/api/processes?limit=2&offset=0"));
    expect(p1.total).toBe(5);
    expect(p1.page.map((i) => i.id)).toEqual(["INS-a", "INS-c"]);
    const p2 = selectProcessPage(items, withQ("/api/processes?limit=2&offset=2"));
    expect(p2.total).toBe(5);
    expect(p2.page.map((i) => i.id)).toEqual(["INS-b", "INS-d"]);
  });

  it("offset past the end → empty page, total unchanged", () => {
    const { page, total } = selectProcessPage(items, withQ("/api/processes?limit=10&offset=100"));
    expect(page).toEqual([]);
    expect(total).toBe(5);
  });
});
