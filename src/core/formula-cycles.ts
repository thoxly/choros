/**
 * src/core/formula-cycles.ts — T-0580 [D-064 §A8 / К4]
 *
 * Cycle detection + topological ordering over the graph of FORMULA fields in a
 * single record_schema (FR-6/ADR §2.4). A formula may reference another
 * formula field, PROVIDED the dependency graph is acyclic. This module is the
 * authoring-time gate (schema save rejects a cycle, FR-7d) AND supplies the
 * deterministic evaluation order `computeAllDerivedFields` must use (§2.4 —
 * NOT a flat Promise.all, which would race two formulas that reference each
 * other and produce a non-deterministic "sees stale/undefined" result,
 * violating NF-6 determinism; rejected alternative A6).
 *
 * GRAPH: one node per formula-kind DerivedFieldSpec (fieldKey). An edge
 * fieldA → fieldB exists iff fieldA's formula references fieldB by name AND
 * fieldB is ALSO a formula field in this same spec list (a reference to a
 * plain scalar or a rollup/matrix-lookup field is not an edge in this graph —
 * those are computed independently, BEFORE formulas run, per §2.4 step 1).
 *
 * ALGORITHM: iterative depth-first topological sort (Kahn's algorithm would
 * work equally; DFS is used here for direct cycle-path reporting). A visited
 * node mid-DFS-stack that is revisited is the cycle — self-reference (`a=f(a)`)
 * is the same case with a graph of size 1 and a self-loop edge.
 *
 * Pure — no I/O. Only imports formula-parser.js's collectFieldRefs +
 * rollup-contract.js's DerivedFieldSpec type (type-only import — no runtime
 * coupling beyond the shared discriminated-union shape).
 */

import { collectFieldRefs, type FormulaAst } from "./formula-parser.js";

/** The minimal shape this module needs from a formula-kind DerivedFieldSpec. */
export interface FormulaGraphNode {
  readonly fieldKey: string;
  readonly ast: FormulaAst;
}

export type DetectFormulaCyclesResult =
  | { ok: true; order: string[] }
  | { ok: false; cycle: string[] };

/**
 * Topologically sort the formula-field dependency graph, or report a cycle.
 *
 * @param nodes  one entry per formula field in the schema (fieldKey + parsed ast).
 * @returns `{ ok:true, order }` — fieldKeys in a valid evaluation order (every
 *          dependency appears before its dependent); or `{ ok:false, cycle }` —
 *          the fieldKeys forming a cycle (self-reference reports `[fieldKey]`).
 */
export function detectFormulaCycles(nodes: readonly FormulaGraphNode[]): DetectFormulaCyclesResult {
  const byKey = new Map<string, FormulaGraphNode>();
  for (const node of nodes) byKey.set(node.fieldKey, node);

  // Adjacency: fieldKey → the OTHER formula fieldKeys it references.
  const edges = new Map<string, string[]>();
  for (const node of nodes) {
    const refs = collectFieldRefs(node.ast).filter((r) => byKey.has(r));
    edges.set(node.fieldKey, refs);
  }

  const WHITE = 0; // unvisited
  const GRAY = 1; // on the current DFS stack (in-progress)
  const BLACK = 2; // fully processed
  const color = new Map<string, number>();
  for (const node of nodes) color.set(node.fieldKey, WHITE);

  const order: string[] = [];
  const stack: string[] = []; // current DFS path, for cycle reporting

  function visit(key: string): string[] | null {
    color.set(key, GRAY);
    stack.push(key);

    for (const dep of edges.get(key) ?? []) {
      const depColor = color.get(dep);
      if (depColor === GRAY) {
        // Found a back-edge → cycle. Report the path from `dep`'s first
        // occurrence on the stack through to `key` (inclusive) — this is the
        // actual cycle, not the whole traversal history.
        const idx = stack.indexOf(dep);
        return stack.slice(idx);
      }
      if (depColor === WHITE) {
        const cyclePath = visit(dep);
        if (cyclePath) return cyclePath;
      }
      // BLACK dep: already fully resolved — safe, no edge to re-walk.
    }

    stack.pop();
    color.set(key, BLACK);
    order.push(key);
    return null;
  }

  for (const node of nodes) {
    if (color.get(node.fieldKey) === WHITE) {
      const cyclePath = visit(node.fieldKey);
      if (cyclePath) return { ok: false, cycle: cyclePath };
    }
  }

  return { ok: true, order };
}
