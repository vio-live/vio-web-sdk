/**
 * Apple Pay on the Web — via Stripe Payment Request API.
 *
 * Architecture decision (matches iOS Vio SDK pattern):
 *   - One Stripe **publishable key** for the Vio platform (global, set
 *     via `Vio.init({ stripePublishableKey })`).
 *   - One **Stripe Connect account id** per sponsor — sourced from
 *     `Vio.bootstrap()` response. Without it, the payment lands on the
 *     platform account instead of the merchant.
 *
 * Apple Pay on the Web prerequisites (Stripe-managed for us):
 *   - Stripe Connect account is enabled for Apple Pay
 *   - Domain registration for Apple Pay (Stripe handles via Dashboard)
 *   - Safari + macOS/iOS device with Apple Pay configured
 *
 * In Chrome / non-Apple browsers `canMakePayment()` returns null, so the
 * UI hides the Apple Pay button automatically.
 */

const STRIPE_JS_URL = 'https://js.stripe.com/v3'

export interface ApplePayConfig {
  /** Stripe platform publishable key (pk_live_xxx or pk_test_xxx). */
  publishableKey: string
  /** Sponsor's Stripe Connect account (acct_xxx). Optional but recommended. */
  connectedAccount?: string
  /** Amount in the smallest unit of the currency (e.g. øre for NOK, cents for USD). */
  amount: number
  /** ISO currency code, lowercased internally for Stripe. */
  currency: string
  /** Two-letter country code, e.g. "NO". */
  country: string
  /** Label shown in the Apple Pay sheet (merchant or order name). */
  label: string
  /** Whether to ask the user for payer name. */
  requestPayerName?: boolean
  /** Whether to ask the user for payer email. */
  requestPayerEmail?: boolean
  /** Whether to ask for shipping address. */
  requestShipping?: boolean
  /**
   * Shipping options shown natively in the Apple Pay sheet. `amount` is in the
   * smallest unit (øre). When set, `requestShipping` is forced on and the sheet
   * total = `amount` (items) + the selected option; switching options updates
   * the total live (Apple Pay native shipping).
   */
  shippingOptions?: Array<{ id: string; label: string; detail?: string; amount: number }>
}

export interface ApplePayResult {
  /** Stripe PaymentMethod id (pm_xxx) — pass to backend to confirm the PaymentIntent. */
  paymentMethodId: string
  payerName?: string
  payerEmail?: string
  payerPhone?: string
  shippingAddress?: {
    line1?: string
    line2?: string
    city?: string
    postal_code?: string
    state?: string
    country?: string
  }
}

let stripeJsPromise: Promise<unknown> | null = null

/** Dynamically load Stripe.js exactly once. */
function loadStripeJs(): Promise<unknown> {
  if (stripeJsPromise) return stripeJsPromise
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('[VioApplePay] Stripe.js requires a browser environment'))
  }
  stripeJsPromise = new Promise<unknown>((resolve, reject) => {
    const w = window as unknown as { Stripe?: unknown }
    if (w.Stripe) {
      resolve(w.Stripe)
      return
    }
    const existing = document.querySelector(
      `script[src^="${STRIPE_JS_URL}"]`,
    ) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve(w.Stripe))
      existing.addEventListener('error', () =>
        reject(new Error('[VioApplePay] Failed to load Stripe.js')),
      )
      return
    }
    const script = document.createElement('script')
    script.src = STRIPE_JS_URL
    script.async = true
    script.addEventListener('load', () => resolve(w.Stripe))
    script.addEventListener('error', () =>
      reject(new Error('[VioApplePay] Failed to load Stripe.js')),
    )
    document.head.appendChild(script)
  })
  return stripeJsPromise
}

interface StripeCanMakePaymentResult {
  applePay?: boolean
  googlePay?: boolean
  link?: boolean
}

interface StripePaymentRequest {
  canMakePayment(): Promise<StripeCanMakePaymentResult | null>
  show(): void
  on(event: string, handler: (ev: unknown) => void): void
}

interface StripeInstance {
  paymentRequest(options: Record<string, unknown>): StripePaymentRequest
}

type StripeFactory = (
  publishableKey: string,
  options?: { stripeAccount?: string },
) => StripeInstance

async function getStripe(config: ApplePayConfig): Promise<StripeInstance> {
  const Stripe = (await loadStripeJs()) as StripeFactory
  return Stripe(
    config.publishableKey,
    config.connectedAccount ? { stripeAccount: config.connectedAccount } : undefined,
  )
}

function buildRequestOptions(config: ApplePayConfig): Record<string, unknown> {
  const ship = config.shippingOptions
  // With shipping options, the sheet's total = items + the (first/selected) option.
  const preselectedShipping = ship && ship.length > 0 ? ship[0]!.amount : 0
  return {
    country: config.country,
    currency: config.currency.toLowerCase(),
    total: { label: config.label, amount: config.amount + preselectedShipping },
    requestPayerName: config.requestPayerName ?? true,
    requestPayerEmail: config.requestPayerEmail ?? true,
    requestShipping: ship && ship.length > 0 ? true : (config.requestShipping ?? false),
    ...(ship && ship.length > 0 ? { shippingOptions: ship } : {}),
    disableWallets: ['link', 'googlePay'],
  }
}

/**
 * Check whether Apple Pay is available right now (Safari + supported device
 * + Stripe configured + domain registered).
 *
 * Returns false on any failure path — never throws.
 */
export async function checkApplePayAvailability(config: ApplePayConfig): Promise<boolean> {
  if (typeof window === 'undefined') return false
  // Quick precheck — Apple Pay is only on Safari + supported macOS/iOS devices.
  if (typeof (window as unknown as { ApplePaySession?: unknown }).ApplePaySession === 'undefined') {
    return false
  }
  if (!config.publishableKey) return false
  try {
    const stripe = await getStripe(config)
    const pr = stripe.paymentRequest(buildRequestOptions(config))
    const result = await pr.canMakePayment()
    return !!result?.applePay
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[VioApplePay] availability check failed:', err)
    }
    return false
  }
}

/**
 * Show the Apple Pay sheet. Resolves with the payment method id (`pm_xxx`)
 * after the user authorises, or rejects on cancel / error.
 *
 * The backend must then confirm a Stripe PaymentIntent with this
 * payment method id (server-side step, not handled here).
 */
export async function showApplePaySheet(config: ApplePayConfig): Promise<ApplePayResult> {
  if (!config.publishableKey) {
    throw new Error('[VioApplePay] publishableKey is required')
  }
  const stripe = await getStripe(config)
  const pr = stripe.paymentRequest(buildRequestOptions(config))
  const canMake = await pr.canMakePayment()
  if (!canMake?.applePay) {
    throw new Error('[VioApplePay] Apple Pay is not available on this device')
  }
  return new Promise<ApplePayResult>((resolve, reject) => {
    let settled = false
    pr.on('paymentmethod', (raw: unknown) => {
      const ev = raw as {
        paymentMethod: { id: string }
        payerName?: string
        payerEmail?: string
        payerPhone?: string
        shippingAddress?: ApplePayResult['shippingAddress']
        complete: (status: 'success' | 'fail') => void
      }
      settled = true
      // We complete with 'success' optimistically. In a real flow the
      // backend confirms the PaymentIntent first, and only then we'd
      // call `ev.complete('success')` (or 'fail' on error).
      ev.complete('success')
      resolve({
        paymentMethodId: ev.paymentMethod.id,
        payerName: ev.payerName,
        payerEmail: ev.payerEmail,
        payerPhone: ev.payerPhone,
        shippingAddress: ev.shippingAddress,
      })
    })
    pr.on('cancel', () => {
      if (settled) return
      reject(new Error('[VioApplePay] User cancelled Apple Pay'))
    })
    pr.show()
  })
}

export interface PreparedApplePay {
  /** True if Apple Pay can be shown (canMakePayment resolved with applePay). */
  available: boolean
  /**
   * Open the Apple Pay sheet. MUST be invoked synchronously from the click
   * handler — the async work (Stripe.js load + canMakePayment) already ran in
   * `prepareApplePay`, so this fires `pr.show()` inside the user gesture. Apple
   * blocks the sheet if `show()` is reached after an `await`.
   */
  show(): Promise<ApplePayResult>
}

/**
 * Pre-create the Apple Pay PaymentRequest and resolve `canMakePayment()` ahead
 * of the click. Express buttons should call this on load/render, then call the
 * returned `show()` synchronously on tap — preserving the user gesture that
 * Apple requires to open the sheet.
 */
export async function prepareApplePay(config: ApplePayConfig): Promise<PreparedApplePay> {
  const unavailable = (msg: string): PreparedApplePay => ({
    available: false,
    show: () => Promise.reject(new Error(msg)),
  })
  if (typeof window === 'undefined' || !config.publishableKey) {
    return unavailable('[VioApplePay] unavailable')
  }
  if (typeof (window as unknown as { ApplePaySession?: unknown }).ApplePaySession === 'undefined') {
    return unavailable('[VioApplePay] ApplePaySession not available')
  }
  try {
    const stripe = await getStripe(config)
    const pr = stripe.paymentRequest(buildRequestOptions(config))
    // Recompute the total live when the user switches shipping option in the
    // Apple Pay sheet: total = items (config.amount) + chosen option amount.
    if (config.shippingOptions && config.shippingOptions.length > 0) {
      pr.on('shippingoptionchange', (raw: unknown) => {
        const ev = raw as {
          shippingOption?: { id?: string }
          updateWith: (u: Record<string, unknown>) => void
        }
        const opt = config.shippingOptions?.find((o) => o.id === ev.shippingOption?.id)
        ev.updateWith({
          status: 'success',
          total: { label: config.label, amount: config.amount + (opt?.amount ?? 0) },
        })
      })
    }
    const result = await pr.canMakePayment()
    if (!result?.applePay) return unavailable('[VioApplePay] Apple Pay not available')
    return {
      available: true,
      show(): Promise<ApplePayResult> {
        return new Promise<ApplePayResult>((resolve, reject) => {
          let settled = false
          pr.on('paymentmethod', (raw: unknown) => {
            const ev = raw as {
              paymentMethod: { id: string }
              payerName?: string
              payerEmail?: string
              payerPhone?: string
              shippingAddress?: ApplePayResult['shippingAddress']
              complete: (status: 'success' | 'fail') => void
            }
            settled = true
            ev.complete('success')
            resolve({
              paymentMethodId: ev.paymentMethod.id,
              payerName: ev.payerName,
              payerEmail: ev.payerEmail,
              payerPhone: ev.payerPhone,
              shippingAddress: ev.shippingAddress,
            })
          })
          pr.on('cancel', () => {
            if (!settled) reject(new Error('[VioApplePay] User cancelled Apple Pay'))
          })
          pr.show() // synchronous — must run inside the click gesture
        })
      },
    }
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[VioApplePay] prepare failed:', err)
    }
    return unavailable('[VioApplePay] prepare failed')
  }
}
