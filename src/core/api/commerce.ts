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
