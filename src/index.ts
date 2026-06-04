/**
 * Vio Web SDK — main entry point.
 *
 * This re-exports core APIs AND registers UI custom elements
 * (so `import { Vio } from 'vio'` gives you everything).
 *
 * For headless / SSR usage, import from 'vio/core' instead
 * (no DOM side-effects).
 */

export * from './core/index.js'

// Side-effect import: registers <vio-product-carousel>, <vio-product>, etc.
import './ui/index.js'
