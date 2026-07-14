/**
 * src/vendor/file-license-store.ts — T-0242
 *
 * MVP file-backed implementation of the LicenseStore port.
 * Stores LicenseRecords as a JSON array in a gitignored file on the vendor machine.
 * This is NOT a tenant table, NOT in choros/migrations/ — vendor ledger only.
 *
 * Zero runtime deps. Synchronous I/O (vendor CLI tool, not a hot path).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { LicenseRecord, LicenseStore } from "./issuance.js";

/** File-backed LicenseStore — reads/writes a JSON ledger file. */
export class FileLicenseStore implements LicenseStore {
  private readonly path: string;

  constructor(ledgerPath: string) {
    this.path = ledgerPath;
  }

  private readAll(): LicenseRecord[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as LicenseRecord[]) : [];
    } catch {
      return [];
    }
  }

  private writeAll(records: LicenseRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(records, null, 2), "utf8");
  }

  getByCircuit(circuit_id: string): LicenseRecord | null {
    const all = this.readAll();
    return all.find((r) => r.circuit_id === circuit_id) ?? null;
  }

  upsert(rec: LicenseRecord): LicenseRecord {
    const all = this.readAll();
    const idx = all.findIndex((r) => r.circuit_id === rec.circuit_id);
    if (idx >= 0) {
      all[idx] = rec;
    } else {
      all.push(rec);
    }
    this.writeAll(all);
    return rec;
  }
}

/** In-memory LicenseStore — for tests (no filesystem). */
export class InMemoryLicenseStore implements LicenseStore {
  private records = new Map<string, LicenseRecord>();

  getByCircuit(circuit_id: string): LicenseRecord | null {
    return this.records.get(circuit_id) ?? null;
  }

  upsert(rec: LicenseRecord): LicenseRecord {
    this.records.set(rec.circuit_id, rec);
    return rec;
  }
}
