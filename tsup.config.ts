import { defineConfig } from 'tsup'

/**
 * Multi-entry ESM build for the Vio Web SDK.
 * - index:       full SDK (core + auto-registers ui)
 * - core/index:  headless managers + types (framework-agnostic, tree-shakeable)
 * - ui/index:    Lit web components facade (tokens + registration)
 * - react/index: @lit/react wrappers (typed React components)
 *
 * Registration is an explicit `registerVioElements()` call (see src/ui/elements),
 * NOT an `@customElement` module side-effect — so it survives tree-shaking
 * wherever the components are chunked, while `./core` stays side-effect-free
 * and tree-shakeable. package.json `sideEffects` lists only the entries that
 * call it. See lessons/web-sdk-tsup-singleton-and-build.
 *
 * Lit + graphql-request stay external (runtime deps, resolved from the
 * consumer's node_modules). react/react-dom are external too — an optional
 * peer, only needed by the `./react` entry. `@lit/react` is intentionally
 * NOT external: it's bundled into dist/react so consumers install nothing
 * beyond react itself.
 *
 * Decorators compile via the tsconfig (experimentalDecorators +
 * useDefineForClassFields:false), which tsup reads.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'ui/index': 'src/ui/index.ts',
    'react/index': 'src/react/index.ts',
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
  external: ['lit', /^lit\//, 'graphql-request', 'react', 'react-dom'],
})
