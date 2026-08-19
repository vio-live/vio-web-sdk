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
export type { CartLineItem, SponsorCartState } from './cart/types.js'

// Analytics
export { AnalyticsManager } from './analytics/analytics-manager.js'
export type {
  AnalyticsEventName,
  AnalyticsContext,
  AnalyticsCommerce,
  AnalyticsItemInput,
  AnalyticsStartOptions,
  TrackOptions,
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
export { displayPrice, primaryImageUrl, formatPrice, getGlobalCurrency } from './types.js'
