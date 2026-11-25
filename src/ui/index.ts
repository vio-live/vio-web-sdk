/**
 * Vio UI — Web Components + design tokens.
 *
 * Importing this file (directly or via the main `vio` entry) has two
 * side-effects:
 *   1. Injects design tokens as CSS custom properties on `:root`
 *   2. Registers the `<vio-*>` custom elements (via `registerVioElements()`):
 *      the cards at once, the detail, cart and checkout a moment later
 *
 * Registration goes through an explicit function call (see ./elements) so it
 * survives tree-shaking while keeping `./core` tree-shakeable.
 *
 * SSR-safe: every side-effect guards on `typeof document !== 'undefined'`.
 */

import './tokens.js'
import { registerVioElements } from './elements.js'

// Auto-register on import, so the conventional `import '@vio-live/web-sdk/ui'`
// keeps working. This call is what pins the registration into this entry.
registerVioElements()

export { VioTokens, applyVioTheme, type VioThemeOverrides } from './tokens.js'
export { registerVioElements, loadVioElements, VioProduct, VioProductCarousel, VioReel } from './elements.js'
// The detail, the cart and the checkout load in a second step (lazy-elements.ts):
// their classes are types here — `await loadVioElements()` gives the values.
export type { VioProductDetail } from './components/vio-product-detail.js'
export type { VioCart } from './components/vio-cart.js'
export type { VioCheckout } from './components/vio-checkout.js'
export { HLS_JS_URL } from './hls.js'

export const VIO_UI_VERSION = '0.3.0'
