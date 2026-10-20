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
  activeCampaignEntry,
  sponsorCampaignEntry,
  campaignCandidates,
  toCampaignId,
  autoSlotId,
  autoSlotDisplayName,
  normalizeScope,
  normalizeSlotKind,
  componentKindOf,
  type CampaignHint,
  type RegisterSlotOptions,
  type SlotInput,
  type SlotKind,
} from './slots.js'

// Content (article) attribution: what `content_id` / `content_title` / `content_url` carry.
export { resolveContent, capContentUrl, originAndPath, CONTENT_URL_MAX_LENGTH, type ContentRef } from './content.js'

// The standard context of the visit (`client` block) and the buyer reference (`buyer_id`).
export {
  resolveClientContext,
  resolveLanding,
  storedLanding,
  landingUrl,
  CLIENT_LANDING_URL_MAX_LENGTH,
  type ClientContext,
  type Landing,
} from './analytics/client-context.js'
export { normalizeBuyerRef, BUYER_REF_MAX_LENGTH } from './buyer-ref.js'

// The attribution of the order (ADR-0035 phase B): what the cart lines and the checkout send to Commerce.
export {
  lineOriginWire,
  LINE_ORIGIN_CAPS,
  GRAPHQL_INT_MAX,
  type LineOriginWire,
  type LineOriginWireOptions,
  type OriginPage,
} from './cart/origin-wire.js'
export {
  checkoutAttributionOf,
  entryContextOf,
  dominantCampaignOf,
  CHECKOUT_ATTRIBUTION_CAPS,
  type CheckoutAttributionWire,
  type CheckoutAttributionInput,
  type EntryContextWire,
} from './checkout/attribution.js'
// What the commerce gateway may not know yet (a field the SDK ships ahead of).
export {
  withGatewayFeature,
  gatewayHas,
  resetGatewayFeatures,
  isUnknownFeatureError,
  isUnknownTokenError,
  type GatewayFeature,
} from './api/gateway-features.js'

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
  getCheckoutReference,
  type CheckoutReference,
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
  UPDATE_ITEM_WITH_ORIGIN_MUTATION,
  GET_CART_QUERY,
  GET_LINE_ITEMS_BY_SUPPLIER_QUERY,
  UPDATE_SHIPPINGS_BY_SUPPLIER_MUTATION,
  CREATE_CHECKOUT_MUTATION,
  CREATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION,
  UPDATE_CHECKOUT_MUTATION,
  UPDATE_CHECKOUT_WITH_ATTRIBUTION_MUTATION,
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
  purchaseIdsOf,
  buyerRefOf,
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
  PurchaseIds,
} from './analytics/analytics-manager.js'
export { SDK_VERSION } from './version.js'

// Checkout
export { CheckoutManager } from './checkout/checkout-manager.js'
export type {
  CheckoutChangeDetail,
  CheckoutManagerDeps,
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
  SurfacePrivacyMode,
  SurfaceResponse,
  ManifestLocation,
  ManifestRequest,
  ManifestResult,
  PlacementComponent,
  ImageSize,
} from './types.js'
export { displayPrice, primaryImageUrl, formatPrice, getGlobalCurrency } from './types.js'
