# T-0236 — Dev-red fix: extend FF-25-3 allow-set for T-0233 runtime custody

## Problem statement

`dev` is RED. `npm run fitness` short-circuits because
`ci/checks/secret-handle-isolation.sh` check **FF-25-3**
("`llm_secret_handle` must appear only in the explicit custody allow-set")
flags three files introduced by T-0233 (the first live agent — the
legal-precheck motor) that were never added to its `ALLOWED_FILES` array:

| File | Why it references `llm_secret_handle` |
|------|----------------------------------------|
| `src/runtime/legal-precheck/run-precheck.ts` | reads the `llm_secret_handle` **column reference** (type field / null-check / `SELECT`) to decide dormancy (all three `llm_*` NULL ⇒ dormant) and to custody the handle hand-off into the injected `LlmPort` |
| `src/adapters/openai-llm-port.ts` | mentions the handle only in a **header comment** (custody is via the opaque `SecretResolverPort`, never a raw column/log/audit/response) |
| `src/runtime/legal-precheck/__tests__/run-precheck.test.ts` | fixtures using `vault://...` handle **references** (not secret values) |

These are legitimate custody sites for T-0233's runtime: the live agent must
read the handle reference to know dormancy and custody it to the adapter. The
FF-25-3 `ALLOWED_FILES` array was written for the T-0025/T-0042 hire-path and
never extended for the T-0233 runtime.

## The escape (FF-25-3)

`ALLOWED_FILES` (FF-25-3, ~line 64 of `secret-handle-isolation.sh`) is extended
**additively** with exactly two entries:

- `src/runtime/legal-precheck/run-precheck.ts`
- `src/adapters/openai-llm-port.ts`

The test sibling `run-precheck.test.ts` is auto-allowed by the existing
`*.test.ts` stem rule (no special-casing).

## Meta-gate finding (correction to the diagnosis)

`secret-handle-isolation.sh` IS guarded — not by a static frozen list, but by
the `frozen-checks-immutable.sh` **meta-gate** (FF-FCI1), keyed on the file's
ownership header (line 2 = `# T-0025 · ...`). Any task branch other than
`task/T-0025` modifying it trips FF-FCI1 unless a `{task,file}` sanction record
exists in `ci/checks/data/frozen-sanctions.jsonl` (FF-FCI12 channel).

This change is the **D-060 additive / mechanism class** (same as T-0233's own
already-ratified unpark of `agent-instruction-runtime-dormant.sh`): additive
allow-set extension, no new authority, frozen files untouched
(`touches_frozen=false`), verifiable by the check's own self-test. A mechanism
sanction line is therefore appended for `{T-0236, secret-handle-isolation.sh}`.

## Machine-checkable acceptance criteria

- **AC-1**: `bash ci/checks/secret-handle-isolation.sh` exits 0 and prints
  `PASS (FF-25-3)`.
- **AC-2**: `bash ci/checks/frozen-checks-immutable.sh` on `task/T-0236` prints
  the `SANCTION`/`AUDIT` lines for `secret-handle-isolation.sh` and exits 0.
- **AC-3**: full `npm run fitness` is GREEN to completion (exit 0) on the dev
  base + the 2 files allow-listed + the one sanction line — no other red check
  hides behind FF-25-3.
- **AC-4**: exactly two entries are added to `ALLOWED_FILES`; no other file is
  added to the allow-set; FF-25-1/2/4/5/6/8 are unchanged.
- **AC-5**: `git diff` touches only `ci/checks/secret-handle-isolation.sh`,
  `ci/checks/data/frozen-sanctions.jsonl`, and `docs/` artifacts. No source
  file (including the 3 flagged files) is modified. `touches_frozen=false`.
