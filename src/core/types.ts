/**
 * Vio types — Product / Sponsor / Bootstrap shapes.
 *
 * Product types mirror the Vio Commerce GraphQL schema.
 * Sponsor / Bootstrap shapes mirror the iOS SDK's bootstrap response so
 * we stay aligned cross-platform.
 */

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

export interface Sponsor {
  id: number
  name: string
  description?: string | null
  avatarUrl?: string | null
  logoUrl?: string | null
  primaryColor?: string | null
  secondaryColor?: string | null
  commerce: SponsorCommerceBlock
}

/**
 * Response shape of `GET /v2/mobile/config` (and likely future `/v2/web/config`).
 * Matches the iOS SDK's `SdkBootstrapResponse` model.
 */
export interface BootstrapResponse {
  campaignId?: number
  primarySponsor?: Sponsor
  secondarySponsors?: Sponsor[]
  market?: {
    countryCode: string
    currencyCode: string
  }
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
 * Active display currency for the page. The host (e.g. the Vev Config block)
 * sets `globalThis.__VIO_CURRENCY__` / localStorage `vio.currency`; falls back
 * to NOK.
 */
export function getGlobalCurrency(): string {
  const g = globalThis as { __VIO_CURRENCY__?: string }
  if (g.__VIO_CURRENCY__) return g.__VIO_CURRENCY__
  if (typeof localStorage !== 'undefined') {
    try {
      const v = localStorage.getItem('vio.currency')
      if (v) return v
    } catch {
      /* privacy mode */
    }
  }
  return 'NOK'
}

/** Format a numeric amount + currency for Norwegian style: "1 299 kr". */
export function formatPrice(amount: number, currency?: string): string {
  const activeCurrency = currency || getGlobalCurrency()
  // Use Norwegian locale grouping (space as thousands separator).
  const formatted = amount
    .toLocaleString('no-NO', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    // Normalize non-breaking space to regular space for predictable rendering.
    .replace(/ /g, ' ')
  // Some currency codes display nicer lowercase: NOK → kr.
  const symbol = activeCurrency === 'NOK' ? 'kr' : activeCurrency
  return `${formatted} ${symbol}`
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
