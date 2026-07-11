import { defineConfig, configDefaults } from 'vitest/config'

// Гейт честен только если гоняет ТОЛЬКО тесты этого чекаута. Без этого vitest
// рекурсивно подхватывал тесты из стейл git-worktree (.claude/worktrees/*) и гонял
// их дважды/на старом коде → недетерминированный гейт (FE-2026-W24-0005).
export default defineConfig({
  test: {
    // T-0646: suite-wide test/hook timeout budget.
    //
    // The db tier (ci/checks/db/**, run via `npm run fitness:db` =
    // `vitest run --dir ci/checks/db`) are LIVE Postgres probes: they start a
    // real server, apply seed packs over HTTP, and do many sequential awaited
    // DB round-trips. Several LEGITIMATELY take 10–27s (e.g. seed-pack.test.ts
    // server-startup + full HTTP applyPack; T-0140) and their runtime grows
    // with the repo and with concurrent-CI DB contention. Vitest's 5000ms
    // default testTimeout / 10000ms default hookTimeout make the whole suite
    // DETERMINISTICALLY / load-sensitively RED on time alone (T-0646) — a
    // timeout-margin failure, NOT a functional bug — and a deterministically-red
    // gate MASKS real db regressions (the "fitness-mask" class,
    // memory choros-fitness-mask-unmask).
    //
    // This is a CURE, not a mask: a genuine regression is an ASSERTION failure,
    // caught at ANY timeout; only a truly-hung test waits longer before failing.
    // Raising the ceiling is harmless for the fast src unit suite (passing tests
    // finish in ms; the db tier is excluded from the default `vitest run` below).
    // 60000/30000 give real margin over the slowest legit test (~27s) under load.
    testTimeout: 60000,
    hookTimeout: 30000,
    // T-0147: globalSetup runs in main-process before workers fork; it clones
    // choros_test_template → choros_test_<epoch>_<hex> and mutates process.env
    // so all db-tier workers see the per-run clone (D-3).  At non-db runs
    // (DATABASE_URL unset or DB_ISOLATION=off) the setup is a no-op.
    globalSetup: ['ci/checks/db/globalSetup.ts'],
    // ci/checks/db/** are LIVE Postgres probes (T-0053) — they require the
    // pinned postgres:16 service and run only in the dedicated `db` CI job via
    // `npm run fitness:db` (vitest --dir ci/checks/db). They are excluded from
    // the default `vitest run` so the ambient-free `ci` job stays green with no
    // DB dependency (D-056: integration-honest, no ambient state).
    exclude: [
      ...configDefaults.exclude,
      '.claude/**',
      'web/**',
      '../choros-wt/**',
      'ci/checks/db/**',
    ],
  },
})
