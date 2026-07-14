/**
 * src/cli/fleet-monitor.ts — T-0069 centralized silo-fleet monitor CLI (tenancy ADR §10)
 *
 * Reports, per silo cell, migration drift + backup freshness so the fleet never
 * silently drifts. Deterministic and OFFLINE: it reads ops/fleet/cells.json and
 * the migrations/ directory only — it does NOT contact any cell. Exit code
 * reflects worst health (0 ok, 1 warn, 2 critical) so it composes into ops cron.
 *
 * This is the ONLY module in this slice allowed fs / process.env / process.exit;
 * src/core/fleet-monitor.ts is pure (NF-1 / no-env-in-core).
 *
 * Usage:
 *   node dist/cli/fleet-monitor.js                 # human table, default paths
 *   node dist/cli/fleet-monitor.js --json          # machine-readable report
 *   node dist/cli/fleet-monitor.js --registry <p> --migrations <dir>
 *
 * ENDPOINT-PROBE SEAM (documented, intentionally a stub here):
 *   Real backup freshness lives on each cell's host (e.g. `pg_dump` artifact mtime
 *   or a backup-manifest endpoint at cell.endpoint). Servers are NOT provisioned
 *   in this environment, so freshness is sourced from the registry's
 *   `last_backup_at` field (populated out-of-band). To wire live probing later,
 *   implement a `probeBackup(cell): Promise<string|null>` over cell.endpoint and
 *   merge its result into each cell before calling reportFleet — the pure core is
 *   already shaped to consume a resolved `last_backup_at`. No core change needed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  reportFleet,
  type CellRegistry,
  type FleetReport,
} from "../core/fleet-monitor.js";

const MIGRATION_FILE_RE = /^(\d{3,}_[A-Za-z0-9_]+)\.sql$/;

/** Read migration stems from a migrations dir (mirrors run.mjs discovery). */
function readMigrationStems(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .map((name) => MIGRATION_FILE_RE.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!);
}

function loadRegistry(registryPath: string): CellRegistry {
  return JSON.parse(readFileSync(registryPath, "utf8")) as CellRegistry;
}

function exitCodeFor(report: FleetReport): number {
  return report.worst === "critical" ? 2 : report.worst === "warn" ? 1 : 0;
}

function renderTable(report: FleetReport): string {
  const lines: string[] = [];
  lines.push(`Choros silo-fleet monitor — ${report.generatedAt}`);
  lines.push(
    `fleet head: ${report.fleetHead ?? "<none>"} · cells: ${report.cellCount} · drifted: ${report.driftedCount} · stale-backup: ${report.staleBackupCount} · worst: ${report.worst.toUpperCase()}`,
  );
  lines.push("");
  lines.push("CELL".padEnd(18) + "HEALTH".padEnd(10) + "DRIFT".padEnd(7) + "BACKUP-AGE".padEnd(14) + "FLAGS");
  for (const c of report.cells) {
    const age = c.backupAgeHours == null ? "—" : `${c.backupAgeHours.toFixed(1)}h`;
    const drift = c.migrationDrift < 0 ? "?" : String(c.migrationDrift);
    lines.push(
      c.slug.padEnd(18) +
        c.health.toUpperCase().padEnd(10) +
        drift.padEnd(7) +
        age.padEnd(14) +
        (c.flags.length ? c.flags.join("; ") : "ok"),
    );
  }
  return lines.join("\n");
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli/ → repo root is two levels up; ops/fleet + migrations sit at root.
  const repoRoot = resolve(here, "..", "..");

  let values: { json?: boolean; registry?: string; migrations?: string };
  try {
    ({ values } = parseArgs({
      options: {
        json: { type: "boolean" },
        registry: { type: "string" },
        migrations: { type: "string" },
      },
      strict: false,
    }) as { values: typeof values });
  } catch {
    values = {};
  }

  const registryPath = values.registry ?? join(repoRoot, "ops", "fleet", "cells.json");
  const migrationsDir = values.migrations ?? join(repoRoot, "migrations");

  let report: FleetReport;
  try {
    const registry = loadRegistry(registryPath);
    const known = readMigrationStems(migrationsDir);
    report = reportFleet(registry, new Date(), known);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
    process.exit(2);
    return;
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ ok: true, report }, null, 2) + "\n");
  } else {
    process.stdout.write(renderTable(report) + "\n");
  }
  process.exit(exitCodeFor(report));
}

const isMain =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith("fleet-monitor.js"));

if (isMain) main();
