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
import { VioReel } from './components/vio-reel.js'
import {
  defineHeavyElements,
  loadHeavyElements,
  registerHeavyElementsLazily,
  type HeavyElementClasses,
} from './lazy-elements.js'

export { VioProduct, VioProductCarousel, VioReel }
export type { HeavyElementClasses }

/**
 * Register every `<vio-*>` custom element. Idempotent (skips already-defined
 * tags, so calling it from both `./ui` and `./react` is safe) and SSR-safe
 * (no-op when `customElements` is undefined).
 *
 * The cards (`vio-product`, `vio-product-carousel`, `vio-reel`) are defined at
 * once. The heavy three (`vio-product-detail`, `vio-cart`, `vio-checkout`)
 * are defined at once when their classes are given (the React entry, the
 * tests), and otherwise loaded a moment later (see lazy-elements.ts).
 */
export function registerVioElements(heavy?: HeavyElementClasses): void {
  if (
    typeof customElements === 'undefined' ||
    typeof customElements.get !== 'function' ||
    typeof customElements.define !== 'function'
  )
    return
  const defs: Array<[string, CustomElementConstructor]> = [
    ['vio-product', VioProduct],
    ['vio-product-carousel', VioProductCarousel],
    ['vio-reel', VioReel],
  ]
  for (const [tag, ctor] of defs) {
    if (!customElements.get(tag)) customElements.define(tag, ctor)
  }
  if (heavy) defineHeavyElements(heavy)
  else registerHeavyElementsLazily(importHeavy)
}

function importHeavy(): Promise<HeavyElementClasses> {
  return import('./heavy-elements.js').then((m) => ({
    VioProductDetail: m.VioProductDetail,
    VioCart: m.VioCart,
    VioCheckout: m.VioCheckout,
  }))
}

/**
 * Load and define the product detail, the cart and the checkout now; resolves
 * with their classes. Await it before calling `show()` on one of them that you
 * have just created (one already in the document waits by itself).
 */
export function loadVioElements(): Promise<HeavyElementClasses> {
  return loadHeavyElements()
}
