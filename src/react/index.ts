/**
 * Vio React adapter — typed React wrappers for the `<vio-*>` web components.
 *
 * Built on `@lit/react`'s `createComponent`, which gives each wrapper:
 *   - typed props derived from the element's reactive properties, and
 *   - typed event props (the `vio:*` CustomEvents below) as `onX` callbacks.
 *
 * Importing this entry also REGISTERS the custom elements (via the
 * `registerVioElements()` call below), so you do NOT need a separate
 * `import '@vio-live/web-sdk/ui'` when you use these.
 *
 * React 18+ is an (optional) peer dependency — only required if you import this
 * entry. `@lit/react` is bundled in, so consumers install nothing extra.
 *
 *   import { Vio } from '@vio-live/web-sdk'
 *   import { VioProductCarousel } from '@vio-live/web-sdk/react'
 *   Vio.init({ apiKey, apiBase, graphqlBase, stripePublishableKey })
 *   <VioProductCarousel onProductAdd={(e) => console.log(e.detail)} />
 */

import * as React from 'react'
import { createComponent } from '@lit/react'
import {
  registerVioElements,
  VioProduct as VioProductEl,
  VioProductCarousel as VioProductCarouselEl,
  VioProductDetail as VioProductDetailEl,
  VioCart as VioCartEl,
  VioCheckout as VioCheckoutEl,
} from '../ui/elements.js'

// Register the underlying custom elements when this entry is imported.
registerVioElements()

export const VioProduct = createComponent({
  react: React,
  tagName: 'vio-product',
  elementClass: VioProductEl,
  events: {
    onProductClick: 'vio:product-click',
    onProductAdd: 'vio:product-add',
  },
})

export const VioProductCarousel = createComponent({
  react: React,
  tagName: 'vio-product-carousel',
  elementClass: VioProductCarouselEl,
  events: {},
})

export const VioProductDetail = createComponent({
  react: React,
  tagName: 'vio-product-detail',
  elementClass: VioProductDetailEl,
  events: {
    onAddedToCart: 'vio:added-to-cart',
    onCheckoutOpen: 'vio:checkout-open',
  },
})

export const VioCart = createComponent({
  react: React,
  tagName: 'vio-cart',
  elementClass: VioCartEl,
  events: {
    onPaymentSuccess: 'vio:payment-success',
    onCheckoutOpen: 'vio:checkout-open',
  },
})

export const VioCheckout = createComponent({
  react: React,
  tagName: 'vio-checkout',
  elementClass: VioCheckoutEl,
  events: {
    onPaymentSuccess: 'vio:payment-success',
  },
})
