#!/usr/bin/env bash
# T-0227
# FF-CA-10 · card-action-broad-scope — static fitness proving the
# transition→terminate privilege-escalation guard exists (ADR T-0125 §2.2.1/§7).
#
# The escalation: terminate/message map onto op=transition. If their target could
# be a `record` ref, a holder of (op=transition, scope=record) would satisfy the
# PDP for a terminate — "right to change a record's status == right to kill the
# process instance" — which ADR T-0125 §2.2.1 REJECTED. This check statically
# proves the two structural defenses are in place:
#
#  1. fireCardAction (src/core/card-action.ts) DENIES terminate/message unless the
#     target.kind AND the resolved handle's ref.kind are BOTH "process_instance"
#     (fail-closed target-kind guard, audited as denied with target_kind_mismatch).
#  2. refToScope (src/core/grant-resolver.ts) has a DISJOINT process_instance
#     branch (its own nodeLevel "process_instance"), so a record-scoped grant can
#     never CONTAIN a process_instance target in the resource hierarchy.
#  3. process_instance is a first-class ResourceType (grant-lattice.ts) and a
#     first-class ResourceRef kind (object-handle.ts).
#
# Distinguishes grep rc=1 (no match) from rc>=2 (error). Ignores comment lines so
# prose explaining a ban passes (lesson T-0143).
#
# Exit 0 on clean, non-zero on any violation. --self-test exercises the detector.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CARD_ACTION="${PROJECT_ROOT}/src/core/card-action.ts"
RESOLVER="${PROJECT_ROOT}/src/core/grant-resolver.ts"
LATTICE="${PROJECT_ROOT}/src/core/grant-lattice.ts"
OBJECT_HANDLE="${PROJECT_ROOT}/src/core/object-handle.ts"

# grep wrapper: returns matches, treats rc=1 (no match) as clean, rc>=2 as error.
grep_noncomment() {
  local pattern="$1" file="$2" out rc
  set +e
  out="$(grep -nE "${pattern}" "${file}" | grep -vE ":[[:space:]]*(//|\*)")"
  rc=$?
  set -e
  if [[ ${rc} -ge 2 ]]; then
    echo "ERROR: grep failed (rc=${rc}) on pattern '${pattern}' in ${file}"
    exit 2
  fi
  printf '%s' "${out}"
}

run_checks() {
  local ca="$1" resolver="$2" lattice="$3" handle="$4"
  local errors=0 before

  for f in "${ca}" "${resolver}" "${lattice}" "${handle}"; do
    if [[ ! -f "${f}" ]]; then
      echo "FAIL: required file ${f} does not exist"
      return 1
    fi
  done

  # ---- (1) fireCardAction has the target-kind guard for terminate/message -----
  before=${errors}
  # The guard must (a) gate on terminate/message semantics, (b) require
  # target.kind === "process_instance", (c) require the handle ref.kind ===
  # "process_instance", and (d) deny with target_kind_mismatch.
  if ! grep_noncomment 'semantics === "terminate"' "${ca}" | grep -q 'terminate'; then
    echo "FAIL [FF-CA-10]: no terminate-semantics branch guarding the target kind in card-action.ts"
    errors=$((errors + 1))
  fi
  if ! grep_noncomment 'target\.kind !== "process_instance"' "${ca}" | grep -q 'process_instance'; then
    echo "FAIL [FF-CA-10]: card-action.ts does not reject a non-process_instance target.kind for terminate/message"
    errors=$((errors + 1))
  fi
  if ! grep_noncomment 'target\.handle\.ref\.kind !== "process_instance"' "${ca}" | grep -q 'process_instance'; then
    echo "FAIL [FF-CA-10]: card-action.ts does not reject a non-process_instance handle ref.kind for terminate/message"
    errors=$((errors + 1))
  fi
  if ! grep_noncomment 'target_kind_mismatch' "${ca}" | grep -q 'target_kind_mismatch'; then
    echo "FAIL [FF-CA-10]: card-action.ts does not deny with target_kind_mismatch"
    errors=$((errors + 1))
  fi
  if [[ ${errors} -eq ${before} ]]; then
    echo "PASS [FF-CA-10]: fireCardAction denies terminate/message unless target & handle are process_instance"
  fi

  # ---- (2) refToScope has a DISJOINT process_instance branch ------------------
  before=${errors}
  # The branch must exist AND map to its own nodeLevel "process_instance" (NOT
  # collapse into "record"), so a record scope can never contain it.
  ps_branch="$(grep_noncomment 'case "process_instance"' "${resolver}")"
  if [[ -z "${ps_branch}" ]]; then
    echo "FAIL [FF-CA-10]: grant-resolver.ts refToScope has no process_instance branch"
    errors=$((errors + 1))
  fi
  if ! grep_noncomment 'nodeLevel: "process_instance"' "${resolver}" | grep -q 'process_instance'; then
    echo "FAIL [FF-CA-10]: grant-resolver.ts process_instance scope does not use a disjoint nodeLevel \"process_instance\""
    errors=$((errors + 1))
  fi
  if [[ ${errors} -eq ${before} ]]; then
    echo "PASS [FF-CA-10]: refToScope has a disjoint process_instance branch (own nodeLevel)"
  fi

  # ---- (3) process_instance is first-class in the lattice + handle ------------
  before=${errors}
  if ! grep_noncomment '"process_instance"' "${lattice}" | grep -q 'process_instance'; then
    echo "FAIL [FF-CA-10]: grant-lattice.ts does not declare the process_instance ResourceType/NodeLevel"
    errors=$((errors + 1))
  fi
  if ! grep_noncomment 'kind: "process_instance"' "${handle}" | grep -q 'process_instance'; then
    echo "FAIL [FF-CA-10]: object-handle.ts ResourceRef union has no process_instance kind"
    errors=$((errors + 1))
  fi
  if [[ ${errors} -eq ${before} ]]; then
    echo "PASS [FF-CA-10]: process_instance is a first-class ResourceType + ResourceRef kind"
  fi

  return ${errors}
}

# ---- self-test: prove the detector fires on a planted regression -------------
self_test() {
  echo "[T-0227] card-action-broad-scope --self-test: planting regressions"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp}"' RETURN

  # A card-action.ts WITHOUT the target-kind guard (the escalation re-introduced).
  cat >"${tmp}/card-action.ts" <<'EOF'
export function fireCardAction() {
  // no target-kind guard here — terminate over any handle would pass
  return { ok: true };
}
EOF
  # A resolver WITHOUT a disjoint process_instance scope branch.
  cat >"${tmp}/grant-resolver.ts" <<'EOF'
export function refToScope(ref) {
  switch (ref.kind) {
    case "record":
      return { nodeLevel: "record" };
  }
}
EOF
  cat >"${tmp}/grant-lattice.ts" <<'EOF'
export type ResourceType = "record";
EOF
  cat >"${tmp}/object-handle.ts" <<'EOF'
export type ResourceRef = { kind: "record" };
EOF

  set +e
  run_checks "${tmp}/card-action.ts" "${tmp}/grant-resolver.ts" \
    "${tmp}/grant-lattice.ts" "${tmp}/object-handle.ts" >/dev/null 2>&1
  local rc=$?
  set -e
  if [[ ${rc} -eq 0 ]]; then
    echo "SELF-TEST FAIL: detector did NOT fire on a planted escalation regression"
    return 1
  fi
  echo "SELF-TEST PASS: detector fired on the planted regression (rc=${rc})"
  return 0
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit $?
fi

echo "[T-0227] card-action-broad-scope: FF-CA-10 transition→terminate escalation guard"
set +e
run_checks "${CARD_ACTION}" "${RESOLVER}" "${LATTICE}" "${OBJECT_HANDLE}"
errors=$?
set -e
if [[ ${errors} -gt 0 ]]; then
  echo "FAIL: card-action-broad-scope found ${errors} violation(s)"
  exit 1
fi
echo "PASS: card-action-broad-scope — FF-CA-10 escalation guard present"
exit 0
