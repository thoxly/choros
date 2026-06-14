/**
 * T-0128 / T-0206 · Connector entity (v1 stub) unit tests
 *
 * Pure unit — no DB. Uses a fake ConnectorWritePort and the InMemoryAuditWriter.
 * Covers the v1-stub ACs / fitness functions:
 *   FF-CONN-3 (custody shape-guard + redact), FF-CONN-5 (closed-kind fail-closed),
 *   FF-CONN-8 (audit without secret), declarative status (no live probe).
 */

import { describe, it, expect } from "vitest";
import {
  setConnector,
  rotateConnectorSecret,
  revokeConnector,
  getConnectorStatus,
  listConnectors,
  isConnectorKind,
  isConnectorStatus,
  type Connector,
  type ConnectorWritePort,
} from "../core/connector.js";
import {
  InMemoryAuditWriter,
  inMemoryTx,
} from "../db/audit-writer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ACTOR = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// A valid opaque handle (passes validateSecretHandleShape — not a vendor key, not short).
const VALID_HANDLE = "vault://secret/connector/tenant-a";
// A raw OpenAI-style key — must be rejected by the shape-guard.
const RAW_VENDOR_KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

// ---------------------------------------------------------------------------
// Fake in-memory connector store (composite key tenant_id + id)
// ---------------------------------------------------------------------------

class FakeConnectorStore implements ConnectorWritePort {
  private data: Map<string, Connector> = new Map();
  private key(tenantId: string, id: string): string {
    return `${tenantId}::${id}`;
  }
  async insert(c: Connector): Promise<void> {
    this.data.set(this.key(c.tenantId, c.id), c);
  }
  async update(c: Connector): Promise<void> {
    this.data.set(this.key(c.tenantId, c.id), c);
  }
  async get(tenantId: string, id: string): Promise<Connector | null> {
    return this.data.get(this.key(tenantId, id)) ?? null;
  }
  async list(tenantId: string): Promise<Connector[]> {
    return [...this.data.values()].filter((c) => c.tenantId === tenantId);
  }
  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.data.delete(this.key(tenantId, id));
  }
}

function makeDeps(tenantId: string) {
  const store = new FakeConnectorStore();
  const auditWriter = new InMemoryAuditWriter();
  const tx = inMemoryTx(tenantId);
  const clock = { now: () => 1_700_000_000_000 };
  return { store, auditWriter, tx, clock };
}

// ---------------------------------------------------------------------------
// Closed-kind / status predicates
// ---------------------------------------------------------------------------

describe("FF-CONN-5 · closed kind/status predicates", () => {
  it("isConnectorKind accepts only the closed set", () => {
    for (const k of ["1c", "ad_ldap", "smtp", "http_generic"]) {
      expect(isConnectorKind(k)).toBe(true);
    }
    for (const k of ["__bogus__", "ldap", "http", "", null, undefined, 42]) {
      expect(isConnectorKind(k)).toBe(false);
    }
  });

  it("isConnectorStatus accepts only the closed set", () => {
    for (const s of ["configured", "disabled", "error"]) {
      expect(isConnectorStatus(s)).toBe(true);
    }
    for (const s of ["enabled", "ok", "", null]) {
      expect(isConnectorStatus(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// setConnector — create
// ---------------------------------------------------------------------------

describe("setConnector · create (v1 stub)", () => {
  it("creates a connector born 'disabled' (declarative status, no live probe)", async () => {
    const deps = makeDeps(TENANT_A);
    const res = await setConnector(deps, TENANT_A, {
      kind: "1c",
      displayName: "1С УПП",
      actor: ACTOR,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const stored = await deps.store.get(TENANT_A, res.id);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("disabled"); // born disabled — no probe set it
    expect(stored?.kind).toBe("1c");
    expect(stored?.secretHandle).toBeNull();
    expect(stored?.backsEffectResourceId).toBeNull();
  });

  it("FF-CONN-5 · rejects an unknown kind with NO write", async () => {
    const deps = makeDeps(TENANT_A);
    // Force a widened string past the type boundary (simulating an untrusted HTTP input).
    const res = await setConnector(deps, TENANT_A, {
      kind: "__bogus__" as unknown as "1c",
      displayName: "bad",
      actor: ACTOR,
    });
    expect(res.ok).toBe(false);
    expect(await deps.store.list(TENANT_A)).toHaveLength(0);
    expect(deps.auditWriter.rows(TENANT_A)).toHaveLength(0);
  });

  it("FF-CONN-3 · rejects a raw vendor key as secret_handle with NO write, NO audit", async () => {
    const deps = makeDeps(TENANT_A);
    const res = await setConnector(deps, TENANT_A, {
      kind: "smtp",
      displayName: "smtp-conn",
      secretHandle: RAW_VENDOR_KEY,
      actor: ACTOR,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("secret_handle rejected");
    expect(await deps.store.list(TENANT_A)).toHaveLength(0);
    expect(deps.auditWriter.rows(TENANT_A)).toHaveLength(0);
  });

  it("accepts a valid opaque handle and stores it as-is", async () => {
    const deps = makeDeps(TENANT_A);
    const res = await setConnector(deps, TENANT_A, {
      kind: "ad_ldap",
      displayName: "AD",
      secretHandle: VALID_HANDLE,
      status: "configured",
      backsEffectResourceId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      config: { host: "ldap.example.local", port: 636 },
      actor: ACTOR,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const stored = await deps.store.get(TENANT_A, res.id);
    expect(stored?.secretHandle).toBe(VALID_HANDLE);
    expect(stored?.status).toBe("configured");
    expect(stored?.config).toEqual({ host: "ldap.example.local", port: 636 });
    expect(stored?.backsEffectResourceId).toBe("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
  });
});

// ---------------------------------------------------------------------------
// FF-CONN-8 · audit without secret
// ---------------------------------------------------------------------------

describe("FF-CONN-8 · audit payload never contains the secret_handle", () => {
  it("connector.set audit payload carries config-only fields, no handle", async () => {
    const deps = makeDeps(TENANT_A);
    const res = await setConnector(deps, TENANT_A, {
      kind: "smtp",
      displayName: "smtp",
      secretHandle: VALID_HANDLE,
      actor: ACTOR,
    });
    expect(res.ok).toBe(true);
    const rows = deps.auditWriter.rows(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("connector.set");
    const payloadStr = JSON.stringify(rows[0].payload);
    expect(payloadStr).not.toContain(VALID_HANDLE);
    expect(rows[0].payload).toMatchObject({
      kind: "smtp",
      display_name: "smtp",
      status: "disabled",
    });
    expect(Object.keys(rows[0].payload as object)).not.toContain("secret_handle");
  });

  it("connector.rotate audit payload never contains the new handle", async () => {
    const deps = makeDeps(TENANT_A);
    const created = await setConnector(deps, TENANT_A, {
      kind: "smtp",
      displayName: "smtp",
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const newHandle = "env://SMTP_TOKEN_ROTATED";
    const rot = await rotateConnectorSecret(deps, TENANT_A, created.id, newHandle, ACTOR);
    expect(rot.ok).toBe(true);

    const rotateRows = deps.auditWriter.rows(TENANT_A).filter((r) => r.type === "connector.rotate");
    expect(rotateRows).toHaveLength(1);
    expect(JSON.stringify(rotateRows[0].payload)).not.toContain(newHandle);

    // The stored handle was actually rotated.
    expect((await deps.store.get(TENANT_A, created.id))?.secretHandle).toBe(newHandle);
  });
});

// ---------------------------------------------------------------------------
// rotate · shape-guard on the new handle
// ---------------------------------------------------------------------------

describe("rotateConnectorSecret · shape-guard + not_found", () => {
  it("rejects a raw vendor key as the new handle with NO write", async () => {
    const deps = makeDeps(TENANT_A);
    const created = await setConnector(deps, TENANT_A, {
      kind: "smtp", displayName: "smtp", secretHandle: VALID_HANDLE, actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = await rotateConnectorSecret(deps, TENANT_A, created.id, RAW_VENDOR_KEY, ACTOR);
    expect(res.ok).toBe(false);
    // handle unchanged
    expect((await deps.store.get(TENANT_A, created.id))?.secretHandle).toBe(VALID_HANDLE);
  });

  it("returns not_found for an absent connector", async () => {
    const deps = makeDeps(TENANT_A);
    const res = await rotateConnectorSecret(
      deps, TENANT_A, "00000000-0000-0000-0000-000000000000", VALID_HANDLE, ACTOR,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// FF-CONN-3 · status/list redact the handle
// ---------------------------------------------------------------------------

describe("FF-CONN-3 · status/list views REDACT the handle (never raw)", () => {
  it("getConnectorStatus returns handleRedacted, not the raw handle", async () => {
    const deps = makeDeps(TENANT_A);
    const created = await setConnector(deps, TENANT_A, {
      kind: "smtp", displayName: "smtp", secretHandle: VALID_HANDLE, actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const view = await getConnectorStatus(deps.store, TENANT_A, created.id);
    expect(view).not.toBeNull();
    expect(view?.secretBound).toBe(true);
    expect(view?.handleRedacted).not.toBe(VALID_HANDLE);
    expect(view?.handleRedacted).toBe("vault://...");
    // The view object as a whole must not leak the raw handle anywhere.
    expect(JSON.stringify(view)).not.toContain(VALID_HANDLE);
  });

  it("a connector with no secret has handleRedacted=null, secretBound=false", async () => {
    const deps = makeDeps(TENANT_A);
    const created = await setConnector(deps, TENANT_A, {
      kind: "1c", displayName: "1c", actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const view = await getConnectorStatus(deps.store, TENANT_A, created.id);
    expect(view?.handleRedacted).toBeNull();
    expect(view?.secretBound).toBe(false);
  });

  it("listConnectors redacts handles for every row", async () => {
    const deps = makeDeps(TENANT_A);
    await setConnector(deps, TENANT_A, {
      kind: "smtp", displayName: "a", secretHandle: VALID_HANDLE, actor: ACTOR,
    });
    await setConnector(deps, TENANT_A, {
      kind: "ad_ldap", displayName: "b", secretHandle: "env://AD_BIND_PW", actor: ACTOR,
    });
    const views = await listConnectors(deps.store, TENANT_A);
    expect(views).toHaveLength(2);
    expect(JSON.stringify(views)).not.toContain(VALID_HANDLE);
    expect(JSON.stringify(views)).not.toContain("AD_BIND_PW");
  });
});

// ---------------------------------------------------------------------------
// revoke + tenant isolation at the store boundary
// ---------------------------------------------------------------------------

describe("revokeConnector + tenant isolation", () => {
  it("revoke deletes and emits connector.revoke; not_found when absent", async () => {
    const deps = makeDeps(TENANT_A);
    const created = await setConnector(deps, TENANT_A, {
      kind: "1c", displayName: "1c", actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const ok = await revokeConnector(deps, TENANT_A, created.id, ACTOR);
    expect(ok.ok).toBe(true);
    expect(await deps.store.get(TENANT_A, created.id)).toBeNull();
    expect(deps.auditWriter.rows(TENANT_A).some((r) => r.type === "connector.revoke")).toBe(true);

    const again = await revokeConnector(deps, TENANT_A, created.id, ACTOR);
    expect(again.ok).toBe(false);
  });

  it("listConnectors for tenant A never returns tenant B rows (store-level keying)", async () => {
    // Shared fake store across two tenants (the app-layer counterpart of RLS).
    const store = new FakeConnectorStore();
    const auditWriter = new InMemoryAuditWriter();
    const clock = { now: () => 1 };

    await setConnector(
      { store, auditWriter, tx: inMemoryTx(TENANT_A), clock }, TENANT_A,
      { kind: "1c", displayName: "A-conn", actor: ACTOR },
    );
    await setConnector(
      { store, auditWriter, tx: inMemoryTx(TENANT_B), clock }, TENANT_B,
      { kind: "smtp", displayName: "B-conn", actor: ACTOR },
    );

    const aViews = await listConnectors(store, TENANT_A);
    const bViews = await listConnectors(store, TENANT_B);
    expect(aViews).toHaveLength(1);
    expect(bViews).toHaveLength(1);
    expect(aViews[0].displayName).toBe("A-conn");
    expect(bViews[0].displayName).toBe("B-conn");
    // Cross-tenant get must not cross the composite key.
    expect(await store.get(TENANT_A, bViews[0].id)).toBeNull();
  });
});
