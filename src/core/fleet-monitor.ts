/**
 * src/core/fleet-monitor.ts — T-0069 (tenancy ADR §10)
 *
 * PURE core for the centralized silo-fleet monitor: given a parsed cell
 * registry, reports per-cell migration drift and backup freshness so the fleet
 * never silently drifts (a tenant on an old migration version / a stale backup
 * is the §10 risk this catches before it becomes an incident).
 *
 * Purity contract (NF-1 / no-env-in-core): NO process.env, NO fs, NO network,
 * NO Date.now() — `now` and the (optional) live backup-probe result are passed
 * in. All file/env/IO and the real endpoint probe live in src/cli/fleet-monitor.ts.
 *
 * Endpoint probe SEAM: the real fleet has no provisioned servers here, so live
 * backup timestamps come from the registry's `last_backup_at` (populated offline)
 * OR, when the CLI is wired to live cells, from an injected probe. The core does
 * not care which — it consumes a resolved `lastBackupAt` per cell.
 */

export type CellMode = "silo" | "pooled";
export type CellTier = "standard" | "regulated" | "enterprise";
export type CellStatus = "active" | "provisioning" | "draining" | "retired";

export interface Cell {
  slug: string;
  display_name?: string;
  tier: CellTier;
  mode: CellMode;
  /** Migration stem the cell is provisioned to, e.g. "055_fix_mcp_tool_demo_tenant". */
  migration_version: string;
  endpoint: string;
  status: CellStatus;
  /** ISO-8601 UTC; null if never backed up / unknown. */
  last_backup_at?: string | null;
}

export interface CellRegistry {
  meta: { registry_version: string; description: string };
  cells: Cell[];
}

export type CellHealth = "ok" | "warn" | "critical";

export interface CellReport {
  slug: string;
  tier: CellTier;
  mode: CellMode;
  status: CellStatus;
  migrationVersion: string;
  /** How many migrations behind the fleet head this cell is (0 = up to date). */
  migrationDrift: number;
  /** Age of the last backup in hours, or null if never backed up / unknown. */
  backupAgeHours: number | null;
  /** Reasons the cell is not "ok" (empty when ok). */
  flags: string[];
  health: CellHealth;
}

export interface FleetReport {
  generatedAt: string;
  fleetHead: string | null;
  cellCount: number;
  driftedCount: number;
  staleBackupCount: number;
  worst: CellHealth;
  cells: CellReport[];
}

export interface MonitorThresholds {
  /** Backup age (hours) at/above which a cell is flagged warn. */
  backupWarnHours: number;
  /** Backup age (hours) at/above which a cell is flagged critical. */
  backupCriticalHours: number;
  /** Migration drift (count) at/above which a cell is flagged warn. */
  driftWarnCount: number;
  /** Migration drift (count) at/above which a cell is flagged critical. */
  driftCriticalCount: number;
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  backupWarnHours: 26, // a daily backup that slipped past one cycle
  backupCriticalHours: 50, // two missed cycles
  driftWarnCount: 1,
  driftCriticalCount: 3,
};

const MIG_STEM_RE = /^(\d{3,})_[A-Za-z0-9_]+$/;

/**
 * Sort migration stems the same way migrations/run.mjs applies them:
 * lexicographically (so 001 < 002 < ... < 010). Returns a new sorted array.
 */
export function sortMigrationStems(stems: readonly string[]): string[] {
  return [...stems].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Fleet head = the lexicographically-last known migration stem, or null. */
export function fleetHead(knownMigrations: readonly string[]): string | null {
  const sorted = sortMigrationStems(knownMigrations);
  return sorted.length ? sorted[sorted.length - 1]! : null;
}

/**
 * Count how many migration stems sort strictly after `pin`, i.e. how many
 * migrations a cell pinned at `pin` has not yet received. -1 if the pin is
 * unknown (not in knownMigrations) — an unknown pin is a hard registry error
 * caught by the CI matrix, surfaced here as drift = -1.
 */
export function migrationDrift(pin: string, knownMigrations: readonly string[]): number {
  if (!knownMigrations.includes(pin)) return -1;
  let behind = 0;
  for (const m of knownMigrations) if (m > pin) behind += 1;
  return behind;
}

/** ISO-8601 → hours before `now`, or null if missing/unparseable. */
export function backupAgeHours(lastBackupAt: string | null | undefined, now: Date): number | null {
  if (lastBackupAt == null) return null;
  const t = Date.parse(lastBackupAt);
  if (Number.isNaN(t)) return null;
  const ms = now.getTime() - t;
  return ms / 3_600_000;
}

function worse(a: CellHealth, b: CellHealth): CellHealth {
  const rank: Record<CellHealth, number> = { ok: 0, warn: 1, critical: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Build a per-cell report. Pure: `now`, the known-migration set, and thresholds
 * are all injected. Retired cells are reported but never flagged (out of fleet SLA).
 */
export function reportCell(
  cell: Cell,
  knownMigrations: readonly string[],
  now: Date,
  thresholds: MonitorThresholds = DEFAULT_THRESHOLDS,
): CellReport {
  const drift = migrationDrift(cell.migration_version, knownMigrations);
  const ageH = backupAgeHours(cell.last_backup_at, now);
  const flags: string[] = [];
  let health: CellHealth = "ok";

  const retired = cell.status === "retired";

  // Migration drift.
  if (drift < 0) {
    flags.push(`migration_version '${cell.migration_version}' is unknown to the fleet`);
    if (!retired) health = worse(health, "critical");
  } else if (!retired && drift >= thresholds.driftCriticalCount) {
    flags.push(`${drift} migrations behind fleet head (critical)`);
    health = worse(health, "critical");
  } else if (!retired && drift >= thresholds.driftWarnCount) {
    flags.push(`${drift} migration(s) behind fleet head`);
    health = worse(health, "warn");
  }

  // Backup freshness. Provisioning cells are exempt (no data to back up yet).
  if (!retired && cell.status !== "provisioning") {
    if (ageH == null) {
      flags.push("no recorded backup");
      health = worse(health, "critical");
    } else if (ageH >= thresholds.backupCriticalHours) {
      flags.push(`last backup ${ageH.toFixed(1)}h ago (critical)`);
      health = worse(health, "critical");
    } else if (ageH >= thresholds.backupWarnHours) {
      flags.push(`last backup ${ageH.toFixed(1)}h ago`);
      health = worse(health, "warn");
    }
  }

  return {
    slug: cell.slug,
    tier: cell.tier,
    mode: cell.mode,
    status: cell.status,
    migrationVersion: cell.migration_version,
    migrationDrift: drift,
    backupAgeHours: ageH,
    flags,
    health,
  };
}

/**
 * Build the whole fleet report from a parsed registry + the known migration set.
 * Pure (inject `now`). `knownMigrations` should be the list of migration stems
 * present in migrations/ (read by the CLI). If omitted, drift is computed
 * against the set of versions the cells themselves declare (degraded mode —
 * head is then the max pinned version).
 */
export function reportFleet(
  registry: CellRegistry,
  now: Date,
  knownMigrations?: readonly string[],
  thresholds: MonitorThresholds = DEFAULT_THRESHOLDS,
): FleetReport {
  const known =
    knownMigrations && knownMigrations.length > 0
      ? knownMigrations
      : registry.cells.map((c) => c.migration_version).filter((v) => MIG_STEM_RE.test(v));

  const head = fleetHead(known);
  const cells = registry.cells.map((c) => reportCell(c, known, now, thresholds));

  let worst: CellHealth = "ok";
  let driftedCount = 0;
  let staleBackupCount = 0;
  for (const r of cells) {
    worst = worse(worst, r.health);
    if (r.migrationDrift !== 0) driftedCount += 1;
    if (r.flags.some((f) => f.startsWith("last backup") || f === "no recorded backup")) staleBackupCount += 1;
  }

  return {
    generatedAt: now.toISOString(),
    fleetHead: head,
    cellCount: cells.length,
    driftedCount,
    staleBackupCount,
    worst,
    cells,
  };
}
