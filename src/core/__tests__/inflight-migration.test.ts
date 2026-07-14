/**
 * T-0086 · inflight-migration unit tests
 *
 * Covers:
 *   - drainInstance: creates InstanceDrainRecord with state="draining" (drain default)
 *   - guardRollback: blocked while live instances exist; allowed when clear (fail-closed)
 *   - validateCamundaMapping: mapping is gated (requires_human_gate=true always)
 *
 * Pure unit tests — no DB, no pg. Uses stub RollbackSafePort.
 */

import { describe, it, expect } from 'vitest';
import {
  drainInstance,
  guardRollback,
  validateCamundaMapping,
  type InstanceDrainRecord,
  type RollbackSafePort,
  type CamundaMappingRequest,
} from '../inflight-migration.js';

// ---------------------------------------------------------------------------
// Stub RollbackSafePort
// ---------------------------------------------------------------------------

/** Create a stub port that reports safe/unsafe and a given live count. */
function makeStubPort(opts: {
  isRollbackSafe: boolean;
  liveCount: number;
}): RollbackSafePort {
  return {
    async isRollbackSafe(_tenantId: string, _registryId: string, _targetVersion: number): Promise<boolean> {
      return opts.isRollbackSafe;
    },
    async countLiveInstancesAboveVersion(
      _tenantId: string,
      _bundleId: string,
      _targetVersion: number,
    ): Promise<number> {
      return opts.liveCount;
    },
  };
}

/** A port that throws (simulates transport / DB failure). */
function makeThrowingPort(): RollbackSafePort {
  return {
    async isRollbackSafe(): Promise<boolean> {
      throw new Error("DB connection refused (test stub)");
    },
    async countLiveInstancesAboveVersion(): Promise<number> {
      throw new Error("DB connection refused (test stub)");
    },
  };
}

// ---------------------------------------------------------------------------
// drainInstance tests
// ---------------------------------------------------------------------------

describe('drainInstance', () => {
  const TENANT  = '11111111-1111-1111-1111-111111111111';
  const PROC    = 'proc-abc-001';
  const BUNDLE  = 'bundle-xyz';
  const HASH    = 'a'.repeat(64);
  const NOW     = 1718000000000;

  it('creates an InstanceDrainRecord with state="draining" (DRAIN-by-default)', () => {
    const rec: InstanceDrainRecord = drainInstance(TENANT, PROC, BUNDLE, HASH, NOW);
    expect(rec.state).toBe('draining');
    expect(rec.tenant_id).toBe(TENANT);
    expect(rec.process_instance_id).toBe(PROC);
    expect(rec.bundle_id).toBe(BUNDLE);
    expect(rec.pinned_content_hash).toBe(HASH);
    expect(rec.pinned_at).toBe(NOW);
  });

  it('drain state is "draining" not "completed" (drain is the safe default)', () => {
    const rec = drainInstance(TENANT, PROC, BUNDLE, HASH, NOW);
    expect(rec.state).toBe('draining');
    expect(rec.state).not.toBe('completed');
  });

  it('throws on empty tenant_id (invalid input)', () => {
    expect(() => drainInstance('', PROC, BUNDLE, HASH, NOW)).toThrow(/tenant_id/);
  });

  it('throws on empty process_instance_id', () => {
    expect(() => drainInstance(TENANT, '', BUNDLE, HASH, NOW)).toThrow(/process_instance_id/);
  });

  it('throws on empty bundle_id', () => {
    expect(() => drainInstance(TENANT, PROC, '', HASH, NOW)).toThrow(/bundle_id/);
  });

  it('throws on empty pinned_content_hash', () => {
    expect(() => drainInstance(TENANT, PROC, BUNDLE, '', NOW)).toThrow(/pinned_content_hash/);
  });

  it('throws on non-integer pinned_at', () => {
    expect(() => drainInstance(TENANT, PROC, BUNDLE, HASH, 1.5)).toThrow(/pinned_at/);
  });

  it('throws on negative pinned_at', () => {
    expect(() => drainInstance(TENANT, PROC, BUNDLE, HASH, -1)).toThrow(/pinned_at/);
  });
});

// ---------------------------------------------------------------------------
// guardRollback tests — rollback is BLOCKED while live instances exist
// ---------------------------------------------------------------------------

describe('guardRollback', () => {
  const TENANT     = '11111111-1111-1111-1111-111111111111';
  const REGISTRY   = '22222222-2222-2222-2222-222222222222';
  const BUNDLE     = 'bundle-abc';
  const VERSION    = 2;

  it('is BLOCKED when schema check says not safe (live records at newer version)', async () => {
    const port = makeStubPort({ isRollbackSafe: false, liveCount: 3 });
    const result = await guardRollback(TENANT, REGISTRY, BUNDLE, VERSION, port);
    expect(result.allowed).toBe(false);
    expect(result.live_instance_count).toBeGreaterThanOrEqual(0);
    expect(result.reason).toMatch(/BLOCKED/i);
  });

  it('is BLOCKED when live instances exist on this bundle even if schema check passes', async () => {
    // Schema says safe (no records above target version), but live instances exist
    const port = makeStubPort({ isRollbackSafe: true, liveCount: 2 });
    const result = await guardRollback(TENANT, REGISTRY, BUNDLE, VERSION, port);
    expect(result.allowed).toBe(false);
    expect(result.live_instance_count).toBe(2);
    expect(result.reason).toMatch(/BLOCKED/i);
  });

  it('is ALLOWED when schema is safe AND no live instances block rollback', async () => {
    const port = makeStubPort({ isRollbackSafe: true, liveCount: 0 });
    const result = await guardRollback(TENANT, REGISTRY, BUNDLE, VERSION, port);
    expect(result.allowed).toBe(true);
    expect(result.live_instance_count).toBe(0);
  });

  it('is BLOCKED (fail-CLOSED) when port throws (DB unreachable)', async () => {
    const port = makeThrowingPort();
    const result = await guardRollback(TENANT, REGISTRY, BUNDLE, VERSION, port);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/port error/i);
  });

  it('is BLOCKED when live_instance_count is 1 (boundary: one live instance = blocked)', async () => {
    const port = makeStubPort({ isRollbackSafe: true, liveCount: 1 });
    const result = await guardRollback(TENANT, REGISTRY, BUNDLE, VERSION, port);
    expect(result.allowed).toBe(false);
    expect(result.live_instance_count).toBe(1);
  });

  it('returns allowed=false for empty tenant_id (fail-CLOSED on invalid input)', async () => {
    const port = makeStubPort({ isRollbackSafe: true, liveCount: 0 });
    const result = await guardRollback('', REGISTRY, BUNDLE, VERSION, port);
    expect(result.allowed).toBe(false);
  });

  it('returns allowed=false for empty registry_id', async () => {
    const port = makeStubPort({ isRollbackSafe: true, liveCount: 0 });
    const result = await guardRollback(TENANT, '', BUNDLE, VERSION, port);
    expect(result.allowed).toBe(false);
  });

  it('returns allowed=false for negative target_version', async () => {
    const port = makeStubPort({ isRollbackSafe: true, liveCount: 0 });
    const result = await guardRollback(TENANT, REGISTRY, BUNDLE, -1, port);
    expect(result.allowed).toBe(false);
  });

  it('always has a non-empty reason when blocked', async () => {
    const port = makeStubPort({ isRollbackSafe: false, liveCount: 5 });
    const result = await guardRollback(TENANT, REGISTRY, BUNDLE, VERSION, port);
    expect(result.allowed).toBe(false);
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// validateCamundaMapping tests — mapping is gated (NOT the default)
// ---------------------------------------------------------------------------

describe('validateCamundaMapping', () => {
  /** A minimal valid mapping request for use in tests. */
  function validRequest(): CamundaMappingRequest {
    return {
      tenant_id:            '11111111-1111-1111-1111-111111111111',
      process_instance_id:  'proc-001',
      from_content_hash:    'a'.repeat(64),
      to_content_hash:      'b'.repeat(64),
      from_activity: {
        activity_id: 'Task_ReviewContract',
        kind: 'userTask',
      },
      to_activity: {
        activity_id: 'Task_ReviewContract',
        kind: 'userTask',
      },
      auto_map_matching_ids: false,
      requested_by: 'founder@example.com',
      requested_at: 1718000000000,
    };
  }

  it('requires_human_gate is ALWAYS true (mapping is never automatic)', () => {
    const result = validateCamundaMapping(validRequest());
    expect(result.requires_human_gate).toBe(true);
  });

  it('a valid request passes structural validation', () => {
    const result = validateCamundaMapping(validRequest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-wait-state fromActivity kind (e.g. serviceTask)', () => {
    const req = validRequest();
    // Force an invalid kind value to simulate non-wait-state activity
    (req.from_activity as { kind: string }).kind = 'serviceTask';
    const result = validateCamundaMapping(req);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('wait-state'))).toBe(true);
    // Even invalid requests must still require human gate
    expect(result.requires_human_gate).toBe(true);
  });

  it('rejects activity type change (fromActivity.kind !== toActivity.kind)', () => {
    const req = validRequest();
    req.to_activity.kind = 'receiveTask'; // different kind
    const result = validateCamundaMapping(req);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('type change'))).toBe(true);
  });

  it('rejects empty requested_by (audit trail required)', () => {
    const req = validRequest();
    req.requested_by = '';
    const result = validateCamundaMapping(req);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('requested_by'))).toBe(true);
  });

  it('rejects identical from/to content_hash (must be a real version change)', () => {
    const req = validRequest();
    req.to_content_hash = req.from_content_hash;
    const result = validateCamundaMapping(req);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('differ') || e.includes('version change'))).toBe(true);
  });

  it('rejects empty from_activity_id', () => {
    const req = validRequest();
    req.from_activity.activity_id = '';
    const result = validateCamundaMapping(req);
    expect(result.valid).toBe(false);
  });

  it('requires_human_gate is true even for invalid requests (safety invariant)', () => {
    const req = validRequest();
    req.requested_by = '';
    req.to_content_hash = req.from_content_hash;
    const result = validateCamundaMapping(req);
    expect(result.valid).toBe(false);
    // SAFETY: even structurally invalid requests must require human gate
    expect(result.requires_human_gate).toBe(true);
  });

  it('allows receiveTask → receiveTask mapping (valid wait-state to same kind)', () => {
    const req = validRequest();
    req.from_activity.kind = 'receiveTask';
    req.to_activity.kind = 'receiveTask';
    const result = validateCamundaMapping(req);
    expect(result.valid).toBe(true);
  });

  it('allows intermediateCatchEvent → intermediateCatchEvent mapping', () => {
    const req = validRequest();
    req.from_activity.kind = 'intermediateCatchEvent';
    req.to_activity.kind = 'intermediateCatchEvent';
    const result = validateCamundaMapping(req);
    expect(result.valid).toBe(true);
  });

  it('allows callActivity → callActivity mapping', () => {
    const req = validRequest();
    req.from_activity.kind = 'callActivity';
    req.to_activity.kind = 'callActivity';
    const result = validateCamundaMapping(req);
    expect(result.valid).toBe(true);
  });
});
