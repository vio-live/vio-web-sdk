/**
 * Cart types — multi-sponsor line items.
 *
 * Mirrors the iOS SDK's `SponsorCart` + `CartLineItem` structure so the
 * mental model stays consistent across platforms.
 */

/**
 * Where a unit in the cart came from (ADR-0027 / ADR-0034): the campaign
 * the place showed when it was added, the place (`slot`) and the content
 * (article). What `Vio.attribution(slot)` answers, minus the sponsor and the
 * title. The purchase is split per campaign from these.
 */
export interface CartOrigin {
  campaignId?: number
  slot?: string
  contentId?: string
}

/** One origin of a line and how many of its units came from it. */
export interface CartLineOrigin extends CartOrigin {
  quantity: number
}

export interface CartLineItem {
  /** Unique local id for this line item (used for update/remove). */
  id: string
  /** Backend cart item id (set once the server-side cart is synced). */
  cartItemId?: string
  /** Vio Commerce product id. */
  productId: number
  /** Sponsor (merchant) id this line item belongs to. */
  sponsorId: number
  /** Optional variant id. */
  variantId?: number
  /** Display brand (e.g. "COS"). */
  brand: string
  /** Display product name. */
  name: string
  /** Numeric unit price (inclusive of taxes when available). */
  unitPrice: number
  /** Currency code (e.g. "NOK"). */
  currency: string
  /** Display image URL. */
  imageUrl: string
  /** Quantity. */
  quantity: number
  /**
   * Where the units came from, most recent last; their quantities add up to
   * `quantity`. Absent on carts persisted before origins existed — read them
   * through `lineOrigins()`, which fills the gap with an empty origin.
   */
  origins?: CartLineOrigin[]
  /** Selected shipping for this line (backend cart). */
  shipping?: unknown
  /** Shipping options offered by the backend for this line. */
  availableShippings?: unknown[]
}

export interface SponsorCartState {
  sponsorId: number
  sponsorName?: string
  items: CartLineItem[]
  currency: string
  /** Backend (Vio Commerce) cart id, once created. */
  cartId?: string
  shippingCountry?: string
  subtotal?: number
  shipping?: number
  availableShippingCountries?: string[]
}
