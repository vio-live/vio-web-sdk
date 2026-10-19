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
      duplicate_of
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
import { normalizeBuyerRef } from '../buyer-ref.js'
import { getGlobalCountryCode, getGlobalCurrency } from '../types.js'

/** Transport options for a cart/checkout GraphQL call. */
export interface CartQueryOptions {
  endpoint?: string
  apiKey?: string
  /** Sponsor commerce key — goes in the Authorization header. */
  commerceKey?: string
  /** True when the commerce key came from a resolved sponsor (bootstrap).
   * False = we fell back to the host apiKey — writes like CreateCart should
   * NOT proceed with the wrong key (the cart would be orphaned). */
  sponsorResolved?: boolean
}

/**
 * Resolve endpoint + keys for cart GraphQL calls. Awaits Vio.bootstrap() once
 * if it hasn't run yet (the sponsor commerce keys come from bootstrap), then
 * uses the sponsor's commerce apiKey (via the Vio facade on globalThis,
 * avoiding an import cycle); falls back to the host apiKey.
 */
export async function getCartGraphQLOptions(sponsorId?: number): Promise<CartQueryOptions> {
  const facade = (
    globalThis as {
      __VIO_FACADE__?: {
        findSponsor?: (id: number) => unknown
        bootstrap?: () => Promise<unknown>
        bootstrapCache?: unknown
      }
    }
  ).__VIO_FACADE__
  // Hosts that mount several independent components (Vev blocks mount in no
  // guaranteed order) may have one query the commerce API before another has
  // called Vio.init(). Wait for initialization FIRST: bootstrap needs the
  // apiKey, so attempting it before init throws "Not initialized", and it used
  // to be attempted here and never retried. The sponsor then stayed unknown,
  // `commerceKey` fell back to the platform apiKey, and every commerce call
  // answered "Authentication failed" — a wrong key, not a missing one, which
  // is why it read as a credentials problem instead of a load-order one.
  if (!Configuration.isInitialized) {
    await Configuration.whenReady()
  }

  // Only now can bootstrap succeed. Without it there is no sponsor, and
  // without a sponsor there is no commerce key.
  if (
    Configuration.isInitialized &&
    facade &&
    typeof facade.bootstrap === 'function' &&
    !facade.bootstrapCache
  ) {
    try {
      await facade.bootstrap()
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[Vio] getCartGraphQLOptions bootstrap failed:', err)
      }
    }
  }

  const cfg = Configuration.isInitialized
    ? Configuration.get()
    : { apiKey: undefined, graphQLBase: 'https://graph-ql-dev.vio.live' }
  const anyCfg = cfg as { apiKey?: string; graphQLBase?: string }
  let commerceKey = anyCfg.apiKey
  let sponsorResolved = false
  if (sponsorId && typeof facade?.findSponsor === 'function') {
    const sponsor = facade.findSponsor(sponsorId) as
      | { commerce?: { apiKey?: string } }
      | undefined
    if (sponsor?.commerce?.apiKey) {
      commerceKey = sponsor.commerce.apiKey
      sponsorResolved = true
    }
  }
  if (sponsorId && !sponsorResolved && typeof console !== 'undefined') {
    // Say it plainly: the call is about to go out with the platform key, which
    // commerce rejects. Silence here is what made this look like bad
    // credentials for a whole day.
    console.warn(
      `[Vio] no commerce key for sponsor ${sponsorId} — falling back to the ` +
        'platform apiKey, which the commerce API will reject. Is the sponsor ' +
        'configured, and did Vio.init run before this call?',
    )
  }
  return {
    endpoint: anyCfg.graphQLBase || 'https://graph-ql-dev.vio.live',
    apiKey: anyCfg.apiKey,
    commerceKey,
    sponsorResolved,
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

/** Upper bound for one commerce GraphQL round trip. A request that never
 * answers would otherwise pin a line's quantity sync — and anything awaiting
 * `waitForCartMutations`, i.e. the checkout — forever; past this it rejects
 * like any other failure and the caller reconciles from the server. */
export const CART_GRAPHQL_TIMEOUT_MS = 15_000

/** Execute a GraphQL query/mutation against the configured commerce endpoint.
 * Callers that skip `getCartGraphQLOptions()` (or pass a bare sponsorId) get
 * it resolved here instead of silently sending an unauthenticated request.
 * Rejects after `CART_GRAPHQL_TIMEOUT_MS` (and aborts the fetch). */
export async function executeCartGraphQL(
  query: string,
  variables: Record<string, unknown>,
  options: CartQueryOptions | number | undefined = {},
): Promise<GraphQLEnvelope> {
  const resolvedOptions: CartQueryOptions =
    typeof options === 'number'
      ? await getCartGraphQLOptions(options)
      : !options.apiKey && !options.commerceKey
        ? { ...(await getCartGraphQLOptions()), ...options }
        : options
  const { endpoint = 'https://graph-ql-dev.vio.live', apiKey, commerceKey } = resolvedOptions

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-API-Key'] = apiKey
  if (commerceKey || apiKey) headers['Authorization'] = (commerceKey || apiKey) as string

  // Own timer + AbortController rather than AbortSignal.timeout: the race also
  // covers a fetch that ignores the signal (polyfills, mocks), and the timer
  // is an ordinary setTimeout, so it can be tested with fake timers.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort()
      reject(new Error(`GraphQL request timed out after ${CART_GRAPHQL_TIMEOUT_MS}ms`))
    }, CART_GRAPHQL_TIMEOUT_MS)
  })
  try {
    const res = await Promise.race([
      fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: controller?.signal,
      }),
      timedOut,
    ])
    const json = (await Promise.race([res.json().catch(() => ({})), timedOut])) as GraphQLEnvelope
    if (!res.ok || json.errors) {
      const errMsg = json.errors?.[0]?.message || `GraphQL request failed (HTTP ${res.status})`
      // What the envelope says travels with the error — whether anything ran
      // (`data`) and the errors, never the data itself — so a caller can tell
      // a validation error (the gateway refused the selection, nothing ran)
      // from a failure of something that did run; see `isUnknownFieldError`.
      throw Object.assign(new Error(errMsg), {
        graphql: { hasData: json.data !== undefined && json.data !== null, errors: json.errors ?? [] },
      })
    }
    return json
  } finally {
    clearTimeout(timer)
  }
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
    {
      customerSessionId,
      currency: currency || getGlobalCurrency(),
      shippingCountry: shippingCountry || getGlobalCountryCode(),
    },
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

// ── buyer_ref: a selection the gateway may not know yet ─────────────────────

/**
 * shopcart's buyer reference (`buyer_ref`, the keyed hash of the buyer's
 * email — analytics `buyer_id`, see core/buyer-ref.ts) is new on the gateway
 * (2026-10-19) and selected on three answers: the order number query, the
 * Apple Pay confirmation and the Klarna native confirmation. A gateway that
 * does not have the field yet refuses the WHOLE operation at validation —
 * before anything runs — so each of them is sent again without the field,
 * once, and the answer remembered for the page load. A confirmation that
 * DID run and failed is never repeated: that would charge twice.
 */
export const BUYER_REF_FIELD = 'buyer_ref'

let gatewayKnowsBuyerRef = true

/** Whether this page load still expects the gateway to know `buyer_ref` (false once it refused the selection). */
export function gatewayHasBuyerRef(): boolean {
  return gatewayKnowsBuyerRef
}

/** Forget what this page load learned about `buyer_ref` (tests). */
export function resetBuyerRefSupport(): void {
  gatewayKnowsBuyerRef = true
}

/** What `executeCartGraphQL` attaches to the error it throws. */
export interface GraphQLErrorInfo {
  hasData: boolean
  errors: Array<{ message?: string }>
}

/**
 * True when `err` is the gateway refusing a selection it does not know
 * (`Cannot query field "buyer_ref" on type …`): a validation error, with no
 * `data` because nothing ran — safe to send again without the field, a
 * mutation included. Anything that ran (data present) or any other message
 * is not.
 */
export function isUnknownFieldError(err: unknown, field: string): boolean {
  if (!err || typeof err !== 'object') return false
  const { message, graphql } = err as { message?: unknown; graphql?: Partial<GraphQLErrorInfo> }
  if (graphql?.hasData) return false
  const messages = [message, ...(graphql?.errors ?? []).map((e) => e?.message)]
  return messages.some(
    (m) => typeof m === 'string' && m.includes(`"${field}"`) && /cannot query field|unknown field/i.test(m),
  )
}

/**
 * Runs `request(true)` (the selection with `buyer_ref`); when the gateway does
 * not know the field, `request(false)` (without it) — and from then on, for
 * this page load, straight to the latter.
 */
export async function withBuyerRef<T>(request: (withBuyerRef: boolean) => Promise<T>): Promise<T> {
  if (!gatewayKnowsBuyerRef) return request(false)
  try {
    return await request(true)
  } catch (err) {
    if (!isUnknownFieldError(err, BUYER_REF_FIELD)) throw err
    gatewayKnowsBuyerRef = false
    return request(false)
  }
}

/**
 * Only the Vio order number of a checkout (#4497) and its buyer reference.
 * Apart from GET_CHECKOUT_QUERY on purpose: `order_id` is new (2026-10-08),
 * `buyer_ref` newer (2026-10-19), and an API that does not have them yet
 * fails the WHOLE query — here that costs a line on the receipt, there it
 * would cost the payment check.
 */
const orderNumberQuery = (withRef: boolean) => `
query GetCheckoutOrderNumber($checkoutId: String!) {
  Checkout {
    GetCheckout(checkout_id: $checkoutId) {
      id
      order_id${withRef ? `\n      ${BUYER_REF_FIELD}` : ''}
    }
  }
}
`
export const GET_CHECKOUT_ORDER_NUMBER_QUERY = orderNumberQuery(true)
/** The same selection for a gateway that predates `buyer_ref`. */
export const GET_CHECKOUT_ORDER_NUMBER_QUERY_LEGACY = orderNumberQuery(false)

/** What a checkout says of itself after paying: its Vio order number, once the order exists, and its buyer reference. */
export interface CheckoutReference {
  orderNumber: number | null
  buyerRef: string | null
}

/** The order number (null while the order does not exist yet) and the buyer reference (null when the API does not say it). */
export async function getCheckoutReference(
  checkoutId: string,
  options?: CartQueryOptions,
): Promise<CheckoutReference> {
  const json = await withBuyerRef((withRef) =>
    executeCartGraphQL(
      withRef ? GET_CHECKOUT_ORDER_NUMBER_QUERY : GET_CHECKOUT_ORDER_NUMBER_QUERY_LEGACY,
      { checkoutId },
      options,
    ),
  )
  const checkout = (json?.data as any)?.Checkout?.GetCheckout
  const n = Number(checkout?.order_id)
  return {
    orderNumber: Number.isInteger(n) && n > 0 ? n : null,
    buyerRef: normalizeBuyerRef(checkout?.[BUYER_REF_FIELD]) ?? null,
  }
}

/** The Vio order number, or null while the order does not exist yet. */
export async function getCheckoutOrderNumber(
  checkoutId: string,
  options?: CartQueryOptions,
): Promise<number | null> {
  return (await getCheckoutReference(checkoutId, options)).orderNumber
}

export async function getAvailablePaymentMethods(options?: CartQueryOptions): Promise<any> {
  const json = await executeCartGraphQL(GET_AVAILABLE_PAYMENT_METHODS_QUERY, {}, options)
  return json?.data?.Payment?.GetAvailablePaymentMethods
}

export const CREATE_PAYMENT_STRIPE_MUTATION = `
mutation CreatePaymentStripe($checkoutId: String!, $successUrl: String!, $paymentMethod: String!, $email: String!) {
  Payment {
    CreatePaymentStripe(checkout_id: $checkoutId, success_url: $successUrl, payment_method: $paymentMethod, email: $email) {
      order_id
      checkout_url
    }
  }
}
`

export async function createPaymentStripe(
  variables: Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<any> {
  const json = await executeCartGraphQL(CREATE_PAYMENT_STRIPE_MUTATION, variables, options)
  return json?.data?.Payment?.CreatePaymentStripe
}

export const CREATE_PAYMENT_APPLE_PAY_MUTATION = `
mutation CreatePaymentApplePay($checkoutId: String!) {
  Payment {
    CreatePaymentApplePay(checkout_id: $checkoutId) {
      gateway
      gateway_merchant_id
    }
  }
}
`

/** Register the Apple Pay payment on the backend checkout. Returns the gateway
 * info (gateway + gateway_merchant_id) the sheet/session should use. */
export async function createPaymentApplePay(
  variables: Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<any> {
  const json = await executeCartGraphQL(CREATE_PAYMENT_APPLE_PAY_MUTATION, variables, options)
  return json?.data?.Payment?.CreatePaymentApplePay
}

const confirmApplePayMutation = (withRef: boolean) => `
mutation ConfirmPaymentApplePay($checkoutId: String!, $applePayToken: String!, $email: String, $shippingAddress: ApplePayAddressInput) {
  Payment {
    ConfirmPaymentApplePay(checkout_id: $checkoutId, apple_pay_token: $applePayToken, email: $email, shipping_address: $shippingAddress) {
      order_id
      status${withRef ? `\n      ${BUYER_REF_FIELD}` : ''}
    }
  }
}
`
export const CONFIRM_PAYMENT_APPLE_PAY_MUTATION = confirmApplePayMutation(true)
/** The same selection for a gateway that predates `buyer_ref`. */
export const CONFIRM_PAYMENT_APPLE_PAY_MUTATION_LEGACY = confirmApplePayMutation(false)

/** Confirm (charge) the Apple Pay payment server-side. Called from the sheet's
 * authorize callback BEFORE completing it — the backend does the actual charge.
 * Sent again without `buyer_ref` only when the gateway refused the selection
 * (nothing ran); a confirmation that ran and failed is never repeated. */
export async function confirmPaymentApplePay(
  variables: Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<any> {
  const json = await withBuyerRef((withRef) =>
    executeCartGraphQL(
      withRef ? CONFIRM_PAYMENT_APPLE_PAY_MUTATION : CONFIRM_PAYMENT_APPLE_PAY_MUTATION_LEGACY,
      variables,
      options,
    ),
  )
  return json?.data?.Payment?.ConfirmPaymentApplePay
}

export {
  CREATE_PAYMENT_VIPPS_MUTATION,
  GET_VIPPS_STATUS_QUERY,
  createPaymentVipps,
  getVippsStatus,
} from '../checkout/payments/vipps.js'

