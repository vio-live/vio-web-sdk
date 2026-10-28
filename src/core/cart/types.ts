/**
 * Cart types — multi-sponsor line items.
 *
 * Mirrors the iOS SDK's `SponsorCart` + `CartLineItem` structure so the
 * mental model stays consistent across platforms.
 */

/**
 * Where a unit in the cart came from (ADR-0027 / ADR-0034 / ADR-0035): the
 * campaign the place showed when it was added, the place (`slot`), the kind
 * of element it was added from, and the content (article: its id, URL and
 * title). What `Vio.attribution(slot)` answers, minus the sponsor, plus the
 * element's kind. The purchase is split per campaign from these, and since
 * 0.26 Commerce receives them with every add (`origin` on the line, ADR-0035
 * phase B) so the order knows where each unit was sold from.
 */
export interface CartOrigin {
  campaignId?: number
  slot?: string
  contentId?: string
  /**
   * The kind of component the units were added from, as Commerce and the
   * collector name it: `card` | `carousel` | `detail` for the SDK's elements
   * (`componentKindOf()` — from the element's `componentTemplateId`, else
   * the kind word in the slot id).
   */
  componentKind?: string
  /** The page the units were added from (`content_url`, ≤ 2 048), kept so a later +1 from the cart credits the same page. */
  contentUrl?: string
  /** Its title (`content_title`, ≤ 255). */
  contentTitle?: string
  /**
   * The layout of `<vio-product-detail>` the units were added from (0.34):
   * its `id`, `revision`, and the experiment / variant it belongs to — set by
   * the detail from the layout it showed at that moment, only for a
   * non-default layout. Kept with the line (localStorage) and never rewritten
   * by a later configuration; reported per unit on the events with items
   * (`layout_id`, `layout_revision`, `experiment_id`, `experiment_variant_id`).
   * Never sent to Commerce. `variantId` here is the EXPERIMENT variant, not the
   * product variant (`CartLineItem.variantId`).
   */
  layoutId?: string
  layoutRevision?: string
  experimentId?: string
  variantId?: string
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
  /**
   * The commerce channel the backend cart was created on (the sponsor's
   * block for the campaign the first line came from). Every later cart and
   * checkout call for this cart uses THAT channel's key; when the bootstrap
   * no longer lists it, the cart is created again on the current channel with
   * its lines. Absent on carts created before 0.33 (they keep the sponsor's
   * first block, as then, and learn it on the next call).
   */
  channelId?: string
  shippingCountry?: string
  subtotal?: number
  shipping?: number
  availableShippingCountries?: string[]
}
