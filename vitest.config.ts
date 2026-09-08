import { defineConfig } from 'vitest/config'

/**
 * Root vitest config — without this, `npm test` silently picks up
 * `examples/vite.config.ts` (the only vite config in the repo) as its root,
 * which scopes test discovery to `examples/` and finds nothing under `src/`.
 * `npm test` then exits 1 with "No test files found" even when tests exist.
 *
 * `environment` stays `node` by default and files opt in per-file with
 *
 *     // @vitest-environment jsdom
 *
 * The core is plain TypeScript: it runs faster in node, and a DOM there would
 * let a test pass on a global the real runtime does not have. The UI is
 * LitElement and needs a document.
 *
 * Until jsdom was added the components could not be instantiated at all, so
 * every test of them was written against a stand-in model instead of the real
 * class. A code review on 2026-09-08 found that five of that day's seven
 * defects would not have been caught if reintroduced, for exactly that reason.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
  },
})
