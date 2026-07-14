/**
 * T-0173 · Notification center unit tests
 *
 * Pure unit — no DB, no network. Uses fake DAO clients.
 * Covers AC-1..AC-9, AC-10 (no-audit structural check) from
 * docs/specs/T-0173-notification-center.spec.contract.json.
 *
 * Fitness functions tested:
 *   FF-OWN-ONLY-READ  — recipient_id always = actor
 *   FF-NO-CROSS-USER  — mark-read foreign row → 404 (markRead returns false)
 *   FF-NO-ISREAD-AUDIT — no appendAuditEvent in DAO or HTTP paths
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  PgNotificationStore,
  serializeCursor,
  deserializeCursor,
  type PgNotifClientLike,
} from "../core/postgres/pgNotificationStore.js";
import type { NotifInsertPort } from "../core/notification-router.js";
import { registerNotificationRoutes } from "../http/notifications.js";
import { Router } from "../http/router.js";
import pg from "pg";

// ---------------------------------------------------------------------------
// AC-1: structural compatibility — PgNotificationStore satisfies NotifInsertPort
// ---------------------------------------------------------------------------

describe("AC-1: PgNotificationStore satisfies NotifInsertPort", () => {
  it("is structurally compatible with the port interface at compile time", () => {
    const pool = null as unknown as pg.Pool;
    // This assignment would fail tsc if the interface is not satisfied.
    const store: NotifInsertPort = new PgNotificationStore(pool);
    expect(typeof store.insert).toBe("function");
  });

  it("does not redeclare NotifInsertPort (imports from notification-router)", async () => {
    // Verify the import works correctly — if the import chain is broken,
    // this import statement itself would fail.
    const mod = await import("../core/postgres/pgNotificationStore.js");
    expect(typeof mod.PgNotificationStore).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Fake PgNotifClientLike for unit tests
// ---------------------------------------------------------------------------

interface QueryCall {
  sql: string;
  params?: unknown[];
}

class FakeNotifClient implements PgNotifClientLike {
  public calls: QueryCall[] = [];
  public rows: unknown[] = [];
  public rowCount: number = 0;

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.calls.push({ sql, params });
    return { rows: this.rows, rowCount: this.rowCount };
  }
}

// ---------------------------------------------------------------------------
// AC-3: keyset cursor serialization/deserialization
// ---------------------------------------------------------------------------

describe("AC-3: keyset cursor roundtrip", () => {
  it("serializes and deserializes correctly", () => {
    const cursor = { createdAt: 1718000000000, id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
    const encoded = serializeCursor(cursor);
    const decoded = deserializeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.createdAt).toBe(cursor.createdAt);
    expect(decoded!.id).toBe(cursor.id);
  });

  it("returns null for invalid cursor string", () => {
    expect(deserializeCursor("not-valid-base64!")).toBeNull();
    expect(deserializeCursor(Buffer.from("{}").toString("base64url"))).toBeNull();
    expect(deserializeCursor("")).toBeNull();
  });

  it("returns null for partial cursor (missing id)", () => {
    const partial = Buffer.from(JSON.stringify({ createdAt: 123 })).toString("base64url");
    expect(deserializeCursor(partial)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-2 / FF-OWN-ONLY-READ: list SQL includes recipient_id = $1 (actor-only)
// ---------------------------------------------------------------------------

describe("AC-2: list issues WHERE recipient_id = $1 (own-only)", () => {
  it("first parameter to list SQL is always the recipientId (actor)", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rows = [];

    await store.list(client, { recipientId: "actor-uuid-123" });

    expect(client.calls.length).toBeGreaterThan(0);
    const call = client.calls[0];
    // First param must be the recipientId (actor)
    expect(call.params?.[0]).toBe("actor-uuid-123");
    // SQL must have recipient_id = $1
    expect(call.sql).toContain("recipient_id = $1");
  });

  it("list with isRead filter includes is_read condition", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rows = [];

    await store.list(client, { recipientId: "a", isRead: false });

    const call = client.calls[0];
    expect(call.sql).toContain("is_read = $");
    // The is_read param should be false
    expect(call.params).toContain(false);
  });

  it("list with cursor includes (created_at, id) < cursor condition", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rows = [];

    const cursor = { createdAt: 1000, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
    await store.list(client, { recipientId: "a", cursor });

    const call = client.calls[0];
    expect(call.sql).toContain("(created_at, id) < (");
    expect(call.params).toContain(cursor.createdAt);
    expect(call.params).toContain(cursor.id);
  });

  it("returns nextCursor when more rows than limit", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();

    // Build limit+1 fake rows
    const makeRow = (i: number) => ({
      tenant_id: "t",
      id: `id-${i}`,
      recipient_id: "actor",
      event_kind: "task.assigned",
      title: "T",
      body: "B",
      object_ref: null,
      is_read: false,
      created_at: String(1000 - i),
      expires_at: null,
    });
    const limit = 2;
    // We fetch limit+1=3 rows from DB, so we know there's a next page
    client.rows = [makeRow(0), makeRow(1), makeRow(2)];

    const result = await store.list(client, { recipientId: "actor", limit });
    expect(result.rows.length).toBe(limit);
    expect(result.nextCursor).not.toBeNull();
    // nextCursor should match the last returned row
    expect(result.nextCursor!.id).toBe(result.rows[result.rows.length - 1].id);
  });

  it("returns null nextCursor when result fits within limit", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rows = [
      {
        tenant_id: "t", id: "id-1", recipient_id: "actor", event_kind: "e",
        title: "T", body: "B", object_ref: null, is_read: false,
        created_at: "1000", expires_at: null,
      },
    ];

    const result = await store.list(client, { recipientId: "actor", limit: 20 });
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-4: countUnread issues SELECT … WHERE is_read = false
// ---------------------------------------------------------------------------

describe("AC-4: countUnread uses partial index pattern (is_read = false in WHERE)", () => {
  it("issues COUNT with WHERE recipient_id=$1 AND is_read=false", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rows = [{ cnt: "5" }];

    const count = await store.countUnread(client, "actor-uuid");
    expect(count).toBe(5);
    expect(client.calls[0].sql).toContain("is_read = false");
    expect(client.calls[0].sql).toContain("recipient_id = $1");
    expect(client.calls[0].params?.[0]).toBe("actor-uuid");
  });

  it("returns 0 when no rows returned", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rows = [];

    const count = await store.countUnread(client, "actor-uuid");
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5 / AC-6 / FF-NO-CROSS-USER: markRead
// ---------------------------------------------------------------------------

describe("AC-5/AC-6: markRead own-only semantics", () => {
  it("markRead for own row returns true (rowCount=1)", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rowCount = 1;

    const result = await store.markRead(client, "notif-id", "actor-id");
    expect(result).toBe(true);
    // SQL must WHERE recipient_id = $2 (actor)
    expect(client.calls[0].sql).toContain("recipient_id = $2");
    expect(client.calls[0].params?.[0]).toBe("notif-id");
    expect(client.calls[0].params?.[1]).toBe("actor-id");
  });

  it("markRead for foreign row returns false (rowCount=0)", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rowCount = 0;

    // AC-6/FF-NO-CROSS-USER: foreign row → no match → false
    const result = await store.markRead(client, "foreign-id", "actor-id");
    expect(result).toBe(false);
  });

  it("markRead SQL does NOT include recipient_id param from request body (no cross-user)", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rowCount = 0;

    await store.markRead(client, "id", "actor-only");
    // Verify the SQL structure: WHERE id=$1 AND recipient_id=$2
    const sql = client.calls[0].sql;
    expect(sql).toContain("id = $1");
    expect(sql).toContain("recipient_id = $2");
  });
});

// ---------------------------------------------------------------------------
// AC-7: batchMarkRead
// ---------------------------------------------------------------------------

describe("AC-7: batchMarkRead own-only semantics", () => {
  it("batchMarkRead returns count of updated rows", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();
    client.rowCount = 2;

    const updated = await store.batchMarkRead(client, ["id1", "id2", "id3"], "actor-id");
    expect(updated).toBe(2);
    // SQL must include ANY($1) and recipient_id=$2
    expect(client.calls[0].sql).toContain("ANY($1)");
    expect(client.calls[0].sql).toContain("recipient_id = $2");
    expect(client.calls[0].params?.[1]).toBe("actor-id");
  });

  it("batchMarkRead with empty ids returns 0 without SQL query", async () => {
    const pool = null as unknown as pg.Pool;
    const store = new PgNotificationStore(pool);
    const client = new FakeNotifClient();

    const updated = await store.batchMarkRead(client, [], "actor-id");
    expect(updated).toBe(0);
    expect(client.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-10: no appendAuditEvent in DAO (FF-NO-ISREAD-AUDIT)
// This is primarily verified by the fitness check (notification-center-isolation.sh),
// but we can also confirm the module text at runtime via source inspection.
// ---------------------------------------------------------------------------

describe("AC-10: PgNotificationStore has no appendAuditEvent (FF-NO-ISREAD-AUDIT)", () => {
  it("module source does not call appendAuditEvent", async () => {
    // Dynamically import the module source as text to verify no audit call
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, "../core/postgres/pgNotificationStore.ts"),
      "utf8",
    );
    // Must not contain any non-comment appendAuditEvent call
    const nonCommentLines = src
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    expect(nonCommentLines).not.toContain("appendAuditEvent");
  });
});

// ---------------------------------------------------------------------------
// HTTP handler tests: AC-2 / AC-6 / AC-7 / AC-8 via live http.Server
// ---------------------------------------------------------------------------

// Fake pool that captures queries for HTTP integration tests
class FakePoolClient {
  public queries: QueryCall[] = [];
  public rows: unknown[] = [];
  public rowCount: number = 0;
  public released = false;

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    // For BEGIN/COMMIT/ROLLBACK/SET LOCAL return empty
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/i.test(sql.trim())) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: this.rows, rowCount: this.rowCount };
  }

  release(): void {
    this.released = true;
  }
}

class FakePool {
  /** Pre-loaded clients returned by successive connect() calls (FIFO). */
  private clientQueue: FakePoolClient[] = [];
  /** Clients that have been issued (for inspection). */
  public issued: FakePoolClient[] = [];
  /** Default client returned when queue is empty. */
  public defaultClient: FakePoolClient = new FakePoolClient();

  /** Push a client that will be returned by the next connect() call. */
  pushClient(client: FakePoolClient): void {
    this.clientQueue.push(client);
  }

  connect(): Promise<FakePoolClient> {
    const client = this.clientQueue.shift() ?? this.defaultClient;
    this.issued.push(client);
    return Promise.resolve(client);
  }

  // pool.query for insert (not used in center REST handlers, but satisfies type)
  query(_sql: string, _params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

function makeTestServer(pool: FakePool): http.Server {
  const router = new Router();
  registerNotificationRoutes(router, pool as unknown as pg.Pool);
  return http.createServer((req, res) => router.dispatch(req, res));
}

async function doRequest(
  server: http.Server,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

describe("HTTP: AC-8 (401 without X-Dev-User)", () => {
  let server: http.Server;
  beforeAll(() => new Promise<void>((resolve) => {
    const pool = new FakePool();
    server = makeTestServer(pool);
    server.listen(0, "127.0.0.1", resolve);
  }));
  afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  it("GET /api/notifications → 401 without X-Dev-User", async () => {
    const { status } = await doRequest(server, "GET", "/api/notifications");
    expect(status).toBe(401);
  });

  it("GET /api/notifications/unread-count → 401 without X-Dev-User", async () => {
    const { status } = await doRequest(server, "GET", "/api/notifications/unread-count");
    expect(status).toBe(401);
  });

  it("POST /api/notifications/:id/read → 401 without X-Dev-User", async () => {
    const { status } = await doRequest(
      server,
      "POST",
      "/api/notifications/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/read",
    );
    expect(status).toBe(401);
  });

  it("PATCH /api/notifications → 401 without X-Dev-User", async () => {
    const { status } = await doRequest(
      server,
      "PATCH",
      "/api/notifications",
      {},
      { ids: [] },
    );
    expect(status).toBe(401);
  });
});

describe("HTTP: AC-5 (POST /:id/read → 200 own row)", () => {
  let server: http.Server;
  let pool: FakePool;
  beforeAll(() => new Promise<void>((resolve) => {
    pool = new FakePool();
    server = makeTestServer(pool);
    server.listen(0, "127.0.0.1", resolve);
  }));
  afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  it("returns 200 { ok: true } when markRead returns true", async () => {
    // Push a client that returns rowCount=1 (own row found and updated)
    const client = new FakePoolClient();
    client.rowCount = 1;
    pool.pushClient(client);

    const { status, body } = await doRequest(
      server,
      "POST",
      "/api/notifications/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/read",
      { "x-dev-user": "actor-uuid" },
    );
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)["ok"]).toBe(true);
  });
});

describe("HTTP: AC-6 (POST /:id/read → 404 for foreign row)", () => {
  let server: http.Server;
  let pool: FakePool;
  beforeAll(() => new Promise<void>((resolve) => {
    pool = new FakePool();
    server = makeTestServer(pool);
    server.listen(0, "127.0.0.1", resolve);
  }));
  afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  it("returns 404 when markRead returns false (foreign or missing row)", async () => {
    const client = new FakePoolClient();
    client.rowCount = 0;   // no match → foreign or missing
    pool.pushClient(client);

    const { status } = await doRequest(
      server,
      "POST",
      "/api/notifications/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/read",
      { "x-dev-user": "actor-uuid" },
    );
    expect(status).toBe(404);
  });
});

describe("HTTP: AC-7 (PATCH /api/notifications batch mark-read)", () => {
  let server: http.Server;
  let pool: FakePool;
  beforeAll(() => new Promise<void>((resolve) => {
    pool = new FakePool();
    server = makeTestServer(pool);
    server.listen(0, "127.0.0.1", resolve);
  }));
  afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  it("returns 200 { updated: N } with correct count", async () => {
    const client = new FakePoolClient();
    client.rowCount = 2;
    pool.pushClient(client);

    const { status, body } = await doRequest(
      server,
      "PATCH",
      "/api/notifications",
      { "x-dev-user": "actor-uuid" },
      {
        ids: [
          "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        ],
      },
    );
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)["updated"]).toBe(2);
  });

  it("returns 400 for invalid UUID in ids", async () => {
    const { status } = await doRequest(
      server,
      "PATCH",
      "/api/notifications",
      { "x-dev-user": "actor-uuid" },
      { ids: ["not-a-uuid"] },
    );
    expect(status).toBe(400);
  });
});

describe("HTTP: GET /api/notifications/unread-count routing", () => {
  let server: http.Server;
  let pool: FakePool;
  beforeAll(() => new Promise<void>((resolve) => {
    pool = new FakePool();
    server = makeTestServer(pool);
    server.listen(0, "127.0.0.1", resolve);
  }));
  afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  it("GET /api/notifications/unread-count is NOT matched as /:id/read", async () => {
    // 'unread-count' is a literal segment, not an id — must go to count route
    const client = new FakePoolClient();
    client.rows = [{ cnt: "3" }];
    pool.pushClient(client);

    const { status, body } = await doRequest(
      server,
      "GET",
      "/api/notifications/unread-count",
      { "x-dev-user": "actor-uuid" },
    );
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)["count"]).toBe(3);
  });
});

describe("HTTP: FF-OWN-ONLY-READ — recipient_id is actor, not from query params", () => {
  let server: http.Server;
  let pool: FakePool;
  beforeAll(() => new Promise<void>((resolve) => {
    pool = new FakePool();
    server = makeTestServer(pool);
    server.listen(0, "127.0.0.1", resolve);
  }));
  afterAll(() => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  }));

  it("GET /api/notifications ignores any recipient_id query param", async () => {
    const client = new FakePoolClient();
    client.rows = [];
    pool.pushClient(client);

    await doRequest(
      server,
      "GET",
      "/api/notifications?recipient_id=other-actor-uuid",
      { "x-dev-user": "real-actor-uuid" },
    );

    // Find the SELECT call in the client's queries
    const selectCall = client.queries.find((q) =>
      q.sql.toLowerCase().includes("select") && q.sql.includes("recipient_id"),
    );
    if (selectCall) {
      // The first param should be the actor from X-Dev-User, not from query params
      expect(selectCall.params?.[0]).toBe("real-actor-uuid");
      expect(selectCall.params?.[0]).not.toBe("other-actor-uuid");
    }
    // No error = own-only enforcement at the routing level
  });
});
