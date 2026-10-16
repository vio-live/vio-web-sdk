/**
 * Vio Core — headless API surface (no DOM, SSR-safe).
 */

export { Vio } from './client.js'
export {
  Configuration,
  type VioConfig,
  type Environment,
  type VioPlatform,
  type ResolvedConfig,
} from './configuration.js'

// Slots (ADR-0027): which campaign a slot shows, from a bootstrap response;
// the auto identity of an element (`carousel-1`, `article-123-card-2`).
export {
  resolveSlotCampaign,
  autoSlotId,
  autoSlotDisplayName,
  normalizeScope,
  type SlotInput,
  type SlotKind,
} from './slots.js'

// Content (article) attribution: what `content_id` / `content_title` carry.
export { resolveContent, type ContentRef } from './content.js'

// API
export { VioApi, VioApiError, createVioApi } from './api/vio.js'
export { CommerceClient, createCommerceClient } from './api/commerce.js'

// Server-side cart / checkout GraphQL (Vio Commerce)
export {
  createCart,
  addItem,
  deleteItem,
  updateItem,
  getCart,
  getLineItemsBySupplier,
  updateShippingsBySupplier,
  createCheckout,
  updateCheckout,
  getCheckout,
  getAvailablePaymentMethods,
  createPaymentStripe,
  createPaymentVipps,
  getVippsStatus,
  executeCartGraphQL,
  getCartGraphQLOptions,
  getCustomerSessionId,
  CREATE_CART_MUTATION,
  ADD_ITEM_MUTATION,
  DELETE_ITEM_MUTATION,
  UPDATE_ITEM_MUTATION,
  GET_CART_QUERY,
  GET_LINE_ITEMS_BY_SUPPLIER_QUERY,
  UPDATE_SHIPPINGS_BY_SUPPLIER_MUTATION,
  CREATE_CHECKOUT_MUTATION,
  UPDATE_CHECKOUT_MUTATION,
  GET_CHECKOUT_QUERY,
  GET_AVAILABLE_PAYMENT_METHODS_QUERY,
  CREATE_PAYMENT_STRIPE_MUTATION,
  CREATE_PAYMENT_VIPPS_MUTATION,
  GET_VIPPS_STATUS_QUERY,
  type CartQueryOptions,
} from './api/cart-queries.js'

// Cart
export { CartManager } from './cart/cart-manager.js'
export type {
  CartChangeDetail,
  AddProductOptions,
  AddManualOptions,
} from './cart/cart-manager.js'
export type { CartLineItem, CartLineOrigin, CartOrigin, SponsorCartState } from './cart/types.js'
// Origins: where each unit of a line came from (pure helpers, for hosts and tests).
export { lineOrigins, normalizeOrigin, sameOrigin } from './cart/cart-manager.js'
// The cart split per campaign — the rule behind begin_checkout / purchase and `Vio.cartSlices()`.
export { cartSlicesFrom, type CartSlice, type VioItem } from './cart/slices.js'

// Analytics
export {
  AnalyticsManager,
  resolveCampaignId,
  purchaseFromPaymentSuccess,
} from './analytics/analytics-manager.js'
export type {
  AnalyticsEventName,
  AnalyticsContext,
  AnalyticsCommerce,
  AnalyticsItemInput,
  AnalyticsStartOptions,
  TrackOptions,
  PaymentSuccessDetail,
  PaymentSuccessResult,
} from './analytics/analytics-manager.js'
export { SDK_VERSION } from './version.js'

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
export type {
  CreatePaymentVippsVariables,
  CreatePaymentVippsResponse,
  GetVippsStatusVariables,
  VippsStatusResult,
  VippsPaymentState,
} from './checkout/payments/vipps.js'
export {
  ensureVippsButton,
  vippsButtonAttributes,
  VIPPS_BUTTON_SCRIPT,
  VIPPS_BUTTON_TAG,
} from './checkout/payments/vipps-button.js'


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
  BootstrapCampaign,
  BootstrapCampaignEntry,
  BootstrapCampaignStatus,
  BootstrapSlot,
  Attribution,
  ManifestLocation,
  ManifestRequest,
  ManifestResult,
  PlacementComponent,
  ImageSize,
} from './types.js'
export { displayPrice, primaryImageUrl, formatPrice, getGlobalCurrency } from './types.js'
