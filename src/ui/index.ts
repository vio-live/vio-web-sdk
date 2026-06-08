/**
 * Vio UI — Web Components + design tokens.
 *
 * Importing this file (directly or via the main `vio` entry) has two
 * side-effects:
 *   1. Injects design tokens as CSS custom properties on `:root`
 *   2. Registers all `<vio-*>` custom elements
 *
 * SSR-safe: every side-effect guards on `typeof document !== 'undefined'`.
 */

import './tokens.js'

// Register custom elements (each side-effect imports its decorator)
import './components/vio-product.js'
import './components/vio-product-carousel.js'
import './components/vio-product-detail.js'
import './components/vio-cart.js'
import './components/vio-checkout.js'

export { VioTokens } from './tokens.js'
export { VioProduct } from './components/vio-product.js'
export { VioProductCarousel } from './components/vio-product-carousel.js'
export { VioProductDetail } from './components/vio-product-detail.js'
export { VioCart } from './components/vio-cart.js'
export { VioCheckout } from './components/vio-checkout.js'

export const VIO_UI_VERSION = '0.1.0'
