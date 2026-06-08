import { defineConfig } from 'tsup'

/**
 * Multi-entry ESM build for the Vio Web SDK.
 * - index:      full SDK (core + ui)
 * - core/index: headless managers + types (framework-agnostic, tree-shakeable)
 * - ui/index:   Lit web components (side-effectful — registers custom elements)
 *
 * Lit + graphql-request stay external (runtime deps, resolved from the
 * consumer's node_modules). Decorators compile via the tsconfig
 * (experimentalDecorators + useDefineForClassFields:false), which tsup reads.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'ui/index': 'src/ui/index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // No code-splitting: keep each entry self-contained so the `sideEffects`
  // paths (./dist/ui/**, ./dist/index.js) fully cover the custom-element
  // registration — otherwise it lands in hashed root chunks a consumer's
  // bundler could tree-shake away.
  splitting: false,
  external: ['lit', /^lit\//, 'graphql-request'],
})
