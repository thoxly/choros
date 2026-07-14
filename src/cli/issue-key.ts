#!/usr/bin/env node
/**
 * src/cli/issue-key.ts — T-0242
 *
 * Thin CLI adapter for vendor pilot key issuance.
 * This is the ONLY place that reads the vendor private key from disk (NF-2 / ADR §1.4).
 * All logic lives in issueEntitlement + signKey in src/vendor/issuance.ts.
 *
 * Usage:
 *   npx tsx src/cli/issue-key.ts \
 *     --circuit-id <uuid>          \
 *     --plan pilot|pro             \
 *     --valid-days <N>             \   (default: 365)
 *     --priv-key <path-to-pem>     \   (NEVER committed to git)
 *     [--notes <text>]             \
 *     [--out <output-file>]        \   (gitignored by convention)
 *     [--store <ledger-path>]          (default: ./vendor-ledger.json)
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  issueEntitlement,
  signKey,
  PILOT_PLAN,
  PRO_PLAN,
  type PlanSpec,
} from "../vendor/issuance.js";
import { FileLicenseStore } from "../vendor/file-license-store.js";

// ---------------------------------------------------------------------------
// Arg parsing (no external dep)
// ---------------------------------------------------------------------------

function arg(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1] ?? null;
}

function run(): void {
  const args = process.argv.slice(2);

  const circuitId = arg(args, "--circuit-id");
  const planLabel = arg(args, "--plan") ?? "pilot";
  const validDaysStr = arg(args, "--valid-days") ?? "365";
  const privKeyPath = arg(args, "--priv-key");
  const notes = arg(args, "--notes");
  const outPath = arg(args, "--out");
  const storePath = arg(args, "--store") ?? "./vendor-ledger.json";

  if (!circuitId) {
    process.stderr.write("Error: --circuit-id is required\n");
    process.exit(1);
  }
  if (!privKeyPath) {
    process.stderr.write("Error: --priv-key is required\n");
    process.exit(1);
  }

  // Resolve plan preset.
  let plan: PlanSpec;
  if (planLabel === "pro") {
    plan = PRO_PLAN;
  } else if (planLabel === "pilot") {
    plan = PILOT_PLAN;
  } else {
    process.stderr.write(`Error: unknown plan '${planLabel}'; use 'pilot' or 'pro'\n`);
    process.exit(1);
  }

  const validDays = parseInt(validDaysStr, 10);
  if (!Number.isFinite(validDays) || validDays <= 0) {
    process.stderr.write(`Error: --valid-days must be a positive integer (got '${validDaysStr}')\n`);
    process.exit(1);
  }

  // Read private key — ONLY here, never inside issuance.ts (NF-2).
  let privKeyPem: Buffer;
  try {
    privKeyPem = readFileSync(privKeyPath);
  } catch (e) {
    process.stderr.write(`Error: cannot read --priv-key at '${privKeyPath}': ${String(e)}\n`);
    process.exit(1);
  }

  const now = new Date();
  const validFrom = now.toISOString();
  const validUntil = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000).toISOString();

  const store = new FileLicenseStore(storePath);

  // Issue (idempotent) then sign.
  const record = issueEntitlement(
    { circuit_id: circuitId, plan, valid_from: validFrom, valid_until: validUntil, source: "pilot", notes: notes ?? undefined },
    store,
    now,
  );

  const wire = signKey(record, privKeyPem, now);

  if (outPath) {
    writeFileSync(outPath, wire + "\n", "utf8");
    process.stderr.write(`Key written to ${outPath}\n`);
  }

  // Always print to stdout (operator copies to client).
  process.stdout.write(wire + "\n");
}

run();
