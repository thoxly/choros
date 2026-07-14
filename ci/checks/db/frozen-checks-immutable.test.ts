// T-0146 · FF-FCI9 / FF-FCI10 — hostile-probe harness for frozen-checks-immutable.sh
//
// This test creates isolated temporary git repositories, sets up branch/diff
// states that reproduce the historical agent anti-patterns (T-0035, T-0118),
// then calls ci/checks/frozen-checks-immutable.sh directly and asserts exit code.
//
// No live Postgres required — this is a pure git/shell test.
//
// FF-FCI9  — Hostile-probe red: exclusion-edit in a foreign ci/checks/*.sh
//            on a task branch with a different TASK_ID → script exits 1.
// FF-FCI10 — Hostile-probe green: editing own ci/checks/*.sh (header matches
//            current TASK_ID) → script exits 0.
//
// Run via: npm run fitness:db (vitest run --dir ci/checks/db)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Path to the script under test (relative to this file: ../../frozen-checks-immutable.sh)
const SCRIPT_PATH = resolve(HERE, '..', 'frozen-checks-immutable.sh');

/** Run a shell command in a given cwd, throw on non-zero exit */
function sh(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${cmd} ${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Run the frozen-checks-immutable.sh script against the given repo dir.
 *  PROJECT_ROOT env override allows running against an isolated git repo
 *  without moving the script itself (hostile-probe isolation).
 *  Returns { exitCode, stdout }. Does NOT throw on non-zero exit. */
function runCheck(repoDir: string): { exitCode: number; stdout: string } {
  const result = spawnSync('bash', [SCRIPT_PATH], {
    cwd: repoDir,
    encoding: 'utf8',
    env: { ...process.env, HOME: process.env.HOME ?? '/tmp', PROJECT_ROOT: repoDir },
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout + result.stderr };
}

/** Create a minimal git repo with an initial commit on "dev" branch.
 *  Adds one ci/checks/*.sh stub per entry in checksToSeed. */
function createBaseRepo(
  tmpRoot: string,
  checksToSeed: Array<{ file: string; header: string }>,
): string {
  const repoDir = mkdtempSync(join(tmpRoot, 'fci-repo-'));
  sh('git', ['init', '-b', 'dev'], repoDir);
  sh('git', ['config', 'user.email', 'test@example.com'], repoDir);
  sh('git', ['config', 'user.name', 'Test'], repoDir);

  // Create ci/checks/ directory
  mkdirSync(join(repoDir, 'ci', 'checks'), { recursive: true });

  for (const { file, header } of checksToSeed) {
    const filePath = join(repoDir, 'ci', 'checks', file);
    writeFileSync(filePath, `#!/usr/bin/env bash\n${header}\nset -euo pipefail\necho "stub"\n`);
  }

  sh('git', ['add', '.'], repoDir);
  sh('git', ['commit', '-m', 'baseline on dev'], repoDir);

  return repoDir;
}

// ---- Test state --------------------------------------------------------------
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fci-tests-'));
});

afterAll(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// =============================================================================
// AC-1 / AC-2 / FF-FCI9: Modifying a foreign ci/checks/*.sh on a task branch
// should cause the script to exit 1 (hostile probe — reproduces T-0035/T-0118)
// =============================================================================

describe('FF-FCI9: hostile probe — modifying foreign check → exit 1', () => {
  it('AC-1/AC-2: modifying dual-control-isolation.sh (T-0044) on task/T-0999-test branch exits 1', () => {
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'dual-control-isolation.sh', header: '# T-0044 · FF-DC1..FF-DC8 + FF-DC11 — dual-control-isolation.' },
      { file: 'role-criticality-isolation.sh', header: '# T-0040 · FF-RC1 / FF-RC2 — role-criticality-isolation' },
    ]);

    // Create task branch with TASK_ID=T-0999
    sh('git', ['checkout', '-b', 'task/T-0999-test'], repoDir);

    // Modify a foreign check (reproducing T-0035/T-0118 anti-pattern)
    const targetFile = join(repoDir, 'ci', 'checks', 'dual-control-isolation.sh');
    writeFileSync(
      targetFile,
      `#!/usr/bin/env bash\n# T-0044 · FF-DC1..FF-DC8 + FF-DC11 — dual-control-isolation.\n` +
      `FROZEN_EXCLUDE_RE='some-exclusion-pattern'\nset -euo pipefail\necho "stub"\n`,
    );
    sh('git', ['add', 'ci/checks/dual-control-isolation.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0999: add exclusion to dual-control (anti-pattern)'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);

    expect(exitCode, `Expected exit 1, got ${exitCode}. Output:\n${stdout}`).toBe(1);
    expect(stdout).toMatch(/FAIL/);
    expect(stdout).toMatch(/dual-control-isolation\.sh/);
    expect(stdout).toMatch(/T-0044/);
  });

  it('AC-11: modifying a legacy check with no T-ID header on any task branch → exit 1', () => {
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'actor_event_append_only.sh', header: '# FF-4 (static half, AC-7 / T-0019 §3.1): actor_event append-only.' },
    ]);

    sh('git', ['checkout', '-b', 'task/T-0888-test'], repoDir);

    // Modify a legacy check (no T-ID in header)
    const targetFile = join(repoDir, 'ci', 'checks', 'actor_event_append_only.sh');
    writeFileSync(
      targetFile,
      `#!/usr/bin/env bash\n# FF-4 (static half, AC-7 / T-0019 §3.1): actor_event append-only.\n# extra line added\necho "stub"\n`,
    );
    sh('git', ['add', 'ci/checks/actor_event_append_only.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0888: modify legacy check (anti-pattern)'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);

    expect(exitCode, `Expected exit 1, got ${exitCode}. Output:\n${stdout}`).toBe(1);
    expect(stdout).toMatch(/FAIL/);
    expect(stdout).toMatch(/actor_event_append_only\.sh/);
    expect(stdout).toMatch(/<no-T-ID>/);
  });

  it('AC-6: deleting a foreign check on a task branch → exit 1', () => {
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'role-criticality-isolation.sh', header: '# T-0040 · FF-RC1 / FF-RC2 — role-criticality-isolation' },
    ]);

    sh('git', ['checkout', '-b', 'task/T-0777-test'], repoDir);

    // Delete the foreign check
    const targetFile = join(repoDir, 'ci', 'checks', 'role-criticality-isolation.sh');
    sh('git', ['rm', 'ci/checks/role-criticality-isolation.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0777: delete foreign check (anti-pattern)'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);

    expect(exitCode, `Expected exit 1, got ${exitCode}. Output:\n${stdout}`).toBe(1);
    expect(stdout).toMatch(/FAIL/);
    expect(stdout).toMatch(/role-criticality-isolation\.sh/);
  });
});

// =============================================================================
// AC-3 / FF-FCI10: Modifying own check (header matches TASK_ID) → exit 0
// =============================================================================

describe('FF-FCI10: own check modification → exit 0', () => {
  it('AC-3: modifying frozen-checks-immutable.sh (T-0146) on task/T-0146-test branch exits 0', () => {
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'frozen-checks-immutable.sh', header: '# T-0146 · FF-FCI1..FF-FCI11 — frozen-checks-immutable meta-gate' },
      { file: 'some-other-check.sh', header: '# T-0200 · FF-OTHER1 — some other check' },
    ]);

    sh('git', ['checkout', '-b', 'task/T-0146-frozen-checks-immutable'], repoDir);

    // Modify own check (T-0146)
    const targetFile = join(repoDir, 'ci', 'checks', 'frozen-checks-immutable.sh');
    writeFileSync(
      targetFile,
      `#!/usr/bin/env bash\n# T-0146 · FF-FCI1..FF-FCI11 — frozen-checks-immutable meta-gate\n# updated content\nset -euo pipefail\necho "updated"\n`,
    );
    sh('git', ['add', 'ci/checks/frozen-checks-immutable.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0146: update own check'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);

    expect(exitCode, `Expected exit 0, got ${exitCode}. Output:\n${stdout}`).toBe(0);
    expect(stdout).toMatch(/PASS/);
  });
});

// =============================================================================
// AC-4 / FF-FCI3: On dev branch (no TASK_ID) → exit 0
// =============================================================================

describe('FF-FCI3: dev branch → exit 0', () => {
  it('AC-4: on dev branch with no task context, exits 0', () => {
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'some-check.sh', header: '# T-0100 · some check' },
    ]);

    // Stay on dev (no checkout needed — already on dev)
    const { exitCode, stdout } = runCheck(repoDir);

    expect(exitCode, `Expected exit 0, got ${exitCode}. Output:\n${stdout}`).toBe(0);
    // On a non-task branch, the script exits 0 with an INFO or WARN message
    expect(stdout).toMatch(/not a task branch|skipping|fail-open/i);
  });
});

// =============================================================================
// AC-5 / FF-FCI4: Adding a new ci/checks/*.sh (diff-filter=A) → exit 0
// =============================================================================

describe('FF-FCI4: adding new check → exit 0', () => {
  it('AC-5: adding a new ci/checks/new-gate.sh on a task branch exits 0', () => {
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'existing-check.sh', header: '# T-0050 · FF-E1 — some existing check' },
    ]);

    sh('git', ['checkout', '-b', 'task/T-0555-new-gate'], repoDir);

    // Add a NEW file (not modifying any existing one)
    const newFile = join(repoDir, 'ci', 'checks', 'new-gate.sh');
    writeFileSync(
      newFile,
      `#!/usr/bin/env bash\n# T-0555 · FF-NG1 — new gate check\nset -euo pipefail\necho "new gate"\n`,
    );
    sh('git', ['add', 'ci/checks/new-gate.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0555: add new gate check'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);

    expect(exitCode, `Expected exit 0, got ${exitCode}. Output:\n${stdout}`).toBe(0);
    expect(stdout).toMatch(/PASS/);
  });
});

// =============================================================================
// R-1 BLOCKING FIX: ownership-capture via header rewrite — must now be caught
// =============================================================================

describe('R-1 fix: ownership-capture via header rewrite → exit 1', () => {
  it('PROBE-2: DELETE foreign check + re-ADD with own T-ID header → exit 1 (was bypass before fix)', () => {
    // Attack: delete a foreign check and re-add it with an own header.
    // Before the fix the gate read the on-disk file header (= own T-ID) → PASS.
    // After the fix the gate reads BASE_REF header (= foreign T-ID) → FAIL.
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'dual-control-isolation.sh', header: '# T-0044 · FF-DC1 — dual-control-isolation' },
    ]);

    sh('git', ['checkout', '-b', 'task/T-0999-del-readd'], repoDir);

    // Delete + re-add the same-named file, but with an own T-ID header
    sh('git', ['rm', 'ci/checks/dual-control-isolation.sh'], repoDir);
    // git rm removes the file; re-create the file in the same location (dir still exists)
    mkdirSync(join(repoDir, 'ci', 'checks'), { recursive: true });
    writeFileSync(
      join(repoDir, 'ci', 'checks', 'dual-control-isolation.sh'),
      `#!/usr/bin/env bash\n# T-0999 · now I own this\nset -euo pipefail\necho "gutted"\n`,
    );
    sh('git', ['add', 'ci/checks/dual-control-isolation.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0999: delete+re-add foreign check with own header (R-1 attack)'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);

    // The delete of the foreign file must be caught (D is in CDMRT, BASE_REF header = T-0044 ≠ T-0999)
    expect(exitCode, `Expected exit 1 (R-1 attack must be caught). Output:\n${stdout}`).toBe(1);
    expect(stdout).toMatch(/FAIL/);
    expect(stdout).toMatch(/dual-control-isolation\.sh/);
    expect(stdout).toMatch(/T-0044/);
  });

  it('PROBE-3: modify foreign check + rewrite header to own T-ID → exit 1 (was bypass before fix)', () => {
    // Attack: edit a foreign check and rewrite its second line to own T-ID.
    // Before the fix the gate read the on-disk file header (= own T-ID) → PASS.
    // After the fix the gate reads BASE_REF header (= foreign T-ID) → FAIL.
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'dual-control-isolation.sh', header: '# T-0044 · FF-DC1 — dual-control-isolation' },
    ]);

    sh('git', ['checkout', '-b', 'task/T-0999-header-capture'], repoDir);

    // Overwrite the file, changing the header to claim ownership
    writeFileSync(
      join(repoDir, 'ci', 'checks', 'dual-control-isolation.sh'),
      `#!/usr/bin/env bash\n# T-0999 · captured ownership of dual-control\nFROZEN_EXCLUDE_RE='bypass'\necho "gutted"\n`,
    );
    sh('git', ['add', 'ci/checks/dual-control-isolation.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0999: rewrite foreign check header to own T-ID (R-1 attack)'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);

    expect(exitCode, `Expected exit 1 (R-1 header-capture must be caught). Output:\n${stdout}`).toBe(1);
    expect(stdout).toMatch(/FAIL/);
    expect(stdout).toMatch(/dual-control-isolation\.sh/);
    expect(stdout).toMatch(/T-0044/);
  });
});

// =============================================================================
// R-2 RESIDUAL: branch-name spoof — editing own check via spoofed branch name
// =============================================================================
// Design decision: a branch task/T-0044-spoof obtains TASK_ID=T-0044.  When
// dual-control-isolation.sh has BASE_REF header "# T-0044 ·", the BASE_REF
// anchor allows this edit (the file genuinely belonged to T-0044 in BASE_REF).
// This residual risk is ACCEPTED BY DESIGN (see script header and ADR §10
// amendment): the reviewer sees the PR branch name alongside the diff, so the
// mismatch between the claimed task and the actual task is reviewer-visible.
// The R-1 fix closes the more dangerous path (foreignizing a check by header
// rewrite); this test documents the accepted residual.

describe('R-2 residual (accepted): branch-name spoof for genuinely-owned check', () => {
  it('PROBE-5 residual: branch task/T-0044-spoof editing T-0044 check → exit 0 (accepted residual risk)', () => {
    // A spoofed branch name matches the BASE_REF header of a real task's check.
    // This is accepted by design — the reviewer sees the branch name mismatch.
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'dual-control-isolation.sh', header: '# T-0044 · FF-DC1 — dual-control-isolation' },
    ]);

    // Branch named task/T-0044-spoof: TASK_ID=T-0044 via branch name
    sh('git', ['checkout', '-b', 'task/T-0044-spoof'], repoDir);

    // Modify the T-0044 check — BASE_REF header says T-0044 = TASK_ID → PASS
    writeFileSync(
      join(repoDir, 'ci', 'checks', 'dual-control-isolation.sh'),
      `#!/usr/bin/env bash\n# T-0044 · FF-DC1 — dual-control-isolation\n# modified by spoofed branch\necho "stub"\n`,
    );
    sh('git', ['add', 'ci/checks/dual-control-isolation.sh'], repoDir);
    sh('git', ['commit', '-m', 'spoof: edit T-0044 check via spoofed branch name (residual risk)'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);

    // This is exit 0 — accepted residual risk documented in ADR §10 and script header
    expect(exitCode, `Expected exit 0 (residual risk, accepted by design). Output:\n${stdout}`).toBe(0);
    expect(stdout).toMatch(/PASS/);
  });
});

// =============================================================================
// AC-12 / FF-FCI6: Subdirectory ci/checks/kc/*.sh not in glob → exit 0
// =============================================================================

describe('FF-FCI6: subdirectory ci/checks/kc/*.sh not matched → exit 0', () => {
  it('AC-12: modifying ci/checks/kc/some-check.sh on a task branch exits 0', () => {
    const repoDir = createBaseRepo(tmpRoot, [
      { file: 'top-level-check.sh', header: '# T-0300 · some top-level check' },
    ]);

    // Also create a kc subdirectory check on dev baseline
    mkdirSync(join(repoDir, 'ci', 'checks', 'kc'), { recursive: true });
    writeFileSync(
      join(repoDir, 'ci', 'checks', 'kc', 'realm-json-exists.sh'),
      `#!/usr/bin/env bash\n# kc check stub\necho "stub"\n`,
    );
    sh('git', ['add', 'ci/checks/kc/realm-json-exists.sh'], repoDir);
    sh('git', ['commit', '-m', 'add kc stub to dev baseline'], repoDir);

    sh('git', ['checkout', '-b', 'task/T-0666-test'], repoDir);

    // Modify the kc subdirectory check (should be ignored by the meta-gate glob)
    writeFileSync(
      join(repoDir, 'ci', 'checks', 'kc', 'realm-json-exists.sh'),
      `#!/usr/bin/env bash\n# kc check stub\n# modified\necho "stub"\n`,
    );
    sh('git', ['add', 'ci/checks/kc/realm-json-exists.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0666: modify kc check (allowed — subdirectory)'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);

    expect(exitCode, `Expected exit 0, got ${exitCode}. Output:\n${stdout}`).toBe(0);
    expect(stdout).toMatch(/PASS/);
  });
});

// =============================================================================
// FF-FCI12: founder-sanction channel (design T-0199)
// A {task,file} pair in ci/checks/data/frozen-sanctions.jsonl lets a task modify
// a FOREIGN frozen check (bypass FF-FCI1) — but ONLY that exact pair.  The
// matcher requires BOTH tokens on the same JSONL line, so a sanction cannot leak
// across files or across tasks.
// =============================================================================

/** Write (and commit, on the current branch) a frozen-sanctions.jsonl. */
function writeSanctions(repoDir: string, lines: string[]): void {
  const dataDir = join(repoDir, 'ci', 'checks', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'frozen-sanctions.jsonl'), lines.join('\n') + '\n');
  sh('git', ['add', 'ci/checks/data/frozen-sanctions.jsonl'], repoDir);
  sh('git', ['commit', '-m', 'add frozen-sanctions allowlist'], repoDir);
}

describe('FF-FCI12: founder-sanction channel', () => {
  const ROLE_CHECK = {
    file: 'role-criticality-isolation.sh',
    header: '# T-0040 · FF-RC1 — role-criticality-isolation',
  };

  it('SANCTIONED: task/T-0085 edits foreign T-0040 check listed in allowlist → exit 0 + SANCTION/AUDIT', () => {
    const repoDir = createBaseRepo(tmpRoot, [ROLE_CHECK]);
    writeSanctions(repoDir, [
      '# allowlist',
      '{"task":"T-0085","file":"ci/checks/role-criticality-isolation.sh","owner":"T-0040","sanctioned_by":"founder"}',
    ]);

    sh('git', ['checkout', '-b', 'task/T-0085-versioning'], repoDir);
    writeFileSync(
      join(repoDir, 'ci', 'checks', 'role-criticality-isolation.sh'),
      `#!/usr/bin/env bash\n# T-0040 · FF-RC1 — role-criticality-isolation\n# T-0085: known_tenant_tables-excludes hatch\necho "stub"\n`,
    );
    sh('git', ['add', 'ci/checks/role-criticality-isolation.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0085: edit foreign check under founder sanction'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);
    expect(exitCode, `Expected exit 0 (sanctioned). Output:\n${stdout}`).toBe(0);
    expect(stdout).toMatch(/SANCTION \[FF-FCI12\]/);
    expect(stdout).toMatch(/AUDIT \[FF-FCI12\]/);
    expect(stdout).toMatch(/role-criticality-isolation\.sh/);
  });

  it('NO ALLOWLIST: same foreign edit with no sanctions file → exit 1 (FF-FCI9 preserved)', () => {
    const repoDir = createBaseRepo(tmpRoot, [ROLE_CHECK]);
    sh('git', ['checkout', '-b', 'task/T-0085-versioning'], repoDir);
    writeFileSync(
      join(repoDir, 'ci', 'checks', 'role-criticality-isolation.sh'),
      `#!/usr/bin/env bash\n# T-0040 · FF-RC1 — role-criticality-isolation\n# unsanctioned edit\necho "stub"\n`,
    );
    sh('git', ['add', 'ci/checks/role-criticality-isolation.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0085: unsanctioned foreign edit'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);
    expect(exitCode, `Expected exit 1 (no allowlist). Output:\n${stdout}`).toBe(1);
    expect(stdout).toMatch(/FAIL/);
  });

  it('FILE LEAK GUARD: allowlist sanctions a DIFFERENT file → edit to non-listed file exits 1', () => {
    const repoDir = createBaseRepo(tmpRoot, [
      ROLE_CHECK,
      { file: 'dual-control-isolation.sh', header: '# T-0044 · FF-DC1 — dual-control-isolation' },
    ]);
    writeSanctions(repoDir, [
      '{"task":"T-0085","file":"ci/checks/role-criticality-isolation.sh","sanctioned_by":"founder"}',
    ]);

    sh('git', ['checkout', '-b', 'task/T-0085-versioning'], repoDir);
    // Edit the OTHER foreign check, which is NOT in the allowlist for T-0085
    writeFileSync(
      join(repoDir, 'ci', 'checks', 'dual-control-isolation.sh'),
      `#!/usr/bin/env bash\n# T-0044 · FF-DC1 — dual-control-isolation\n# sneaky edit not in allowlist\necho "stub"\n`,
    );
    sh('git', ['add', 'ci/checks/dual-control-isolation.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0085: edit a foreign check NOT sanctioned'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);
    expect(exitCode, `Expected exit 1 (file not in allowlist). Output:\n${stdout}`).toBe(1);
    expect(stdout).toMatch(/FAIL/);
    expect(stdout).toMatch(/dual-control-isolation\.sh/);
  });

  it('TASK LEAK GUARD: allowlist grants T-0085 → a different branch (T-0999) cannot ride it → exit 1', () => {
    const repoDir = createBaseRepo(tmpRoot, [ROLE_CHECK]);
    writeSanctions(repoDir, [
      '{"task":"T-0085","file":"ci/checks/role-criticality-isolation.sh","sanctioned_by":"founder"}',
    ]);

    sh('git', ['checkout', '-b', 'task/T-0999-impersonate'], repoDir);
    writeFileSync(
      join(repoDir, 'ci', 'checks', 'role-criticality-isolation.sh'),
      `#!/usr/bin/env bash\n# T-0040 · FF-RC1 — role-criticality-isolation\n# T-0999 riding T-0085 sanction\necho "stub"\n`,
    );
    sh('git', ['add', 'ci/checks/role-criticality-isolation.sh'], repoDir);
    sh('git', ['commit', '-m', 'T-0999: ride another tasks sanction'], repoDir);

    const { exitCode, stdout } = runCheck(repoDir);
    expect(exitCode, `Expected exit 1 (sanction is for T-0085, not T-0999). Output:\n${stdout}`).toBe(1);
    expect(stdout).toMatch(/FAIL/);
  });
});
