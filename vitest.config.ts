import { defineConfig } from 'vitest/config'

/**
 * Root vitest config — without this, `npm test` silently picks up
 * `examples/vite.config.ts` (the only vite config in the repo) as its root,
 * which scopes test discovery to `examples/` and finds nothing under `src/`.
 * `npm test` then exits 1 with "No test files found" even when tests exist.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
  },
})
