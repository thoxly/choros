import { defineConfig, configDefaults } from 'vitest/config'

// Гейт честен только если гоняет ТОЛЬКО тесты этого чекаута. Без этого vitest
// рекурсивно подхватывал тесты из стейл git-worktree (.claude/worktrees/*) и гонял
// их дважды/на старом коде → недетерминированный гейт (FE-2026-W24-0005).
export default defineConfig({
  test: {
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
