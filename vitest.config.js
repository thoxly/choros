import { defineConfig, configDefaults } from 'vitest/config'

// Гейт честен только если гоняет ТОЛЬКО тесты этого чекаута. Без этого vitest
// рекурсивно подхватывал тесты из стейл git-worktree (.claude/worktrees/*) и гонял
// их дважды/на старом коде → недетерминированный гейт (FE-2026-W24-0005).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.claude/**', 'web/**', '../choros-wt/**'],
  },
})
