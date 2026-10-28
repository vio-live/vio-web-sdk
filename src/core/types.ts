/**
 * Vio types — Product / Sponsor / Bootstrap shapes.
 *
 * Product types mirror the Vio Commerce GraphQL schema.
 * Sponsor / Bootstrap shapes mirror the iOS SDK's bootstrap response so
 * we stay aligned cross-platform.
 */

import { storageGet } from './safe-storage.js'

export type ImageSize = 'thumbnail' | 'small' | 'medium' | 'large' | 'full'

export interface ProductPrice {
  amount: number
  currency_code: string
  compare_at?: number | null
  amount_incl_taxes?: number | null
  compare_at_incl_taxes?: number | null
  tax_amount?: number | null
  tax_rate?: number | null
}

export interface ProductImage {
  id: string
  url: string
  width?: number | null
  height?: number | null
  order?: number | null
}

export interface ProductOption {
  id: number
  name: string
  order: number
  values: string[]
}

export interface ProductCategory {
  id: number
  name: string
}

export interface ProductVariant {
  id: number
  barcode?: string | null
  quantity?: number | null
  sku?: string | null
  title?: string | null
  price: ProductPrice
  images: ProductImage[]
}

export interface Product {
  id: number
  brand?: string | null
  title: string
  description?: string | null
  tags?: string | null
  sku: string
  quantity?: number | null
  price: ProductPrice
  variants: ProductVariant[]
  barcode?: string | null
  options: ProductOption[]
  categories?: ProductCategory[] | null
  images: ProductImage[]
}

/** Per-sponsor commerce config sourced from Vio bootstrap. */
export interface SponsorCommerceBlock {
  apiKey: string
  channelId?: string | null
  paymentMethods?: string[]
}

/** One of a brand's promises («Rask levering» / «2-5 virkedager»), with a line icon of the SDK's set. */
export interface SponsorHighlight {
  icon: string
  title: string
  text?: string | null
}

export interface Sponsor {
  id: number
  name: string
  description?: string | null
  avatarUrl?: string | null
  logoUrl?: string | null
  primaryColor?: string | null
  secondaryColor?: string | null
  /** The brand's purchase terms (its own page, e.g. its shop's terms of service). */
  termsUrl?: string | null
  /** The brand's returns / refund policy page. */
  refundPolicyUrl?: string | null
  /** The brand's promises (Settings → Brand): up to three, shown under the buy zone of the product detail. */
  highlights?: SponsorHighlight[] | null
  commerce: SponsorCommerceBlock
}

/**
 * `campaign` of `GET /v2/mobile/config`: the head of the surface's default
 * campaign (the one `primarySponsor` / `secondarySponsors` belong to).
 */
export interface BootstrapCampaign {
  id: number
  name: string
  logo?: string | null
  isActive?: boolean
  isPaused?: boolean
  startDate?: string | null
  endDate?: string | null
}

/** Campaign status as the backend computes it (`[startsAt, endsAt)`). */
export type BootstrapCampaignStatus = 'scheduled' | 'active' | 'paused' | 'ended'

/** A slot assignment of a campaign on this surface (`campaigns[].slots[]`). */
export interface BootstrapSlot {
  name: string
  platform?: string | null
  startDate?: string | null
  endDate?: string | null
  /** Who assigned it: the dashboard (always wins) or a page's own campaign (campaigns micro PR #16). */
  source?: 'dashboard' | 'page' | null
}

/**
 * One entry of `campaigns[]`: every active campaign of the surface, with its
 * own sponsors — a sponsor may live only in a non-default campaign.
 */
export interface BootstrapCampaignEntry extends BootstrapCampaign {
  isDefault?: boolean
  status?: BootstrapCampaignStatus
  primarySponsor?: Sponsor | null
  secondarySponsors?: Sponsor[]
  slots?: BootstrapSlot[]
}

/**
 * Response shape of `GET /v2/mobile/config` (and likely future `/v2/web/config`).
 * Matches the iOS SDK's `SdkBootstrapResponse` model.
 *
 * `campaign` + `primarySponsor` + `secondarySponsors` describe the surface's
 * default campaign; `campaigns[]` lists every active one. There is no
 * top-level `campaignId` — the id lives in `campaign.id`.
 */
export interface BootstrapResponse {
  endpoints?: {
    webSocketBase?: string
    commerceGraphQL?: string
  }
  /**
   * `null` when the surface has no active campaign: a web, custom-web or Vev
   * page then keeps selling with the sponsors of the surface's channels
   * (`noActiveCampaign: true`, `campaigns: []`), and nothing it sells carries
   * a campaign. Native apps get a 404 instead.
   */
  campaign?: BootstrapCampaign | null
  /** True when `campaign` is null on purpose: no campaign is active on the surface. */
  noActiveCampaign?: boolean
  primarySponsor?: Sponsor
  secondarySponsors?: Sponsor[]
  features?: {
    shoppable?: boolean
    lineup?: boolean
  }
  campaigns?: BootstrapCampaignEntry[]
  market?: {
    countryCode: string
    currencyCode: string
  }
  /**
   * The surface of the key, when the bootstrap says it (the campaigns
   * service answers it on `/v2/mobile/surface` today; here when it adds it).
   * Its `privacyMode` decides what the order attribution may carry.
   */
  surface?: SurfaceResponse['surface']
}

/**
 * A slot this page declares to the campaigns service (ADR-0027 / ADR-0034):
 * `id` is the slot name (≤ 100 chars, what `vio-slot` carries and what the
 * dashboard assigns a campaign to); `displayName` is only for the dashboard.
 */
export interface ManifestLocation {
  id: string
  displayName?: string
  /** The campaign this location belongs to when it differs from the page's (`ManifestRequest.campaignId`). */
  campaignId?: number
  /** The kind of element the slot holds — `card` | `carousel` | `detail` for the SDK's, a host's own word otherwise. For the dashboard. */
  kind?: string
}

/**
 * Where something happened, as `Vio.attribution(slot)` answers it — the ONE
 * attribution shape the SDK elements, Vev and Replit all use: the place
 * (`slot`), the campaign that place shows right now and its primary sponsor,
 * and the content (article) the page is. Everything optional: `{}` before the
 * bootstrap, except the content.
 */
export interface Attribution {
  slot?: string
  campaignId?: number
  sponsorId?: number
  contentId?: string
  contentTitle?: string
  /** The page's URL within the 2 048 cap (`content_url`) — what Commerce keeps on the order and its lines. */
  contentUrl?: string
}

/**
 * How much context analytics and Commerce may keep of a visit to this
 * surface. `minimal` drops what says WHICH screen someone was on and WHY —
 * the page (`content_url`, `content_title`), the slot (`location_id`) and
 * the entry (referrer, utm, landing page) — the collector drops it from the
 * events on its side (vio-analytics `privacy.ts`); the SDK keeps it off the
 * order and off the cart lines it sends to Commerce. What measures the
 * funnel and bills the sale stays: the surface, the campaign, the kind of
 * component, the products and the amounts. A mode the SDK could not learn
 * counts as `minimal`.
 */
export type SurfacePrivacyMode = 'standard' | 'minimal'

/** Response of `GET /v2/mobile/surface`: what the key may know of its own surface. */
export interface SurfaceResponse {
  surface?: {
    id?: number
    name?: string
    status?: string
    privacyMode?: SurfacePrivacyMode | string | null
  } | null
}

/** Body of `POST /v2/mobile/components/manifest`. */
export interface ManifestRequest {
  platform: string
  /**
   * `merge` upserts the slots without deprecating those of other pages (a
   * surface on the web has many pages, each knowing only its own blocks);
   * `replace` (the native SDKs' mode) deprecates whatever is not listed.
   */
  mode: 'merge' | 'replace'
  locations: ManifestLocation[]
  /**
   * The campaign the PAGE belongs to (`Vio.init({ campaignId })`): the micro
   * assigns every declared location to it (`source: 'page'`) unless the
   * dashboard already assigned that slot.
   */
  campaignId?: number
}

/** Response of `POST /v2/mobile/components/manifest`. */
export interface ManifestResult {
  clientAppId: number
  platform: string
  mode: 'merge' | 'replace'
  locations: Array<{
    id: number | string
    locationId: string
    displayName?: string | null
    /**
     * What the micro did with the page's campaign for this slot: `created` /
     * `kept` / `replaced` a page assignment, `dashboard` (the dashboard's
     * assignment stands — the page's campaign is ignored there), `none`.
     */
    assignment?: 'created' | 'kept' | 'replaced' | 'dashboard' | 'none'
  }>
  deprecatedCount: number
  warnings: Array<{ kind: string; detail: string }>
}

/**
 * A placement component returned by `/v2/mobile/campaigns/:id/components`.
 * Used by `<vio-product-carousel campaign-id="...">` to know which products
 * to render at a given slot.
 */
export interface PlacementComponent {
  id: number
  componentType: string
  locationId: string
  sponsorId?: number
  config: {
    productIds?: number[]
    [key: string]: unknown
  }
}

/** Helper: extract a useful display price from a Product. */
export function displayPrice(product: Product): string {
  const p = product.price
  const amount = p.amount_incl_taxes ?? p.amount
  return formatPrice(amount, p.currency_code)
}

/**
 * Active shipping/market country for the page. The host (e.g. the Vev Config
 * block) sets `globalThis.__VIO_COUNTRY__` / localStorage `vio.country`; falls
 * back to NO.
 */
export function getGlobalCountryCode(): string {
  const g = globalThis as { __VIO_COUNTRY__?: string }
  if (g.__VIO_COUNTRY__) return g.__VIO_COUNTRY__
  // Never throws: an in-app browser can refuse even to look (safe-storage.ts).
  const stored = storageGet('local', 'vio.country')
  if (stored) return stored
  return 'NO'
}

/**
 * Active display locale for the page (number formatting + payment sheets).
 * Host sets `globalThis.__VIO_LOCALE__` / localStorage `vio.locale`; falls
 * back to nb-NO.
 */
export function getGlobalLocale(): string {
  const g = globalThis as { __VIO_LOCALE__?: string }
  if (g.__VIO_LOCALE__) return g.__VIO_LOCALE__
  // Never throws: an in-app browser can refuse even to look (safe-storage.ts).
  const stored = storageGet('local', 'vio.locale')
  if (stored) return stored
  return 'nb-NO'
}

/**
 * Currency symbol for display. With no explicit currency, a host-set override
 * (`__VIO_SYMBOL__` / vio.symbol) wins; otherwise a small per-currency map.
 */
export function getGlobalSymbol(currency?: string): string {
  const activeCurrency = currency || getGlobalCurrency()
  const g = globalThis as { __VIO_SYMBOL__?: string }
  if (!currency && g.__VIO_SYMBOL__) return g.__VIO_SYMBOL__
  if (!currency) {
    const v = storageGet('local', 'vio.symbol')
    if (v) return v
  }
  const curr = String(activeCurrency).toUpperCase()
  if (curr === 'NOK' || curr === 'DKK') return 'Kr'
  if (curr === 'SEK') return 'SEK'
  if (curr === 'EUR') return '€'
  if (curr === 'USD' || curr === 'CAD') return '$'
  if (curr === 'GBP') return '£'
  if (curr === 'CHF') return 'CHF'
  return activeCurrency
}

/**
 * Active display currency for the page. The host (e.g. the Vev Config block)
 * sets `globalThis.__VIO_CURRENCY__` / localStorage `vio.currency`; falls back
 * to NOK.
 */
export function getGlobalCurrency(): string {
  const g = globalThis as { __VIO_CURRENCY__?: string }
  if (g.__VIO_CURRENCY__) return g.__VIO_CURRENCY__
  // Never throws: an in-app browser can refuse even to look (safe-storage.ts).
  const stored = storageGet('local', 'vio.currency')
  if (stored) return stored
  return 'NOK'
}

/** Cache of validated locales — hosts can feed anything into vio.locale. */
const validatedLocales = new Map<string, string>()

/** Return the locale if Intl accepts it, else nb-NO (a host-set `nb_NO` with
 * an underscore makes toLocaleString throw and blanks the whole render). */
function safeLocale(locale: string): string {
  const cached = validatedLocales.get(locale)
  if (cached) return cached
  let resolved = 'nb-NO'
  try {
    if (Intl.NumberFormat.supportedLocalesOf([locale]).length > 0) resolved = locale
  } catch {
    /* structurally invalid tag — keep the fallback */
  }
  validatedLocales.set(locale, resolved)
  return resolved
}

/** Format a numeric amount + currency using the page locale and symbol map. */
export function formatPrice(amount: number, currency?: string): string {
  const activeCurrency = currency || getGlobalCurrency()
  const activeLocale = safeLocale(getGlobalLocale())
  const activeSymbol = getGlobalSymbol(activeCurrency)
  const formatted = amount
    .toLocaleString(activeLocale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    // Normalize non-breaking space to regular space for predictable rendering.
    .replace(/ /g, ' ')
  return `${formatted} ${activeSymbol}`
}

/**
 * Helper: pick the first image URL (variant first, then product). Defensive:
 * accepts loose shapes (backend cart rows, catalog rows) where images may be
 * plain strings or live under image / imageUrl / image_url / primaryImage.
 */
export function primaryImageUrl(product: Product): string | undefined {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const p = product as any
  if (!p || typeof p !== 'object') return undefined
  if (Array.isArray(p.variants) && p.variants.length > 0) {
    const vImages = p.variants[0]?.images
    if (Array.isArray(vImages) && vImages.length > 0) {
      const vUrl = typeof vImages[0] === 'string' ? vImages[0] : vImages[0]?.url
      if (vUrl) return vUrl
    }
  }
  if (Array.isArray(p.images) && p.images.length > 0) {
    const img0 = p.images[0]
    const url = typeof img0 === 'string' ? img0 : img0?.url
    if (url) return url
  }
  if (typeof p.image === 'string' && p.image) return p.image
  if (p.image && typeof p.image === 'object' && p.image.url) return p.image.url
  if (typeof p.imageUrl === 'string' && p.imageUrl) return p.imageUrl
  if (typeof p.image_url === 'string' && p.image_url) return p.image_url
  if (typeof p.primaryImage === 'string' && p.primaryImage) return p.primaryImage
  if (p.primaryImage && typeof p.primaryImage === 'object' && p.primaryImage.url) {
    return p.primaryImage.url
  }
  return undefined
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
