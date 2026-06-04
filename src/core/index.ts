/**
 * Vio Core — headless API surface (no DOM, SSR-safe).
 */

export { Vio } from './client.js'
export {
  Configuration,
  type VioConfig,
  type Environment,
  type ResolvedConfig,
} from './configuration.js'

// API
export { VioApi, VioApiError, createVioApi } from './api/vio.js'
export { CommerceClient, createCommerceClient } from './api/commerce.js'

// Cart
export { CartManager } from './cart/cart-manager.js'
export type {
  CartChangeDetail,
  AddProductOptions,
  AddManualOptions,
} from './cart/cart-manager.js'
export type { CartLineItem, SponsorCartState } from './cart/types.js'

// Checkout
export { CheckoutManager } from './checkout/checkout-manager.js'
export type {
  CheckoutChangeDetail,
  PaymentSelectDetail,
  PaymentCompleteDetail,
} from './checkout/checkout-manager.js'
export type { CheckoutState, CheckoutAddress, PaymentMethod } from './checkout/types.js'

// Payment adapters (low-level, exposed for advanced consumers)
export {
  checkApplePayAvailability,
  showApplePaySheet,
  type ApplePayConfig,
  type ApplePayResult,
} from './checkout/payments/apple-pay.js'

// Types + helpers
export type {
  Product,
  ProductPrice,
  ProductImage,
  ProductOption,
  ProductCategory,
  ProductVariant,
  Sponsor,
  SponsorCommerceBlock,
  BootstrapResponse,
  PlacementComponent,
  ImageSize,
} from './types.js'
export { displayPrice, primaryImageUrl, formatPrice } from './types.js'
