/**
 * The heavy `<vio-*>` elements — the product detail, the cart and the checkout
 * (most of the UI's weight: payments, forms, widgets). `./ui` loads this
 * module lazily (lazy-elements.ts); the React entry and the tests import it
 * directly and define them at once.
 */
export { VioProductDetail } from './components/vio-product-detail.js'
export { VioCart } from './components/vio-cart.js'
export { VioCheckout } from './components/vio-checkout.js'
