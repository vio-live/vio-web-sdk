import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

/**
 * The SDK playground (`playground/`): the components built from `src/`, not
 * from npm, so a visual change is visible on a deployed page before any
 * release. `npm run playground` serves it; `npm run playground:build` writes
 * `dist-playground/`; `npm run playground:deploy` uploads that to Vercel
 * (team `tipio-2`, project `vio-demo` → https://vio-demo.vercel.app).
 */
const sha = (() => {
  try {
    const short = execSync('git rev-parse --short HEAD').toString().trim()
    const dirty = execSync('git status --porcelain -- src playground').toString().trim() ? '+local' : ''
    return short + dirty
  } catch {
    return 'unknown'
  }
})()

export default defineConfig({
  root: 'playground',
  define: { __GIT_SHA__: JSON.stringify(sha) },
  server: { port: 5174, host: '127.0.0.1' },
  build: { outDir: '../dist-playground', emptyOutDir: true, sourcemap: true },
})
