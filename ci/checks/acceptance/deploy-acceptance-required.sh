#!/usr/bin/env bash
# T-0274 · FF-T0274-2 / FF-T0274-5 — deploy-acceptance barrier: gated-vs-exempt
# predicate + non-loosening guard (ADR docs/design/T-0274-deploy-acceptance-dod.adr.md).
#
# The founder ratified a HARD deploy-acceptance barrier: a UI/user-facing change is
# not "done" until its browser-journey is green on a deployed-equivalent (no-mock)
# stack. This script is the choros-side, deterministic half of that barrier (ADR
# "Split A"). It does TWO things, both computed mechanically (no LLM judgment):
#
#  (1) THE SCOPE PREDICATE (FF-T0274-5) — `--predicate`:
#      GATED  ⇔ this branch's diff (merge-base vs dev) touches `web/**`
#               OR adds/modifies an `e2e/journeys/*.journey.ts`.
#      EXEMPT ⇔ pure-backend: no `web/**` diff AND no journey added/modified.
#      A GATED change MUST have its deploy-acceptance journey green; an EXEMPT
#      (pure-backend) change is NEVER blocked by journey absence — it has no
#      user-facing surface to click. This mirrors the UX_REVIEW conditional-phase
#      predicate ("трогает web/ ⇒ фаза; иначе пропускается, бэкенд не тормозит")
#      verbatim, so the loop keeps one mental model and never blocks legitimately
#      journey-less backend tasks forever (ADR §3, ADR rejected-alt "Gate ALL tasks").
#
#  (2) THE NON-LOOSENING GUARD (FF-T0274-2) — default arm (no flag):
#      A static assertion over .github/workflows/ci.yml that the `deploy-acceptance`
#      job is not silently HALF-flipped or re-loosened by a future diff. The barrier
#      has two consistent end-states:
#        • ADVISORY (today): `continue-on-error: true` present AND the job is NOT in
#          `deploy-dev.needs`. The gate runs every push but cannot red-line dev. This
#          is the safe state until the journeys are PROVEN green in the GitHub runner
#          (D-056: only flip a gate to required when it is already green).
#        • REQUIRED (post-founder-GO): `continue-on-error: true` REMOVED AND the job
#          IS a member of `deploy-dev.needs`. A red journey then blocks the dev deploy.
#      The guard FORBIDS the inconsistent middle (e.g. continue-on-error removed but
#      not in needs, or in needs but still continue-on-error) — that middle is either
#      a no-teeth illusion or a red-line-dev footgun. Which end-state is expected is
#      pinned by BARRIER_MODE below: flipping it to "required" is the founder's leash
#      call (строгость гейта, D-061), NOT an autonomous loosening. Once "required",
#      this guard becomes the anti-loosening lock — a later diff that re-adds
#      continue-on-error or drops the job from needs fails the guard (the barrier
#      cannot be quietly re-loosened, ADR §2 / §5).
#
# --self-test: synthetic fixtures for BOTH halves — a gated case (web/ diff ⇒
# required), an exempt case (backend-only diff ⇒ not required), an advisory-mode
# workflow (consistent), a required-mode workflow (consistent), and the two
# inconsistent half-flip workflows (must be rejected). Exit 0 clean / non-zero on
# any broken predicate.
#
# EXIT CODES: 0 clean · 1 guard/predicate violation · 2 self-test broken.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CI="${ROOT}/.github/workflows/ci.yml"

# BARRIER_MODE pins the EXPECTED end-state of the deploy-acceptance job.
#   "advisory"  — the gate is informational (continue-on-error present, NOT in
#                 deploy-dev.needs). This is the state T-0274 (Split A) lands in:
#                 the journeys are not yet PROVEN green in the GitHub runner, so
#                 flipping required could red-line dev (D-056 chicken-and-egg).
#   "required"  — the FOUNDER has flipped the barrier under GO (строгость гейта,
#                 D-061): continue-on-error removed AND in deploy-dev.needs. From
#                 then on this guard is the anti-loosening lock.
#
# FLIP CONDITION (do NOT flip blind — ADR §2 / §4 / task constraint): set this to
# "required" ONLY together with the ci.yml change (remove `continue-on-error: true`
# from the `deploy-acceptance` job + add `deploy-acceptance` to `deploy-dev.needs`),
# and ONLY once `npm run acceptance` (all *.journey.ts) is verified GREEN in the
# GitHub Actions runner against the ephemeral compose stack — i.e. the job has gone
# green at least once while still advisory. That green run is the proof D-056
# demands. The flip is founder-applied (leash), recorded by the Demiurge-side
# self-improve iteration (ADR "Split B", out of scope for this choros task).
BARRIER_MODE="${BARRIER_MODE_OVERRIDE:-advisory}"

# ===========================================================================
# Predicate primitives (operate on a newline-delimited list of changed paths on
# stdin, so they are reusable by both MAIN and SELF-TEST without git).
# ===========================================================================

# touches_web — true (prints "web") iff any changed path is under web/.
touches_web() {
  grep -qE '^web/' && return 0 || return 1
}

# declares_journey — true (prints "journey") iff any changed path is an
# e2e/journeys/*.journey.ts file (the task adds/owns a journey).
declares_journey() {
  grep -qE '^e2e/journeys/[^/]+\.journey\.ts$' && return 0 || return 1
}

# classify_paths — read changed paths on stdin, echo "GATED" or "EXEMPT".
# GATED ⇔ touches web/ OR declares a journey; else EXEMPT.
classify_paths() {
  local paths
  paths="$(cat)"
  if printf '%s\n' "${paths}" | touches_web \
     || printf '%s\n' "${paths}" | declares_journey; then
    echo "GATED"
  else
    echo "EXEMPT"
  fi
}

# ===========================================================================
# Workflow-state primitives (the non-loosening guard). All grep-based, no YAML
# parser dependency (pyyaml is not present on the runner/local — same constraint
# the sibling ci/checks/*.sh observe). Operate on a workflow file path argument.
# ===========================================================================

# deploy_acceptance_block <ci_file> — print the line-range body of the
# `deploy-acceptance:` job (from its header to the next top-level job header).
# Used so `continue-on-error` is read from THIS job, not e.g. the ci-job comment.
deploy_acceptance_block() {
  local f="$1"
  awk '
    /^  deploy-acceptance:/ { inblk=1; print; next }
    inblk && /^  [a-zA-Z0-9_-]+:/ { inblk=0 }
    inblk { print }
  ' "${f}"
}

# job_is_advisory <ci_file> — true iff the deploy-acceptance job body carries
# `continue-on-error: true`.
job_is_advisory() {
  deploy_acceptance_block "$1" | grep -qE '^\s*continue-on-error:\s*true\b'
}

# job_in_deploy_needs <ci_file> — true iff `deploy-acceptance` appears in the
# deploy-dev job's `needs:` list. The needs list is a single bracketed line:
#   needs: [ci, db, kc, stack, flowable, deploy-acceptance]
job_in_deploy_needs() {
  local f="$1"
  awk '
    /^  deploy-dev:/ { inblk=1 }
    inblk && /^  [a-zA-Z0-9_-]+:/ && !/^  deploy-dev:/ { inblk=0 }
    inblk && /needs:/ { print }
  ' "${f}" | grep -qE '\bdeploy-acceptance\b'
}

# guard_workflow <ci_file> — assert the deploy-acceptance job matches the
# EXPECTED end-state (advisory|required) consistently. Echoes PASS/FAIL lines,
# returns 0 clean / 1 on violation. Mode is the 2nd arg (defaults to BARRIER_MODE).
guard_workflow() {
  local f="$1"
  local mode="${2:-${BARRIER_MODE}}"
  local errors=0

  if [[ ! -f "${f}" ]]; then
    echo "FAIL [FF-T0274-2]: workflow file not found: ${f}"
    return 1
  fi

  # The job must exist at all (advisory or required — the barrier wiring is present).
  if ! grep -qE '^  deploy-acceptance:' "${f}"; then
    echo "FAIL [FF-T0274-2]: no deploy-acceptance job in ${f} — the barrier wiring is missing"
    return 1
  fi

  local advisory needs
  advisory=0; job_is_advisory "${f}" && advisory=1
  needs=0;    job_in_deploy_needs "${f}" && needs=1

  if [[ "${mode}" == "required" ]]; then
    # REQUIRED end-state: NO continue-on-error AND in deploy-dev.needs.
    if [[ "${advisory}" -eq 1 ]]; then
      echo "FAIL [FF-T0274-2]: barrier mode=required but deploy-acceptance still carries 'continue-on-error: true' (re-loosened) — a red journey would not block the deploy"
      errors=$((errors + 1))
    fi
    if [[ "${needs}" -eq 0 ]]; then
      echo "FAIL [FF-T0274-2]: barrier mode=required but deploy-acceptance is NOT in deploy-dev.needs — a red journey would not block the dev deploy"
      errors=$((errors + 1))
    fi
    if [[ "${errors}" -eq 0 ]]; then
      echo "PASS [FF-T0274-2]: barrier REQUIRED — deploy-acceptance has no continue-on-error AND is in deploy-dev.needs (hard barrier intact)"
    fi
  else
    # ADVISORY end-state: continue-on-error present AND NOT in deploy-dev.needs.
    # Forbid the inconsistent HALF-flip (one teeth without the other).
    if [[ "${advisory}" -eq 0 && "${needs}" -eq 0 ]]; then
      echo "FAIL [FF-T0274-2]: deploy-acceptance has NO continue-on-error yet is NOT in deploy-dev.needs — inconsistent half-flip (no teeth: a red journey neither fails its own job NOR blocks the deploy). Flip BARRIER_MODE=required together with adding it to deploy-dev.needs, or restore continue-on-error: true."
      errors=$((errors + 1))
    elif [[ "${advisory}" -eq 1 && "${needs}" -eq 1 ]]; then
      echo "FAIL [FF-T0274-2]: deploy-acceptance is in deploy-dev.needs but STILL carries continue-on-error: true — inconsistent half-flip (continue-on-error makes the job succeed even when red, so being in needs gives no barrier). Remove continue-on-error and set BARRIER_MODE=required, or drop it from deploy-dev.needs."
      errors=$((errors + 1))
    else
      echo "PASS [FF-T0274-2]: barrier ADVISORY (consistent) — continue-on-error: true present AND not in deploy-dev.needs; the gate runs every push but cannot red-line dev (D-056). Flip to required under founder GO once green in the runner."
    fi
  fi

  return $(( errors > 0 ? 1 : 0 ))
}

# ===========================================================================
# --predicate [--explain] : compute GATED/EXEMPT for the CURRENT branch from the
# merge-base diff against dev (the same base the reviewer pre-check uses). Prints
# GATED or EXEMPT to stdout. Graceful when no dev/merge-base is reachable
# (detached/shallow) → EXEMPT (nothing new to gate). Exit 0.
# ===========================================================================
if [[ "${1:-}" == "--predicate" ]]; then
  BASE=""
  for cand in "dev" "origin/dev"; do
    if git -C "${ROOT}" rev-parse --verify -q "${cand}^{commit}" >/dev/null 2>&1; then
      BASE="$(git -C "${ROOT}" merge-base "${cand}" HEAD 2>/dev/null || true)"
      [[ -n "${BASE}" ]] && break
    fi
  done

  if [[ -z "${BASE}" ]]; then
    [[ "${2:-}" == "--explain" ]] && echo "[T-0274 predicate] no dev/merge-base reachable — nothing new to gate" >&2
    echo "EXEMPT"
    exit 0
  fi

  CHANGED="$(git -C "${ROOT}" diff --name-only "${BASE}...HEAD" 2>/dev/null || true)"
  VERDICT="$(printf '%s\n' "${CHANGED}" | classify_paths)"
  if [[ "${2:-}" == "--explain" ]]; then
    {
      echo "[T-0274 predicate] base=${BASE}"
      echo "[T-0274 predicate] verdict=${VERDICT}"
      printf '%s\n' "${CHANGED}" | touches_web >/dev/null 2>&1 \
        && echo "[T-0274 predicate]   reason: diff touches web/ (GATED)"
      printf '%s\n' "${CHANGED}" | declares_journey >/dev/null 2>&1 \
        && echo "[T-0274 predicate]   reason: diff adds/modifies an e2e/journeys/*.journey.ts (GATED)"
      [[ "${VERDICT}" == "EXEMPT" ]] \
        && echo "[T-0274 predicate]   reason: pure-backend — no web/ diff, no journey (EXEMPT, never blocked by journey absence)"
    } >&2
  fi
  echo "${VERDICT}"
  exit 0
fi

# ===========================================================================
# --self-test : synthetic fixtures for both halves.
# ===========================================================================
if [[ "${1:-}" == "--self-test" ]]; then
  echo "[T-0274] deploy-acceptance-required: --self-test"

  # ---- Predicate: GATED case (web/ diff ⇒ required) -----------------------
  v="$(printf 'web/src/screens/inbox.jsx\nsrc/server/foo.ts\n' | classify_paths)"
  if [[ "${v}" != "GATED" ]]; then
    echo "SELF-TEST FAIL: web/-touching change classified ${v}, expected GATED"; exit 2
  fi
  echo "  [OK] web/-touching change ⇒ GATED (journey required)"

  # ---- Predicate: GATED case via journey declaration ----------------------
  v="$(printf 'e2e/journeys/new-flow.journey.ts\nsrc/core/x.ts\n' | classify_paths)"
  if [[ "${v}" != "GATED" ]]; then
    echo "SELF-TEST FAIL: journey-declaring change classified ${v}, expected GATED"; exit 2
  fi
  echo "  [OK] adds e2e/journeys/*.journey.ts ⇒ GATED"

  # ---- Predicate: EXEMPT case (backend-only diff ⇒ not required) ----------
  v="$(printf 'src/server/route.ts\nmigrations/099-foo.sql\nci/checks/x.sh\n' | classify_paths)"
  if [[ "${v}" != "EXEMPT" ]]; then
    echo "SELF-TEST FAIL: pure-backend change classified ${v}, expected EXEMPT (must never be blocked by journey absence)"; exit 2
  fi
  echo "  [OK] pure-backend change ⇒ EXEMPT (never blocked by journey absence)"

  # ---- Predicate: a non-journey e2e file must NOT alone gate --------------
  # (e2e/journeys/runner.ts is harness, not a journey; if a change touches only
  #  it + backend, it is EXEMPT — only *.journey.ts or web/ gates.)
  v="$(printf 'e2e/journeys/runner.ts\nsrc/core/x.ts\n' | classify_paths)"
  if [[ "${v}" != "EXEMPT" ]]; then
    echo "SELF-TEST FAIL: e2e harness-only (runner.ts) change classified ${v}, expected EXEMPT"; exit 2
  fi
  echo "  [OK] e2e harness-only (runner.ts, not *.journey.ts) ⇒ EXEMPT"

  # ---- Guard: consistent ADVISORY workflow passes in advisory mode --------
  TMPADV="$(mktemp /tmp/dar-adv-XXXXXX.yml)"
  cat > "${TMPADV}" <<'YML'
jobs:
  deploy-acceptance:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: npm run acceptance
  deploy-dev:
    needs: [ci, db, kc, stack, flowable]
    steps:
      - run: echo deploy
YML
  if ! guard_workflow "${TMPADV}" "advisory" >/dev/null; then
    rm -f "${TMPADV}"; echo "SELF-TEST FAIL: consistent ADVISORY workflow rejected in advisory mode"; exit 2
  fi
  echo "  [OK] consistent ADVISORY workflow accepted (advisory mode)"

  # ---- Guard: consistent REQUIRED workflow passes in required mode --------
  TMPREQ="$(mktemp /tmp/dar-req-XXXXXX.yml)"
  cat > "${TMPREQ}" <<'YML'
jobs:
  deploy-acceptance:
    runs-on: ubuntu-latest
    steps:
      - run: npm run acceptance
  deploy-dev:
    needs: [ci, db, kc, stack, flowable, deploy-acceptance]
    steps:
      - run: echo deploy
YML
  if ! guard_workflow "${TMPREQ}" "required" >/dev/null; then
    rm -f "${TMPADV}" "${TMPREQ}"; echo "SELF-TEST FAIL: consistent REQUIRED workflow rejected in required mode"; exit 2
  fi
  echo "  [OK] consistent REQUIRED workflow accepted (required mode)"

  # ---- Guard: half-flip A (no continue-on-error, NOT in needs) rejected ----
  TMPH1="$(mktemp /tmp/dar-h1-XXXXXX.yml)"
  cat > "${TMPH1}" <<'YML'
jobs:
  deploy-acceptance:
    runs-on: ubuntu-latest
    steps:
      - run: npm run acceptance
  deploy-dev:
    needs: [ci, db, kc, stack, flowable]
    steps:
      - run: echo deploy
YML
  if guard_workflow "${TMPH1}" "advisory" >/dev/null; then
    rm -f "${TMPADV}" "${TMPREQ}" "${TMPH1}"; echo "SELF-TEST FAIL: half-flip (no continue-on-error, not in needs = no teeth) accepted"; exit 2
  fi
  echo "  [OK] half-flip 'no continue-on-error but not in needs' (no teeth) rejected"

  # ---- Guard: half-flip B (continue-on-error AND in needs) rejected --------
  TMPH2="$(mktemp /tmp/dar-h2-XXXXXX.yml)"
  cat > "${TMPH2}" <<'YML'
jobs:
  deploy-acceptance:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: npm run acceptance
  deploy-dev:
    needs: [ci, db, kc, stack, flowable, deploy-acceptance]
    steps:
      - run: echo deploy
YML
  if guard_workflow "${TMPH2}" "advisory" >/dev/null; then
    rm -f "${TMPADV}" "${TMPREQ}" "${TMPH1}" "${TMPH2}"; echo "SELF-TEST FAIL: half-flip (continue-on-error AND in needs = illusion of teeth) accepted"; exit 2
  fi
  echo "  [OK] half-flip 'continue-on-error but in needs' (illusory teeth) rejected"

  # ---- Guard: required mode must REJECT a re-loosened (advisory) workflow --
  if guard_workflow "${TMPADV}" "required" >/dev/null; then
    rm -f "${TMPADV}" "${TMPREQ}" "${TMPH1}" "${TMPH2}"; echo "SELF-TEST FAIL: required mode accepted a re-loosened (continue-on-error) workflow — anti-loosening lock broken"; exit 2
  fi
  echo "  [OK] required mode rejects a re-loosened workflow (anti-loosening lock holds)"

  rm -f "${TMPADV}" "${TMPREQ}" "${TMPH1}" "${TMPH2}"
  echo "[T-0274] deploy-acceptance-required: --self-test PASS"
  exit 0
fi

# ===========================================================================
# MAIN — the non-loosening guard over the REAL ci.yml, in the pinned BARRIER_MODE.
# ===========================================================================
echo "[T-0274] deploy-acceptance-required: guarding ci.yml barrier (expected mode=${BARRIER_MODE})"

if guard_workflow "${CI}" "${BARRIER_MODE}"; then
  echo "PASS: deploy-acceptance barrier is in a consistent '${BARRIER_MODE}' state"
  exit 0
fi
echo "FAIL: deploy-acceptance barrier guard found a violation (see above)"
exit 1
