/**
 * CheckoutManager — orchestrates the checkout flow.
 *
 * Stable contract: open / setAddress / selectPaymentMethod / close.
 * Per-vendor payment integrations plug into the corresponding method:
 *   - Apple Pay → `startApplePay()` (Stripe Payment Request, this iteration)
 *   - Klarna / Vipps / Card → land in subsequent iterations
 *
 * Dispatches `change` (state changes) and `payment-select` (user picked
 * a method) and `payment-complete` (vendor sheet completed successfully).
 */

import type { CartLineItem } from '../cart/types.js'
import type { CartManager } from '../cart/cart-manager.js'
import { Configuration } from '../configuration.js'
import {
  checkApplePayAvailability,
  prepareApplePay,
  preloadStripeJs,
  showApplePaySheet,
  type ApplePayResult,
} from './payments/apple-pay.js'
import {
  cleanUrlParams,
  isKlarnaAvailable,
  listenForKlarnaCompletion,
  mountKlarnaExpressButton,
  readKlarnaTokenFromUrl,
  type KlarnaAuthorizeResult,
  type KlarnaButtonHandle,
  type KlarnaLineItem,
  type KlarnaPaymentRequestData,
} from './payments/klarna.js'
import {
  createKlarnaPaymentsWidget,
  isKlarnaPaymentsAvailable,
  type KlarnaPaymentsCategory,
} from './payments/klarna-payments.js'
import {
  confirmPaymentApplePay as gqlConfirmPaymentApplePay,
  createCheckout as gqlCreateCheckout,
  createPaymentApplePay as gqlCreatePaymentApplePay,
  createPaymentStripe as gqlCreatePaymentStripe,
  createPaymentVipps as gqlCreatePaymentVipps,
  getVippsStatus as gqlGetVippsStatus,
  executeCartGraphQL,
  getAvailablePaymentMethods as gqlGetAvailablePaymentMethods,
  getCartGraphQLOptions,
  getCheckout as gqlGetCheckout,
  getLineItemsBySupplier as gqlGetLineItemsBySupplier,
  updateCheckout as gqlUpdateCheckout,
  updateShippingsBySupplier as gqlUpdateShippingsBySupplier,
  type CartQueryOptions,
} from '../api/cart-queries.js'
import { getGlobalCountryCode, getGlobalCurrency, getGlobalLocale } from '../types.js'

/**
 * Best-effort human-readable string for an unknown thrown/rejected value.
 * Klarna's SDK rejects with plain objects, so `String(err)` would collapse to
 * "[object Object]"; we pull a known message field or JSON-serialise so the
 * real reason stays visible.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>
    for (const k of ['message', 'error', 'reason', 'description']) {
      if (typeof o[k] === 'string' && o[k]) return o[k] as string
    }
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

/** sessionStorage key for a pending Klarna purchase (survives redirect). */
const KLARNA_PENDING_KEY = 'vio.klarna.pending.v1'

interface KlarnaPendingContext {
  sponsorId: number
  currency: string
  orderAmount: number
  orderLines: Array<{
    name: string
    quantity: number
    unit_price: number
    total_amount: number
    reference?: string
    /** Klarna line type, e.g. "shipping_fee". */
    type?: string
  }>
  /** Backend checkout id (native GraphQL flow). */
  checkoutId?: string
  /** Klarna Payments session id (native GraphQL flow). */
  sessionId?: string
  /** Klarna Payments client token (native GraphQL flow). */
  clientToken?: string
}

/** A shipping option offered in the checkout. `price` in minor units (øre). */
export interface KlarnaShippingOption {
  id: string
  method: string
  description: string
  price: number
  tax_amount: number
  tax_rate: number
  preselected: boolean
  /** Backend supplier the option belongs to (server-side shippings). */
  supplierId?: string
  /** Display name from the backend (mirror of `method`). */
  name?: string
  country_code?: string
  /** Price in MAJOR units, as delivered by the backend. */
  priceMajor?: number
  currency?: string
}

/**
 * Shipping options offered for express purchases. Amounts in minor units (øre).
 * The chosen one is added to the order total + as a `shipping_fee` line so the
 * Klarna order reconciles. (Klarna Payments doesn't render a shipping picker —
 * KCO/KSA would, but the account isn't provisioned — so the picker is ours.)
 */
export const KLARNA_SHIPPING_OPTIONS: KlarnaShippingOption[] = [
  {
    id: 'standard',
    method: 'Standard',
    description: '3–5 virkedager',
    price: 4900,
    tax_amount: 0,
    tax_rate: 0,
    preselected: true,
  },
  {
    id: 'express',
    method: 'Express',
    description: '1–2 virkedager',
    price: 9900,
    tax_amount: 0,
    tax_rate: 0,
    preselected: false,
  },
]
import type { CheckoutAddress, CheckoutState, PaymentMethod } from './types.js'

// MARK: - Klarna native (Vio Commerce GraphQL Payment mutations)

const CREATE_PAYMENT_KLARNA_NATIVE_MUTATION = `
mutation CreatePaymentKlarnaNative($checkoutId: String!, $countryCode: String, $currency: String, $locale: String, $returnUrl: String, $intent: String, $customer: KlarnaNativeCustomerInput, $billingAddress: KlarnaNativeAddressInput, $shippingAddress: KlarnaNativeAddressInput, $autoCapture: Boolean) {
  Payment {
    CreatePaymentKlarnaNative(checkout_id: $checkoutId, country_code: $countryCode, currency: $currency, locale: $locale, return_url: $returnUrl, intent: $intent, customer: $customer, billing_address: $billingAddress, shipping_address: $shippingAddress, auto_capture: $autoCapture) {
      client_token
      session_id
      purchase_country
      purchase_currency
      cart_id
      checkout_id
      payment_method_categories {
        identifier
        name
        asset_urls {
          descriptive
          standard
        }
      }
    }
  }
}
`

const CONFIRM_PAYMENT_KLARNA_NATIVE_MUTATION = `
mutation ConfirmPaymentKlarnaNative($checkoutId: String!, $authorizationToken: String!, $autoCapture: Boolean, $billingAddress: KlarnaNativeAddressInput, $shippingAddress: KlarnaNativeAddressInput, $customer: KlarnaNativeCustomerInput) {
  Payment {
    ConfirmPaymentKlarnaNative(checkout_id: $checkoutId, authorization_token: $authorizationToken, auto_capture: $autoCapture, billing_address: $billingAddress, shipping_address: $shippingAddress, customer: $customer) {
      order_id
      checkout_id
      fraud_status
      order {
        order_id
        status
        purchase_country
        purchase_currency
        locale
        billing_address {
          given_name
          family_name
          email
          street_address
          postal_code
          city
          country
        }
        shipping_address {
          given_name
          family_name
          email
          street_address
          postal_code
          city
          country
        }
        order_amount
        order_tax_amount
        total_line_items_price
        order_lines {
          type
          name
          quantity
          unit_price
          tax_rate
          total_amount
          total_discount_amount
          total_tax_amount
          merchant_data
        }
        merchant_urls {
          terms
          checkout
          confirmation
          push
        }
        html_snippet
        started_at
        last_modified_at
        options {
          allow_separate_shipping_address
          date_of_birth_mandatory
          require_validate_callback_success
          phone_mandatory
          auto_capture
        }
        shipping_options {
          id
          name
          price
          tax_amount
          tax_rate
          preselected
        }
        merchant_data
        selected_shipping_option {
          id
          name
          price
          tax_amount
          tax_rate
          preselected
        }
      }
    }
  }
}
`

/* eslint-disable @typescript-eslint/no-explicit-any */

function buildKlarnaCustomer(address: any): Record<string, unknown> | null {
  if (!address) return null
  return {
    dob: address.dob || address.date_of_birth || null,
    email: address.email || null,
    organization_registration_id:
      address.organization_registration_id || address.org_id || null,
    phone: address.phone || address.telephone || null,
    type: address.type || 'person',
  }
}

function buildKlarnaAddress(address: any): Record<string, unknown> | null {
  if (!address) return null
  return {
    city: address.city || null,
    country: address.country || address.countryCode || getGlobalCountryCode(),
    email: address.email || null,
    family_name:
      address.familyName || address.family_name || address.last_name || address.lastName || null,
    given_name:
      address.givenName || address.given_name || address.first_name || address.firstName || null,
    phone: address.phone || null,
    postal_code: address.postalCode || address.postal_code || address.zip || null,
    region: address.region || address.state || null,
    street_address:
      address.streetAddress ||
      address.street_address ||
      address.address1 ||
      address.street ||
      address.address || // CheckoutAddress uses plain `address` for the street
      null,
    // street_address2 intentionally omitted — the KlarnaNativeAddressInput
    // backend type rejects it.
  }
}

/** Map any address-ish object to the backend checkout address input shape. */
function buildCheckoutAddress(address: any): Record<string, unknown> | null {
  if (!address) return null
  const firstName =
    address.firstName || address.first_name || address.givenName || address.given_name || null
  const lastName =
    address.lastName || address.last_name || address.familyName || address.family_name || null
  const address1 =
    address.address || address.address1 || address.street || address.street_address || null
  const city = address.city || null
  const zip = address.postalCode || address.postal_code || address.zip || null
  const country_code = address.countryCode || address.country_code || address.country || getGlobalCountryCode()

  if (!firstName && !lastName && !address1 && !city && !zip) return null

  return {
    first_name: firstName,
    last_name: lastName,
    address1: address1,
    city: city,
    zip: zip,
    country_code: country_code,
  }
}

/**
 * Klarna/Stripe/Vipps require an https return_url — normalise whatever the
 * page has, optionally appending query params (used to detect the redirect
 * return and show the confirmation).
 */
function resolveHttpsReturnUrl(
  overrideUrl?: string | null,
  params: Record<string, unknown> | null = null,
): string {
  let url = overrideUrl ?? undefined
  if (!url && typeof window !== 'undefined' && window.location) {
    url = window.location.href
  }
  if (!url || typeof url !== 'string' || url.startsWith('about:') || url.startsWith('file:')) {
    url = 'https://vev.design/checkout/confirmation'
  }
  if (url.startsWith('http://')) {
    url = 'https://' + url.slice(7)
  } else if (!url.startsWith('https://')) {
    url = 'https://' + url.replace(/^[a-zA-Z]+:\/\//, '')
  }

  if (params && typeof params === 'object') {
    try {
      const parsed = new URL(url)
      Object.keys(params).forEach((k) => {
        if (params[k] !== undefined && params[k] !== null) {
          parsed.searchParams.set(k, String(params[k]))
        }
      })
      return parsed.toString()
    } catch {
      const queryStr = Object.keys(params)
        .filter((k) => params[k] !== undefined && params[k] !== null)
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
        .join('&')
      if (queryStr) {
        url += (url.includes('?') ? '&' : '?') + queryStr
      }
    }
  }

  return url
}

/** Execute a Payment.* mutation with the sponsor's commerce key. */
async function executeKlarnaGraphQL(
  query: string,
  variables: Record<string, unknown>,
  sponsorId?: number,
): Promise<any> {
  return executeCartGraphQL(query, variables, await getCartGraphQLOptions(sponsorId))
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export interface CheckoutChangeDetail {
  state: CheckoutState | null
}

export interface PaymentSelectDetail {
  method: PaymentMethod
  state: CheckoutState
}

export interface PaymentCompleteDetail {
  method: PaymentMethod
  state: CheckoutState
  result: ApplePayResult | KlarnaAuthorizeResult | unknown
}

export interface PaymentErrorDetail {
  method: PaymentMethod
  error: string
}

/** Handle for the Klarna Payments (classic widget) flow. */
export interface KlarnaPaymentsHandle {
  /** Categories offered by the session (pay_now / pay_later / pay_over_time). */
  categories: KlarnaPaymentsCategory[]
  /** Shipping options in effect (backend per-supplier, or the static fallback). */
  shippings: KlarnaShippingOption[]
  /** Currently selected category. */
  readonly selected: string
  /** (Re)load the widget for a category. */
  load(category?: string): Promise<{ showForm: boolean }>
  /** Authorize the selected method and (on approval) create the order. */
  authorize(): Promise<void>
  /** Tear down the mounted widget. */
  unmount(): void
}

export class CheckoutManager extends EventTarget {
  private state: CheckoutState | null = null
  private applePayAvailableCache: boolean | null = null

  /** Gateway hints learned from CreatePaymentApplePay (per session). The
   * backend's gateway_merchant_id may be a publishable key (pk_…) or a Stripe
   * Connect account (acct_…) — stored defensively by prefix. */
  private applePayPublishableKey: string | null = null
  private applePayConnectedAccount: string | null = null
  private klarnaAvailableCache: boolean | null = null
  private klarnaOrderInFlight = false
  /** Last backend shippings fetched (per-supplier), for UI reuse. */
  private lastFetchedShippings: KlarnaShippingOption[] = []
  /** Per-sponsor payment methods cache + in-flight dedupe. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private paymentMethodsCache = new Map<number, any>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private paymentMethodsPromises = new Map<number, Promise<any>>()

  constructor(private readonly cartManager: CartManager) {
    super()
    // Warm Stripe.js early: Apple Pay's sheet must open synchronously inside
    // the tap gesture, so the library can't be lazy-loaded at click time.
    preloadStripeJs()
  }

  open(sponsorId: number): CheckoutState {
    const cart = this.cartManager.getCart(sponsorId)
    if (!cart || cart.items.length === 0) {
      throw new Error(`[VioCheckout] sponsor ${sponsorId} has no cart items`)
    }
    this.state = {
      sponsorId,
      subtotal: this.cartManager.subtotalForSponsor(sponsorId),
      // Page-level currency wins over whatever the persisted cart carries —
      // the host may have switched currency since the cart was created.
      currency: getGlobalCurrency(),
    }
    this.emit()
    return this.state
  }

  close(): void {
    this.state = null
    this.applePayAvailableCache = null
    this.klarnaAvailableCache = null
    this.emit()
  }

  // MARK: - Backend checkout (Vio Commerce GraphQL)

  /* eslint-disable @typescript-eslint/no-explicit-any */

  /** Create the backend checkout for the sponsor's cart (auto-accepts terms). */
  async createCheckout(sponsorId: number): Promise<any> {
    const cart = this.cartManager.getCart(sponsorId)
    let cartId = cart?.cartId
    if (!cartId) {
      cartId = await this.cartManager.ensureCartId(sponsorId, cart?.currency)
      if (!cartId) {
        throw new Error(`[CheckoutManager] Failed to obtain cart_id for sponsor ${sponsorId}`)
      }
    }
    const opts = await getCartGraphQLOptions(sponsorId)
    const checkout = await gqlCreateCheckout(cartId, opts)
    if (checkout?.id) {
      this.state = {
        ...(this.state ?? { sponsorId, subtotal: 0, currency: getGlobalCurrency() }),
        sponsorId,
        checkoutId: checkout.id,
        checkout,
      }
      this.emit()
      try {
        const updated = await gqlUpdateCheckout(
          {
            checkoutId: checkout.id,
            buyerAcceptsPurchaseConditions: true,
            buyerAcceptsTermsConditions: true,
          },
          opts,
        )
        if (updated?.id) {
          this.state = { ...this.state, checkout: updated }
          this.emit()
          return updated
        }
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[CheckoutManager] Failed to auto-accept terms & purchase conditions:', err)
        }
      }
    }
    return checkout
  }

  /** Update the backend checkout (terms are re-asserted unless overridden). */
  async updateCheckout(variables: Record<string, unknown>, sponsorId?: number): Promise<any> {
    const opts = await getCartGraphQLOptions(sponsorId ?? this.state?.sponsorId)
    const fullVars = {
      buyerAcceptsPurchaseConditions: true,
      buyerAcceptsTermsConditions: true,
      ...variables,
    }
    const updated = await gqlUpdateCheckout(fullVars, opts)
    if (updated?.id && this.state) {
      this.state = { ...this.state, checkoutId: updated.id, checkout: updated }
      this.emit()
    }
    return updated
  }

  async getCheckout(checkoutId: string, sponsorId?: number): Promise<any> {
    const opts = await getCartGraphQLOptions(sponsorId ?? this.state?.sponsorId)
    return gqlGetCheckout(checkoutId, opts)
  }

  /**
   * Payment methods enabled for the sponsor (backend-configured). Memoised per
   * sponsor with in-flight dedupe — several UI components ask on every open.
   */
  async getAvailablePaymentMethods(sponsorId?: number): Promise<any> {
    const spId = sponsorId ?? this.state?.sponsorId
    if (!spId) return null

    if (this.paymentMethodsCache.has(spId)) {
      return this.paymentMethodsCache.get(spId)
    }
    const inFlight = this.paymentMethodsPromises.get(spId)
    if (inFlight) return inFlight

    const promise = (async () => {
      try {
        const opts = await getCartGraphQLOptions(spId)
        const res = await gqlGetAvailablePaymentMethods(opts)
        // Never cache empty/failed responses — a transient blip would freeze
        // the payment grid for the whole page session.
        if (res) this.paymentMethodsCache.set(spId, res)
        return res
      } finally {
        this.paymentMethodsPromises.delete(spId)
      }
    })()

    this.paymentMethodsPromises.set(spId, promise)
    return promise
  }

  clearPaymentMethodsCache(): void {
    this.paymentMethodsCache.clear()
    this.paymentMethodsPromises.clear()
  }

  /**
   * Real shipping options from the backend cart (per supplier), mapped to the
   * KlarnaShippingOption shape (minor units). Empty array on failure — callers
   * fall back to the static KLARNA_SHIPPING_OPTIONS.
   */
  async fetchAvailableShippings(sponsorId?: number): Promise<KlarnaShippingOption[]> {
    try {
      const spId = sponsorId ?? this.state?.sponsorId
      if (!spId) return []
      const cart = this.cartManager.getCart(spId)
      let cartId = cart?.cartId
      if (!cartId) {
        cartId = await this.cartManager.ensureCartId(spId)
      }
      if (!cartId) return []
      const opts = await getCartGraphQLOptions(spId)
      const supplierGroups = await gqlGetLineItemsBySupplier(cartId, opts)
      const firstGroup = Array.isArray(supplierGroups) ? supplierGroups[0] : null
      const shippings = firstGroup?.available_shippings ?? []
      if (Array.isArray(shippings) && shippings.length > 0) {
        const supplierId = firstGroup?.supplier?.id
        const mapped: KlarnaShippingOption[] = shippings.map((s: any, idx: number) => {
          const priceObj = s.price ?? {}
          const amount =
            typeof priceObj.amount_incl_taxes === 'number'
              ? priceObj.amount_incl_taxes
              : typeof priceObj.amount === 'number'
                ? priceObj.amount
                : 0
          return {
            id: String(s.id),
            supplierId: supplierId != null ? String(supplierId) : undefined,
            method: s.name || 'Default Shipping',
            name: s.name || 'Default Shipping',
            description: s.description || '',
            country_code: s.country_code || 'NO',
            price: Math.round(amount * 100),
            priceMajor: amount,
            currency: priceObj.currency_code || getGlobalCurrency(),
            tax_amount: Math.round((priceObj.tax_amount ?? 0) * 100),
            tax_rate: Math.round((priceObj.tax_rate ?? 0) * 100),
            preselected: idx === 0,
          }
        })
        this.lastFetchedShippings = mapped
        return mapped
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[CheckoutManager] fetchAvailableShippings failed:', err)
      }
    }
    return []
  }

  /** Set the chosen shipping per supplier on the backend cart. */
  async updateShippingsBySupplier(
    data: Array<{ shipping_id: string; supplier_id: number }>,
    sponsorId?: number,
  ): Promise<any> {
    const spId = sponsorId ?? this.state?.sponsorId
    if (!spId) return null
    const cart = this.cartManager.getCart(spId)
    if (!cart?.cartId) return null
    const opts = await getCartGraphQLOptions(spId)
    const updated = await gqlUpdateShippingsBySupplier(cart.cartId, data, opts)
    if (updated) {
      this.cartManager.updateFromBackendCart(spId, updated)
    }
    return updated
  }

  /**
   * Shared setup for the redirect payment links (Stripe / Vipps): ensure the
   * backend cart + checkout exist, push email/address onto the checkout, and
   * return everything the payment mutation needs.
   */
  private async prepareRedirectPayment(
    sponsorId: number | undefined,
    formData: unknown,
    extraUpdateVars: Record<string, unknown> = {},
  ): Promise<{ spId: number; checkoutId: string; emailVal: string; opts: CartQueryOptions }> {
    const spId = sponsorId ?? this.state?.sponsorId
    if (!spId) throw new Error('[CheckoutManager] no sponsor for payment')
    const cart = this.cartManager.getCart(spId)
    let cartId = cart?.cartId
    if (!cartId) {
      cartId = await this.cartManager.ensureCartId(spId)
    }
    if (!cartId) {
      throw new Error(`[CheckoutManager] Failed to obtain cart_id for sponsor ${spId}`)
    }

    const opts = await getCartGraphQLOptions(spId)
    let checkoutId = this.state?.checkoutId
    if (!checkoutId) {
      const checkoutRes = await gqlCreateCheckout(cartId, opts)
      checkoutId = checkoutRes?.id
    }
    if (!checkoutId) {
      throw new Error('[CheckoutManager] no backend checkout — cannot start the payment')
    }

    // Vipps collects the address in its own flow — never push one onto the
    // checkout for it (the backend rejects partial Vipps addresses).
    const isVipps = extraUpdateVars?.paymentMethod === 'Vipps'
    const addr =
      typeof formData === 'object' && formData !== null ? formData : this.state?.address
    const addressObj = !isVipps ? buildCheckoutAddress(addr) : null
    const emailVal =
      (typeof formData === 'string'
        ? formData
        : (formData as { email?: string } | undefined)?.email) ||
      this.state?.address?.email ||
      ''
    if (!emailVal || !emailVal.includes('@')) {
      // Never mint a payment link with a fabricated email — the order's
      // receipt/contact would be wrong forever.
      throw new Error('[CheckoutManager] email is required to start the payment')
    }

    const updateVars: Record<string, unknown> = {
      checkoutId,
      email: emailVal,
      buyerAcceptsPurchaseConditions: true,
      buyerAcceptsTermsConditions: true,
      ...extraUpdateVars,
    }
    if (addressObj) {
      updateVars.shippingAddress = addressObj
      updateVars.billingAddress = addressObj
    }

    try {
      const updated = await gqlUpdateCheckout(updateVars, opts)
      if (updated?.id) {
        this.state = {
          ...(this.state ?? { sponsorId: spId, subtotal: 0, currency: getGlobalCurrency() }),
          sponsorId: spId,
          checkoutId: updated.id,
          checkout: updated,
        }
        this.emit()
        checkoutId = updated.id
      }
    } catch (err) {
      // Redirecting after a failed UpdateCheckout would charge with a stale
      // (or missing) address/email — abort instead.
      throw new Error(
        `[CheckoutManager] could not persist checkout details: ${describeError(err)}`,
      )
    }

    // (Narrowing: the assignment inside the try widens the type again.)
    if (!checkoutId) {
      throw new Error('[CheckoutManager] no backend checkout — cannot start the payment')
    }
    return { spId, checkoutId, emailVal, opts }
  }

  /** Redirect the top window to a payment provider URL. */
  private static redirectTo(url: string): void {
    if (typeof window === 'undefined') return
    try {
      if (window.top && window.top !== window) {
        window.top.location.href = url
      } else {
        window.location.href = url
      }
    } catch {
      window.open(url, '_top') || window.open(url, '_blank')
    }
  }

  /**
   * Stripe payment link: create/refresh the backend checkout, mint the Stripe
   * Checkout URL (CreatePaymentStripe) and redirect. The return URL carries
   * vio_payment/vio_method/checkout_id so the page can show the confirmation.
   */
  async startStripePayment(sponsorId?: number, formData?: unknown): Promise<any> {
    const { spId, checkoutId, emailVal, opts } = await this.prepareRedirectPayment(
      sponsorId,
      formData,
      { paymentMethod: 'Stripe' },
    )
    const successUrl = resolveHttpsReturnUrl(null, {
      vio_payment: 'success',
      vio_method: 'stripe',
      vio_sponsor: spId,
      checkout_id: checkoutId,
    })
    const stripeRes = await gqlCreatePaymentStripe(
      { checkoutId, successUrl, paymentMethod: 'Stripe', email: emailVal },
      opts,
    )
    if (stripeRes?.checkout_url) {
      CheckoutManager.redirectTo(stripeRes.checkout_url)
      return stripeRes
    }
    throw new Error('Stripe payment link generation failed: missing checkout_url')
  }

  /**
   * Vipps payment link: same flow as Stripe — CreatePaymentVipps → redirect to
   * payment_url.
   */
  async startVippsPayment(sponsorId?: number, formData?: unknown): Promise<any> {
    const { spId, checkoutId, emailVal, opts } = await this.prepareRedirectPayment(
      sponsorId,
      formData,
      { paymentMethod: 'Vipps' },
    )
    const returnUrl = resolveHttpsReturnUrl(null, {
      vio_payment: 'success',
      vio_method: 'vipps',
      vio_sponsor: spId,
      checkout_id: checkoutId,
    })
    const vippsRes = await gqlCreatePaymentVipps(
      { checkoutId, email: emailVal, returnUrl },
      opts,
    )
    if (vippsRes?.payment_url) {
      CheckoutManager.redirectTo(vippsRes.payment_url)
      return vippsRes
    }
    throw new Error('Vipps payment link generation failed: missing payment_url')
  }

  /** Vipps' own payment state for the checkout — see getVippsStatus in
   * cart-queries.ts for why this exists instead of trusting GetCheckout. */
  async getVippsStatus(checkoutId: string, sponsorId?: number): Promise<{ state?: string } | null> {
    const opts = await getCartGraphQLOptions(sponsorId ?? this.state?.sponsorId)
    return gqlGetVippsStatus({ checkoutId }, opts)
  }

  /* eslint-enable @typescript-eslint/no-explicit-any */

  setAddress(address: CheckoutAddress): void {
    if (!this.state) return
    // Immutable update — a fresh object reference so reactive UIs (Lit
    // `@state`, which compares by identity) actually re-render.
    this.state = { ...this.state, address }
    this.emit()
  }

  selectPaymentMethod(method: PaymentMethod): void {
    if (!this.state) return
    // New reference (see setAddress) so the selection re-renders.
    this.state = { ...this.state, paymentMethod: method }
    this.emit()
    this.dispatchEvent(
      new CustomEvent<PaymentSelectDetail>('payment-select', {
        detail: { method, state: this.state },
      }),
    )
  }

  // MARK: - Apple Pay (Stripe Payment Request)

  /**
   * Returns true if Apple Pay can be shown on this device + Stripe config.
   * Result is memoised — call `clearApplePayCache()` if config changes.
   */
  async isApplePayAvailable(country = 'NO'): Promise<boolean> {
    if (this.applePayAvailableCache !== null) return this.applePayAvailableCache
    const cfg = Configuration.isInitialized ? Configuration.get() : null
    const publishableKey = cfg?.stripePublishableKey ?? ''
    if (!publishableKey || !this.state) {
      this.applePayAvailableCache = false
      return false
    }
    const amount = toSmallestUnit(this.state.subtotal, this.state.currency)
    const available = await checkApplePayAvailability({
      publishableKey,
      connectedAccount: this.findStripeConnectAccount() ?? undefined,
      amount,
      currency: this.state.currency,
      country,
      label: 'Vio',
    })
    this.applePayAvailableCache = available
    return available
  }

  clearApplePayCache(): void {
    this.applePayAvailableCache = null
  }

  /**
   * Prepare Apple Pay for the product-page express button (no active checkout
   * needed). Pre-creates the Stripe PaymentRequest + resolves canMakePayment so
   * the returned `show()` can fire synchronously inside the tap (Apple blocks
   * the sheet if `show()` is reached after an await). `show()` resolves the
   * sheet, then dispatches `payment-complete` (→ confirmation) or
   * `payment-error`. `available` is true only when Apple Pay will actually work.
   */
  async prepareApplePayFor(
    amount: number,
    currency: string,
    country = 'NO',
  ): Promise<{ available: boolean; show: () => Promise<void> }> {
    const cfg = Configuration.isInitialized ? Configuration.get() : null
    const publishableKey = this.applePayPublishableKey || cfg?.stripePublishableKey || ''
    if (!publishableKey) return { available: false, show: async () => {} }
    const prepared = await prepareApplePay({
      publishableKey,
      connectedAccount:
        this.applePayConnectedAccount ?? this.findStripeConnectAccount() ?? undefined,
      amount: toSmallestUnit(amount, currency),
      currency,
      country,
      label: 'Vio',
      // Native Apple Pay shipping — same Standard/Express options as Klarna.
      shippingOptions: KLARNA_SHIPPING_OPTIONS.map((o) => ({
        id: o.id,
        label: o.method,
        detail: o.description,
        amount: o.price,
      })),
      // The real backend charge — sponsor resolved at authorize-time (the
      // product-detail button calls checkout.open() before show()).
      onAuthorize: (raw) => {
        const spId =
          this.state?.sponsorId ?? [...this.cartManager.getAllCarts().keys()][0]
        if (spId == null) {
          return Promise.reject(new Error('[VioCheckout] no sponsor for Apple Pay'))
        }
        return this.buildApplePayAuthorize(spId)(raw)
      },
    })
    return {
      available: prepared.available,
      show: async (): Promise<void> => {
        try {
          const result = await prepared.show()
          this.selectPaymentMethod('apple-pay')
          const state: CheckoutState =
            this.state ?? { sponsorId: 0, subtotal: amount, currency }
          this.dispatchEvent(
            new CustomEvent<PaymentCompleteDetail>('payment-complete', {
              detail: { method: 'apple-pay', state, result },
            }),
          )
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn('[VioCheckout] Apple Pay express failed:', err)
          }
          this.dispatchEvent(
            new CustomEvent<PaymentErrorDetail>('payment-error', {
              detail: { method: 'apple-pay', error: describeError(err) },
            }),
          )
        }
      },
    }
  }

  /**
   * Prepare an Apple Pay express charge for an arbitrary amount (e.g. the whole
   * cart) with NO active checkout. Unlike `prepareApplePayFor`, the returned
   * `show()` RESOLVES with the result (or `null` on cancel/failure) and does
   * NOT dispatch the global `payment-complete` — so no checkout overlay appears.
   * The caller (the cart drawer) renders its own confirmation. `show()` must be
   * called synchronously inside the tap (Apple's user-gesture rule).
   */
  async prepareApplePayExpress(
    amount: number,
    currency: string,
    country = 'NO',
    sponsorId?: number,
  ): Promise<{ available: boolean; show: () => Promise<ApplePayResult | null> }> {
    const cfg = Configuration.isInitialized ? Configuration.get() : null
    const publishableKey = this.applePayPublishableKey || cfg?.stripePublishableKey || ''
    if (!publishableKey) return { available: false, show: async () => null }
    const spId =
      sponsorId ?? this.state?.sponsorId ?? [...this.cartManager.getAllCarts().keys()][0]
    const prepared = await prepareApplePay({
      publishableKey,
      connectedAccount:
        this.applePayConnectedAccount ?? this.findStripeConnectAccount() ?? undefined,
      amount: toSmallestUnit(amount, currency),
      currency,
      country,
      label: 'Vio',
      // Native Apple Pay shipping (same Standard/Express options as Klarna) —
      // selected inside the sheet, so it's not a separate checkout step.
      shippingOptions: KLARNA_SHIPPING_OPTIONS.map((o) => ({
        id: o.id,
        label: o.method,
        detail: o.description,
        amount: o.price,
      })),
      // The real backend charge, run inside the sheet's authorize event.
      ...(spId != null ? { onAuthorize: this.buildApplePayAuthorize(spId) } : {}),
    })
    return {
      available: prepared.available,
      show: async (): Promise<ApplePayResult | null> => {
        try {
          return await prepared.show()
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn('[VioCheckout] cart Apple Pay express failed:', err)
          }
          return null
        }
      },
    }
  }

  /** The charge closure run inside the Apple Pay sheet's authorize event —
   * shared by the checkout button and the cart's express button. Fail-closed:
   * any failure throws and the sheet closes with failure, nothing confirmed. */
  private buildApplePayAuthorize(spId: number): (raw: ApplePayResult) => Promise<unknown> {
    return async (raw: ApplePayResult): Promise<unknown> => {
      let checkoutId = this.state?.checkoutId
      if (!checkoutId) {
        const created = await this.createCheckout(spId)
        checkoutId = created?.id ?? this.state?.checkoutId
      }
      if (!checkoutId) {
        throw new Error('[VioCheckout] could not obtain a checkout for Apple Pay')
      }
      const email = raw.payerEmail || this.state?.address?.email || ''
      // Record the method (+ email) on the checkout. Non-fatal: Confirm carries
      // the email too, and the charge is what decides the outcome.
      try {
        await this.updateCheckout(
          { checkoutId, paymentMethod: 'Apple Pay', ...(email ? { email } : {}) },
          spId,
        )
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[VioCheckout] updateCheckout before Apple Pay confirm failed:', err)
        }
      }
      const gqlOpts = await getCartGraphQLOptions(spId)
      const createRes = await gqlCreatePaymentApplePay({ checkoutId }, gqlOpts)
      const gatewayId = String(createRes?.gateway_merchant_id ?? '')
      if (gatewayId.startsWith('pk_')) this.applePayPublishableKey = gatewayId
      else if (gatewayId.startsWith('acct_')) this.applePayConnectedAccount = gatewayId

      const addr = (raw.shippingAddress ?? {}) as Record<string, unknown>
      const str = (v: unknown): string => (typeof v === 'string' ? v : '')
      const lines = Array.isArray(addr.addressLine) ? (addr.addressLine as string[]) : []
      const fullName = str(addr.name) || raw.payerName || ''
      const shippingAddress = {
        address1: lines[0] || str(addr.line1) || '',
        address2: lines[1] || str(addr.line2) || '',
        city: str(addr.locality) || str(addr.city) || '',
        company: '',
        country: str(addr.country) || '',
        country_code: str(addr.countryCode) || getGlobalCountryCode(),
        first_name: str(addr.givenName) || fullName.split(' ')[0] || '',
        last_name: str(addr.familyName) || fullName.split(' ').slice(1).join(' ') || '',
        phone: str(addr.phone) || str(addr.phoneNumber) || raw.payerPhone || '',
        phone_code: '',
        province: str(addr.administrativeArea) || str(addr.state) || '',
        province_code: '',
        zip: str(addr.postalCode) || str(addr.postal_code) || '',
      }

      const confirmRes = await gqlConfirmPaymentApplePay(
        { checkoutId, applePayToken: raw.paymentMethodId, email, shippingAddress },
        gqlOpts,
      )
      const status = String(confirmRes?.status ?? '').toLowerCase()
      if (!confirmRes || CheckoutManager.APPLE_PAY_FAILED_STATUSES.has(status)) {
        throw new Error(
          `[VioCheckout] Apple Pay confirmation failed (status: ${confirmRes?.status ?? 'none'})`,
        )
      }
      return { orderId: confirmRes?.order_id, status: confirmRes?.status }
    }
  }

  /** Backend statuses from ConfirmPaymentApplePay that mean the charge did
   * NOT go through — anything here fails the sheet (fail-closed). */
  private static readonly APPLE_PAY_FAILED_STATUSES = new Set([
    'failed', 'declined', 'rejected', 'cancelled', 'canceled', 'error', 'expired',
  ])

  /**
   * Launches the Apple Pay sheet and charges server-side INSIDE the sheet's
   * authorize event (round-5 wiring, contract from the commerce backend):
   *   1. ensure a backend checkout exists (create if missing)
   *   2. UpdateCheckout(paymentMethod: "Apple Pay" + payer email)
   *   3. CreatePaymentApplePay → gateway hints (pk_/acct_ stored by prefix)
   *   4. ConfirmPaymentApplePay(token, email, shipping) → the REAL charge;
   *      a failed/absent confirmation throws → the sheet closes with failure
   * Resolves null if the user closes the sheet. On success, dispatches
   * `payment-complete` with the backend order id in `result.confirmation`.
   */
  async startApplePay(options: {
    country?: string
    label?: string
    sponsorId?: number
  } = {}): Promise<ApplePayResult | null> {
    if (!this.state) throw new Error('[VioCheckout] no active checkout — call open() first')
    const spId = options.sponsorId ?? this.state.sponsorId
    const cfg = Configuration.isInitialized ? Configuration.get() : null
    const publishableKey = this.applePayPublishableKey || cfg?.stripePublishableKey || ''
    if (!publishableKey) {
      throw new Error(
        '[VioCheckout] No Stripe publishable key configured. Pass `stripePublishableKey` to Vio.init({ ... }).',
      )
    }
    const amount = toSmallestUnit(this.state.subtotal, this.state.currency)
    const onAuthorize = this.buildApplePayAuthorize(spId)

    const result = await showApplePaySheet({
      publishableKey,
      connectedAccount:
        this.applePayConnectedAccount ?? this.findStripeConnectAccount() ?? undefined,
      amount,
      currency: this.state.currency,
      country: options.country ?? 'NO',
      label: options.label ?? 'Vio',
      onAuthorize,
    })
    if (!result) return null // user closed the sheet — no event, nothing charged

    this.selectPaymentMethod('apple-pay')
    this.dispatchEvent(
      new CustomEvent<PaymentCompleteDetail>('payment-complete', {
        detail: { method: 'apple-pay', state: this.state, result },
      }),
    )
    return result
  }

  // MARK: - Klarna Express Checkout (Klarna Web SDK v2)

  /**
   * True if the Klarna Express button can be offered (clientId configured +
   * SDK loads). Memoised per active checkout. Never throws.
   */
  async isKlarnaExpressAvailable(): Promise<boolean> {
    if (this.klarnaAvailableCache !== null) return this.klarnaAvailableCache
    const cfg = Configuration.isInitialized ? Configuration.get() : null
    const clientId = cfg?.klarnaClientId ?? ''
    if (!clientId || !this.state) {
      this.klarnaAvailableCache = false
      return false
    }
    const available = await isKlarnaAvailable({
      clientId,
      locale: getGlobalLocale(),
      environment: cfg?.klarnaEnvironment,
    })
    this.klarnaAvailableCache = available
    return available
  }

  clearKlarnaCache(): void {
    this.klarnaAvailableCache = null
  }

  /**
   * Build the Klarna payment request from the active cart — amounts in the
   * currency's minor unit (øre/cents), one line item per cart line.
   */
  buildKlarnaPaymentRequest(): KlarnaPaymentRequestData {
    if (!this.state) throw new Error('[VioCheckout] no active checkout — call open() first')
    const currency = this.state.currency
    const lineItems: KlarnaLineItem[] = this.items.map((item) => {
      const unitPrice = toSmallestUnit(item.unitPrice, currency)
      return {
        name: item.name || item.brand || 'Produkt',
        quantity: item.quantity,
        unitPrice,
        totalAmount: unitPrice * item.quantity,
        reference: String(item.productId),
        ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
      }
    })
    return {
      currency,
      amount: toSmallestUnit(this.state.subtotal, currency),
      supplementaryPurchaseData: { lineItems },
    }
  }

  /**
   * Mount the Klarna Express button into `container`. On a successful
   * authorization, fires `payment-complete` with the authorization token —
   * the host (or vio-backend) then creates the Klarna order server-side.
   *
   * Returns the button handle so the UI can unmount on teardown.
   */
  async mountKlarnaExpress(container: HTMLElement): Promise<KlarnaButtonHandle> {
    if (!this.state) throw new Error('[VioCheckout] no active checkout — call open() first')
    const cfg = Configuration.get()
    if (!cfg.klarnaClientId) {
      throw new Error(
        '[VioCheckout] No Klarna client id configured. Pass `klarnaClientId` to Vio.init({ ... }).',
      )
    }
    const pendingContext = this.buildKlarnaPendingContext()
    return mountKlarnaExpressButton({
      config: {
        clientId: cfg.klarnaClientId,
        locale: getGlobalLocale(),
        environment: cfg.klarnaEnvironment,
      },
      container,
      paymentRequest: this.buildKlarnaPaymentRequest(),
      pendingKey: KLARNA_PENDING_KEY,
      pendingContext,
      // POPUP path: the initiate() promise resolves in-page with the token.
      onAuthorize: (result) => {
        void this.completeKlarnaOrder(result.authorizationToken, pendingContext, result)
      },
      onError: (err) => {
        if (typeof console !== 'undefined') {
          console.warn('[VioCheckout] Klarna Express cancelled/error:', err)
        }
        // Surface the error in the UI (not just the console). Klarna's reject
        // payload is often a plain object, so serialise it instead of letting
        // String(err) collapse to "[object Object]" — we need the real reason
        // (e.g. validation field, unsupported initiationMode, blocked origin)
        // visible on screen while we stabilise the flow.
        this.dispatchEvent(
          new CustomEvent<PaymentErrorDetail>('payment-error', {
            detail: { method: 'klarna', error: describeError(err) },
          }),
        )
      },
    })
  }

  /**
   * Klarna Payments — classic widget flow (server client_token). Creates a
   * session on vio-backend, then mounts Klarna's inline widget into
   * `container`. Returns a handle to switch category and to authorize → which
   * on approval creates the order via the same backend /orders route as KEC.
   *
   * Unlike `mountKlarnaExpress`, this needs no public `klarnaClientId` and no
   * origin handshake — auth is the server-side API key.
   */
  async mountKlarnaPayments(
    container: HTMLElement,
    opts?: { withShipping?: boolean; shippingId?: string; category?: string },
  ): Promise<KlarnaPaymentsHandle> {
    if (!this.state) throw new Error('[VioCheckout] no active checkout — call open() first')
    const sponsorId = this.state.sponsorId

    // 1. Real per-supplier shippings from the backend cart (static fallback).
    const fetchedShippings = await this.fetchAvailableShippings(sponsorId)
    const shippings = fetchedShippings.length > 0 ? fetchedShippings : KLARNA_SHIPPING_OPTIONS

    // With shipping: add the CHOSEN shipping option as a shipping_fee line +
    // bump the total. (Klarna Payments doesn't render a picker; ours lives in
    // the checkout UI and re-mounts this widget with the new total on change.)
    const { ctx } = opts?.withShipping
      ? this.buildKlarnaInstantContext(opts.shippingId, shippings)
      : { ctx: this.buildKlarnaPendingContext() }

    // 2. Persist the chosen shipping on the backend cart.
    const selectedOpt = shippings.find((s) => s.id === opts?.shippingId) ?? shippings[0]
    if (selectedOpt?.id && selectedOpt?.supplierId) {
      try {
        await this.updateShippingsBySupplier(
          [{ shipping_id: selectedOpt.id, supplier_id: Number(selectedOpt.supplierId) }],
          sponsorId,
        )
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[CheckoutManager] updateShippingsBySupplier failed during mount:', err)
        }
      }
    }

    // 3. Backend checkout (CreatePaymentKlarnaNative requires a checkout_id).
    let checkoutId = ctx.checkoutId ?? this.state.checkoutId
    try {
      const checkoutRes = await this.createCheckout(sponsorId)
      if (checkoutRes?.id) {
        checkoutId = checkoutRes.id
        ctx.checkoutId = checkoutRes.id
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[CheckoutManager] CreateCheckout before Klarna init failed:', err)
      }
    }
    if (!checkoutId) {
      throw new Error('[CheckoutManager] no backend checkout for the Klarna session')
    }

    // 4. Klarna Payments session via the commerce GraphQL (native flow).
    const address = this.state.address
    const activeCurrency = getGlobalCurrency()
    if (this.state) this.state = { ...this.state, currency: activeCurrency }
    ctx.currency = activeCurrency
    const variables = {
      checkoutId,
      countryCode: getGlobalCountryCode(),
      currency: activeCurrency,
      locale: getGlobalLocale(),
      returnUrl: resolveHttpsReturnUrl(null, {
        vio_payment: 'success',
        vio_method: 'klarna',
        vio_sponsor: sponsorId,
        checkout_id: checkoutId,
      }),
      intent: 'buy',
      customer: buildKlarnaCustomer(address),
      billingAddress: buildKlarnaAddress(address),
      shippingAddress: buildKlarnaAddress(address),
      autoCapture: true,
    }

    const json = await executeKlarnaGraphQL(
      CREATE_PAYMENT_KLARNA_NATIVE_MUTATION,
      variables,
      sponsorId,
    )
    const nativeRes = json?.data?.Payment?.CreatePaymentKlarnaNative
    if (!nativeRes || !nativeRes.client_token) {
      throw new Error('Klarna session creation failed: missing client_token')
    }
    if (nativeRes.checkout_id) {
      ctx.checkoutId = nativeRes.checkout_id
      this.state = { ...this.state, checkoutId: nativeRes.checkout_id }
    }
    if (nativeRes.session_id) {
      ctx.sessionId = nativeRes.session_id
      this.state = { ...this.state, sessionId: nativeRes.session_id }
    }
    ctx.clientToken = nativeRes.client_token
    this.state = { ...this.state, clientToken: nativeRes.client_token }

    // 5. Mount the inline widget and load the first category.
    const widget = await createKlarnaPaymentsWidget({
      clientToken: nativeRes.client_token,
      sessionId: nativeRes.session_id,
      categories: nativeRes.payment_method_categories ?? [],
      category: opts?.category,
      container,
    })
    await widget.load()

    return {
      categories: widget.categories,
      shippings,
      get selected() {
        return widget.selected
      },
      load: (category?: string) => widget.load(category),
      authorize: async (): Promise<void> => {
        try {
          // The session already carries the order (country/currency/lines);
          // Klarna collects customer details in its widget. Authorize with no
          // update payload to avoid any session/payload mismatch.
          const token = await widget.authorize()
          await this.completeKlarnaOrder(token, ctx, { authorizationToken: token })
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn('[VioCheckout] Klarna Payments authorize failed:', err)
          }
          this.dispatchEvent(
            new CustomEvent<PaymentErrorDetail>('payment-error', {
              detail: { method: 'klarna', error: describeError(err) },
            }),
          )
        }
      },
      unmount: () => {
        try {
          container.innerHTML = ''
        } catch {
          /* already gone */
        }
      },
    }
  }

  /** True if the Klarna Payments widget lib can load (UI gate). */
  async klarnaPaymentsAvailable(): Promise<boolean> {
    return isKlarnaPaymentsAvailable()
  }

  /** Cart snapshot + chosen shipping line/amount, for express purchases. */
  private buildKlarnaInstantContext(
    shippingId?: string,
    availableShippings: KlarnaShippingOption[] = [],
  ): {
    ctx: KlarnaPendingContext
    shippingOptions: KlarnaShippingOption[]
  } {
    const base = this.buildKlarnaPendingContext()
    const options = availableShippings.length > 0 ? availableShippings : KLARNA_SHIPPING_OPTIONS
    const shipping =
      (shippingId ? options.find((o) => o.id === shippingId) : undefined) ??
      options.find((o) => o.preselected) ??
      options[0]
    const orderLines = [...base.orderLines]
    if (shipping) {
      orderLines.push({
        name: `Frakt – ${shipping.method || shipping.name}`,
        quantity: 1,
        unit_price: shipping.price,
        total_amount: shipping.price,
        reference: `shipping:${shipping.id}`,
        type: 'shipping_fee',
      })
    }
    return {
      ctx: {
        ...base,
        orderLines,
        orderAmount: base.orderAmount + (shipping?.price ?? 0),
      },
      shippingOptions: options,
    }
  }

  /**
   * Express instant purchase — go straight to Klarna's own modal, no checkout
   * overlay. Creates a session (with shipping options), loads the widget into a
   * hidden container, then authorizes (which opens Klarna's confirm modal). On
   * approval creates the order → `payment-complete` (host shows confirmation);
   * on failure → `payment-error`. Call `open(sponsorId)` first.
   */
  async startKlarnaInstant(): Promise<void> {
    if (!this.state) throw new Error('[VioCheckout] no active checkout — call open() first')
    const sponsorId = this.state.sponsorId
    const fetchedShippings = await this.fetchAvailableShippings(sponsorId)
    const shippings = fetchedShippings.length > 0 ? fetchedShippings : KLARNA_SHIPPING_OPTIONS
    const { ctx } = this.buildKlarnaInstantContext(undefined, shippings)

    // 1. Backend checkout + Klarna Payments session via commerce GraphQL.
    let clientToken: string
    let categories: KlarnaPaymentsCategory[]
    try {
      let checkoutId = ctx.checkoutId ?? this.state.checkoutId
      try {
        const checkoutRes = await this.createCheckout(sponsorId)
        if (checkoutRes?.id) {
          checkoutId = checkoutRes.id
          ctx.checkoutId = checkoutRes.id
        }
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[CheckoutManager] CreateCheckout before Klarna instant failed:', err)
        }
      }
      if (!checkoutId) {
        throw new Error('[CheckoutManager] no backend checkout for the Klarna session')
      }

      const address = this.state.address
      const activeCurrency = getGlobalCurrency()
      this.state = { ...this.state, currency: activeCurrency }
      ctx.currency = activeCurrency
      const variables = {
        checkoutId,
        countryCode: getGlobalCountryCode(),
        currency: activeCurrency,
        locale: getGlobalLocale(),
        returnUrl: resolveHttpsReturnUrl(null, {
          vio_payment: 'success',
          vio_method: 'klarna',
          vio_sponsor: sponsorId,
          checkout_id: checkoutId,
        }),
        intent: 'buy',
        customer: buildKlarnaCustomer(address),
        billingAddress: buildKlarnaAddress(address),
        shippingAddress: buildKlarnaAddress(address),
        autoCapture: true,
      }

      const json = await executeKlarnaGraphQL(
        CREATE_PAYMENT_KLARNA_NATIVE_MUTATION,
        variables,
        sponsorId,
      )
      const nativeRes = json?.data?.Payment?.CreatePaymentKlarnaNative
      if (!nativeRes || !nativeRes.client_token) {
        throw new Error('Klarna instant session failed: missing client_token')
      }
      if (nativeRes.checkout_id) {
        ctx.checkoutId = nativeRes.checkout_id
        this.state = { ...this.state, checkoutId: nativeRes.checkout_id }
      }
      if (nativeRes.session_id) {
        ctx.sessionId = nativeRes.session_id
        this.state = { ...this.state, sessionId: nativeRes.session_id }
      }
      ctx.clientToken = nativeRes.client_token
      this.state = { ...this.state, clientToken: nativeRes.client_token }
      clientToken = nativeRes.client_token
      categories = nativeRes.payment_method_categories ?? []
    } catch (err) {
      this.dispatchEvent(
        new CustomEvent<PaymentErrorDetail>('payment-error', {
          detail: { method: 'klarna', error: describeError(err) },
        }),
      )
      return
    }

    // 2. Hidden container → load → authorize (opens Klarna's own modal).
    const container = document.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;'
    document.body.appendChild(container)
    try {
      const widget = await createKlarnaPaymentsWidget({
        clientToken,
        sessionId: ctx.sessionId,
        categories,
        container,
      })
      await widget.load()
      const token = await widget.authorize()
      await this.completeKlarnaOrder(token, ctx, { authorizationToken: token })
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCheckout] Klarna instant failed:', err)
      }
      this.dispatchEvent(
        new CustomEvent<PaymentErrorDetail>('payment-error', {
          detail: { method: 'klarna', error: describeError(err) },
        }),
      )
    } finally {
      try {
        container.remove()
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * REDIRECT path: call once on app load. If a Klarna purchase was launched
   * (pending context persisted) and we're back with a token — from the URL or
   * the SDK's resumed `complete` event — finish creating the order + confirm.
   */
  async resumeKlarnaReturn(): Promise<void> {
    if (typeof sessionStorage === 'undefined') return
    const raw = sessionStorage.getItem(KLARNA_PENDING_KEY)
    if (!raw) return
    let pending: KlarnaPendingContext
    try {
      pending = JSON.parse(raw) as KlarnaPendingContext
    } catch {
      sessionStorage.removeItem(KLARNA_PENDING_KEY)
      return
    }

    // 1) Token already in the URL (most redirect flows append it).
    const fromUrl = readKlarnaTokenFromUrl()
    if (fromUrl) {
      cleanUrlParams([fromUrl.param])
      await this.completeKlarnaOrder(fromUrl.token, pending, { authorizationToken: fromUrl.token })
      return
    }

    // No recognised token param — log what Klarna actually returned so the
    // param name can be mapped if the SDK `complete` event doesn't fire.
    if (typeof window !== 'undefined' && typeof console !== 'undefined' && window.location.search) {
      console.warn(
        '[VioCheckout] Klarna return: no known token param. URL was:',
        window.location.search,
      )
    }

    // 2) Otherwise let the SDK resume its session and fire `complete`.
    const cfg = Configuration.isInitialized ? Configuration.get() : null
    if (!cfg?.klarnaClientId) return
    await listenForKlarnaCompletion({
      config: { clientId: cfg.klarnaClientId, locale: getGlobalLocale(), environment: cfg.klarnaEnvironment },
      onComplete: (result) => {
        void this.completeKlarnaOrder(result.authorizationToken, pending, result)
      },
      onError: (err) => {
        if (typeof console !== 'undefined') {
          console.warn('[VioCheckout] Klarna resume error:', err)
        }
      },
    })
  }

  /** Snapshot of the active cart for redirect recovery (minor units). */
  private buildKlarnaPendingContext(): KlarnaPendingContext {
    if (!this.state) throw new Error('[VioCheckout] no active checkout')
    const currency = this.state.currency
    return {
      sponsorId: this.state.sponsorId,
      currency,
      orderAmount: toSmallestUnit(this.state.subtotal, currency),
      orderLines: this.items.map((item) => {
        const unitPrice = toSmallestUnit(item.unitPrice, currency)
        return {
          name: item.name || item.brand || 'Produkt',
          quantity: item.quantity,
          unit_price: unitPrice,
          total_amount: unitPrice * item.quantity,
          reference: String(item.productId),
        }
      }),
    }
  }

  /**
   * POST the token + order lines to vio-backend (it holds the secret API key
   * and creates the real Klarna order). On success → `payment-complete`; on
   * failure → `payment-error`. Idempotent: clears the pending key so the
   * popup and redirect paths can't double-fire.
   */
  private async completeKlarnaOrder(
    authorizationToken: string,
    ctx: KlarnaPendingContext,
    result: KlarnaAuthorizeResult,
  ): Promise<void> {
    // Idempotency guard — first caller wins (also without sessionStorage).
    if (this.klarnaOrderInFlight) return
    this.klarnaOrderInFlight = true
    // A token can only be confirmed once — a retry with an already-confirmed
    // token (network blip after a successful confirm) would create a second
    // order with autoCapture: double charge.
    if (
      typeof sessionStorage !== 'undefined' &&
      sessionStorage.getItem('vio.klarna.confirmed.v1') === authorizationToken
    ) {
      this.klarnaOrderInFlight = false
      return
    }
    try {
      const checkoutId =
        ctx?.checkoutId ?? this.state?.checkoutId ?? String(ctx?.sponsorId ?? this.state?.sponsorId ?? '')
      const address = this.state?.address
      const variables = {
        checkoutId,
        authorizationToken,
        autoCapture: true,
        billingAddress: buildKlarnaAddress(address),
        shippingAddress: buildKlarnaAddress(address),
        customer: buildKlarnaCustomer(address),
      }

      const json = await executeKlarnaGraphQL(
        CONFIRM_PAYMENT_KLARNA_NATIVE_MUTATION,
        variables,
        ctx?.sponsorId ?? this.state?.sponsorId,
      )
      const confirmRes = json?.data?.Payment?.ConfirmPaymentKlarnaNative
      if (!confirmRes) {
        throw new Error('Klarna order confirmation failed: missing response data')
      }
      const orderData = confirmRes.order || confirmRes

      // Success: only NOW is the pending context consumed (keeping it until
      // here lets the redirect path retry a confirm that never ran).
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('vio.klarna.confirmed.v1', authorizationToken)
        sessionStorage.removeItem(KLARNA_PENDING_KEY)
      }

      // Synthesize a checkout state for the confirmation if the live one was
      // lost to a redirect reload.
      const state: CheckoutState =
        this.state ?? { sponsorId: ctx.sponsorId, subtotal: ctx.orderAmount, currency: ctx.currency }
      this.dispatchEvent(
        new CustomEvent<PaymentCompleteDetail>('payment-complete', {
          detail: {
            method: 'klarna',
            state,
            // chargedTotal in MAJOR units (incl. shipping for express) for the
            // confirmation screen. ctx.orderAmount is minor (øre) → /100.
            // Prefer the amount Klarna actually charged (includes shipping in
            // every flow); the local ctx misses shipping outside express.
            result: {
              ...result,
              order: orderData,
              chargedTotal:
                typeof orderData?.order_amount === 'number'
                  ? orderData.order_amount / 100
                  : ctx.orderAmount / 100,
            },
          },
        }),
      )
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.error('[VioCheckout] Klarna order creation failed:', err)
      }
      this.dispatchEvent(
        new CustomEvent<PaymentErrorDetail>('payment-error', {
          detail: { method: 'klarna', error: err instanceof Error ? err.message : String(err) },
        }),
      )
    } finally {
      this.klarnaOrderInFlight = false
    }
  }

  // MARK: - Accessors

  get currentState(): CheckoutState | null {
    return this.state
  }

  get items(): CartLineItem[] {
    if (!this.state) return []
    return this.cartManager.getCart(this.state.sponsorId)?.items ?? []
  }

  // MARK: - Internals

  /**
   * Resolve the Stripe Connect account for the active sponsor — for now
   * pulled from bootstrap cache if present. Returns undefined if not set
   * (Stripe will route to the platform account in that case).
   */
  private findStripeConnectAccount(): string | undefined {
    // Placeholder hook — when bootstrap exposes per-sponsor stripeAccount
    // we'll wire it here. For now returns undefined.
    return undefined
  }

  private emit(): void {
    this.dispatchEvent(
      new CustomEvent<CheckoutChangeDetail>('change', { detail: { state: this.state } }),
    )
  }
}

/**
 * Stripe expects amounts in the smallest currency unit. NOK/SEK/DKK/EUR/USD
 * are all hundredths (øre, öre, øre, cents, cents). JPY is the exception
 * (no fractional unit).
 */
function toSmallestUnit(amount: number, currency: string): number {
  const zeroDecimal = new Set(['JPY', 'KRW', 'VND'])
  if (zeroDecimal.has(currency.toUpperCase())) return Math.round(amount)
  return Math.round(amount * 100)
}
