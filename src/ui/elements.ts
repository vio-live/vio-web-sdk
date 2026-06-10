/**
 * Vio elements — owns the `<vio-*>` custom-element classes and their registration.
 *
 * WHY REGISTRATION IS A FUNCTION (not `@customElement` module side-effects):
 * Both `./ui` and `./react` need the component classes, so the bundler hoists
 * them into a *hashed* shared chunk that package.json `sideEffects` can't name.
 * If registration were a module-eval side-effect (`@customElement`), a
 * consumer's tree-shaker would drop that chunk on a bare `import '.../ui'` and
 * the elements would never `define`. Instead, `registerVioElements()` is a
 * *called value*: any sideEffects-listed entry that calls it (see ui/index +
 * react/index) keeps the function and the classes it references — regardless of
 * chunking — while `./core` stays free of these side-effects and remains
 * tree-shakeable. See lessons/web-sdk-tsup-singleton-and-build.
 */

import { VioProduct } from './components/vio-product.js'
import { VioProductCarousel } from './components/vio-product-carousel.js'
import { VioProductDetail } from './components/vio-product-detail.js'
import { VioCart } from './components/vio-cart.js'
import { VioCheckout } from './components/vio-checkout.js'

export { VioProduct, VioProductCarousel, VioProductDetail, VioCart, VioCheckout }

/**
 * Register every `<vio-*>` custom element. Idempotent (skips already-defined
 * tags, so calling it from both `./ui` and `./react` is safe) and SSR-safe
 * (no-op when `customElements` is undefined).
 */
export function registerVioElements(): void {
  if (typeof customElements === 'undefined') return
  const defs: Array<[string, CustomElementConstructor]> = [
    ['vio-product', VioProduct],
    ['vio-product-carousel', VioProductCarousel],
    ['vio-product-detail', VioProductDetail],
    ['vio-cart', VioCart],
    ['vio-checkout', VioCheckout],
  ]
  for (const [tag, ctor] of defs) {
    if (!customElements.get(tag)) customElements.define(tag, ctor)
  }
}
