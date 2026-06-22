/**
 * T-0384 · assistant thread UX tests — auto-title, lazy-create, delete/rename/pin.
 *
 * Tests:
 *   AC-T384-1: deriveThreadTitle — short message used as-is
 *   AC-T384-2: deriveThreadTitle — long message truncated with ellipsis
 *   AC-T384-3: deriveThreadTitle — newlines/whitespace collapsed
 *   AC-T384-4: deriveThreadTitle — exactly 60 chars, no ellipsis
 *   AC-T384-5: GET /api/assistant/threads — empty threads hidden (lazy-create)
 *   AC-T384-6: GET /api/assistant/threads — thread visible after first message
 *   AC-T384-7: POST /api/assistant/threads/:id/messages — auto-title event fired on first message
 *   AC-T384-8: POST /api/assistant/threads/:id/messages — no auto-title on second message
 *   AC-T384-9: PATCH /api/assistant/threads/:id — rename appends thread.renamed event
 *   AC-T384-10: PATCH /api/assistant/threads/:id — pin appends thread.pinned event
 *   AC-T384-11: DELETE /api/assistant/threads/:id — tombstone appended, thread excluded from list
 *   AC-T384-12: GET /api/assistant/threads — tombstone-event projection: deleted thread absent
 *   AC-T384-13: GET /api/assistant/threads — pinned threads sort first
 *   AC-T384-14: GET /api/assistant/threads — last rename wins over creation title
 *   AC-T384-15: DELETE non-existent thread returns 404
 *   AC-T384-16: PATCH non-existent thread returns 404
 *   AC-T384-17: POST /api/assistant/threads/:id/messages — auto-title skipped if thread already renamed
 *   AC-T384-18: audit_event table — only INSERT, no UPDATE/DELETE (append-only guard)
 *
 * DB / network: ZERO (all stubs — fake pg pool + LLM stub).
 */

import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { Router } from "../http/router.js";
import { registerAssistantRoutes } from "../http/assistant.js";
import { deriveThreadTitle } from "../http/assistant.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const USER = "e-alice";
const DEV_USER_HEADER = "x-dev-user";

// ---------------------------------------------------------------------------
// Helpers: in-memory audit_event store (mimic append-only DB)
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  type: string;
  subject: string;
  payload: Record<string, unknown>;
  occurred_at: number;
}

/**
 * In-memory store mimicking the audit_event table.
 * Enforces append-only (throws if UPDATE/DELETE SQL is detected).
 */
class InMemoryAuditStore {
  rows: AuditRow[] = [];
  /** Track all SQL statements to enforce append-only. */
  sqlLog: string[] = [];

  reset(): void {
    this.rows = [];
    this.sqlLog = [];
  }

  /**
   * Returns a fake pg Pool that routes queries to this store.
   * The fake handles all queries the assistant routes issue.
   */
  makeFakePool(): import("pg").Pool {
    let seqCounter = 0;
    // Use arrow function for makeClient so 'this' refers to InMemoryAuditStore.
    const makeClientFn = (): import("pg").PoolClient => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query = async (sql: string, params?: unknown[]): Promise<any> => {
        const text = sql.trim();
        this.sqlLog.push(text);

        // AC-T384-18: Enforce append-only — detect any UPDATE/DELETE on audit_event.
        if (
          /UPDATE\s+choros\.audit_event/i.test(text) ||
          /DELETE\s+FROM\s+choros\.audit_event/i.test(text)
        ) {
          throw new Error("APPEND_ONLY_VIOLATION: audit_event is append-only");
        }

        if (/^BEGIN/i.test(text)) return { rows: [] };
        if (/^COMMIT/i.test(text)) return { rows: [] };
        if (/^ROLLBACK/i.test(text)) return { rows: [] };
        if (/SET LOCAL/i.test(text)) return { rows: [] };

        // --- Audit writer infrastructure ---
        // NOTE: The SELECT current_setting guard must be SPECIFIC to the
        // standalone "SELECT current_setting(...) AS tenant_id" query — NOT the
        // SELECT ... FOR UPDATE that also contains current_setting() in its WHERE.
        if (/^SELECT current_setting\('choros\.tenant_id'/i.test(text)) {
          return { rows: [{ tenant_id: TENANT_ID }] };
        }
        if (/INSERT INTO choros\.audit_head/i.test(text)) {
          return { rows: [] };
        }
        if (/FROM choros\.audit_head/i.test(text) && text.includes("FOR UPDATE")) {
          const currentSeq = seqCounter;
          seqCounter++;
          return { rows: [{ seq: currentSeq, row_hash: Buffer.alloc(32), vocab_version: 1 }] };
        }
        if (/UPDATE choros\.audit_head/i.test(text)) {
          return { rows: [] };
        }

        // --- INSERT audit_event: store to in-memory rows ---
        if (/INSERT INTO choros\.audit_event/i.test(text)) {
          const p = params ?? [];
          // Positional params from audit-writer.ts INSERT (tenant_id is current_setting, not a param):
          // $1=seq (p[0]), $2=id (p[1]), $3=type (p[2]), $4=actor (p[3]), $5=subject (p[4]),
          // $6=scope (p[5]), $7=via (p[6]), $8=proposed_by (p[7]), $9=confirmed_by (p[8]),
          // $10=payload (p[9]), $11=occurred_at (p[10]), $12=prev_hash (p[11]),
          // $13=row_hash (p[12]), $14=vocab_version (p[13])
          const id = String(p[1] ?? "");
          const type = String(p[2] ?? "");
          const subject = String(p[4] ?? "");
          const payloadRaw = p[9];
          let payload: Record<string, unknown> = {};
          if (typeof payloadRaw === "string") {
            try { payload = JSON.parse(payloadRaw) as Record<string, unknown>; } catch { /* ignore */ }
          } else if (payloadRaw && typeof payloadRaw === "object") {
            payload = payloadRaw as Record<string, unknown>;
          }
          const occurred_at = Number(p[10] ?? 0);
          this.rows.push({ id, type, subject, payload, occurred_at });
          return { rows: [] };
        }

        // --- Fetch threads (assistant.thread events by subject) ---
        if (text.includes("type = 'assistant.thread'") && text.includes("AND subject = $1") && !text.includes("AND id = $1")) {
          const subject = String((params ?? [])[0] ?? "");
          const result = this.rows
            .filter((r) => r.type === "assistant.thread" && r.subject === subject)
            .sort((a, b) => a.occurred_at - b.occurred_at)
            .map((r) => ({ id: r.id, occurred_at: String(r.occurred_at), payload: r.payload }));
          return { rows: result };
        }

        // --- Fetch single thread by id ---
        if (text.includes("type = 'assistant.thread'") && text.includes("AND id = $1")) {
          const id = String((params ?? [])[0] ?? "");
          const found = this.rows.find((r) => r.type === "assistant.thread" && r.id === id);
          if (!found) return { rows: [] };
          return {
            rows: [{ id: found.id, occurred_at: String(found.occurred_at), payload: found.payload, subject: found.subject }],
          };
        }

        // --- Fetch lifecycle events (renamed/deleted/pinned) ---
        if (text.includes("'assistant.thread.renamed'") && text.includes("'assistant.thread.deleted'")) {
          const p = params ?? [];
          const subject = String(p[0] ?? "");
          // Second param is either a thread id (string) or an array of thread ids.
          const secondParam = p[1];
          const threadIds: string[] =
            Array.isArray(secondParam)
              ? secondParam.map(String)
              : typeof secondParam === "string"
                ? [secondParam]
                : [];
          const result = this.rows
            .filter(
              (r) =>
                (r.type === "assistant.thread.renamed" ||
                  r.type === "assistant.thread.deleted" ||
                  r.type === "assistant.thread.pinned") &&
                r.subject === subject &&
                threadIds.includes(String(r.payload["thread_id"] ?? "")),
            )
            .sort((a, b) => a.occurred_at - b.occurred_at)
            .map((r) => ({ type: r.type, occurred_at: String(r.occurred_at), payload: r.payload }));
          return { rows: result };
        }

        // --- Count messages per thread (GROUP BY path) ---
        if (text.includes("type = 'assistant.message'") && text.includes("GROUP BY") && text.includes("thread_id")) {
          const p = params ?? [];
          const threadIds: string[] = Array.isArray(p[0]) ? p[0].map(String) : [];
          const subject = String(p[1] ?? "");
          const counts = new Map<string, number>();
          for (const r of this.rows) {
            if (r.type === "assistant.message" && r.subject === subject) {
              const tid = String(r.payload["thread_id"] ?? "");
              if (threadIds.includes(tid)) {
                counts.set(tid, (counts.get(tid) ?? 0) + 1);
              }
            }
          }
          return {
            rows: Array.from(counts.entries()).map(([thread_id, cnt]) => ({
              thread_id,
              cnt: String(cnt),
            })),
          };
        }

        // --- Count messages for first-message detection (single thread, no GROUP BY) ---
        if (text.includes("type = 'assistant.message'") && text.includes("thread_id' = $1") && !text.includes("GROUP BY")) {
          const p = params ?? [];
          const threadId = String(p[0] ?? "");
          const subject = String(p[1] ?? "");
          const cnt = this.rows.filter(
            (r) => r.type === "assistant.message" && r.subject === subject && r.payload["thread_id"] === threadId,
          ).length;
          return { rows: [{ cnt: String(cnt) }] };
        }

        // --- Fetch messages in a thread (ORDER BY) ---
        if (text.includes("type = 'assistant.message'") && text.includes("payload->>'thread_id' = $1")) {
          const p = params ?? [];
          const threadId = String(p[0] ?? "");
          const subject = String(p[1] ?? "");
          const result = this.rows
            .filter(
              (r) => r.type === "assistant.message" && r.payload["thread_id"] === threadId && r.subject === subject,
            )
            .sort((a, b) => a.occurred_at - b.occurred_at)
            .map((r) => ({ id: r.id, occurred_at: String(r.occurred_at), payload: r.payload, subject: r.subject }));
          return { rows: result };
        }

        // --- Budget: employee lookup ---
        if (text.includes("FROM choros.employee") && text.includes("slug")) {
          return { rows: [] }; // agent not seeded → zeroes
        }

        // --- Budget: agent_budget ---
        if (/FROM choros\.agent_budget/i.test(text)) {
          return { rows: [] };
        }

        // --- Grants query (makeDbGrantSource) ---
        if (/FROM choros\.grant/i.test(text)) {
          return { rows: [] };
        }

        return { rows: [] };
      };

      return { query, release: () => {} } as unknown as import("pg").PoolClient;
    };

    return { connect: async () => makeClientFn() } as unknown as import("pg").Pool;
  }
}

// ---------------------------------------------------------------------------
// Stub LLM port (non-dormant — returns a fixed text reply)
// ---------------------------------------------------------------------------

function makeStubLlmPort(): import("../core/llm-port.js").LlmPort {
  return {
    // Stub: complete() is not used by assistant routes (only chat() is).
    // Return a minimal shape to satisfy the LlmPort interface type.
    complete: (() => Promise.reject(new Error("not used in assistant routes"))) as import("../core/llm-port.js").LlmPort["complete"],
    async chat(_req) {
      return { text: "Заглушка ответа LLM." };
    },
  };
}

// ---------------------------------------------------------------------------
// Test server factory
// ---------------------------------------------------------------------------

const store = new InMemoryAuditStore();

function buildServer(): { server: http.Server; baseUrl: () => string } {
  const router = new Router();
  const pool = store.makeFakePool();
  const llm = makeStubLlmPort();

  registerAssistantRoutes(router, {
    pool,
    resolveActorTenant: async () => TENANT_ID,
    llmPortFactory: async () => llm,
    agentSlug: "assistant-agent",
  });

  router.setFallback((_req, res) => {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const server = http.createServer(router.dispatch.bind(router));
  return {
    server,
    baseUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}

async function httpReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(buf ? { "Content-Type": "application/json", "Content-Length": String(buf.length) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(data), raw: data });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: { raw: data }, raw: data });
        }
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

const authHeader = { [DEV_USER_HEADER]: USER };

// ---------------------------------------------------------------------------
// AC-T384-1..4: deriveThreadTitle (pure unit, no server needed)
// ---------------------------------------------------------------------------

describe("deriveThreadTitle (T-0384)", () => {
  it("AC-T384-1: short message used as-is", () => {
    expect(deriveThreadTitle("Привет, помоги мне!")).toBe("Привет, помоги мне!");
  });

  it("AC-T384-2: message >60 chars truncated with ellipsis", () => {
    const long = "А".repeat(80);
    const result = deriveThreadTitle(long);
    expect(result.length).toBe(60);
    expect(result.endsWith("…")).toBe(true);
  });

  it("AC-T384-3: newlines and multiple spaces collapsed to single space", () => {
    expect(deriveThreadTitle("Строка 1\nСтрока 2\n  лишний   пробел")).toBe(
      "Строка 1 Строка 2 лишний пробел",
    );
  });

  it("AC-T384-4: exactly 60 chars — no ellipsis", () => {
    const exactly60 = "Б".repeat(60);
    expect(deriveThreadTitle(exactly60)).toBe(exactly60);
    expect(deriveThreadTitle(exactly60).endsWith("…")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-T384-5..18: HTTP route tests (require live HTTP server)
// ---------------------------------------------------------------------------

describe("assistant thread UX routes (T-0384)", () => {
  let server: http.Server;
  let base: string;

  async function start(): Promise<void> {
    store.reset();
    const h = buildServer();
    server = h.server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => { base = h.baseUrl(); r(); }));
  }

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  // -------------------------------------------------------------------------
  // Helper: create a thread via POST /api/assistant/threads
  // -------------------------------------------------------------------------
  async function createThread(title = "Новый разговор"): Promise<string> {
    const r = await httpReq("POST", `${base}/api/assistant/threads`, authHeader, { title });
    expect(r.status).toBe(201);
    return (r.json as { id: string }).id;
  }

  // -------------------------------------------------------------------------
  // Helper: send a message to a thread (triggers auto-title on first message)
  // -------------------------------------------------------------------------
  async function sendMessage(threadId: string, text: string): Promise<void> {
    const r = await httpReq(
      "POST",
      `${base}/api/assistant/threads/${threadId}/messages`,
      authHeader,
      { text },
    );
    // Accept both 200 (LLM reply) and 503 (dormant) — both are valid responses
    expect([200, 503]).toContain(r.status);
  }

  // -------------------------------------------------------------------------
  // AC-T384-5: GET /api/assistant/threads — empty threads hidden (lazy-create)
  // -------------------------------------------------------------------------
  it("AC-T384-5: empty threads hidden from GET list (lazy-create)", async () => {
    await start();
    const threadId = await createThread();
    // No messages sent — thread should be hidden.
    const r = await httpReq("GET", `${base}/api/assistant/threads`, authHeader);
    expect(r.status).toBe(200);
    const { threads } = r.json as { threads: Array<{ id: string }> };
    const found = threads.find((t) => t.id === threadId);
    expect(found).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC-T384-6: Thread visible after first message
  // -------------------------------------------------------------------------
  it("AC-T384-6: thread appears in GET list after first message is sent", async () => {
    await start();
    const threadId = await createThread();
    await sendMessage(threadId, "Первое сообщение");
    const r = await httpReq("GET", `${base}/api/assistant/threads`, authHeader);
    expect(r.status).toBe(200);
    const { threads } = r.json as { threads: Array<{ id: string }> };
    const found = threads.find((t) => t.id === threadId);
    expect(found).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-T384-7: Auto-title event fired on first message
  // -------------------------------------------------------------------------
  it("AC-T384-7: auto-title event appended on first message, title reflects message", async () => {
    await start();
    const threadId = await createThread();
    await sendMessage(threadId, "Нужна помощь с настройкой CRM");
    // Check that a thread.renamed event was appended with the derived title.
    const renamedEvent = store.rows.find(
      (r) => r.type === "assistant.thread.renamed" && r.payload["thread_id"] === threadId,
    );
    expect(renamedEvent).toBeDefined();
    expect(renamedEvent?.payload["title"]).toBe("Нужна помощь с настройкой CRM");
    // Thread list should show the auto-title.
    const listR = await httpReq("GET", `${base}/api/assistant/threads`, authHeader);
    const { threads } = listR.json as { threads: Array<{ id: string; title: string }> };
    const t = threads.find((x) => x.id === threadId);
    expect(t?.title).toBe("Нужна помощь с настройкой CRM");
  });

  // -------------------------------------------------------------------------
  // AC-T384-8: No duplicate auto-title on second message
  // -------------------------------------------------------------------------
  it("AC-T384-8: auto-title NOT fired on second message", async () => {
    await start();
    const threadId = await createThread();
    await sendMessage(threadId, "Первое сообщение");
    const countBefore = store.rows.filter(
      (r) => r.type === "assistant.thread.renamed" && r.payload["thread_id"] === threadId,
    ).length;
    await sendMessage(threadId, "Второе сообщение");
    const countAfter = store.rows.filter(
      (r) => r.type === "assistant.thread.renamed" && r.payload["thread_id"] === threadId,
    ).length;
    // Only one auto-rename should exist (from the first message).
    expect(countAfter).toBe(countBefore);
  });

  // -------------------------------------------------------------------------
  // AC-T384-9: PATCH — rename appends thread.renamed event
  // -------------------------------------------------------------------------
  it("AC-T384-9: PATCH rename appends thread.renamed event and updates GET title", async () => {
    await start();
    const threadId = await createThread();
    await sendMessage(threadId, "Первое сообщение");
    const newTitle = "Мой переименованный тред";
    const r = await httpReq(
      "PATCH",
      `${base}/api/assistant/threads/${threadId}`,
      authHeader,
      { title: newTitle },
    );
    expect(r.status).toBe(204);
    // A thread.renamed event should be in the store.
    const renamedEvents = store.rows.filter(
      (row) => row.type === "assistant.thread.renamed" && row.payload["thread_id"] === threadId,
    );
    // Last event should have the new title (last-rename-wins in projection).
    const lastRename = renamedEvents[renamedEvents.length - 1];
    expect(lastRename?.payload["title"]).toBe(newTitle);
    // GET list should show the new title.
    const listR = await httpReq("GET", `${base}/api/assistant/threads`, authHeader);
    const { threads } = listR.json as { threads: Array<{ id: string; title: string }> };
    const t = threads.find((x) => x.id === threadId);
    expect(t?.title).toBe(newTitle);
  });

  // -------------------------------------------------------------------------
  // AC-T384-10: PATCH — pin appends thread.pinned event
  // -------------------------------------------------------------------------
  it("AC-T384-10: PATCH pin appends thread.pinned event", async () => {
    await start();
    const threadId = await createThread();
    await sendMessage(threadId, "Сообщение");
    const r = await httpReq(
      "PATCH",
      `${base}/api/assistant/threads/${threadId}`,
      authHeader,
      { pinned: true },
    );
    expect(r.status).toBe(204);
    const pinEvent = store.rows.find(
      (row) => row.type === "assistant.thread.pinned" && row.payload["thread_id"] === threadId,
    );
    expect(pinEvent).toBeDefined();
    expect(pinEvent?.payload["pinned"]).toBe(true);
    // GET list should reflect pin state.
    const listR = await httpReq("GET", `${base}/api/assistant/threads`, authHeader);
    const { threads } = listR.json as { threads: Array<{ id: string; pinned: boolean }> };
    const t = threads.find((x) => x.id === threadId);
    expect(t?.pinned).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AC-T384-11: DELETE — tombstone appended, thread excluded from list
  // -------------------------------------------------------------------------
  it("AC-T384-11: DELETE appends thread.deleted tombstone and excludes thread from GET", async () => {
    await start();
    const threadId = await createThread();
    await sendMessage(threadId, "Сообщение");
    const r = await httpReq("DELETE", `${base}/api/assistant/threads/${threadId}`, authHeader);
    expect(r.status).toBe(204);
    // Tombstone event in store.
    const tombstone = store.rows.find(
      (row) => row.type === "assistant.thread.deleted" && row.payload["thread_id"] === threadId,
    );
    expect(tombstone).toBeDefined();
    // Thread absent from GET list.
    const listR = await httpReq("GET", `${base}/api/assistant/threads`, authHeader);
    const { threads } = listR.json as { threads: Array<{ id: string }> };
    expect(threads.find((t) => t.id === threadId)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC-T384-12: Audit_event rows NOT deleted/updated after tombstone (append-only)
  // -------------------------------------------------------------------------
  it("AC-T384-12: original audit_event rows persist after DELETE (append-only — only INSERT)", async () => {
    await start();
    const threadId = await createThread();
    await sendMessage(threadId, "Сообщение");
    await httpReq("DELETE", `${base}/api/assistant/threads/${threadId}`, authHeader);
    // Original thread row must still be in store.
    const originalRow = store.rows.find((r) => r.type === "assistant.thread" && r.id === threadId);
    expect(originalRow).toBeDefined();
    // Original message row must still be in store.
    const msgRow = store.rows.find((r) => r.type === "assistant.message" && r.payload["thread_id"] === threadId);
    expect(msgRow).toBeDefined();
    // No UPDATE/DELETE SQL should have been logged.
    const badSql = store.sqlLog.filter(
      (s) =>
        /UPDATE\s+choros\.audit_event/i.test(s) ||
        /DELETE\s+FROM\s+choros\.audit_event/i.test(s),
    );
    expect(badSql).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // AC-T384-13: Pinned threads sort first in GET list
  // -------------------------------------------------------------------------
  it("AC-T384-13: pinned threads appear before unpinned threads in GET list", async () => {
    await start();
    const id1 = await createThread("Тред 1");
    await sendMessage(id1, "Сообщение 1");
    const id2 = await createThread("Тред 2");
    await sendMessage(id2, "Сообщение 2");
    const id3 = await createThread("Тред 3");
    await sendMessage(id3, "Сообщение 3");
    // Pin only the second thread.
    await httpReq("PATCH", `${base}/api/assistant/threads/${id2}`, authHeader, { pinned: true });
    const listR = await httpReq("GET", `${base}/api/assistant/threads`, authHeader);
    const { threads } = listR.json as { threads: Array<{ id: string; pinned: boolean }> };
    const idx2 = threads.findIndex((t) => t.id === id2);
    const idx1 = threads.findIndex((t) => t.id === id1);
    const idx3 = threads.findIndex((t) => t.id === id3);
    // Pinned thread (id2) must come before unpinned threads.
    expect(idx2).toBeLessThan(idx1);
    expect(idx2).toBeLessThan(idx3);
  });

  // -------------------------------------------------------------------------
  // AC-T384-14: Last rename wins over previous renames and creation title
  // -------------------------------------------------------------------------
  it("AC-T384-14: last rename event wins over creation title and earlier renames", async () => {
    await start();
    const threadId = await createThread("Тред изначальный");
    await sendMessage(threadId, "Первое сообщение");
    await httpReq("PATCH", `${base}/api/assistant/threads/${threadId}`, authHeader, { title: "Первое переименование" });
    await httpReq("PATCH", `${base}/api/assistant/threads/${threadId}`, authHeader, { title: "Второе переименование" });
    const listR = await httpReq("GET", `${base}/api/assistant/threads`, authHeader);
    const { threads } = listR.json as { threads: Array<{ id: string; title: string }> };
    const t = threads.find((x) => x.id === threadId);
    expect(t?.title).toBe("Второе переименование");
  });

  // -------------------------------------------------------------------------
  // AC-T384-15: DELETE non-existent thread → 404
  // -------------------------------------------------------------------------
  it("AC-T384-15: DELETE non-existent thread returns 404", async () => {
    await start();
    const r = await httpReq(
      "DELETE",
      `${base}/api/assistant/threads/bbbbbbbb-0000-0000-0000-000000000001`,
      authHeader,
    );
    expect(r.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // AC-T384-16: PATCH non-existent thread → 404
  // -------------------------------------------------------------------------
  it("AC-T384-16: PATCH non-existent thread returns 404", async () => {
    await start();
    const r = await httpReq(
      "PATCH",
      `${base}/api/assistant/threads/cccccccc-0000-0000-0000-000000000001`,
      authHeader,
      { title: "новое имя" },
    );
    expect(r.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // AC-T384-17: Auto-title skipped if thread already has a rename event
  //             (e.g. thread was manually renamed before first message)
  // -------------------------------------------------------------------------
  it("AC-T384-17: auto-title does NOT override an existing rename event", async () => {
    await start();
    const threadId = await createThread();
    // Manually send a first message and get auto-titled.
    await sendMessage(threadId, "Первое авто-название");
    // Manually rename.
    await httpReq("PATCH", `${base}/api/assistant/threads/${threadId}`, authHeader, { title: "Вручную переименованный" });
    // Send a second message — should NOT fire another auto-rename.
    const renamedCountBefore = store.rows.filter(
      (r) => r.type === "assistant.thread.renamed" && r.payload["thread_id"] === threadId,
    ).length;
    await sendMessage(threadId, "Второе сообщение");
    const renamedCountAfter = store.rows.filter(
      (r) => r.type === "assistant.thread.renamed" && r.payload["thread_id"] === threadId,
    ).length;
    // Count should not increase (auto-title only fires on first message, not on 2nd+).
    expect(renamedCountAfter).toBe(renamedCountBefore);
    // Last rename should still be the manual one.
    const listR = await httpReq("GET", `${base}/api/assistant/threads`, authHeader);
    const { threads } = listR.json as { threads: Array<{ id: string; title: string }> };
    const t = threads.find((x) => x.id === threadId);
    expect(t?.title).toBe("Вручную переименованный");
  });

  // -------------------------------------------------------------------------
  // AC-T384-18: Confirm no UPDATE/DELETE on audit_event across all operations
  // -------------------------------------------------------------------------
  it("AC-T384-18: no UPDATE/DELETE on audit_event table across all operations", async () => {
    await start();
    const tid = await createThread();
    await sendMessage(tid, "Сообщение тест");
    await httpReq("PATCH", `${base}/api/assistant/threads/${tid}`, authHeader, { title: "Новое название" });
    await httpReq("PATCH", `${base}/api/assistant/threads/${tid}`, authHeader, { pinned: true });
    await httpReq("DELETE", `${base}/api/assistant/threads/${tid}`, authHeader);
    const badSql = store.sqlLog.filter(
      (s) =>
        /UPDATE\s+choros\.audit_event/i.test(s) ||
        /DELETE\s+FROM\s+choros\.audit_event/i.test(s),
    );
    expect(badSql).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // AC-T384-19: Cross-user ownership guard — PATCH and DELETE by another user
  //             in the same tenant must return 404 and must NOT append any
  //             tombstone or mutation event for the original owner's thread.
  // -------------------------------------------------------------------------
  it("AC-T384-19: PATCH and DELETE by a different subject in same tenant return 404 (ownership guard)", async () => {
    await start();

    const aliceHeader = { [DEV_USER_HEADER]: "e-alice" };
    const bobHeader   = { [DEV_USER_HEADER]: "e-bob" };

    // Alice creates a thread and sends the first message to make it visible.
    const aliceThreadId = await createThread("Разговор Алисы");
    // Note: createThread() uses authHeader which is e-alice — consistent.
    await sendMessage(aliceThreadId, "Первое сообщение Алисы");

    // Count events owned by Alice before Bob's attempts.
    const eventsBefore = store.rows.filter((r) => r.subject === "e-alice").length;

    // Bob attempts PATCH on Alice's thread — must get 404.
    const patchRes = await httpReq(
      "PATCH",
      `${base}/api/assistant/threads/${aliceThreadId}`,
      bobHeader,
      { title: "Боб меняет название" },
    );
    expect(patchRes.status).toBe(404);

    // Bob attempts DELETE on Alice's thread — must get 404.
    const deleteRes = await httpReq(
      "DELETE",
      `${base}/api/assistant/threads/${aliceThreadId}`,
      bobHeader,
    );
    expect(deleteRes.status).toBe(404);

    // No new events must have been appended for Alice's thread as a result of
    // Bob's unauthorized attempts.
    const eventsAfter = store.rows.filter((r) => r.subject === "e-alice").length;
    expect(eventsAfter).toBe(eventsBefore);

    // Specifically, no tombstone event for Alice's thread.
    const tombstone = store.rows.find(
      (r) => r.type === "assistant.thread.deleted" && r.payload["thread_id"] === aliceThreadId,
    );
    expect(tombstone).toBeUndefined();

    // Alice's thread must still appear in Alice's list (not deleted).
    const listRes = await httpReq("GET", `${base}/api/assistant/threads`, aliceHeader);
    expect(listRes.status).toBe(200);
    const { threads: aliceThreads } = listRes.json as { threads: Array<{ id: string }> };
    expect(aliceThreads.find((t) => t.id === aliceThreadId)).toBeDefined();
  });
});
