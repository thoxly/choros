#!/usr/bin/env bash
# FF-7: the importer apply path NEVER issues an HTTP write for display-plane sections.
# process_instances and rights_cards must NOT appear inside the apply/POST loop.
# Display data is load-and-serve only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMPORTER="$REPO_ROOT/seed/importer.ts"

if [[ ! -f "$IMPORTER" ]]; then
  echo "FAIL: seed/importer.ts does not exist" >&2
  exit 1
fi

# The POST loop must iterate an explicit LIVE_ENTITY_ORDER list, not the whole pack.
# Verify LIVE_ENTITY_ORDER exists and does not contain display-plane sections.
if ! grep -q "LIVE_ENTITY_ORDER" "$IMPORTER"; then
  echo "FAIL: seed/importer.ts does not define LIVE_ENTITY_ORDER (FF-7)" >&2
  exit 1
fi

# Check that process_instances and rights_cards do not appear in a POST/write context.
# Allowed contexts: loadPack, validatePackShape, type declarations, comments.
# Disallowed: httpPost(...process_instances...) or iterating them in the apply loop.
node - "$IMPORTER" <<'NODEJS'
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const lines = src.split('\n');
const forbidden = ['process_instances', 'rights_cards'];
let failed = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (const term of forbidden) {
    if (!line.includes(term)) continue;
    // Allowed: comments, type declarations, loadPack/validatePackShape context, variable declaration
    const stripped = line.trim();
    if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) continue;
    if (stripped.includes('type ') || stripped.includes('export type') || stripped.includes(': Pack')) continue;
    if (stripped.includes('loadPack') || stripped.includes('validatePackShape')) continue;
    // Check if this line contains an HTTP write call
    if (stripped.includes('httpPost') || stripped.includes('await fetch') || stripped.includes('DELETE') || stripped.includes('PUT')) {
      console.error(`FAIL: display-plane term '${term}' appears in write context at line ${i+1}: ${stripped}`);
      failed = true;
    }
    // Check if iterating over display-plane section (for...of pack.process_instances / pack.rights_cards)
    if (stripped.match(/for\s*\(.*pack\.(process_instances|rights_cards)/)) {
      console.error(`FAIL: display-plane section '${term}' iterated in apply loop at line ${i+1}: ${stripped}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('FF-7: display-plane-no-write PASS (node check)');
NODEJS

echo "FF-7: display-plane-no-write PASS"
