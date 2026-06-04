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
  private klarnaAvailableCache: boolean | null = null
  private klarnaOrderInFlight = false

  constructor(private readonly cartManager: CartManager) {
    super()
  }

  open(sponsorId: number): CheckoutState {
    const cart = this.cartManager.getCart(sponsorId)
    if (!cart || cart.items.length === 0) {
      throw new Error(`[VioCheckout] sponsor ${sponsorId} has no cart items`)
    }
    this.state = {
      sponsorId,
      subtotal: this.cartManager.subtotalForSponsor(sponsorId),
      currency: cart.currency,
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
    if (!cfg?.stripePublishableKey) return { available: false, show: async () => {} }
    const prepared = await prepareApplePay({
      publishableKey: cfg.stripePublishableKey,
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
  ): Promise<{ available: boolean; show: () => Promise<ApplePayResult | null> }> {
    const cfg = Configuration.isInitialized ? Configuration.get() : null
    if (!cfg?.stripePublishableKey) return { available: false, show: async () => null }
    const prepared = await prepareApplePay({
      publishableKey: cfg.stripePublishableKey,
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

  /**
   * Launches the Apple Pay sheet. Resolves with the Stripe PaymentMethod
   * id once the user authorises — the backend then confirms the
   * PaymentIntent with that id to actually capture the funds.
   */
  async startApplePay(options: {
    country?: string
    label?: string
  } = {}): Promise<ApplePayResult> {
    if (!this.state) throw new Error('[VioCheckout] no active checkout — call open() first')
    const cfg = Configuration.get()
    if (!cfg.stripePublishableKey) {
      throw new Error(
        '[VioCheckout] No Stripe publishable key configured. Pass `stripePublishableKey` to Vio.init({ ... }).',
      )
    }
    const amount = toSmallestUnit(this.state.subtotal, this.state.currency)
    const result = await showApplePaySheet({
      publishableKey: cfg.stripePublishableKey,
      connectedAccount: this.findStripeConnectAccount() ?? undefined,
      amount,
      currency: this.state.currency,
      country: options.country ?? 'NO',
      label: options.label ?? 'Vio',
    })
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
      locale: 'nb-NO',
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
        locale: 'nb-NO',
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
    opts?: { withShipping?: boolean; shippingId?: string },
  ): Promise<KlarnaPaymentsHandle> {
    if (!this.state) throw new Error('[VioCheckout] no active checkout — call open() first')
    const cfg = Configuration.get()
    // With shipping: add the CHOSEN shipping option as a shipping_fee line +
    // bump the total. (Klarna Payments doesn't render a picker; ours lives in
    // the checkout UI and re-mounts this widget with the new total on change.)
    const { ctx, shippingOptions } = opts?.withShipping
      ? this.buildKlarnaInstantContext(opts.shippingId)
      : { ctx: this.buildKlarnaPendingContext(), shippingOptions: undefined }

    // 1. Create the Payments session on the backend (it holds the API key).
    const res = await fetch(`${cfg.apiBase}/v2/commerce/klarna/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
      body: JSON.stringify({
        currency: ctx.currency,
        purchaseCountry: 'NO',
        locale: 'nb-NO',
        orderAmount: ctx.orderAmount,
        orderLines: ctx.orderLines,
        ...(shippingOptions ? { shippingOptions } : {}),
      }),
    })
    const json = (await res.json().catch(() => ({}))) as {
      error?: string
      clientToken?: string
      paymentMethodCategories?: KlarnaPaymentsCategory[]
    }
    if (!res.ok || !json.clientToken) {
      throw new Error(json?.error ?? `Klarna session failed (HTTP ${res.status})`)
    }

    // 2. Mount the inline widget and load the first category.
    const widget = await createKlarnaPaymentsWidget({
      clientToken: json.clientToken,
      categories: json.paymentMethodCategories ?? [],
      container,
    })
    await widget.load()

    return {
      categories: widget.categories,
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
  private buildKlarnaInstantContext(shippingId?: string): {
    ctx: KlarnaPendingContext
    shippingOptions: typeof KLARNA_SHIPPING_OPTIONS
  } {
    const base = this.buildKlarnaPendingContext()
    const shipping =
      (shippingId ? KLARNA_SHIPPING_OPTIONS.find((o) => o.id === shippingId) : undefined) ??
      KLARNA_SHIPPING_OPTIONS.find((o) => o.preselected) ??
      KLARNA_SHIPPING_OPTIONS[0]
    const orderLines = [...base.orderLines]
    if (shipping) {
      orderLines.push({
        name: `Frakt – ${shipping.method}`,
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
      shippingOptions: KLARNA_SHIPPING_OPTIONS,
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
    const cfg = Configuration.get()
    const { ctx, shippingOptions } = this.buildKlarnaInstantContext()

    // 1. Session on the backend (it holds the API key) — includes shipping.
    let clientToken: string
    let categories: KlarnaPaymentsCategory[]
    try {
      const res = await fetch(`${cfg.apiBase}/v2/commerce/klarna/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
        body: JSON.stringify({
          currency: ctx.currency,
          purchaseCountry: 'NO',
          locale: 'nb-NO',
          orderAmount: ctx.orderAmount,
          orderLines: ctx.orderLines,
          shippingOptions,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string
        clientToken?: string
        paymentMethodCategories?: KlarnaPaymentsCategory[]
      }
      if (!res.ok || !json.clientToken) {
        throw new Error(json?.error ?? `Klarna session failed (HTTP ${res.status})`)
      }
      clientToken = json.clientToken
      categories = json.paymentMethodCategories ?? []
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
      const widget = await createKlarnaPaymentsWidget({ clientToken, categories, container })
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
      config: { clientId: cfg.klarnaClientId, locale: 'nb-NO', environment: cfg.klarnaEnvironment },
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
    if (typeof sessionStorage !== 'undefined') {
      // Idempotency guard — first caller wins.
      if (this.klarnaOrderInFlight) return
      this.klarnaOrderInFlight = true
      sessionStorage.removeItem(KLARNA_PENDING_KEY)
    }
    const cfg = Configuration.get()
    try {
      const res = await fetch(`${cfg.apiBase}/v2/commerce/klarna/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
        body: JSON.stringify({
          authorizationToken,
          purchaseCountry: 'NO',
          currency: ctx.currency,
          locale: 'nb-NO',
          orderAmount: ctx.orderAmount,
          orderLines: ctx.orderLines,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string; orderId?: string }
      if (!res.ok) throw new Error(json?.error ?? `Klarna order failed (HTTP ${res.status})`)

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
            result: { ...result, order: json, chargedTotal: ctx.orderAmount / 100 },
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
