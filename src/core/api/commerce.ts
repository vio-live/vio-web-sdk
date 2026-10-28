/**
 * Commerce GraphQL client — talks to Vio Commerce.
 *
 * Mirrors the iOS SDK's `SdkClient.channel.product` surface, but uses
 * `graphql-request` (lightweight) instead of Apollo. Auth header: `Authorization: <apiKey>`
 * (per-sponsor commerce apiKey, NOT the top-level Vio apiKey).
 *
 * Usage:
 *   const commerce = createCommerceClient({
 *     endpoint: 'https://graph-ql-dev.vio.live',
 *     apiKey: '<sponsor-commerce-apiKey>',  // sponsor's commerce apiKey
 *   })
 *   const products = await commerce.channel.product.getByIds({
 *     product_ids: [408895, 408896],
 *     currency: 'NOK',
 *     image_size: 'large',
 *   })
 */

import { GraphQLClient } from 'graphql-request'
import { getGlobalCountryCode, getGlobalCurrency, type ImageSize, type Product } from '../types.js'

export interface CommerceClientOptions {
  /** Vio Commerce GraphQL endpoint, e.g. `https://graph-ql-dev.vio.live`. */
  endpoint: string
  /** Per-sponsor commerce apiKey (from bootstrap.primarySponsor.commerce.apiKey). */
  apiKey: string
}

const GET_PRODUCTS_BY_IDS = /* GraphQL */ `
  query GetProductsByIds(
    $currency: String
    $imageSize: ImageSize
    $productIds: [Int!]
    $useCache: Boolean!
    $shippingCountryCode: String
  ) {
    Channel {
      GetProductsByIds(
        currency: $currency
        image_size: $imageSize
        product_ids: $productIds
        useCache: $useCache
        shipping_country_code: $shippingCountryCode
      ) {
        id
        brand
        title
        description
        tags
        sku
        quantity
        price {
          amount
          currency_code
          compare_at
          amount_incl_taxes
          compare_at_incl_taxes
          tax_amount
          tax_rate
        }
        variants {
          id
          barcode
          quantity
          sku
          title
          price {
            amount
            currency_code
            compare_at
            amount_incl_taxes
            compare_at_incl_taxes
            tax_amount
            tax_rate
          }
          images {
            id
            url
            width
            height
            order
          }
        }
        barcode
        options {
          id
          name
          order
          values
        }
        categories {
          id
          name
        }
        images {
          id
          url
          width
          height
          order
        }
      }
    }
  }
`

/**
 * Only the seller's Company name of a product (Settings → Company), for the
 * header of the product detail. Apart from GET_PRODUCTS_BY_IDS on purpose:
 * `supplier_company` is new (2026-10-08), and an API without it fails the
 * whole query — here that costs the header its name, there it would cost
 * the product.
 */
const GET_PRODUCT_SELLER = /* GraphQL */ `
  query GetProductSeller($productIds: [Int!], $useCache: Boolean!) {
    Channel {
      GetProductsByIds(product_ids: $productIds, useCache: $useCache) {
        id
        supplier_company
      }
    }
  }
`

/**
 * A product's shipping rates (`product_shipping`) for the page's market — the
 * same rates the backend cart offers for its line. Apart from
 * GET_PRODUCTS_BY_IDS like the seller: a failure here costs the detail its
 * «Frakt fra» line, never the product.
 */
export const GET_PRODUCT_SHIPPING = /* GraphQL */ `
  query GetProductShipping(
    $productIds: [Int!]
    $useCache: Boolean!
    $currency: String
    $shippingCountryCode: String
  ) {
    Channel {
      GetProductsByIds(
        product_ids: $productIds
        useCache: $useCache
        currency: $currency
        shipping_country_code: $shippingCountryCode
      ) {
        id
        product_shipping {
          id
          name
          description
          default
          shipping_country {
            country
            price {
              amount
              amount_incl_taxes
              currency_code
            }
          }
        }
      }
    }
  }
`

/** The same, with the carrier logo of each rate (a gateway without `logo_url` refuses it: see getShippingRates). */
export const GET_PRODUCT_SHIPPING_WITH_LOGO = /* GraphQL */ `
  query GetProductShippingWithLogo(
    $productIds: [Int!]
    $useCache: Boolean!
    $currency: String
    $shippingCountryCode: String
  ) {
    Channel {
      GetProductsByIds(
        product_ids: $productIds
        useCache: $useCache
        currency: $currency
        shipping_country_code: $shippingCountryCode
      ) {
        id
        product_shipping {
          id
          name
          description
          logo_url
          default
          shipping_country {
            country
            price {
              amount
              amount_incl_taxes
              currency_code
            }
          }
        }
      }
    }
  }
`

/** One shipping rate of a product for a country, tax included. */
export interface ProductShippingRate {
  id: string
  name: string
  /** Major units, tax included when the backend says it. */
  price: number
  currency: string
  default: boolean
  /** What the brand wrote for the rate — in practice its delivery time («Leveringstid 1-5 dager»); '' when none. */
  description: string
  /** The carrier's logo for the rate (https), '' when none. */
  logoUrl: string
}

/**
 * Whether the gateway knows `ProductShipping.logo_url` (2026-10-28): unknown
 * until the first answer, `false` after a gateway refused the field — then
 * the rates are asked without it for the rest of the page, so an SDK newer
 * than its gateway never loses the rates over a logo.
 */
let gatewayHasShippingLogo: boolean | undefined
/** Tests only. */
export function resetShippingLogoSupport(): void {
  gatewayHasShippingLogo = undefined
}

export interface GetProductsByIdsOptions {
  product_ids: number[]
  currency?: string | null
  image_size?: ImageSize | null
  useCache?: boolean
  shipping_country_code?: string | null
}

class ChannelProduct {
  constructor(private readonly client: GraphQLClient) {}

  /**
   * Fetch a batch of products by their numeric ids.
   * Returns an empty array if no ids are provided.
   */
  async getByIds(options: GetProductsByIdsOptions): Promise<Product[]> {
    if (!options.product_ids || options.product_ids.length === 0) return []

    const variables = {
      productIds: options.product_ids,
      // Page-level currency/country defaults (multi-market support).
      currency: options.currency ?? getGlobalCurrency(),
      imageSize: options.image_size ?? 'large',
      useCache: options.useCache ?? true,
      shippingCountryCode: options.shipping_country_code ?? getGlobalCountryCode(),
    }

    const data = await this.client.request<{
      Channel: { GetProductsByIds: Product[] }
    }>(GET_PRODUCTS_BY_IDS, variables)

    return data.Channel?.GetProductsByIds ?? []
  }

  /**
   * The seller's Company name for one product, or null (none set, or an API
   * that does not have the field yet). Never throws.
   *
   * Never from the cache, on purpose: graphql caches product answers by
   * path whatever fields the query asked, so this narrow query, written to
   * the cache, would hand the next full product query a product with no
   * price and no images. `useCache: false` neither reads nor writes it.
   */
  async getSellerCompany(productId: number): Promise<string | null> {
    try {
      const data = await this.client.request<{
        Channel: { GetProductsByIds: Array<{ id: number; supplier_company?: string | null }> }
      }>(GET_PRODUCT_SELLER, { productIds: [productId], useCache: false })
      const name = String(data.Channel?.GetProductsByIds?.[0]?.supplier_company ?? '').trim()
      return name || null
    } catch {
      return null
    }
  }

  /**
   * The product's shipping rates for the page's market (or `country`),
   * cheapest first; `[]` when it has none there, `null` when they could not
   * be read. Never throws. Never from the cache, for the reason given at
   * getSellerCompany.
   */
  async getShippingRates(
    productId: number,
    options: { currency?: string | null; country?: string | null } = {},
  ): Promise<ProductShippingRate[] | null> {
    const country = options.country || getGlobalCountryCode()
    const variables = {
      productIds: [productId],
      useCache: false,
      currency: options.currency ?? getGlobalCurrency(),
      shippingCountryCode: country,
    }
    type Answer = { Channel: { GetProductsByIds: Array<{ id: number; product_shipping?: unknown }> } }
    try {
      let data: Answer
      if (gatewayHasShippingLogo === false) {
        data = await this.client.request<Answer>(GET_PRODUCT_SHIPPING, variables)
      } else {
        try {
          data = await this.client.request<Answer>(GET_PRODUCT_SHIPPING_WITH_LOGO, variables)
          gatewayHasShippingLogo = true
        } catch (err) {
          if (!/logo_url/.test(String((err as Error)?.message ?? ''))) throw err
          gatewayHasShippingLogo = false
          data = await this.client.request<Answer>(GET_PRODUCT_SHIPPING, variables)
        }
      }
      const product = data.Channel?.GetProductsByIds?.[0]
      if (!product) return null
      return shippingRatesFor(product.product_shipping, country)
    } catch {
      return null
    }
  }
}

/**
 * Descriptions Commerce writes on a rate by itself, which say nothing about
 * delivery: products' `shipping.service.ts` defaults ('By Outshifter', QA's
 * 'Default Shipping Method'). Compared trimmed, case-insensitively.
 */
export const FILLER_SHIPPING_DESCRIPTIONS: readonly string[] = Object.freeze(['by outshifter', 'default shipping method'])

/**
 * A rate's description as a shopper should read it — in practice its
 * delivery time — trimmed; '' when there is none or it is filler: one of
 * `FILLER_SHIPPING_DESCRIPTIONS`, or a repeat of any of `repeats` (the rate's
 * own name — dashboard-created rates copied it —, the product's title or the
 * seller's name — products writes those on imports). Case-insensitive.
 */
export function shippingDescriptionOf(value: unknown, repeats: ReadonlyArray<unknown> = []): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  const key = text.toLowerCase()
  if (FILLER_SHIPPING_DESCRIPTIONS.includes(key)) return ''
  for (const r of repeats) {
    if (typeof r === 'string' && r.trim() && r.trim().toLowerCase() === key) return ''
  }
  return text
}

/**
 * The rates of a product for one country, cheapest first: `null` when they
 * could not be read (unknown), `[]` when the product has none there.
 */
export function shippingRatesFor(
  productShipping: unknown,
  country: string,
): ProductShippingRate[] {
  if (!Array.isArray(productShipping)) return []
  const want = String(country || '').trim().toUpperCase()
  const out: ProductShippingRate[] = []
  for (const s of productShipping as Array<Record<string, any>>) {
    const countries = Array.isArray(s?.shipping_country) ? s.shipping_country : []
    const row = countries.find((c: { country?: string }) => String(c?.country ?? '').trim().toUpperCase() === want)
    const price = row?.price
    const amount = typeof price?.amount_incl_taxes === 'number' ? price.amount_incl_taxes : price?.amount
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) continue
    const name = String(s.name ?? '')
    const description = shippingDescriptionOf(s.description, [name])
    out.push({
      id: String(s.id ?? ''),
      name,
      price: amount,
      currency: String(price?.currency_code ?? ''),
      default: s.default === true,
      description,
      logoUrl: httpsUrlOrEmpty(s.logo_url ?? s.logoUrl),
    })
  }
  return out.sort((a, b) => a.price - b.price)
}

class Channel {
  readonly product: ChannelProduct

  constructor(client: GraphQLClient) {
    this.product = new ChannelProduct(client)
  }
}

/** CommerceClient — namespaced facade, mirrors the iOS SdkClient. */
export class CommerceClient {
  readonly channel: Channel
  /** Underlying graphql-request client (escape hatch for custom queries). */
  readonly raw: GraphQLClient

  constructor(options: CommerceClientOptions) {
    if (!options.endpoint) throw new Error('[VioCommerce] endpoint is required')
    if (!options.apiKey) throw new Error('[VioCommerce] apiKey is required')

    this.raw = new GraphQLClient(options.endpoint, {
      headers: { Authorization: options.apiKey },
    })
    this.channel = new Channel(this.raw)
  }
}

export function createCommerceClient(options: CommerceClientOptions): CommerceClient {
  return new CommerceClient(options)
}

/** An https URL as given, or '' (http, javascript: and anything else are dropped). */
function httpsUrlOrEmpty(value: unknown): string {
  if (typeof value !== 'string') return ''
  const url = value.trim()
  return /^https:\/\/[^\s]+$/i.test(url) ? url : ''
}
