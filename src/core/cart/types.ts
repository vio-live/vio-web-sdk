/**
 * Cart types — multi-sponsor line items.
 *
 * Mirrors the iOS SDK's `SponsorCart` + `CartLineItem` structure so the
 * mental model stays consistent across platforms.
 */

export interface CartLineItem {
  /** Unique local id for this line item (used for update/remove). */
  id: string
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
}

export interface SponsorCartState {
  sponsorId: number
  sponsorName?: string
  items: CartLineItem[]
  currency: string
}
