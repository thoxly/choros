#!/usr/bin/env bash
# T-0155 · FF-CAT1..FF-CAT4 — Enemy security-invariants CATALOG append-only / no-weakening gate.
#
# Эпик E-VRG / T-0151 «Враг». spec: playbooks/enemy-redteam-backlog.md §7 (репо
# Demiurge) — «Governance: красные линии самого Врага». Демиург пишет И Choros, И
# Врага, значит в том же цикле может Врага *ослабить*. §7 требует:
#   «Каталог инвариантов + корпус — под frozen-checks-immutable (append-only,
#    изменения только founder-gated)».
#
# Корпус (src/__tests__/enemy/corpus/corpus.jsonl) уже защищён append-only гейтом
# T-0154 (ci/checks/enemy/corpus-append-only.sh). ЭТОТ чек закрывает вторую
# половину конституции Врага — КАТАЛОГ инвариантов
# (docs/design/T-0152-security-invariants-catalog.md). Каталог — `docs/` файл, и
# frozen-мета-гейт T-0146 сторожит только `ci/checks/*.sh`, НЕ `docs/`; поэтому
# каталог защищается здесь, выделенным T-0155-овским fitness-чеком.
#
# КОНСТИТУЦИЯ НЕ ОСЛАБЛЯЕТСЯ — против BASE_REF (merge-base с dev), тем же приёмом,
# что corpus-append-only.sh и frozen-checks-immutable.sh, поэтому чек корректен и
# на task-ветке, и пост-мерж на dev:
#
#   FF-CAT1 (семья не удалена) — каждая НАЗВАННАЯ семья инвариантов, присутствующая
#       в каталоге BASE_REF (заголовок `## N. NAME` / `### N.N NAME`, где NAME —
#       UPPERCASE-токен вида TENANT-ISO, PDP-DENY, DEV-AUTH-PROD, AUDIT-APPEND,
#       GRANT-ESCALATION, NO-SECRET, OBJECT-HANDLE-ISO, NO-KILLSWITCH-IN-CORE,
#       EGRESS-POLICY-ISO, FROZEN-CHECKS-IMMUTABLE, …), ОБЯЗАНА присутствовать в
#       HEAD. Удаление семьи ⇒ FAIL. Новые семьи добавлять можно.
#   FF-CAT2 (множество «Enforced by» не сужается) — для КАЖДОЙ выжившей семьи каждая
#       enforcement-ссылка на конкретный гейт `ci/checks/…(.sh|.sql|.test.ts)`,
#       перечисленная под этой семьёй в BASE_REF, ОБЯЗАНА всё ещё перечисляться под
#       той же семьёй в HEAD. Множество «Enforced by» может РАСТИ, но не сужаться —
#       молчаливое выпиливание гейта из каталога = разоружение = FAIL.
#   FF-CAT3 (fail-open вне task-ветки) — на dev/main/non-task ветке, при отсутствии
#       merge-base, либо если каталог отсутствовал в BASE_REF (вводится этой
#       задачей) — чек no-op (совпадает с frozen-checks-immutable / corpus).
#   FF-CAT4 (--self-test) — синтетически удаляем семью и синтетически выпиливаем
#       enforcement-ссылку; чек ОБЯЗАН покраснеть на обоих (и пропустить чистое
#       добавление семьи/ссылки).
#
# «Изменения только founder-gated»: этот гейт делает ОСЛАБЛЕНИЕ красным в CI.
# Легитимный путь ослабить/перекроить каталог — существующий founder-санкционный
# канал (ci/checks/data/frozen-sanctions.jsonl, T-0199, авторизация = founder_decide
# в control-plane). НИКАКОГО нового auth-канала и НИКАКОГО founder-trust-root здесь
# не вводится (§7 это прямо запрещает): для правки каталога фаундер санкционирует
# именно ЭТОТ чек ({task, "ci/checks/enemy/catalog-frozen.sh"}) тем же append-only
# каналом — и тогда T-0146 мета-гейт пропустит правку самого чека, а каталог
# меняется в том же diff под надзором фаундера.
#
# Сам этот чек — `ci/checks/*.sh`, поэтому T-0146 мета-гейт автоматически защищает
# ЕГО от ослабления любой другой задачей: гарантия «строитель не может молча
# разоружить Врага» держится БЕЗ правки frozen-файла T-0146.
#
# Exit 0 on clean / skip · 1 on an append-only/weakening violation · 2 self-test broken.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-"$(cd "${SCRIPT_DIR}/../../.." && pwd)"}"
CATALOG_REL="docs/design/T-0152-security-invariants-catalog.md"

# ---------------------------------------------------------------------------
# Parsers. Both read a catalog file on stdin or by path and emit a stable,
# diff-friendly normalized form. Kept pure (no git) so --self-test can drive
# them against synthetic fixtures.
# ---------------------------------------------------------------------------

# families <file> — emit the set of named invariant families, one per line, sorted
# unique. A family is a hyphenated UPPERCASE token in the NAME part of a numbered
# section heading — i.e. before the em-dash that introduces the prose description:
#   `## 1. TENANT-ISO — …`  → TENANT-ISO
#   `### 7.1 OBJECT-HANDLE-ISO — …` → OBJECT-HANDLE-ISO
#   `### 7.2 AUDIT-NO-GLOBAL-SEQ / SINGLE-RESOLVER — …` → AUDIT-NO-GLOBAL-SEQ + SINGLE-RESOLVER
# We cut at the first em-dash so a parenthetical like "(RED-LINE)" in the
# DESCRIPTION never gets pinned as a frozen family name. A family token is a run of
# [A-Z0-9] with ≥1 hyphen-joined segment, so a bare numeral never counts. The
# leading "N." / "N.N" ordinal is stripped first.
families() {
  grep -E '^#{2,3}[[:space:]]+[0-9]' "$1" 2>/dev/null \
    | sed -E 's/^#{2,3}[[:space:]]+[0-9]+(\.[0-9]+)*\.?[[:space:]]*//' \
    | sed -E 's/[[:space:]]*—.*$//' \
    | grep -oE '\b[A-Z][A-Z0-9]*(-[A-Z0-9]+)+\b' \
    | sort -u || true
}

# enforced_refs <file> — emit "FAMILY<TAB>ci/checks/<path>" pairs: for each named
# family section, every distinct ci/checks/… enforcement gate referenced (in
# backticks) anywhere inside that family's block until the next family heading.
# Only ci/checks/ references are tracked — those ARE the concrete guards; dropping
# one from the catalog is the exact "silently filed-down the guard" signal. Sorted
# unique. Pure awk (no git), so the self-test can drive it on fixtures.
enforced_refs() {
  awk '
    function flush() { fam = fam }  # no-op; family stays until next heading
    /^#{2,3}[[:space:]]+[0-9]/ {
      line = $0
      sub(/^#{2,3}[[:space:]]+[0-9]+(\.[0-9]+)*\.?[[:space:]]*/, "", line)
      sub(/[[:space:]]*—.*$/, "", line)   # keep only the NAME part (before em-dash)
      # capture every UPPERCASE family token in the name part (handles "A / B")
      nfam = 0
      while (match(line, /[A-Z][A-Z0-9]*(-[A-Z0-9]+)+/)) {
        nfam++
        fams[nfam] = substr(line, RSTART, RLENGTH)
        line = substr(line, RSTART + RLENGTH)
      }
      next
    }
    {
      # within the current family block, harvest `ci/checks/…(.sh|.sql|.test.ts)`
      s = $0
      while (match(s, /ci\/checks\/[A-Za-z0-9_.\/-]+\.(sh|sql|test\.ts)/)) {
        ref = substr(s, RSTART, RLENGTH)
        for (i = 1; i <= nfam; i++) print fams[i] "\t" ref
        s = substr(s, RSTART + RLENGTH)
      }
    }
  ' "$1" 2>/dev/null | sort -u || true
}

# ---------------------------------------------------------------------------
# Core: given BASE and HEAD catalog files, enforce FF-CAT1 + FF-CAT2.
# Returns 0 clean, 1 violation. Prints explicit PASS/FAIL lines (never silent).
# ---------------------------------------------------------------------------
verify_no_weakening() {
  local base="$1" head="$2" errs=0 tmp
  tmp="$(mktemp -d)"

  # FF-CAT1: no family removed.
  families "$base" > "${tmp}/base_fam"
  families "$head" > "${tmp}/head_fam"
  while IFS= read -r fam; do
    [[ -z "$fam" ]] && continue
    if ! grep -qxF -- "$fam" "${tmp}/head_fam"; then
      echo "FAIL [FF-CAT1]: invariant family '${fam}' present in BASE_REF catalog was REMOVED at HEAD (catalog is append-only / no-weakening)"
      errs=$((errs + 1))
    fi
  done < "${tmp}/base_fam"

  # FF-CAT2: per surviving family, the Enforced-by ci/checks set must not shrink.
  enforced_refs "$base" > "${tmp}/base_ref"
  enforced_refs "$head" > "${tmp}/head_ref"
  while IFS= read -r pair; do
    [[ -z "$pair" ]] && continue
    local fam="${pair%%$'\t'*}"
    # Skip enforcement-shrink check for a family that was wholly removed — already
    # reported by FF-CAT1; avoids double-counting the same deletion.
    grep -qxF -- "$fam" "${tmp}/head_fam" || continue
    if ! grep -qxF -- "$pair" "${tmp}/head_ref"; then
      local ref="${pair#*$'\t'}"
      echo "FAIL [FF-CAT2]: enforcement gate '${ref}' listed under family '${fam}' in BASE_REF was DROPPED from the catalog at HEAD (Enforced-by set may grow, not shrink — that is silent disarmament)"
      errs=$((errs + 1))
    fi
  done < "${tmp}/base_ref"

  rm -rf "$tmp"
  return $(( errs > 0 ? 1 : 0 ))
}

# ---------------------------------------------------------------------------
# --self-test (FF-CAT4): prove the gate bites on a removed family AND a dropped
# enforcement reference, and accepts a clean additive change.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0155] catalog-frozen --self-test: proving the gate bites on a weakened catalog"
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' EXIT

  cat > "${tmp}/base.md" <<'EOF'
# Catalog
## 1. TENANT-ISO — изоляция
**Enforced by.** `ci/checks/cross-tenant-fitness.sh`, `ci/checks/db/schema.test.ts`.
## 2. PDP-DENY — deny-by-default
**Enforced by.** `ci/checks/single-resolver.sh`.
### 7.5 FROZEN-CHECKS-IMMUTABLE — мета-инвариант
**Enforced by.** `ci/checks/frozen-checks-immutable.sh`.
EOF

  # Case 1: clean additive change (new family + new enforcement ref) — must PASS.
  cat > "${tmp}/head_ok.md" <<'EOF'
# Catalog
## 1. TENANT-ISO — изоляция
**Enforced by.** `ci/checks/cross-tenant-fitness.sh`, `ci/checks/db/schema.test.ts`, `ci/checks/db/two_tenant.test.ts`.
## 2. PDP-DENY — deny-by-default
**Enforced by.** `ci/checks/single-resolver.sh`.
### 7.5 FROZEN-CHECKS-IMMUTABLE — мета-инвариант
**Enforced by.** `ci/checks/frozen-checks-immutable.sh`.
### 8.1 NEW-FAMILY — добавленная семья
**Enforced by.** `ci/checks/some-new-gate.sh`.
EOF
  if verify_no_weakening "${tmp}/base.md" "${tmp}/head_ok.md" >/dev/null 2>&1; then
    echo "PASS: clean additive catalog change accepted (new family + grown Enforced-by)"
  else
    echo "SELF-TEST FAIL: a legitimate additive catalog change was rejected"; exit 2
  fi

  # Case 2: a whole invariant family REMOVED — must FAIL (FF-CAT1).
  cat > "${tmp}/head_delfam.md" <<'EOF'
# Catalog
## 1. TENANT-ISO — изоляция
**Enforced by.** `ci/checks/cross-tenant-fitness.sh`, `ci/checks/db/schema.test.ts`.
### 7.5 FROZEN-CHECKS-IMMUTABLE — мета-инвариант
**Enforced by.** `ci/checks/frozen-checks-immutable.sh`.
EOF
  if verify_no_weakening "${tmp}/base.md" "${tmp}/head_delfam.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: a REMOVED invariant family (PDP-DENY) was NOT caught"; exit 2
  else
    echo "PASS: removal of an invariant family is rejected (FF-CAT1 bites)"
  fi

  # Case 3: an enforcement gate DROPPED from a surviving family — must FAIL (FF-CAT2).
  cat > "${tmp}/head_dropref.md" <<'EOF'
# Catalog
## 1. TENANT-ISO — изоляция
**Enforced by.** `ci/checks/cross-tenant-fitness.sh`.
## 2. PDP-DENY — deny-by-default
**Enforced by.** `ci/checks/single-resolver.sh`.
### 7.5 FROZEN-CHECKS-IMMUTABLE — мета-инвариант
**Enforced by.** `ci/checks/frozen-checks-immutable.sh`.
EOF
  if verify_no_weakening "${tmp}/base.md" "${tmp}/head_dropref.md" >/dev/null 2>&1; then
    echo "SELF-TEST FAIL: a DROPPED enforcement gate (db/schema.test.ts under TENANT-ISO) was NOT caught"; exit 2
  else
    echo "PASS: dropping an Enforced-by gate from a surviving family is rejected (FF-CAT2 bites)"
  fi

  echo "PASS: catalog-frozen --self-test green (gate bites on removed family + dropped enforcement gate; accepts additive growth)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Live mode: compare BASE_REF:catalog vs working-tree catalog.
# ---------------------------------------------------------------------------
BRANCH="$(git -C "${PROJECT_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
TASK_ID="$(echo "${BRANCH}" | grep -oE '^task/(T-[0-9]+)' | sed 's|^task/||' || true)"
if [[ -z "${TASK_ID}" ]]; then
  echo "INFO [FF-CAT3]: not a task branch (branch='${BRANCH}'), skipping catalog-frozen"
  exit 0
fi

BASE_REF=""
for cand in "dev" "origin/dev"; do
  if git -C "${PROJECT_ROOT}" rev-parse --verify --quiet "${cand}^{commit}" >/dev/null 2>&1; then
    mb="$(git -C "${PROJECT_ROOT}" merge-base "${cand}" HEAD 2>/dev/null || true)"
    if [[ -n "${mb}" ]]; then BASE_REF="${mb}"; break; fi
  fi
done
if [[ -z "${BASE_REF}" ]]; then
  echo "WARN [FF-CAT3]: no dev/origin/dev reachable, skipping catalog-frozen (fail-open)"
  exit 0
fi

# If the catalog did not exist at BASE_REF (this task INTRODUCES it), nothing to
# protect yet — clean by construction.
if ! git -C "${PROJECT_ROOT}" cat-file -e "${BASE_REF}:${CATALOG_REL}" 2>/dev/null; then
  echo "INFO [FF-CAT3]: catalog absent at BASE_REF (introduced by ${TASK_ID}) — append-only trivially holds"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
git -C "${PROJECT_ROOT}" show "${BASE_REF}:${CATALOG_REL}" > "${tmp}/base.md"
# Working-tree catalog (what would be committed), so an uncommitted weakening is
# caught before the commit even lands.
cp "${PROJECT_ROOT}/${CATALOG_REL}" "${tmp}/head.md"

base_fam_n="$(families "${tmp}/base.md" | grep -c . || true)"
base_ref_n="$(enforced_refs "${tmp}/base.md" | grep -c . || true)"
echo "[T-0155] catalog-frozen: ${base_fam_n} invariant famil(ies) + ${base_ref_n} Enforced-by ci/checks gate(s) at BASE_REF must survive at HEAD"

if verify_no_weakening "${tmp}/base.md" "${tmp}/head.md"; then
  echo "PASS: catalog-frozen — every invariant family preserved & no Enforced-by gate dropped (append-only / no-weakening holds)"
  echo "INFO: corpus half of the Враг constitution is guarded by ci/checks/enemy/corpus-append-only.sh (T-0154); legitimate catalog weakening requires a founder frozen-sanction (ci/checks/data/frozen-sanctions.jsonl, T-0199) on THIS check."
  exit 0
fi
echo "FAIL: catalog-frozen — the security-invariants catalog was WEAKENED (a family or an enforcement gate was removed). To change it legitimately, obtain a founder frozen-sanction (founder_decide → ci/checks/data/frozen-sanctions.jsonl) for {task, ci/checks/enemy/catalog-frozen.sh}."
exit 1
