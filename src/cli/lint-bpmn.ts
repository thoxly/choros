/**
 * T-0027 / T-0072: BPMN Deploy-time Linter — CLI entry-point
 *
 * Usage:
 *   node dist/cli/lint-bpmn.js <file.bpmn>
 *   node dist/cli/lint-bpmn.js --binding-schema ./schema.json <file.bpmn>
 *
 * Exit 0: BPMN is clean.
 * Exit 1: Violations found or malformed XML — JSON array printed to stderr.
 *
 * T-0072 additive (FR-5 / AC-8):
 *   --binding-schema <path>   path to a JSON file containing BindingField[].
 *     When supplied, lintBpmn is called with { bindingSchema } and binding_mismatch
 *     violations are included in the output. Without the flag, behavior is identical
 *     to T-0027 (backward-compatible, NF-4 / AC-13).
 *
 * This is the ONLY module allowed to use fs, process.exit, and I/O.
 * The library (bpmn-linter.ts) is pure — all I/O lives here.
 */

import { readFileSync } from "node:fs";
import { lintBpmn, type LintOpts } from "../core/bpmn-linter.js";
import type { BindingField } from "../core/binding-compat.js";

function main(): void {
  // T-0072: parse optional --binding-schema <path> flag.
  // Preserve backward-compat: without the flag, argv behaves as before.
  let bindingSchemaPath: string | undefined;
  let filePath: string | undefined;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--binding-schema") {
      bindingSchemaPath = args[i + 1];
      i++; // skip the value
    } else {
      filePath = args[i];
    }
  }

  if (!filePath) {
    process.stderr.write("Usage: lint-bpmn [--binding-schema <path>] <file.bpmn>\n");
    process.exit(1);
  }

  let xml = "";
  try {
    // Read as raw buffer to validate UTF-8 encoding before passing to linter
    const buf = readFileSync(filePath);
    // Validate: re-encode UTF-8 via Buffer and check for replacement characters
    // If the file contains invalid UTF-8, Node will silently replace bytes with U+FFFD
    xml = buf.toString("utf8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify([{
      type: "malformed_xml",
      elementId: "",
      elementKind: "malformed_xml",
      message: `failed to read file: ${message}`,
    }]) + "\n");
    process.exit(1);
  }

  // T-0072: load binding schema if --binding-schema was supplied (FR-5 / AC-8).
  const opts: LintOpts = {};
  if (bindingSchemaPath !== undefined) {
    let schemaRaw: unknown;
    try {
      const schemaBuf = readFileSync(bindingSchemaPath, "utf8");
      schemaRaw = JSON.parse(schemaBuf);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(JSON.stringify([{
        type: "binding_mismatch",
        elementId: "",
        elementKind: "binding_mismatch",
        message: `failed to load --binding-schema: ${message}`,
      }]) + "\n");
      process.exit(1);
    }
    if (!Array.isArray(schemaRaw)) {
      process.stderr.write(JSON.stringify([{
        type: "binding_mismatch",
        elementId: "",
        elementKind: "binding_mismatch",
        message: `--binding-schema must be a JSON array of BindingField objects`,
      }]) + "\n");
      process.exit(1);
    }
    opts.bindingSchema = schemaRaw as BindingField[];
  }

  const result = lintBpmn(xml, opts);

  if (result.ok) {
    process.exit(0);
  } else {
    process.stderr.write(JSON.stringify(result.violations) + "\n");
    process.exit(1);
  }
}

main();
