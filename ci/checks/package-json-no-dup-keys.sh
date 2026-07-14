#!/usr/bin/env bash
# T-0187 · package-json-no-dup-keys — guard against duplicate keys in package.json
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$REPO_ROOT/package.json"

# ---------------------------------------------------------------------------
# Node.js helper — written to a temp file to avoid heredoc/quoting issues
# ---------------------------------------------------------------------------
write_checker() {
  local target_file="$1"
  local pkg_path="$2"
  cat > "$target_file" <<NODESCRIPT
import { readFileSync } from 'fs';

function findDups(jsonStr) {
  const dups = [];
  const stack = [];
  let depth = -1;
  let i = 0;
  while (i < jsonStr.length) {
    const ch = jsonStr[i];
    if (ch === '{') {
      depth++;
      stack[depth] = new Set();
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      i++;
      continue;
    }
    if (ch === '"' && depth >= 0) {
      // scan key string
      let j = i + 1;
      let key = '';
      while (j < jsonStr.length) {
        if (jsonStr[j] === '"' && jsonStr[j-1] !== '\\\\') break;
        key += jsonStr[j];
        j++;
      }
      j++; // skip closing quote
      while (j < jsonStr.length && /\\s/.test(jsonStr[j])) j++;
      if (j < jsonStr.length && jsonStr[j] === ':') {
        if (stack[depth].has(key)) {
          dups.push(key);
        }
        stack[depth].add(key);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return dups;
}

const raw = readFileSync('${pkg_path}', 'utf8');
const dups = findDups(raw);
if (dups.length > 0) {
  process.stderr.write('FAIL: duplicate keys in package.json: ' + dups.join(', ') + '\\n');
  process.exit(1);
}
process.stdout.write('PASS\\n');
NODESCRIPT
}

# ---------------------------------------------------------------------------
# SELF-TEST mode
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0187] package-json-no-dup-keys: running self-test"

  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_ST"' EXIT

  # Synthetic package.json with duplicate "fitness" key
  printf '{\n  "name": "test",\n  "scripts": {\n    "fitness": "echo one",\n    "fitness": "echo two"\n  }\n}\n' \
    > "$TMPDIR_ST/package.json"

  CHECKER="$TMPDIR_ST/check.mjs"
  write_checker "$CHECKER" "$TMPDIR_ST/package.json"

  # Should exit non-zero (detect duplicate)
  if node --input-type=module < "$CHECKER" 2>/dev/null; then
    echo "[T-0187] SELF-TEST FAIL: duplicate not detected" >&2
    exit 1
  else
    echo "[T-0187] SELF-TEST PASS: duplicate correctly detected"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# MAIN CHECK
# ---------------------------------------------------------------------------
echo "[T-0187] package-json-no-dup-keys: checking $(basename "$PKG")"

TMPDIR_MAIN="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_MAIN"' EXIT

CHECKER="$TMPDIR_MAIN/check.mjs"
write_checker "$CHECKER" "$PKG"

if node --input-type=module < "$CHECKER"; then
  echo "[T-0187] PASS: no duplicate keys in package.json"
  exit 0
else
  echo "[T-0187] FAIL: duplicate keys detected in package.json" >&2
  exit 1
fi
