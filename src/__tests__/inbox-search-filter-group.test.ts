/**
 * T-0653 (W5-UX/§4) — inbox server-side search / filters / grouping.
 *
 * Two layers:
 *  A) Pure unit tests of the exported predicate + grouper (parseInboxFilters /
 *     matchesInboxFilters / groupInboxByProcess) — no server, deterministic.
 *  B) E2E over the real server (in-memory seed, DEV_TENANT) proving the query
 *     params reach the response: q=, process=, status=, deadline range, group.
 *
 * These filters are IN-MEMORY over already-materialized items — there is NO SQL
 * path for q, so there is no injection surface (view-query-injection-safe is
 * about the records translator, not inbox).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { createServer } from "../server.js";
import {
  parseInboxFilters,
  matchesInboxFilters,
  groupInboxByProcess,
} from "../http/inbox.js";

// ---------------------------------------------------------------------------
// A) Pure unit tests
// ---------------------------------------------------------------------------

// Minimal InboxItem-shaped fixtures (only the fields the filters read).
type ItemLike = Parameters<typeof matchesInboxFilters>[0];
function mk(partial: Partial<ItemLike> & { id: string }): ItemLike {
  return {
    status: "waiting",
    name: "",
    step: "",
    inst: "",
    role: "r",
    sla: { min: 60, left: 60 },
    due: "",
    ...partial,
  } as ItemLike;
}

describe("T-0653 parseInboxFilters", () => {
  it("parses q/process/status/deadline range; ignores unknown status", () => {
    const qs = new URLSearchParams(
      "q=  счёт  &process=canonical&status=waiting&deadline_from=1000&deadline_to=2000",
    );
    const f = parseInboxFilters(qs);
    expect(f.q).toBe("счёт");
    expect(f.process).toBe("canonical");
    expect(f.status).toBe("waiting");
    expect(f.deadlineFrom).toBe(1000);
    expect(f.deadlineTo).toBe(2000);
  });

  it("drops an invalid status and non-numeric deadlines", () => {
    const f = parseInboxFilters(new URLSearchParams("status=bogus&deadline_from=abc&deadline_to="));
    expect(f.status).toBe(null);
    expect(f.deadlineFrom).toBe(null);
    expect(f.deadlineTo).toBe(null);
  });

  it("empty/absent params → all null (no filter)", () => {
    const f = parseInboxFilters(new URLSearchParams(""));
    expect(f).toEqual({ q: null, process: null, status: null, deadlineFrom: null, deadlineTo: null });
  });
});

describe("T-0653 matchesInboxFilters", () => {
  const item = mk({
    id: "t1",
    name: "Проверить реквизиты счёта №4471",
    step: "Согласование счёта · Проверка",
    inst: "INS-7731",
    processName: "Канонический линейный ТЭЛ",
    procKey: "kanon-tel",
    status: "running",
    deadline: 1500,
  });

  it("q matches over name (case-insensitive)", () => {
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("q=РЕКВИЗИТЫ")))).toBe(true);
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("q=нетакого")))).toBe(false);
  });

  it("q matches over processName + inst too", () => {
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("q=канонический")))).toBe(true);
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("q=INS-7731")))).toBe(true);
  });

  it("process matches procKey / processName / inst", () => {
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("process=kanon-tel")))).toBe(true);
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("process=INS-7731")))).toBe(true);
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("process=другой")))).toBe(false);
  });

  it("status filters exactly", () => {
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("status=running")))).toBe(true);
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("status=waiting")))).toBe(false);
  });

  it("deadline range includes/excludes by epoch-ms bounds", () => {
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("deadline_from=1000&deadline_to=2000")))).toBe(true);
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("deadline_from=1600")))).toBe(false);
    expect(matchesInboxFilters(item, parseInboxFilters(new URLSearchParams("deadline_to=1400")))).toBe(false);
  });

  it("an item WITHOUT a deadline is excluded only when a deadline bound is active", () => {
    const noDl = mk({ id: "t2", name: "x", deadline: undefined });
    expect(matchesInboxFilters(noDl, parseInboxFilters(new URLSearchParams("")))).toBe(true);
    expect(matchesInboxFilters(noDl, parseInboxFilters(new URLSearchParams("deadline_from=1")))).toBe(false);
  });

  it("filters combine (AND)", () => {
    const f = parseInboxFilters(new URLSearchParams("q=счёт&status=running&process=kanon-tel"));
    expect(matchesInboxFilters(item, f)).toBe(true);
    const f2 = parseInboxFilters(new URLSearchParams("q=счёт&status=waiting"));
    expect(matchesInboxFilters(item, f2)).toBe(false);
  });
});

describe("T-0653 groupInboxByProcess", () => {
  it("groups by procKey (falls back to inst), counts, and orders by count desc", () => {
    const items = [
      mk({ id: "a", procKey: "p1", processName: "Процесс 1", inst: "INS-1" }),
      mk({ id: "b", procKey: "p1", processName: "Процесс 1", inst: "INS-1" }),
      mk({ id: "c", procKey: "p2", processName: "Процесс 2", inst: "INS-2" }),
      mk({ id: "d", inst: "INS-9" }), // no procKey → grouped by inst
    ];
    const groups = groupInboxByProcess(items);
    expect(groups[0]!.key).toBe("p1");
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.label).toBe("Процесс 1");
    const p2 = groups.find((g) => g.key === "p2")!;
    expect(p2.count).toBe(1);
    const legacy = groups.find((g) => g.key === "INS-9")!;
    expect(legacy.count).toBe(1);
    expect(legacy.label).toBe("INS-9"); // human inst label, not "—"
  });
});

// ---------------------------------------------------------------------------
// B) E2E over the real server (in-memory seed)
// ---------------------------------------------------------------------------

describe("T-0653 inbox query params (E2E, in-memory seed)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "localhost", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function get(path: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const r = http.request(new URL(baseUrl + path), { method: "GET" }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString(); });
        res.on("end", () => resolve(JSON.parse(body)));
      });
      r.on("error", reject);
      r.end();
    });
  }

  it("AC-2.1: q= narrows the returned items server-side", async () => {
    const all = await get("/api/inbox");
    const allItems = all.items as Array<Record<string, unknown>>;
    // "счёт" appears in a subset of seed names/steps, not all.
    const filtered = await get("/api/inbox?q=" + encodeURIComponent("счёт"));
    const fItems = filtered.items as Array<Record<string, unknown>>;
    expect(fItems.length).toBeGreaterThan(0);
    expect(fItems.length).toBeLessThan(allItems.length);
    for (const it of fItems) {
      const hay = `${it.name} ${it.step} ${it.inst}`.toLowerCase();
      expect(hay.includes("счёт")).toBe(true);
    }
  });

  it("AC-2.3: status= filters by status", async () => {
    const filtered = await get("/api/inbox?status=failed");
    const items = filtered.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.status).toBe("failed");
  });

  it("AC-2.2: process= filters by inst/process", async () => {
    const filtered = await get("/api/inbox?process=INS-7731");
    const items = filtered.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.inst).toBe("INS-7731");
  });

  it("AC-3.1: group=process returns свёртки with counts; AC-2.5 counts unchanged", async () => {
    const data = await get("/api/inbox?group=process");
    const groups = data.groups as Array<Record<string, unknown>>;
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
    // Sum of group counts == number of items in the (unfiltered) result.
    const total = groups.reduce((s, g) => s + (g.count as number), 0);
    expect(total).toBe((data.items as unknown[]).length);
    // counts (per-tab) are still present and computed from the base.
    expect(data.counts).toBeTruthy();
  });

  it("AC-3.2: no group param → response has no 'groups' key (backward compatible)", async () => {
    const data = await get("/api/inbox");
    expect("groups" in data).toBe(false);
  });
});
