/**
 * T-0083 · E12.2 — Fitness suite for bundle-commit core.
 *
 * Tests cover:
 *   FF-BC-UNIT-1  Same bytes → same content_hash (determinism, D-1)
 *   FF-BC-UNIT-2  Different bytes → different content_hash (content-addressing)
 *   FF-BC-UNIT-3  Parent-chain: child's parent_hash equals parent's content_hash
 *   FF-BC-UNIT-4  GENESIS_PARENT_HASH for first commit in chain
 *   FF-BC-UNIT-5  Semantic changelog: same snapshot → empty diff
 *   FF-BC-UNIT-6  Semantic changelog: added member detected
 *   FF-BC-UNIT-7  Semantic changelog: updated member detected
 *   FF-BC-UNIT-8  Semantic changelog: removed member detected
 *   FF-BC-UNIT-9  Hash-port injection: different ports → different hashes
 *   FF-BC-UNIT-10 canonicalCommitPreimage is deterministic (same inputs → same Buffer)
 *   FF-BC-UNIT-11 SemanticChange never exposes raw content_hash/parent_hash
 *   FF-BC-UNIT-12 committed_at injected (not Date.now — caller supplies it)
 *
 * All tests are pure (no IO, no DB, no node:crypto in test — the SHA-256 port
 * from bundle-commit-store.ts is imported only for the integration-with-adapter tests;
 * purity tests use a stub port).
 */

import { describe, it, expect } from "vitest";
import {
  makeCommit,
  deriveSemanticChangelog,
  canonicalCommitPreimage,
  GENESIS_PARENT_HASH,
  type BundleSnapshot,
  type BundleHashPort,
} from "../core/bundle-commit.js";
import { makeSha256Port } from "../core/bundle-commit-store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT: BundleSnapshot = {
  object_schema: "",
  grants: "",
  bpmn_process: "",
  form_code: "",
  form_json_schema: "",
};

const SNAPSHOT_V1: BundleSnapshot = {
  object_schema: '{"type":"object","properties":{"name":{"type":"string"}}}',
  grants: '[{"resource_type":"record","action":"read"}]',
  bpmn_process: '<process id="p1"/>',
  form_code: "",
  form_json_schema: "",
};

const SNAPSHOT_V2: BundleSnapshot = {
  object_schema:
    '{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"number"}}}',
  grants: '[{"resource_type":"record","action":"read"},{"resource_type":"record","action":"write"}]',
  bpmn_process: '<process id="p1"/>',
  form_code: "export const Form = () => <div/>;",
  form_json_schema: '{"type":"object"}',
};

/** Deterministic stub port: hash(data) = hex of first 32 bytes repeated to fill 64 chars. */
function makeStubPort(): BundleHashPort {
  return {
    hash(data: Buffer): string {
      // Deterministic: XOR-reduce the buffer bytes into a 32-byte pattern
      const out = Buffer.alloc(32, 0);
      for (let i = 0; i < data.length; i++) {
        out[i % 32] ^= data[i];
      }
      return out.toString("hex");
    },
  };
}

const STUB_PORT = makeStubPort();
const SHA256_PORT = makeSha256Port();

const AUTHOR = "test-agent";
const MESSAGE = "initial commit";
const NOW = 1_700_000_000_000; // fixed epoch-ms

// ---------------------------------------------------------------------------
// FF-BC-UNIT-1: Determinism — same inputs → same content_hash
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-1: determinism (same bytes → same content_hash)", () => {
  it("two calls with identical inputs produce identical content_hash", () => {
    const c1 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, STUB_PORT);
    const c2 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, STUB_PORT);
    expect(c1.content_hash).toBe(c2.content_hash);
  });

  it("SHA-256 port is also deterministic", () => {
    const c1 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, SHA256_PORT);
    const c2 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, SHA256_PORT);
    expect(c1.content_hash).toBe(c2.content_hash);
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-2: Different inputs → different content_hash
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-2: content-addressing (different snapshots → different hashes)", () => {
  it("different object_schema produces different content_hash", () => {
    const c1 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, SHA256_PORT);
    const c2 = makeCommit(SNAPSHOT_V2, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, SHA256_PORT);
    expect(c1.content_hash).not.toBe(c2.content_hash);
  });

  it("same snapshot but different message produces different content_hash", () => {
    const c1 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, "msg-A", NOW, SHA256_PORT);
    const c2 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, "msg-B", NOW, SHA256_PORT);
    expect(c1.content_hash).not.toBe(c2.content_hash);
  });

  it("same snapshot but different author produces different content_hash", () => {
    const c1 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, "author-A", MESSAGE, NOW, SHA256_PORT);
    const c2 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, "author-B", MESSAGE, NOW, SHA256_PORT);
    expect(c1.content_hash).not.toBe(c2.content_hash);
  });

  it("same snapshot but different committed_at produces different content_hash", () => {
    const c1 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, SHA256_PORT);
    const c2 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW + 1, SHA256_PORT);
    expect(c1.content_hash).not.toBe(c2.content_hash);
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-3: Parent-chain integrity
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-3: parent-chain — child.parent_hash === parent.content_hash", () => {
  it("chained commit has the parent hash set correctly", () => {
    const parent = makeCommit(
      SNAPSHOT_V1,
      GENESIS_PARENT_HASH,
      AUTHOR,
      "first",
      NOW,
      SHA256_PORT,
    );
    const child = makeCommit(
      SNAPSHOT_V2,
      parent.content_hash,
      AUTHOR,
      "second",
      NOW + 1000,
      SHA256_PORT,
    );
    expect(child.parent_hash).toBe(parent.content_hash);
  });

  it("three-commit chain maintains integrity", () => {
    const c0 = makeCommit(EMPTY_SNAPSHOT, GENESIS_PARENT_HASH, AUTHOR, "genesis", NOW, SHA256_PORT);
    const c1 = makeCommit(SNAPSHOT_V1, c0.content_hash, AUTHOR, "v1", NOW + 1, SHA256_PORT);
    const c2 = makeCommit(SNAPSHOT_V2, c1.content_hash, AUTHOR, "v2", NOW + 2, SHA256_PORT);

    expect(c1.parent_hash).toBe(c0.content_hash);
    expect(c2.parent_hash).toBe(c1.content_hash);
    // All hashes distinct (no collision)
    expect(c0.content_hash).not.toBe(c1.content_hash);
    expect(c1.content_hash).not.toBe(c2.content_hash);
    expect(c0.content_hash).not.toBe(c2.content_hash);
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-4: GENESIS_PARENT_HASH
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-4: GENESIS_PARENT_HASH", () => {
  it("is 64 zero-chars (matches SHA-256 output length)", () => {
    expect(GENESIS_PARENT_HASH).toBe("0".repeat(64));
    expect(GENESIS_PARENT_HASH.length).toBe(64);
  });

  it("first commit in chain uses GENESIS_PARENT_HASH as parent_hash", () => {
    const c = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, SHA256_PORT);
    expect(c.parent_hash).toBe(GENESIS_PARENT_HASH);
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-5: Semantic changelog — identical snapshots → empty diff
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-5: semantic changelog (same snapshot → empty)", () => {
  it("two commits with identical snapshots produce empty changelog", () => {
    const from = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, "v1", NOW, SHA256_PORT);
    const to = makeCommit(SNAPSHOT_V1, from.content_hash, AUTHOR, "re-commit", NOW + 1, SHA256_PORT);
    const diff = deriveSemanticChangelog(from, to);
    expect(diff).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-6: Semantic changelog — added member
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-6: semantic changelog (added member)", () => {
  it("detects form_code added from empty to non-empty", () => {
    const from = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, "v1", NOW, SHA256_PORT);
    const to = makeCommit(SNAPSHOT_V2, from.content_hash, AUTHOR, "v2", NOW + 1, SHA256_PORT);
    const diff = deriveSemanticChangelog(from, to);
    const formCodeChange = diff.find((c) => c.member === "form_code");
    expect(formCodeChange).toBeDefined();
    expect(formCodeChange?.kind).toBe("added");
  });

  it("detects form_json_schema added", () => {
    const from = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, "v1", NOW, SHA256_PORT);
    const to = makeCommit(SNAPSHOT_V2, from.content_hash, AUTHOR, "v2", NOW + 1, SHA256_PORT);
    const diff = deriveSemanticChangelog(from, to);
    const schemaChange = diff.find((c) => c.member === "form_json_schema");
    expect(schemaChange).toBeDefined();
    expect(schemaChange?.kind).toBe("added");
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-7: Semantic changelog — updated member
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-7: semantic changelog (updated member)", () => {
  it("detects object_schema updated", () => {
    const from = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, "v1", NOW, SHA256_PORT);
    const to = makeCommit(SNAPSHOT_V2, from.content_hash, AUTHOR, "v2", NOW + 1, SHA256_PORT);
    const diff = deriveSemanticChangelog(from, to);
    const schemaChange = diff.find((c) => c.member === "object_schema");
    expect(schemaChange).toBeDefined();
    expect(schemaChange?.kind).toBe("updated");
  });

  it("detects grants updated", () => {
    const from = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, "v1", NOW, SHA256_PORT);
    const to = makeCommit(SNAPSHOT_V2, from.content_hash, AUTHOR, "v2", NOW + 1, SHA256_PORT);
    const diff = deriveSemanticChangelog(from, to);
    const grantsChange = diff.find((c) => c.member === "grants");
    expect(grantsChange).toBeDefined();
    expect(grantsChange?.kind).toBe("updated");
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-8: Semantic changelog — removed member
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-8: semantic changelog (removed member)", () => {
  it("detects bpmn_process removed (from non-empty to empty)", () => {
    const snapshotWithBpmn: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      bpmn_process: "<process/>",
    };
    const snapshotNoBpmn: BundleSnapshot = {
      ...EMPTY_SNAPSHOT,
      bpmn_process: "",
    };
    const from = makeCommit(snapshotWithBpmn, GENESIS_PARENT_HASH, AUTHOR, "v1", NOW, SHA256_PORT);
    const to = makeCommit(snapshotNoBpmn, from.content_hash, AUTHOR, "v2", NOW + 1, SHA256_PORT);
    const diff = deriveSemanticChangelog(from, to);
    const bpmnChange = diff.find((c) => c.member === "bpmn_process");
    expect(bpmnChange).toBeDefined();
    expect(bpmnChange?.kind).toBe("removed");
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-9: Different hash ports → different content hashes
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-9: different hash ports produce different hashes", () => {
  it("stub port and SHA-256 port produce different hashes for same input", () => {
    const c1 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, STUB_PORT);
    const c2 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, SHA256_PORT);
    expect(c1.content_hash).not.toBe(c2.content_hash);
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-10: canonicalCommitPreimage determinism
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-10: canonicalCommitPreimage determinism", () => {
  it("same inputs produce identical Buffer bytes", () => {
    const p1 = canonicalCommitPreimage(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW);
    const p2 = canonicalCommitPreimage(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW);
    expect(p1.equals(p2)).toBe(true);
  });

  it("different snapshots produce different preimage bytes", () => {
    const p1 = canonicalCommitPreimage(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW);
    const p2 = canonicalCommitPreimage(SNAPSHOT_V2, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW);
    expect(p1.equals(p2)).toBe(false);
  });

  it("different parent_hash produces different preimage bytes", () => {
    const p1 = canonicalCommitPreimage(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW);
    const p2 = canonicalCommitPreimage(SNAPSHOT_V1, "a".repeat(64), AUTHOR, MESSAGE, NOW);
    expect(p1.equals(p2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-11: SemanticChange never exposes raw content_hash/parent_hash
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-11: SemanticChange does not expose raw hashes", () => {
  it("summary strings do not contain 64-char hex content_hash", () => {
    const from = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, "v1", NOW, SHA256_PORT);
    const to = makeCommit(SNAPSHOT_V2, from.content_hash, AUTHOR, "v2", NOW + 1, SHA256_PORT);
    const diff = deriveSemanticChangelog(from, to);
    for (const change of diff) {
      // content_hash is 64 hex chars; summary must not contain it
      expect(change.summary).not.toContain(from.content_hash);
      expect(change.summary).not.toContain(to.content_hash);
      expect(change.summary).not.toContain(GENESIS_PARENT_HASH);
    }
  });

  it("SemanticChange contains member + kind + human summary, not raw diff", () => {
    const from = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, "v1", NOW, SHA256_PORT);
    const to = makeCommit(SNAPSHOT_V2, from.content_hash, AUTHOR, "v2", NOW + 1, SHA256_PORT);
    const diff = deriveSemanticChangelog(from, to);
    for (const change of diff) {
      expect(["object_schema", "grants", "bpmn_process", "form_code", "form_json_schema"]).toContain(
        change.member,
      );
      expect(["added", "removed", "updated"]).toContain(change.kind);
      expect(typeof change.summary).toBe("string");
      expect(change.summary.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// FF-BC-UNIT-12: committed_at is injected (the core accepts it, does not call Date.now())
// ---------------------------------------------------------------------------
describe("FF-BC-UNIT-12: committed_at is injected (not generated internally)", () => {
  it("committed_at on the returned commit equals the injected value", () => {
    const ts = 1_234_567_890_123;
    const c = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, ts, SHA256_PORT);
    expect(c.committed_at).toBe(ts);
  });

  it("different committed_at values produce the same commit modulo timestamp", () => {
    const c1 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, 1000, SHA256_PORT);
    const c2 = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, 2000, SHA256_PORT);
    // Different timestamps → different content_hash (timestamp is in preimage)
    expect(c1.content_hash).not.toBe(c2.content_hash);
    // But snapshot and other fields are identical
    expect(c1.snapshot).toEqual(c2.snapshot);
    expect(c1.author).toBe(c2.author);
    expect(c1.message).toBe(c2.message);
  });
});

// ---------------------------------------------------------------------------
// Integration: SHA-256 content_hash is exactly 64 hex chars
// ---------------------------------------------------------------------------
describe("SHA-256 content_hash shape", () => {
  it("content_hash is 64 lowercase hex chars", () => {
    const c = makeCommit(SNAPSHOT_V1, GENESIS_PARENT_HASH, AUTHOR, MESSAGE, NOW, SHA256_PORT);
    expect(c.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
