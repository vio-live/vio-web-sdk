// GraphQL Queries and Mutations for VIO Cart & Checkout Services

export const CREATE_CART_MUTATION = `
mutation CreateCart($customerSessionId: String!, $currency: String!, $shippingCountry: String) {
  Cart {
    CreateCart(customer_session_id: $customerSessionId, currency: $currency, shipping_country: $shippingCountry) {
      cart_id
      customer_session_id
      shipping_country
      line_items {
        id
        supplier
        image {
          id
          url
          width
          height
        }
        sku
        barcode
        brand
        product_id
        title
        variant_id
        variant_title
        variant {
          option
          value
        }
        quantity
        price {
          amount
          currency_code
          discount
          compare_at
          compare_at_incl_taxes
          amount_incl_taxes
          tax_amount
          tax_rate
        }
        shipping {
          id
          name
          description
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
        available_shippings {
          id
          name
          description
          country_code
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
      }
      subtotal
      shipping
      currency
      available_shipping_countries
    }
  }
}
`;

export const ADD_ITEM_MUTATION = `
mutation AddItem($cartId: String!, $lineItems: [LineItemInput!]!) {
  Cart {
    AddItem(cart_id: $cartId, line_items: $lineItems) {
      cart_id
      customer_session_id
      shipping_country
      line_items {
        id
        supplier
        image {
          id
          url
          width
          height
        }
        sku
        barcode
        brand
        product_id
        title
        variant_id
        variant_title
        variant {
          option
          value
        }
        quantity
        price {
          amount
          currency_code
          discount
          compare_at
          compare_at_incl_taxes
          amount_incl_taxes
          tax_amount
          tax_rate
        }
        shipping {
          id
          name
          description
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
        available_shippings {
          id
          name
          description
          country_code
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
      }
      subtotal
      shipping
      currency
      available_shipping_countries
    }
  }
}
`;

export const DELETE_ITEM_MUTATION = `
mutation DeleteItem($cartId: String!, $cartItemId: String!) {
  Cart {
    DeleteItem(cart_id: $cartId, cart_item_id: $cartItemId) {
      cart_id
      customer_session_id
      shipping_country
      line_items {
        id
        supplier
        image {
          id
          url
          width
          height
        }
        sku
        barcode
        brand
        product_id
        title
        variant_id
        variant_title
        variant {
          option
          value
        }
        quantity
        price {
          amount
          currency_code
          discount
          compare_at
          compare_at_incl_taxes
          amount_incl_taxes
          tax_amount
          tax_rate
        }
        shipping {
          id
          name
          description
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
        available_shippings {
          id
          name
          description
          country_code
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
      }
      subtotal
      shipping
      currency
      available_shipping_countries
    }
  }
}
`;

export const UPDATE_ITEM_MUTATION = `
mutation UpdateItem($cartId: String!, $cartItemId: String!, $shippingId: String, $qty: Int) {
  Cart {
    UpdateItem(cart_id: $cartId, cart_item_id: $cartItemId, shipping_id: $shippingId, qty: $qty) {
      cart_id
      customer_session_id
      shipping_country
      line_items {
        id
        supplier
        image {
          id
          url
          width
          height
        }
        sku
        barcode
        brand
        product_id
        title
        variant_id
        variant_title
        variant {
          option
          value
        }
        quantity
        price {
          amount
          currency_code
          discount
          compare_at
          compare_at_incl_taxes
          amount_incl_taxes
          tax_amount
          tax_rate
        }
        shipping {
          id
          name
          description
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
        available_shippings {
          id
          name
          description
          country_code
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
      }
      subtotal
      shipping
      currency
      available_shipping_countries
    }
  }
}
`;

export const GET_CART_QUERY = `
query GetCart($cartId: String!) {
  Cart {
    GetCart(cart_id: $cartId) {
      cart_id
      customer_session_id
      shipping_country
      line_items {
        id
        supplier
        image {
          id
          url
          width
          height
        }
        sku
        barcode
        brand
        product_id
        title
        variant_id
        variant_title
        variant {
          option
          value
        }
        quantity
        price {
          amount
          currency_code
          discount
          compare_at
          compare_at_incl_taxes
          amount_incl_taxes
          tax_amount
          tax_rate
        }
        shipping {
          id
          name
          description
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
        available_shippings {
          id
          name
          description
          country_code
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
      }
      subtotal
      shipping
      currency
      available_shipping_countries
    }
  }
}
`;

export const GET_LINE_ITEMS_BY_SUPPLIER_QUERY = `
query GetLineItemsBySupplier($cartId: String!) {
  Cart {
    GetLineItemsBySupplier(cart_id: $cartId) {
      supplier {
        id
        name
      }
      available_shippings {
        id
        name
        description
        country_code
        price {
          amount
          currency_code
          amount_incl_taxes
          tax_amount
          tax_rate
        }
      }
      line_items {
        id
        supplier
        image {
          id
          url
          width
          height
        }
        sku
        barcode
        brand
        product_id
        title
        variant_id
        variant_title
        variant {
          option
          value
        }
        quantity
        price {
          amount
          currency_code
          discount
          compare_at
          compare_at_incl_taxes
          amount_incl_taxes
          tax_amount
          tax_rate
        }
        shipping {
          id
          name
          description
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
      }
    }
  }
}
`;

export const UPDATE_SHIPPINGS_BY_SUPPLIER_MUTATION = `
mutation UpdateShippingsBySupplier($cartId: String!, $data: [DataUpdateShippingsBySupplier!]!) {
  Cart {
    UpdateShippingsBySupplier(cart_id: $cartId, data: $data) {
      cart_id
      customer_session_id
      shipping_country
      line_items {
        id
        supplier
        image {
          id
          url
          width
          height
        }
        sku
        barcode
        brand
        product_id
        title
        variant_id
        variant_title
        variant {
          option
          value
        }
        quantity
        price {
          amount
          currency_code
          discount
          compare_at
          compare_at_incl_taxes
          amount_incl_taxes
          tax_amount
          tax_rate
        }
        shipping {
          id
          name
          description
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
        available_shippings {
          id
          name
          description
          country_code
          price {
            amount
            currency_code
            amount_incl_taxes
            tax_amount
            tax_rate
          }
        }
      }
      subtotal
      shipping
      currency
      available_shipping_countries
    }
  }
}
`;

export const CREATE_CHECKOUT_MUTATION = `
mutation CreateCheckout($cartId: String!) {
  Checkout {
    CreateCheckout(cart_id: $cartId) {
      buyer_accepts_purchase_conditions
      buyer_accepts_terms_conditions
      created_at
      updated_at
      id
      deleted_at
      success_url
      cancel_url
      payment_method
      email
      status
      checkout_url
      origin_payment_id
      billing_address {
        id
        first_name
        last_name
        phone_code
        phone
        company
        address1
        address2
        city
        province
        province_code
        country
        country_code
        zip
      }
      shipping_address {
        id
        first_name
        last_name
        phone_code
        phone
        company
        address1
        address2
        city
        province
        province_code
        country
        country_code
        zip
      }
      available_payment_methods {
        name
      }
      discount_code
      cart {
        cart_id
        customer_session_id
        shipping_country
        line_items {
          id
          supplier
          image {
            id
            url
            width
            height
          }
          sku
          barcode
          brand
          product_id
          title
          variant_id
          variant_title
          variant {
            option
            value
          }
          quantity
          price {
            amount
            currency_code
            discount
            compare_at
            compare_at_incl_taxes
            amount_incl_taxes
            tax_amount
            tax_rate
          }
          shipping {
            id
            name
            description
            price {
              amount
              currency_code
              amount_incl_taxes
              tax_amount
              tax_rate
            }
          }
          available_shippings {
            id
            name
            description
            country_code
            price {
              amount
              currency_code
              amount_incl_taxes
              tax_amount
              tax_rate
            }
          }
        }
        subtotal
        shipping
        currency
        available_shipping_countries
      }
      totals {
        currency_code
        subtotal
        shipping
        total
        taxes
        tax_rate
        discounts
      }
    }
  }
}
`;

export const UPDATE_CHECKOUT_MUTATION = `
mutation UpdateCheckout($checkoutId: String!, $status: String, $successUrl: String, $email: String, $cancelUrl: String, $paymentMethod: String, $shippingAddress: AddressArgs, $billingAddress: AddressArgs, $buyerAcceptsPurchaseConditions: Boolean, $buyerAcceptsTermsConditions: Boolean) {
  Checkout {
    UpdateCheckout(checkout_id: $checkoutId, status: $status, success_url: $successUrl, email: $email, cancel_url: $cancelUrl, payment_method: $paymentMethod, shipping_address: $shippingAddress, billing_address: $billingAddress, buyer_accepts_purchase_conditions: $buyerAcceptsPurchaseConditions, buyer_accepts_terms_conditions: $buyerAcceptsTermsConditions) {
      buyer_accepts_purchase_conditions
      buyer_accepts_terms_conditions
      created_at
      updated_at
      id
      deleted_at
      success_url
      cancel_url
      payment_method
      email
      status
      checkout_url
      origin_payment_id
      billing_address {
        id
        first_name
        last_name
        phone_code
        phone
        company
        address1
        address2
        city
        province
        province_code
        country
        country_code
        zip
      }
      shipping_address {
        id
        first_name
        last_name
        phone_code
        phone
        company
        address1
        address2
        city
        province
        province_code
        country
        country_code
        zip
      }
      available_payment_methods {
        name
      }
      discount_code
      cart {
        cart_id
        customer_session_id
        shipping_country
        line_items {
          id
          supplier
          image {
            id
            url
            width
            height
          }
          sku
          barcode
          brand
          product_id
          title
          variant_id
          variant_title
          variant {
            option
            value
          }
          quantity
          price {
            amount
            currency_code
            discount
            compare_at
            compare_at_incl_taxes
            amount_incl_taxes
            tax_amount
            tax_rate
          }
          shipping {
            id
            name
            description
            price {
              amount
              currency_code
              amount_incl_taxes
              tax_amount
              tax_rate
            }
          }
          available_shippings {
            id
            name
            description
            country_code
            price {
              amount
              currency_code
              amount_incl_taxes
              tax_amount
              tax_rate
            }
          }
        }
        subtotal
        shipping
        currency
        available_shipping_countries
      }
      totals {
        currency_code
        subtotal
        shipping
        total
        taxes
        tax_rate
        discounts
      }
    }
  }
}
`;

export const GET_CHECKOUT_QUERY = `
query GetCheckout($checkoutId: String!) {
  Checkout {
    GetCheckout(checkout_id: $checkoutId) {
      buyer_accepts_purchase_conditions
      buyer_accepts_terms_conditions
      created_at
      updated_at
      id
      deleted_at
      success_url
      cancel_url
      payment_method
      email
      status
      checkout_url
      origin_payment_id
      billing_address {
        id
        first_name
        last_name
        phone_code
        phone
        company
        address1
        address2
        city
        province
        province_code
        country
        country_code
        zip
      }
      shipping_address {
        id
        first_name
        last_name
        phone_code
        phone
        company
        address1
        address2
        city
        province
        province_code
        country
        country_code
        zip
      }
      available_payment_methods {
        name
      }
      discount_code
      cart {
        cart_id
        customer_session_id
        shipping_country
        line_items {
          id
          supplier
          image {
            id
            url
            width
            height
          }
          sku
          barcode
          brand
          product_id
          title
          variant_id
          variant_title
          variant {
            option
            value
          }
          quantity
          price {
            amount
            currency_code
            discount
            compare_at
            compare_at_incl_taxes
            amount_incl_taxes
            tax_amount
            tax_rate
          }
          shipping {
            id
            name
            description
            price {
              amount
              currency_code
              amount_incl_taxes
              tax_amount
              tax_rate
            }
          }
          available_shippings {
            id
            name
            description
            country_code
            price {
              amount
              currency_code
              amount_incl_taxes
              tax_amount
              tax_rate
            }
          }
        }
        subtotal
        shipping
        currency
        available_shipping_countries
      }
      totals {
        currency_code
        subtotal
        shipping
        total
        taxes
        tax_rate
        discounts
      }
    }
  }
}
`;

export const GET_AVAILABLE_PAYMENT_METHODS_QUERY = `
query Config {
  Payment {
    GetAvailablePaymentMethods {
      config {
        name
        type
        value
      }
      name
    }
  }
}
`;


/**
 * Server-side cart / checkout GraphQL client (Vio Commerce).
 *
 * Ported from the hand-edited Vev bundle (Alan, 2026-07-28/29) into the SDK
 * source so the vendored bundle stays a pure esbuild artifact.
 */

import { Configuration } from '../configuration.js'

/** Transport options for a cart/checkout GraphQL call. */
export interface CartQueryOptions {
  endpoint?: string
  apiKey?: string
  /** Sponsor commerce key — goes in the Authorization header. */
  commerceKey?: string
}

/**
 * Resolve endpoint + keys for cart GraphQL calls. Uses the sponsor's commerce
 * apiKey (via the Vio facade on globalThis, avoiding an import cycle) when a
 * sponsorId is given; falls back to the host apiKey.
 */
export function getCartGraphQLOptions(sponsorId?: number): CartQueryOptions {
  const cfg = Configuration.isInitialized
    ? Configuration.get()
    : { apiKey: undefined, graphQLBase: 'https://graph-ql-dev.vio.live' }
  const anyCfg = cfg as { apiKey?: string; graphQLBase?: string }
  let commerceKey = anyCfg.apiKey
  const facade = (
    globalThis as { __VIO_FACADE__?: { findSponsor?: (id: number) => unknown } }
  ).__VIO_FACADE__
  if (sponsorId && typeof facade?.findSponsor === 'function') {
    const sponsor = facade.findSponsor(sponsorId) as
      | { commerce?: { apiKey?: string } }
      | undefined
    if (sponsor?.commerce?.apiKey) commerceKey = sponsor.commerce.apiKey
  }
  return {
    endpoint: anyCfg.graphQLBase || 'https://graph-ql-dev.vio.live',
    apiKey: anyCfg.apiKey,
    commerceKey,
  }
}

const CUSTOMER_SESSION_KEY = 'vio.customer_session_id.v1'

/** Stable per-browser customer session id (backend CreateCart requires one). */
export function getCustomerSessionId(): string {
  if (typeof localStorage === 'undefined') return 'cs_session_default'
  let id = localStorage.getItem(CUSTOMER_SESSION_KEY)
  if (!id) {
    id = 'cs_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36)
    localStorage.setItem(CUSTOMER_SESSION_KEY, id)
  }
  return id
}

interface GraphQLEnvelope {
  data?: Record<string, Record<string, unknown>>
  errors?: Array<{ message?: string }>
}

/** Execute a GraphQL query/mutation against the configured commerce endpoint. */
export async function executeCartGraphQL(
  query: string,
  variables: Record<string, unknown>,
  options: CartQueryOptions = {},
): Promise<GraphQLEnvelope> {
  const { endpoint = 'https://graph-ql-dev.vio.live', apiKey, commerceKey } = options

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-API-Key'] = apiKey
  if (commerceKey || apiKey) headers['Authorization'] = (commerceKey || apiKey) as string

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })

  const json = (await res.json().catch(() => ({}))) as GraphQLEnvelope
  if (!res.ok || json.errors) {
    const errMsg = json.errors?.[0]?.message || `GraphQL request failed (HTTP ${res.status})`
    throw new Error(errMsg)
  }
  return json
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function createCart(
  customerSessionId: string,
  currency: string,
  shippingCountry?: string | null,
  options?: CartQueryOptions,
): Promise<any> {
  const json = await executeCartGraphQL(
    CREATE_CART_MUTATION,
    { customerSessionId, currency, shippingCountry: shippingCountry || null },
    options,
  )
  return json?.data?.Cart?.CreateCart
}

export async function addItem(
  cartId: string,
  lineItems: unknown[],
  options?: CartQueryOptions,
): Promise<any> {
  const json = await executeCartGraphQL(ADD_ITEM_MUTATION, { cartId, lineItems }, options)
  return json?.data?.Cart?.AddItem
}

export async function deleteItem(
  cartId: string,
  cartItemId: string,
  options?: CartQueryOptions,
): Promise<any> {
  const json = await executeCartGraphQL(DELETE_ITEM_MUTATION, { cartId, cartItemId }, options)
  return json?.data?.Cart?.DeleteItem
}

export async function updateItem(
  cartId: string,
  cartItemId: string,
  shippingId?: string | null,
  qty?: number | null,
  options?: CartQueryOptions,
): Promise<any> {
  const json = await executeCartGraphQL(
    UPDATE_ITEM_MUTATION,
    { cartId, cartItemId, shippingId: shippingId || null, qty: qty != null ? qty : null },
    options,
  )
  return json?.data?.Cart?.UpdateItem
}

export async function getCart(cartId: string, options?: CartQueryOptions): Promise<any> {
  const json = await executeCartGraphQL(GET_CART_QUERY, { cartId }, options)
  return json?.data?.Cart?.GetCart
}

export async function getLineItemsBySupplier(
  cartId: string,
  options?: CartQueryOptions,
): Promise<any> {
  const json = await executeCartGraphQL(GET_LINE_ITEMS_BY_SUPPLIER_QUERY, { cartId }, options)
  return json?.data?.Cart?.GetLineItemsBySupplier
}

export async function updateShippingsBySupplier(
  cartId: string,
  data: unknown[],
  options?: CartQueryOptions,
): Promise<any> {
  const json = await executeCartGraphQL(
    UPDATE_SHIPPINGS_BY_SUPPLIER_MUTATION,
    { cartId, data },
    options,
  )
  return json?.data?.Cart?.UpdateShippingsBySupplier
}

export async function createCheckout(cartId: string, options?: CartQueryOptions): Promise<any> {
  const json = await executeCartGraphQL(CREATE_CHECKOUT_MUTATION, { cartId }, options)
  return json?.data?.Checkout?.CreateCheckout
}

export async function updateCheckout(
  variables: Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<any> {
  const json = await executeCartGraphQL(UPDATE_CHECKOUT_MUTATION, variables, options)
  return json?.data?.Checkout?.UpdateCheckout
}

export async function getCheckout(checkoutId: string, options?: CartQueryOptions): Promise<any> {
  const json = await executeCartGraphQL(GET_CHECKOUT_QUERY, { checkoutId }, options)
  return json?.data?.Checkout?.GetCheckout
}

export async function getAvailablePaymentMethods(options?: CartQueryOptions): Promise<any> {
  const json = await executeCartGraphQL(GET_AVAILABLE_PAYMENT_METHODS_QUERY, {}, options)
  return json?.data?.Payment?.GetAvailablePaymentMethods
}
