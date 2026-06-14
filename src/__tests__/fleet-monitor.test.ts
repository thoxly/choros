/**
 * Unit tests for the pure silo-fleet monitor core (T-0069, tenancy ADR §10).
 * All functions under test are pure (now/known-migrations injected) — no IO, no DB.
 */
import { describe, it, expect } from "vitest";
import {
  fleetHead,
  sortMigrationStems,
  migrationDrift,
  backupAgeHours,
  reportCell,
  reportFleet,
  DEFAULT_THRESHOLDS,
  type Cell,
  type CellRegistry,
} from "../core/fleet-monitor.js";

const KNOWN = ["001_a", "002_b", "010_c", "055_head"];
const NOW = new Date("2026-06-14T12:00:00.000Z");

function cell(p: Partial<Cell>): Cell {
  return {
    slug: "c",
    tier: "standard",
    mode: "silo",
    migration_version: "055_head",
    endpoint: "h:1",
    status: "active",
    last_backup_at: NOW.toISOString(),
    ...p,
  };
}

describe("sort + head (mirrors run.mjs lexicographic order)", () => {
  it("sorts so 002 < 010 < 055", () => {
    expect(sortMigrationStems(["010_c", "002_b", "055_head", "001_a"])).toEqual([
      "001_a",
      "002_b",
      "010_c",
      "055_head",
    ]);
  });
  it("head is the lexicographically-last stem", () => {
    expect(fleetHead(KNOWN)).toBe("055_head");
    expect(fleetHead([])).toBeNull();
  });
});

describe("migrationDrift", () => {
  it("0 when pinned at head", () => {
    expect(migrationDrift("055_head", KNOWN)).toBe(0);
  });
  it("counts migrations after the pin", () => {
    expect(migrationDrift("002_b", KNOWN)).toBe(2); // 010_c, 055_head
    expect(migrationDrift("001_a", KNOWN)).toBe(3);
  });
  it("-1 for an unknown pin", () => {
    expect(migrationDrift("999_ghost", KNOWN)).toBe(-1);
  });
});

describe("backupAgeHours", () => {
  it("computes hours before now", () => {
    expect(backupAgeHours("2026-06-14T06:00:00.000Z", NOW)).toBeCloseTo(6, 6);
  });
  it("null for missing or unparseable", () => {
    expect(backupAgeHours(null, NOW)).toBeNull();
    expect(backupAgeHours("not-a-date", NOW)).toBeNull();
  });
});

describe("reportCell health", () => {
  it("ok: at head + fresh backup", () => {
    const r = reportCell(cell({}), KNOWN, NOW);
    expect(r.health).toBe("ok");
    expect(r.flags).toEqual([]);
    expect(r.migrationDrift).toBe(0);
  });

  it("warn: 1 migration behind", () => {
    const r = reportCell(cell({ migration_version: "010_c" }), KNOWN, NOW);
    expect(r.migrationDrift).toBe(1);
    expect(r.health).toBe("warn");
  });

  it("critical: 3+ migrations behind", () => {
    const r = reportCell(cell({ migration_version: "001_a" }), KNOWN, NOW);
    expect(r.migrationDrift).toBe(3);
    expect(r.health).toBe("critical");
  });

  it("critical: unknown migration version", () => {
    const r = reportCell(cell({ migration_version: "999_ghost" }), KNOWN, NOW);
    expect(r.migrationDrift).toBe(-1);
    expect(r.health).toBe("critical");
    expect(r.flags.some((f) => f.includes("unknown"))).toBe(true);
  });

  it("critical: no recorded backup", () => {
    const r = reportCell(cell({ last_backup_at: null }), KNOWN, NOW);
    expect(r.health).toBe("critical");
    expect(r.flags).toContain("no recorded backup");
  });

  it("warn: backup past one cycle", () => {
    const stale = new Date(NOW.getTime() - 30 * 3_600_000).toISOString();
    const r = reportCell(cell({ last_backup_at: stale }), KNOWN, NOW);
    expect(r.health).toBe("warn");
  });

  it("critical: backup past two cycles", () => {
    const stale = new Date(NOW.getTime() - 60 * 3_600_000).toISOString();
    const r = reportCell(cell({ last_backup_at: stale }), KNOWN, NOW);
    expect(r.health).toBe("critical");
  });

  it("retired cells are reported but never flagged", () => {
    const r = reportCell(cell({ status: "retired", last_backup_at: null, migration_version: "001_a" }), KNOWN, NOW);
    expect(r.health).toBe("ok");
    expect(r.flags).toEqual([]);
  });

  it("provisioning cells are exempt from backup-freshness", () => {
    const r = reportCell(cell({ status: "provisioning", last_backup_at: null }), KNOWN, NOW);
    // drift ok (at head), backup exempt → ok
    expect(r.health).toBe("ok");
  });

  it("thresholds are injectable", () => {
    const r = reportCell(cell({ migration_version: "010_c" }), KNOWN, NOW, {
      ...DEFAULT_THRESHOLDS,
      driftWarnCount: 5,
      driftCriticalCount: 9,
    });
    expect(r.migrationDrift).toBe(1);
    expect(r.health).toBe("ok"); // 1 < warn threshold of 5
  });
});

describe("reportFleet", () => {
  const registry: CellRegistry = {
    meta: { registry_version: "1", description: "test" },
    cells: [
      cell({ slug: "dev", migration_version: "055_head" }),
      cell({ slug: "lagger", migration_version: "001_a", last_backup_at: null }),
      cell({ slug: "retired-old", status: "retired", migration_version: "001_a", last_backup_at: null }),
    ],
  };

  it("aggregates worst health, drift and stale-backup counts", () => {
    const report = reportFleet(registry, NOW, KNOWN);
    expect(report.fleetHead).toBe("055_head");
    expect(report.cellCount).toBe(3);
    expect(report.worst).toBe("critical");
    // dev=0 drift, lagger drifted, retired drifted (drift!=0 still counts the fact)
    expect(report.driftedCount).toBe(2);
    expect(report.staleBackupCount).toBe(1); // only lagger (retired exempt)
    expect(report.generatedAt).toBe(NOW.toISOString());
  });

  it("degraded mode: derives head from cell pins when no known set given", () => {
    const report = reportFleet(registry, NOW);
    expect(report.fleetHead).toBe("055_head"); // max pinned
  });

  it("clean fleet is ok", () => {
    const clean: CellRegistry = {
      meta: { registry_version: "1", description: "clean" },
      cells: [cell({ slug: "dev" })],
    };
    const report = reportFleet(clean, NOW, KNOWN);
    expect(report.worst).toBe("ok");
    expect(report.driftedCount).toBe(0);
    expect(report.staleBackupCount).toBe(0);
  });
});
