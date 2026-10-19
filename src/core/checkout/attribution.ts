/**
 * The attribution of a checkout (ADR-0035 phase B): what the order is born
 * knowing about the surface it was sold from, the campaign of the page, the
 * page itself and where the shopper came in from. Sent as `attribution` on
 * `CreateCheckout` and on the `UpdateCheckout` right before paying; shopcart
 * keeps it on the checkout (`checkout.attribution`, merged key by key) and
 * writes `order.surface_id` / `campaign_id` / `content_url` / `content_title`
 * / `entry_source` from it when the order is created. The surface itself is
 * checked there against the cart's channel: a page cannot credit a sale to
 * somebody else's surface.
 *
 * Pure: `checkoutAttributionOf()` takes what the facade gathered. snake_case
 * on the wire, the caps of shopcart's `CheckoutAttributionDto` enforced here.
 */

import { CONTENT_TITLE_MAX_LENGTH, capContentUrl } from '../content.js'
import {
  CLIENT_LANDING_URL_MAX_LENGTH,
  CLIENT_REFERRER_MAX_LENGTH,
  CLIENT_UTM_MAX_LENGTH,
  type Landing,
} from '../analytics/client-context.js'
import type { CartSlice, VioItem } from '../cart/slices.js'
import type { SurfacePrivacyMode } from '../types.js'

/** `EntryContextDto`: what the page knew when the shopper came in (the SDK's landing memory). */
export interface EntryContextWire {
  referrer?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  landing_url?: string
}

/** `CheckoutAttributionDto` (shopcart `checkout/dtos/checkout-attribution.dto.ts`). */
export interface CheckoutAttributionWire {
  surface_key?: string
  campaign_id?: number
  content_url?: string
  content_title?: string
  entry?: EntryContextWire
}

/** The caps of `CheckoutAttributionDto` / `EntryContextDto`. */
export const CHECKOUT_ATTRIBUTION_CAPS = Object.freeze({
  surfaceKey: 255,
  contentUrl: 2_048,
  contentTitle: CONTENT_TITLE_MAX_LENGTH,
  referrer: CLIENT_REFERRER_MAX_LENGTH,
  utm: CLIENT_UTM_MAX_LENGTH,
  landingUrl: CLIENT_LANDING_URL_MAX_LENGTH,
})

export interface CheckoutAttributionInput {
  /** The surface's SDK key (`Vio.init({ apiKey })`) — shopcart resolves the surface from it. */
  surfaceKey?: string
  /** The campaign the PAGE belongs to, when the bootstrap lists it as active (`Vio.pageCampaign()`). */
  pageCampaignId?: number
  /** The cart split per campaign (`Vio.cartSlices(sponsorId)`), for the campaign that explains most units when the page has none. */
  slices?: ReadonlyArray<CartSlice>
  /** The page at pay time: `Vio.content()`'s url and title. */
  content?: { url?: string; title?: string }
  /** Where the session came in (`resolveLanding()`): referrer, utm, landing page. */
  landing?: Landing | null
  /**
   * The surface's privacy mode. `minimal` — or `unknown`, when it could not be
   * learnt — keeps the entry context off the order: what can reveal why
   * someone is on the page is only sent when the surface is known to allow it.
   */
  privacyMode?: SurfacePrivacyMode | 'unknown'
}

/**
 * The attribution for the wire, or `undefined` when there is nothing to say.
 * The campaign is the page's; without one, the campaign that explains most
 * units of the cart under the same rule `purchase` is split by (ties: the
 * higher value, then the first). The entry goes only on a `standard` surface.
 */
export function checkoutAttributionOf(input: CheckoutAttributionInput): CheckoutAttributionWire | undefined {
  const out: CheckoutAttributionWire = {}
  const surfaceKey = cut(input.surfaceKey, CHECKOUT_ATTRIBUTION_CAPS.surfaceKey)
  if (surfaceKey) out.surface_key = surfaceKey
  const campaignId = positiveInt(input.pageCampaignId) ?? dominantCampaignOf(input.slices)
  if (campaignId !== undefined) out.campaign_id = campaignId
  const url = capContentUrl(input.content?.url)
  if (url) out.content_url = url
  const title = cut(input.content?.title, CHECKOUT_ATTRIBUTION_CAPS.contentTitle)
  if (title) out.content_title = title
  if (input.privacyMode === 'standard') {
    const entry = entryContextOf(input.landing)
    if (entry) out.entry = entry
  }
  return Object.keys(out).length ? out : undefined
}

/** The landing as `entry`, capped; `undefined` when it says nothing. */
export function entryContextOf(landing: Landing | null | undefined): EntryContextWire | undefined {
  if (!landing || typeof landing !== 'object') return undefined
  const out: EntryContextWire = {}
  const referrer = cut(landing.referrer, CHECKOUT_ATTRIBUTION_CAPS.referrer)
  if (referrer) out.referrer = referrer
  const source = cut(landing.utm?.utm_source, CHECKOUT_ATTRIBUTION_CAPS.utm)
  if (source) out.utm_source = source
  const medium = cut(landing.utm?.utm_medium, CHECKOUT_ATTRIBUTION_CAPS.utm)
  if (medium) out.utm_medium = medium
  const campaign = cut(landing.utm?.utm_campaign, CHECKOUT_ATTRIBUTION_CAPS.utm)
  if (campaign) out.utm_campaign = campaign
  const landingUrl = cut(landing.url, CHECKOUT_ATTRIBUTION_CAPS.landingUrl)
  if (landingUrl) out.landing_url = landingUrl
  return Object.keys(out).length ? out : undefined
}

/**
 * The campaign that explains most units of the cart — over the slices
 * `purchase` is split by, so the order names the campaign the biggest
 * purchase event names. Ties go to the higher value, then to the first
 * slice. Units nobody attributes (a slice without campaign) never win.
 */
export function dominantCampaignOf(slices: ReadonlyArray<CartSlice> | null | undefined): number | undefined {
  if (!Array.isArray(slices)) return undefined
  let best: { campaignId: number; units: number; value: number } | undefined
  for (const slice of slices) {
    const campaignId = positiveInt(slice?.campaignId)
    if (campaignId === undefined) continue
    const items: ReadonlyArray<VioItem> = Array.isArray(slice.items) ? slice.items : []
    const units = items.reduce((sum: number, item) => sum + (Number(item?.quantity) > 0 ? Number(item.quantity) : 0), 0)
    const value = Number(slice.value) || 0
    if (!best || units > best.units || (units === best.units && value > best.value)) {
      best = { campaignId, units, value }
    }
  }
  return best?.campaignId
}

function positiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function cut(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim()
  if (!text) return undefined
  return text.length > max ? text.slice(0, max).trim() || undefined : text
}
