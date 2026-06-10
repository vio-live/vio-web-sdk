/**
 * Vio UI — Web Components + design tokens.
 *
 * Importing this file (directly or via the main `vio` entry) has two
 * side-effects:
 *   1. Injects design tokens as CSS custom properties on `:root`
 *   2. Registers all `<vio-*>` custom elements (via `registerVioElements()`)
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

export { VioTokens } from './tokens.js'
export {
  registerVioElements,
  VioProduct,
  VioProductCarousel,
  VioProductDetail,
  VioCart,
  VioCheckout,
} from './elements.js'

export const VIO_UI_VERSION = '0.2.0'
