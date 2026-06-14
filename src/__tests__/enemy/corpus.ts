/**
 * T-0154 · ВРАГ — append-only regression corpus loader.
 *
 * spec: playbooks/enemy-redteam-backlog.md §6 «Корпус-антитела — каждая
 * подтверждённая атака навсегда в регрессии». Catalog §7.5: the corpus is the
 * append-only antibody store; it follows the same append-only discipline as the
 * audit ledger / frozen-sanctions.jsonl (T-0199).
 *
 * FORMAT: corpus/corpus.jsonl — one compact JSON `AttackCase` per line.
 *   - `#`-prefixed and blank lines are comments (ignored), like frozen-sanctions.jsonl.
 *   - APPEND-ONLY: lines are never deleted or weakened; new confirmed attacks are
 *     appended. The fitness check ci/checks/enemy/corpus-append-only.sh (owned by
 *     T-0154) enforces this against the merge base (git show BASE_REF), mirroring
 *     frozen-checks-immutable's BASE_REF technique.
 *
 * Every corpus case is REPLAYED against the real surfaces on every CI run
 * (enemy.adversarial.test.ts) — a permanent regression: once an attack is
 * recorded, the system must forever deny it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { type AttackCase } from "./enemy-harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = join(HERE, "corpus", "corpus.jsonl");

/** Parse a JSONL corpus body into AttackCases (skips `#`/blank lines). */
export function parseCorpus(body: string): AttackCase[] {
  const cases: AttackCase[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `corpus.jsonl line ${i + 1} is not valid JSON: ${(err as Error).message}\n  line: ${line}`,
      );
    }
    const c = parsed as AttackCase;
    if (!c.id || !c.family || !c.input || !c.expect) {
      throw new Error(
        `corpus.jsonl line ${i + 1} is missing a required field (id/family/input/expect): ${line}`,
      );
    }
    cases.push(c);
  }
  return cases;
}

/** Load the on-disk corpus. */
export function loadCorpus(): AttackCase[] {
  return parseCorpus(readFileSync(CORPUS_PATH, "utf8"));
}
