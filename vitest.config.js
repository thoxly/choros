import { defineConfig, configDefaults } from 'vitest/config'

// Гейт честен только если гоняет ТОЛЬКО тесты этого чекаута. Без этого vitest
// рекурсивно подхватывал тесты из стейл git-worktree (.claude/worktrees/*) и гонял
// их дважды/на старом коде → недетерминированный гейт (FE-2026-W24-0005).
export default defineConfig({
  test: {
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
