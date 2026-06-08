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
import type { ImageSize, Product } from '../types.js'

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
      currency: options.currency ?? null,
      imageSize: options.image_size ?? 'large',
      useCache: options.useCache ?? true,
      shippingCountryCode: options.shipping_country_code ?? null,
    }

    const data = await this.client.request<{
      Channel: { GetProductsByIds: Product[] }
    }>(GET_PRODUCTS_BY_IDS, variables)

    return data.Channel?.GetProductsByIds ?? []
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
