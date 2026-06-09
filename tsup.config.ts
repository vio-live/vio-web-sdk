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
  // Code-splitting stays ON (esm default): the Vio client is a singleton
  // shared across entries, so it must live in ONE shared chunk. Disabling
  // splitting duplicates it and breaks Vio.init() reaching the components.
  // Custom-element registration stays side-effectful via package.json sideEffects.
  external: ['lit', /^lit\//, 'graphql-request'],
})
