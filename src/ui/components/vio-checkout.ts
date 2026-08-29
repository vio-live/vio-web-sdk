/**
 * <vio-checkout> — full-screen native checkout overlay, reactively bound
 * to `Vio.checkout` (CheckoutManager).
 *
 * Subscribes to checkout state on connect, renders address form + payment
 * method buttons + order summary. Apple Pay is auto-detected via Stripe
 * Payment Request — button is hidden when unavailable (e.g. Chrome on
 * non-Apple device, or no Stripe key configured).
 */

import { LitElement, css, html } from 'lit'
import { property, state } from 'lit/decorators.js'
import { Vio } from '../../core/client.js'
import { formatPrice, getGlobalCurrency } from '../../core/types.js'
import type { CartLineItem } from '../../core/cart/types.js'
import type {
  CheckoutChangeDetail,
  KlarnaPaymentsHandle,
  KlarnaShippingOption,
} from '../../core/checkout/checkout-manager.js'
import type {
  CheckoutAddress,
  CheckoutState,
  PaymentMethod,
} from '../../core/checkout/types.js'

/** Stripe wordmark, inlined so the published article needs no asset path.
 * (Duplicated in vio-cart.ts — tiny constant, avoids a shared-module dance.) */
const STRIPE_LOGO_SRC =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg width="360" height="150" viewBox="0 0 360 150" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M360 77.4001C360 51.8001 347.6 31.6001 323.9 31.6001C300.1 31.6001 285.7 51.8001 285.7 77.2001C285.7 107.3 302.7 122.5 327.1 122.5C339 122.5 348 119.8 354.8 116V96.0001C348 99.4001 340.2 101.5 330.3 101.5C320.6 101.5 312 98.1001 310.9 86.3001H359.8C359.8 85.0001 360 79.8001 360 77.4001ZM310.6 67.9001C310.6 56.6001 317.5 51.9001 323.8 51.9001C329.9 51.9001 336.4 56.6001 336.4 67.9001H310.6Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M247.1 31.6001C237.3 31.6001 231 36.2001 227.5 39.4001L226.2 33.2001H204.2V149.8L229.2 144.5L229.3 116.2C232.9 118.8 238.2 122.5 247 122.5C264.9 122.5 281.2 108.1 281.2 76.4001C281.1 47.4001 264.6 31.6001 247.1 31.6001ZM241.1 100.5C235.2 100.5 231.7 98.4001 229.3 95.8001L229.2 58.7001C231.8 55.8001 235.4 53.8001 241.1 53.8001C250.2 53.8001 256.5 64.0001 256.5 77.1001C256.5 90.5001 250.3 100.5 241.1 100.5Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M169.8 25.7L194.9 20.3V0L169.8 5.3V25.7Z" fill="#533AFD"/><path d="M194.9 33.3H169.8V120.8H194.9V33.3Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M142.9 40.7L141.3 33.3H119.7V120.8H144.7V61.5C150.6 53.8 160.6 55.2 163.7 56.3V33.3C160.5 32.1 148.8 29.9 142.9 40.7Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M92.8999 11.6001L68.4999 16.8001L68.3999 96.9001C68.3999 111.7 79.4999 122.6 94.2999 122.6C102.5 122.6 108.5 121.1 111.8 119.3V99.0001C108.6 100.3 92.7999 104.9 92.7999 90.1001V54.6001H111.8V33.3001H92.7999L92.8999 11.6001Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M25.3 58.7001C25.3 54.8001 28.5 53.3001 33.8 53.3001C41.4 53.3001 51 55.6001 58.6 59.7001V36.2001C50.3 32.9001 42.1 31.6001 33.8 31.6001C13.5 31.6001 0 42.2001 0 59.9001C0 87.5001 38 83.1001 38 95.0001C38 99.6001 34 101.1 28.4 101.1C20.1 101.1 9.5 97.7001 1.1 93.1001V116.9C10.4 120.9 19.8 122.6 28.4 122.6C49.2 122.6 63.5 112.3 63.5 94.4001C63.4 64.6001 25.3 69.9001 25.3 58.7001Z" fill="#533AFD"/></svg>',
  )

export class VioCheckout extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false
  @property({ type: String }) heading = 'Kasse'
  @property({ type: String, attribute: 'shipping-label' })
  shippingLabel = 'Beregnes ved kasse'
  /** Express mode — render only the Klarna widget (no address form / method grid). */
  @property({ type: Boolean, reflect: true }) express = false

  @state() private checkoutState: CheckoutState | null = null
  @state() private items: CartLineItem[] = []
  @state() private applePayAvailable = false
  @state() private applePayInProgress = false
  @state() private klarnaAvailable = false
  @state() private orderConfirmed = false
  @state() private confirmedMethod: PaymentMethod | null = null
  @state() private paymentError: string | null = null
  /** Neutral (non-error) status line: "verifying payment…" / "still processing". */
  @state() private paymentNotice: string | null = null
  /** Snapshot of the placed order, for the confirmation screen. */
  @state() private confirmedOrder: {
    items: CartLineItem[]
    currency: string
    total: number
    orderId?: string
  } | null = null

  /** Active Klarna Payments widget handle + the subtotal it was mounted for. */
  private klarnaHandle: KlarnaPaymentsHandle | null = null
  private klarnaMountedAmount: number | null = null
  private klarnaMountedShipping: string | null = null
  private klarnaMounting = false
  /** Categories offered by the active Klarna session + the selected one. */
  @state() private klarnaCategories: KlarnaPaymentsHandle['categories'] = []
  @state() private klarnaSelectedCat = ''
  @state() private klarnaAuthorizing = false
  /** Chosen shipping option id (express flow) — drives the Klarna order total. */
  @state() private selectedShipping = ''
  /** Real per-supplier shippings from the backend. */
  @state() private availableShippingsList: KlarnaShippingOption[] = []
  /** Payment method names enabled for the sponsor (backend-configured).
   * null = not loaded yet → all buttons render; [] = none enabled. */
  @state() private availableMethods: string[] | null = null
  @state() private kustomMounting = false
  private kustomMountedOrderId: string | null = null
  @state() private qliroMounting = false
  private qliroMountedOrderId: string | null = null
  /** Redirecting to the Stripe / Vipps hosted page. */
  @state() private stripeLoading = false
  @state() private vippsLoading = false
  @state() private form: CheckoutAddress = {
    firstName: '',
    lastName: '',
    email: '',
    address: '',
    postalCode: '',
    city: '',
  }
  /** In-flight guard for loadAvailablePaymentMethods. */
  private loadingPaymentMethods = false
  /** In-flight + attempted guards for loadAvailableShippings (change events
   * fire per keystroke — without these, typing an address hammers the API). */
  private loadingShippings = false
  private shippingsAttempted = false

  private boundOnCheckoutChange = (e: Event): void => {
    const detail = (e as CustomEvent<CheckoutChangeDetail>).detail
    const prevSponsorId = this.checkoutState?.sponsorId
    const sponsorChanged = !prevSponsorId || prevSponsorId !== detail.state?.sponsorId
    this.checkoutState = detail.state
    this.items = Vio.checkout.items
    // Re-check vendor availability when the sponsor changes (state changes fire
    // on every selection — refetching each time hammers the backend).
    if (this.checkoutState) {
      if (sponsorChanged || this.availableMethods === null) {
        void this.refreshApplePay()
        void this.refreshKlarna()
        void this.loadAvailablePaymentMethods()
        void this.loadAvailableShippings()
      } else if (!this.shippingsAttempted) {
        void this.loadAvailableShippings()
      }
    } else {
      this.applePayAvailable = false
      this.klarnaAvailable = false
      this.orderConfirmed = false
      this.confirmedMethod = null
      this.confirmedOrder = null
      this.paymentError = null
      this.paymentNotice = null
      this.express = false
      this.availableMethods = null
      this.unmountKlarna()
    }
  }

  private boundOnPaymentComplete = (e: Event): void => {
    const detail = (
      e as CustomEvent<{ method: string; state?: { sponsorId: number }; result: unknown }>
    ).detail
    // Klarna (after server order creation) and Apple Pay (after the sheet
    // authorizes) both reach the same confirmation drawer. Other methods
    // (Vipps/Card) confirm via the plain CTA, not this event.
    if (detail.method !== 'klarna' && detail.method !== 'apple-pay') return
    const sponsorId = detail.state?.sponsorId ?? this.checkoutState?.sponsorId
    if (sponsorId == null) return
    this.confirmOrder(detail.method as PaymentMethod, sponsorId, detail.result)
  }

  private boundOnPaymentError = (e: Event): void => {
    const detail = (e as CustomEvent<{ method: string; error: string }>).detail
    this.paymentError =
      detail.method === 'klarna'
        ? `Klarna-betalingen kunne ikke fullføres: ${detail.error}`
        : detail.error
    // A redirect failure lands with the overlay closed — open it so the error
    // is visible rather than silently dropping the user on the home page.
    this.open = true
  }

  static override styles = css`
    :host { display: contents; }
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
      z-index: 999;
    }
    :host([open]) .backdrop { opacity: 1; pointer-events: auto; }

    .modal {
      position: fixed;
      inset: 0;
      background: var(--vio-color-surface, #fff);
      transform: translateY(100%);
      transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1);
      display: flex;
      flex-direction: column;
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
      color: var(--vio-color-text, #0a0a0a);
      z-index: 1000;
      overflow-y: auto;
    }
    :host([open]) .modal { transform: translateY(0); }

    /* Confirmation drawer — compact bottom sheet, not the full-screen overlay. */
    .modal.as-drawer {
      inset: auto 0 0 0;
      height: auto;
      max-height: 88vh;
      max-width: 460px;
      margin: 0 auto;
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.18);
    }
    .modal.as-drawer .handle {
      display: flex;
      justify-content: center;
      padding: 10px 0 4px;
      flex-shrink: 0;
    }
    .modal.as-drawer .handle::before {
      content: '';
      width: 40px;
      height: 4px;
      background: var(--vio-color-border, #e5e5e5);
      border-radius: 2px;
    }

    /* Express (Apple Pay-style): right-side drawer, like the cart. Slides in
       from the right instead of the full-screen overlay. */
    .modal.as-side {
      inset: 0 0 0 auto;
      width: min(440px, 100%);
      max-width: 440px;
      transform: translateX(100%);
      border-radius: 0;
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.1);
    }
    :host([open]) .modal.as-side { transform: translateX(0); }

    /* Desktop: the checkout ALWAYS lives as a right-side panel (like the cart,
       product detail and express drawer) — never a full-width overlay. Only the
       compact confirmation card stays centered. */
    @media (min-width: 601px) {
      .modal:not(.as-confirm) {
        inset: 0 0 0 auto;
        width: min(440px, 100%);
        max-width: 440px;
        transform: translateX(100%);
        border-radius: 0;
        box-shadow: -8px 0 24px rgba(0, 0, 0, 0.1);
      }
      :host([open]) .modal:not(.as-confirm) { transform: translateX(0); }
    }
    @media (max-width: 600px) {
      /* On phones, keep it a bottom sheet for reachability. */
      .modal.as-side {
        inset: auto 0 0 0;
        width: 100%;
        max-width: none;
        height: 92vh;
        transform: translateY(100%);
        border-radius: 16px 16px 0 0;
      }
      :host([open]) .modal.as-side { transform: translateY(0); }
    }

    /* Confirmation: a centered desktop dialog (the bottom-sheet looked like
       mobile on desktop). Falls back to a bottom sheet on phones. */
    .modal.as-confirm {
      inset: auto;
      top: 50%;
      left: 50%;
      width: min(92vw, 440px);
      max-width: 440px;
      height: auto;
      max-height: 88vh;
      border-radius: 16px;
      box-shadow: 0 30px 80px -24px rgba(0, 0, 0, 0.4);
      transform: translate(-50%, -50%) scale(0.96);
      opacity: 0;
    }
    :host([open]) .modal.as-confirm {
      transform: translate(-50%, -50%) scale(1);
      opacity: 1;
    }
    @media (max-width: 600px) {
      .modal.as-confirm {
        inset: auto 0 0 0;
        top: auto;
        left: 0;
        width: 100%;
        max-width: none;
        border-radius: 16px 16px 0 0;
        transform: translateY(100%) scale(1);
        opacity: 1;
      }
      :host([open]) .modal.as-confirm { transform: translateY(0); }
    }

    .handle { display: none; }

    /* Mobile: bottom sheet with rounded top + drag handle. */
    @media (max-width: 600px) {
      .modal {
        top: auto;
        height: 92vh;
        border-radius: 16px 16px 0 0;
        box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.08);
      }
      .handle {
        display: flex;
        justify-content: center;
        padding: 10px 0 4px;
        flex-shrink: 0;
      }
      .handle::before {
        content: '';
        width: 40px;
        height: 4px;
        background: var(--vio-color-border, #e5e5e5);
        border-radius: 2px;
      }
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px var(--vio-space-lg, 24px);
      border-bottom: 1px solid var(--vio-color-border, #e5e5e5);
      position: sticky;
      top: 0;
      background: var(--vio-color-surface, #fff);
      z-index: 1;
    }
    .heading {
      font-family: var(--vio-font-serif, Georgia, serif);
      font-size: 24px;
      font-weight: 400;
      margin: 0;
    }
    .close {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 28px;
      line-height: 1;
      padding: 0;
      color: var(--vio-color-text, #0a0a0a);
      font-family: inherit;
    }
    .close:hover { color: var(--vio-color-text-secondary, #666); }

    .body {
      max-width: 720px;
      margin: 0 auto;
      width: 100%;
      padding: 56px var(--vio-space-lg, 24px) 80px;
      box-sizing: border-box;
    }
    .section { margin-bottom: 56px; }
    .section-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-accent, #c14a3b);
      margin-bottom: 12px;
      font-weight: 500;
    }
    .section-heading {
      font-family: var(--vio-font-serif, Georgia, serif);
      font-size: 28px;
      margin: 0 0 var(--vio-space-lg, 24px);
      font-weight: 400;
      line-height: 1.2;
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--vio-space-md, 16px);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: var(--vio-space-md, 16px);
    }
    .field label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 500;
    }
    .field input {
      padding: 12px 0;
      border: none;
      border-bottom: 1px solid var(--vio-color-border, #e5e5e5);
      font-size: 16px;
      font-family: inherit;
      color: inherit;
      background: transparent;
      outline: none;
      transition: border-color 0.15s;
    }
    .field input:focus { border-bottom-color: var(--vio-color-text, #0a0a0a); }

    .payment-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--vio-space-md, 16px);
    }
    .payment-btn {
      padding: 20px;
      background: #fff;
      border: 1px solid var(--vio-color-border, #e5e5e5);
      cursor: pointer;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: border-color 0.15s, background 0.15s;
      color: var(--vio-color-text, #0a0a0a);
    }
    .payment-btn:hover:not(:disabled) {
      border-color: var(--vio-color-text, #0a0a0a);
      background: var(--vio-color-surface-hover, #fafafa);
    }
    .payment-btn:disabled {
      cursor: not-allowed;
      opacity: 0.45;
      pointer-events: none;
    }
    .payment-btn.primary {
      background: var(--vio-color-text, #0a0a0a);
      color: var(--vio-color-text-on-primary, #fff);
      grid-column: 1 / -1;
      border-color: var(--vio-color-text, #0a0a0a);
      padding: 22px;
      font-weight: 600;
    }
    .payment-btn.primary:hover:not(:disabled) { background: #222; border-color: #222; }
    .payment-btn[aria-pressed='true'] {
      border-color: var(--vio-color-accent, #c14a3b);
    }
    .apple-pay-note {
      grid-column: 1 / -1;
      font-size: 12px;
      color: var(--vio-color-text-tertiary, #999);
      text-align: center;
      margin-top: 4px;
    }
    /* Klarna Payments — inline widget panel, shown once Klarna is selected. */
    .klarna-panel {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 4px;
    }
    /* Klarna remembers the customer's preferred payment_method_category
     * server-side across sessions/browsers — exposing a category-switcher
     * chip UI on top of that just confuses users. Hidden per Alan's
     * 2026-08-18 cross-browser investigation; the switching logic (onKlarnaCategory)
     * stays wired for when/if this becomes configurable again. */
    .klarna-cats {
      display: none !important;
    }
    .klarna-cat {
      flex: 1 1 auto;
      padding: 8px 12px;
      border: 1px solid var(--vio-color-border, #ddd);
      border-radius: 8px;
      background: #fff;
      font-size: 13px;
      cursor: pointer;
    }
    .klarna-cat.active {
      border-color: var(--vio-color-text, #111);
      background: var(--vio-color-surface-2, #f6f6f6);
      font-weight: 600;
    }
    .klarna-widget {
      min-height: 48px;
    }
    .express-summary {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
    }
    /* Shipping selector (express) — Standard / Express options. */
    .ship-select { display: flex; flex-direction: column; gap: 8px; }
    .ship-opt {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 12px 14px; border: 1px solid var(--vio-color-border, #ddd);
      border-radius: 10px; background: #fff; cursor: pointer; font-family: inherit;
      text-align: left;
    }
    .ship-opt.active {
      border-color: var(--vio-color-text, #111);
      background: var(--vio-color-surface-2, #f6f6f6);
    }
    .ship-opt:disabled { opacity: 0.6; cursor: default; }
    .ship-meta { display: flex; flex-direction: column; gap: 2px; }
    .ship-meta b { font-weight: 600; font-size: 13px; }
    .ship-meta span { color: var(--vio-color-text-secondary, #666); font-size: 12px; }
    .ship-price { font-weight: 600; font-size: 13px; }
    .payment-error {
      grid-column: 1 / -1;
      padding: 12px 16px;
      background: #fdecea;
      border: 1px solid var(--vio-color-accent, #c14a3b);
      border-radius: 8px;
      font-size: 13px;
      color: var(--vio-color-accent, #c14a3b);
      text-align: center;
    }
    .payment-notice {
      grid-column: 1 / -1;
      padding: 12px 16px;
      background: #f4f4f2;
      border: 1px solid var(--vio-color-border, #ddd);
      border-radius: 8px;
      font-size: 13px;
      color: var(--vio-color-text, #1a1a1a);
      text-align: center;
    }
    /* "Betal" CTA — sits full-width below the method grid once a method is
       picked. Reuses .payment-btn.primary (its grid-column spans the row). */
    .complete-cta {
      width: 100% !important;
      box-sizing: border-box !important;
      margin-top: 8px;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      text-align: center !important;
    }

    /* Order confirmation — compact, shown inside the drawer. */
    .confirmation {
      text-align: center;
      padding: 24px 24px 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }
    .confirm-check {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: #2e7d32;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
      line-height: 1;
    }
    .confirm-title {
      font-family: var(--vio-font-serif, Georgia, serif);
      font-size: 28px;
      font-weight: 400;
      margin: 0;
    }
    .confirm-text {
      font-size: 14px;
      color: var(--vio-color-text-secondary, #666);
      max-width: 360px;
      line-height: 1.6;
      margin: 0;
    }
    .confirm-order-id {
      font-size: 13px;
      color: var(--vio-color-text-secondary, #666);
    }
    .confirm-order-id b {
      color: var(--vio-color-text, #0a0a0a);
      font-variant-numeric: tabular-nums;
    }
    .confirm-summary {
      width: 100%;
      max-width: 360px;
      border-top: 1px solid var(--vio-color-border, #eee);
      padding-top: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      text-align: left;
      font-size: 13px;
    }
    .confirm-close {
      border: none;
      background: var(--vio-color-text, #0a0a0a);
      color: var(--vio-color-text-on-primary, #fff);
      padding: 16px 48px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      margin-top: 16px;
    }
    .confirm-close:hover { background: #222; }

    .order-summary {
      background: var(--vio-color-surface-muted, #f2f2f2);
      padding: var(--vio-space-lg, 24px);
      margin-top: var(--vio-space-xl, 32px);
    }
    .order-line {
      display: grid;
      grid-template-columns: 56px 1fr auto;
      gap: 12px;
      padding: 8px 0;
      align-items: center;
    }
    .order-line-img {
      aspect-ratio: 1;
      background: #fff;
      overflow: hidden;
    }
    .order-line-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .order-line-meta { font-size: 13px; }
    .order-line-meta b { display: block; }
    .order-line-meta span {
      color: var(--vio-color-text-secondary, #666);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
    }
    .order-line-price { font-weight: 700; font-size: 14px; }
    .order-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      font-size: 14px;
    }
    .order-row.total {
      border-top: 1px solid var(--vio-color-border-default, #ccc);
      margin-top: var(--vio-space-sm, 8px);
      padding-top: var(--vio-space-md, 16px);
      font-weight: 700;
      font-size: 16px;
    }

    @media (max-width: 600px) {
      .form-row { grid-template-columns: 1fr; gap: 0; }
      .payment-grid { grid-template-columns: 1fr; }
      .body { padding: 32px var(--vio-space-lg, 24px) 64px; }
    }
  `

  override connectedCallback(): void {
    super.connectedCallback()
    this.checkoutState = Vio.checkout.currentState
    this.items = Vio.checkout.items
    Vio.checkout.addEventListener('change', this.boundOnCheckoutChange)
    Vio.checkout.addEventListener('payment-complete', this.boundOnPaymentComplete)
    Vio.checkout.addEventListener('payment-error', this.boundOnPaymentError)
    if (this.checkoutState) {
      void this.refreshApplePay()
      void this.refreshKlarna()
      void this.loadAvailablePaymentMethods()
    }
    // Klarna redirect-return first: it must consume its pending context and
    // create the order BEFORE the generic return check runs.
    void Vio.checkout.resumeKlarnaReturn()
    // Landing back from a Stripe/Vipps/Klarna redirect? Verify, then confirm.
    void this.checkReturnPaymentStatus()
  }

  /**
   * Detect the redirect return from a hosted payment page (Stripe / Vipps /
   * Klarna): the return URL carries vio_payment/vio_method/vio_sponsor. On
   * success: clear that sponsor's cart, show the confirmation drawer, emit
   * vio:payment-success (analytics/host hooks) and scrub the URL params.
   */
  /** Backend checkout statuses that mean the payment went through. */
  private static readonly PAID_STATUSES = new Set([
    'paid', 'completed', 'complete', 'success', 'succeeded', 'confirmed', 'captured',
  ])

  /** Statuses that mean the payment definitively did NOT go through. */
  private static readonly FAILED_STATUSES = new Set([
    'failed', 'cancelled', 'canceled', 'rejected', 'declined', 'expired', 'aborted',
    'terminated', 'error', 'voided', 'unpaid',
  ])

  /** Waits between GetCheckout attempts — PSP webhooks (Vipps especially) can
   * land seconds after the shopper is redirected back, so a single immediate
   * check misreads a successful charge as unpaid. ~20s total. */
  private static readonly RETURN_VERIFY_DELAYS_MS = [0, 2000, 4000, 6000, 8000]

  /** Vipps polling cadence — up to 2 minutes. Its webhook can lag well behind
   * the redirect; this window was verified against a live checkout. */
  private static readonly VIPPS_STATUS_MAX_ATTEMPTS = 24
  private static readonly VIPPS_STATUS_DELAY_MS = 5000

  /**
   * Vipps redirects to our return URL the same way on cancel as on success —
   * the URL alone can't tell them apart, and the generic checkout status can
   * lag behind Vipps' own webhook. Poll Vipps' own state directly instead:
   * AUTHORIZED confirms, CREATED means still processing (keep polling),
   * anything else (including an unrecognized state) is treated as failed —
   * fail-closed by default rather than guessing.
   */
  private async pollVippsStatus(
    checkoutId: string,
    sponsorId: number,
  ): Promise<{ outcome: 'paid' | 'failed' | 'pending'; sawStatus: boolean }> {
    let sawStatus = false
    for (let attempt = 0; attempt < VioCheckout.VIPPS_STATUS_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, VioCheckout.VIPPS_STATUS_DELAY_MS))
      }
      try {
        const vippsStatus = await Vio.checkout.getVippsStatus(checkoutId, sponsorId || undefined)
        const state = String(vippsStatus?.state ?? '').toUpperCase()
        sawStatus = true
        if (state === 'AUTHORIZED') return { outcome: 'paid', sawStatus }
        if (state === 'CREATED') continue
        return { outcome: 'failed', sawStatus }
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[VioCheckout] GetVippsStatus attempt failed:', err)
        }
      }
    }
    // Exhausted every attempt without a definitive state — honestly "still
    // processing", not a fabricated failure (Vipps' webhook may still land
    // and the backend order still get created).
    return { outcome: 'pending', sawStatus }
  }

  /** Shared outcome handler for both the generic (GetCheckout) and the
   * Vipps-specific (GetVippsStatus) return-verification paths. */
  private applyReturnOutcome(
    outcome: 'paid' | 'failed' | 'pending',
    sawStatus: boolean,
    vioMethod: string,
    sponsorId: number,
    checkoutId: string,
  ): void {
    if (outcome === 'paid') {
      if (sponsorId > 0) Vio.cart.clearSponsorCart(sponsorId)
      this.confirmedOrder = {
        items: [],
        currency: getGlobalCurrency(),
        total: 0,
        orderId: checkoutId || undefined,
      }
      this.confirmedMethod = vioMethod as PaymentMethod
      this.orderConfirmed = true
      this.open = true
      this.dispatchEvent(
        new CustomEvent('vio:payment-success', {
          bubbles: true,
          composed: true,
          detail: { method: vioMethod, sponsorId, orderId: checkoutId },
        }),
      )
    } else if (outcome === 'failed') {
      this.paymentError = 'Betalingen ble avbrutt eller feilet. Vennligst prøv igjen.'
      this.open = true
    } else if (sawStatus) {
      // Backend reachable but the checkout is still processing (webhook not
      // landed yet). Fail-closed: keep the cart, set expectations.
      this.paymentNotice =
        'Betalingen behandles fortsatt. Du får ordrebekreftelse på e-post når den er gjennomført. Handlekurven er uendret.'
      this.open = true
    } else {
      // Never got an answer from the backend: keep the cart, tell the user.
      this.paymentError =
        'Vi kunne ikke bekrefte betalingen. Handlekurven er uendret — prøv igjen, eller kontakt support hvis du ble belastet.'
      this.open = true
    }
  }

  private async checkReturnPaymentStatus(): Promise<void> {
    if (typeof window === 'undefined' || !window.location || !window.location.search) return
    try {
      const urlParams = new URLSearchParams(window.location.search)
      // ONLY our own vio_* params — generic names like ?payment= belong to the
      // publisher's page and must never trigger our confirmation flow.
      const vioPayment = urlParams.get('vio_payment')
      const vioMethod = urlParams.get('vio_method') || 'stripe'
      const sponsorId = Number(urlParams.get('vio_sponsor') || 0)
      const checkoutId = urlParams.get('checkout_id') || ''
      // Vipps is handled below without needing vioPayment at all (it
      // re-verifies against Vipps directly, never trusts the URL) — so only
      // bail here when there's neither a payment param NOR a checkout to
      // check.
      if (!vioPayment && !checkoutId) return

      // Kustom's confirmation return: shopcart registers the confirmation URL
      // as ?order_id=…&payment_processor=KUSTOM (no vio_* params — the href
      // is query-less by contract). Re-read the order and render KCO's own
      // confirmation snippet; the Commerce order is created server-side by
      // the push webhook, never from the browser.
      const kustomOrderId = urlParams.get('order_id') || ''
      if (urlParams.get('payment_processor') === 'KUSTOM' && kustomOrderId) {
        if (!this.checkoutState) {
          const spIdToUse = sponsorId || [...Vio.cart.getAllCarts().keys()][0] || 0
          if (spIdToUse) {
            try {
              Vio.checkout.open(spIdToUse)
            } catch {
              /* noop */
            }
          }
        }
        try {
          Vio.checkout.selectPaymentMethod('kustom')
        } catch {
          /* noop */
        }
        this.open = true
        this.paymentNotice = 'Bekrefter betalingen…'
        try {
          const order = await Vio.checkout.getKustomOrder(
            kustomOrderId,
            this.checkoutState?.sponsorId,
          )
          this.paymentNotice = null
          if (order?.html_snippet) {
            // Render KCO's own receipt into the panel once it exists in the DOM.
            this.kustomMountedOrderId = order.order_id
            await this.updateComplete
            const container = this.renderRoot?.querySelector(
              '#vio-kustom-checkout-container',
            ) as HTMLElement | null
            if (container) {
              Vio.checkout.renderKustomSnippet(container, order.html_snippet)
            }
            if (order.status === 'checkout_complete') {
              this.dispatchEvent(
                new CustomEvent('vio:payment-success', {
                  detail: { method: 'kustom', orderId: order.order_id },
                  bubbles: true,
                  composed: true,
                }),
              )
              const spId = this.checkoutState?.sponsorId
              if (spId) {
                try {
                  Vio.cart.clearSponsorCart(spId)
                } catch {
                  /* noop */
                }
              }
            }
          }
        } catch (err) {
          this.paymentNotice = null
          if (typeof console !== 'undefined') {
            console.warn('[VioCheckout] Kustom confirmation read failed:', err)
          }
        }
        this.cleanReturnQueryParams(['order_id', 'payment_processor'])
        return
      }

      // Qliro's confirmation return: ?checkout_id=…&payment_processor=QLIRO
      // (the href is query-less by contract). Re-read the order BY CHECKOUT
      // and render Qliro's own receipt; the Commerce order is created
      // server-side by the push webhook, never from the browser.
      if (urlParams.get('payment_processor') === 'QLIRO' && checkoutId) {
        if (!this.checkoutState) {
          const spIdToUse = sponsorId || [...Vio.cart.getAllCarts().keys()][0] || 0
          if (spIdToUse) {
            try {
              Vio.checkout.open(spIdToUse)
            } catch {
              /* noop */
            }
          }
        }
        try {
          Vio.checkout.selectPaymentMethod('qliro')
        } catch {
          /* noop */
        }
        this.open = true
        this.paymentNotice = 'Bekrefter betalingen…'
        try {
          const order = await Vio.checkout.getQliroOrder(
            checkoutId,
            this.checkoutState?.sponsorId,
          )
          this.paymentNotice = null
          if (order?.html_snippet) {
            this.qliroMountedOrderId = order.order_id
            await this.updateComplete
            const container = this.renderRoot?.querySelector(
              '#vio-qliro-checkout-container',
            ) as HTMLElement | null
            if (container) {
              Vio.checkout.renderKustomSnippet(container, order.html_snippet)
            }
            if (order.status === 'Completed') {
              this.dispatchEvent(
                new CustomEvent('vio:payment-success', {
                  detail: { method: 'qliro', orderId: order.order_id },
                  bubbles: true,
                  composed: true,
                }),
              )
              const spId = this.checkoutState?.sponsorId
              if (spId) {
                try {
                  Vio.cart.clearSponsorCart(spId)
                } catch {
                  /* noop */
                }
              }
            }
          }
        } catch (err) {
          this.paymentNotice = null
          if (typeof console !== 'undefined') {
            console.warn('[VioCheckout] Qliro confirmation read failed:', err)
          }
        }
        this.cleanReturnQueryParams(['checkout_id', 'payment_processor'])
        return
      }

      // Klarna's own return path (resumeKlarnaReturn) creates the order and
      // fires payment-complete — don't double-handle while it's pending.
      if (
        vioMethod === 'klarna' &&
        typeof sessionStorage !== 'undefined' &&
        sessionStorage.getItem('vio.klarna.pending.v1')
      ) {
        this.cleanReturnQueryParams(['vio_payment', 'vio_method', 'vio_sponsor', 'checkout_id'])
        return
      }

      if (vioMethod === 'vipps' && checkoutId) {
        // Vipps-specific path: check Vipps' own state instead of the generic
        // checkout status (see pollVippsStatus for why) — deliberately
        // ignores vioPayment's value entirely (not just 'success'), since
        // that URL param can't be trusted either way for Vipps.
        //
        // A fresh page load (redirect back from Vipps) never called
        // Vio.checkout.open() this session, so checkoutState is still null —
        // populate it before showing the notice so the overlay has a
        // coherent state to render instead of a blank/broken shell.
        if (!this.checkoutState) {
          const spIdToUse =
            sponsorId || [...Vio.cart.getAllCarts().keys()][0] || 0
          if (spIdToUse) {
            try {
              Vio.checkout.open(spIdToUse)
              Vio.checkout.selectPaymentMethod('vipps')
            } catch {
              /* noop */
            }
          }
        }
        this.open = true
        this.paymentNotice = 'Bekrefter betalingen med Vipps…'
        const { outcome, sawStatus } = await this.pollVippsStatus(checkoutId, sponsorId)
        this.paymentNotice = null
        this.applyReturnOutcome(outcome, sawStatus, vioMethod, sponsorId, checkoutId)
        this.cleanReturnQueryParams(['vio_payment', 'vio_method', 'vio_sponsor', 'checkout_id'])
      } else if (vioPayment === 'success') {
        // The URL is forgeable (and some PSPs reuse one return URL for
        // cancellations) — the BACKEND decides whether this checkout is paid.
        // Webhooks can lag the redirect, so poll a few times before deciding;
        // a genuinely-pending checkout gets a neutral "processing" notice, never
        // a fabricated success.
        let outcome: 'paid' | 'failed' | 'pending' = 'pending'
        let sawStatus = false
        if (checkoutId) {
          this.open = true
          this.paymentNotice = 'Bekrefter betalingen…'
          for (const delayMs of VioCheckout.RETURN_VERIFY_DELAYS_MS) {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
            try {
              const checkout = await Vio.checkout.getCheckout(checkoutId, sponsorId || undefined)
              const status = String(checkout?.status ?? '').toLowerCase()
              sawStatus = true
              if (VioCheckout.FAILED_STATUSES.has(status)) {
                outcome = 'failed'
                break
              }
              if (
                VioCheckout.PAID_STATUSES.has(status) ||
                Boolean(checkout?.origin_payment_id)
              ) {
                outcome = 'paid'
                break
              }
            } catch (err) {
              if (typeof console !== 'undefined') {
                console.warn('[VioCheckout] return verification attempt failed:', err)
              }
            }
          }
          this.paymentNotice = null
        }

        this.applyReturnOutcome(outcome, sawStatus, vioMethod, sponsorId, checkoutId)
        this.cleanReturnQueryParams(['vio_payment', 'vio_method', 'vio_sponsor', 'checkout_id'])
      } else if (vioPayment === 'cancel' || vioPayment === 'error') {
        this.paymentError = 'Betalingen ble avbrutt eller feilet. Vennligst prøv igjen.'
        this.open = true
        this.cleanReturnQueryParams(['vio_payment', 'vio_method', 'vio_sponsor', 'checkout_id'])
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCheckout] checkReturnPaymentStatus failed:', err)
      }
    }
  }

  /** Remove our payment-return params from the URL without a reload. */
  private cleanReturnQueryParams(keys: string[]): void {
    try {
      if (typeof window === 'undefined' || !window.history || !window.location) return
      const url = new URL(window.location.href)
      let changed = false
      keys.forEach((k) => {
        if (url.searchParams.has(k)) {
          url.searchParams.delete(k)
          changed = true
        }
      })
      if (changed) {
        const newSearch = url.searchParams.toString()
        const newUrl = url.pathname + (newSearch ? '?' + newSearch : '') + url.hash
        window.history.replaceState({}, document.title, newUrl)
      }
    } catch {
      // Ignore URL cleanup failures.
    }
  }

  override disconnectedCallback(): void {
    Vio.checkout.removeEventListener('change', this.boundOnCheckoutChange)
    Vio.checkout.removeEventListener('payment-complete', this.boundOnPaymentComplete)
    Vio.checkout.removeEventListener('payment-error', this.boundOnPaymentError)
    this.unmountKlarna()
    super.disconnectedCallback()
  }

  override updated(changed: Map<string, unknown>): void {
    // Opening the overlay: make sure the real shippings are loaded. Gated on
    // items.length — fetching shippings for an empty cart is wasted work and
    // can race the cart's own in-flight mutations.
    if (
      changed.has('open') &&
      this.open &&
      this.items.length > 0 &&
      this.availableShippingsList.length === 0
    ) {
      void this.loadAvailableShippings()
    }
    // Mount the Klarna Express button once its slot is in the DOM, the
    // express flow is available, and the overlay is open. Re-mount when the
    // amount changes (the payment request is captured at mount time).
    void this.mountKlarnaIfNeeded()
    void this.mountKustomIfNeeded()
    void this.mountQliroIfNeeded()
  }

  close(): void {
    this.open = false
    this.express = false
    Vio.checkout.close()
  }

  show(): void {
    this.open = true
    if (this.items.length > 0 && this.availableShippingsList.length === 0) {
      void this.loadAvailableShippings()
    }
  }

  /** Fetch the real per-supplier shippings and preselect + persist the first. */
  private async loadAvailableShippings(): Promise<void> {
    const spId = this.checkoutState?.sponsorId
    if (!spId) return
    if (this.items.length === 0) return
    if (this.loadingShippings) return
    this.loadingShippings = true
    this.shippingsAttempted = true
    try {
      const shippings = await Vio.checkout.fetchAvailableShippings(spId)
      if (Array.isArray(shippings) && shippings.length > 0) {
        this.availableShippingsList = shippings
        if (!this.selectedShipping || !shippings.some((s) => s.id === this.selectedShipping)) {
          const firstOpt = shippings[0]!
          this.selectedShipping = firstOpt.id
          if (firstOpt.supplierId) {
            void Vio.checkout.updateShippingsBySupplier(
              [{ shipping_id: firstOpt.id, supplier_id: Number(firstOpt.supplierId) }],
              spId,
            )
          }
        }
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCheckout] loadAvailableShippings failed:', err)
      }
    } finally {
      this.loadingShippings = false
    }
  }

  /** Whether all mandatory Leveringsadresse fields are filled. */
  private get isAddressValid(): boolean {
    const f = this.form
    if (!f) return false
    return Boolean(
      f.firstName && String(f.firstName).trim().length > 0 &&
      f.lastName && String(f.lastName).trim().length > 0 &&
      f.email && String(f.email).trim().length > 0 && String(f.email).includes('@') &&
      f.address && String(f.address).trim().length > 0 &&
      f.postalCode && String(f.postalCode).trim().length > 0 &&
      f.city && String(f.city).trim().length > 0,
    )
  }

  /** Whether a valid shipping option is selected (when shippings exist). */
  private get hasSelectedShipping(): boolean {
    if (this.availableShippingsList.length === 0) return true
    return Boolean(
      this.selectedShipping && this.shippingList.some((s) => s.id === this.selectedShipping),
    )
  }

  /** Which payment buttons to render — backend-configured per sponsor. */
  private async loadAvailablePaymentMethods(): Promise<void> {
    if (!this.checkoutState) return
    if (this.loadingPaymentMethods) return
    this.loadingPaymentMethods = true
    try {
      const methods = (await Vio.checkout.getAvailablePaymentMethods(
        this.checkoutState.sponsorId,
      )) as Array<{ name: string }> | unknown
      if (Array.isArray(methods)) {
        this.availableMethods = methods.map((m) => m.name)
      } else {
        this.availableMethods = null
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCheckout] Failed to load payment methods:', err)
      }
      // Unknown (not "none") — render everything rather than an empty grid.
      this.availableMethods = null
    } finally {
      this.loadingPaymentMethods = false
    }
  }

  /** Backend names arrive as e.g. "Apple Pay" — compare letters only. */
  private methodEnabled(name: string): boolean {
    if (this.availableMethods === null) return true
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
    return this.availableMethods.some((m) => norm(m) === norm(name))
  }

  private async refreshApplePay(): Promise<void> {
    Vio.checkout.clearApplePayCache()
    this.applePayAvailable = await Vio.checkout.isApplePayAvailable('NO')
  }

  private async refreshKlarna(): Promise<void> {
    // Klarna Payments (classic widget) is available if its lib can load — it
    // uses a server-minted client_token, no public clientId / origin handshake.
    const available = await Vio.checkout.klarnaPaymentsAvailable()
    if (available !== this.klarnaAvailable) {
      if (!available) this.unmountKlarna()
      this.klarnaAvailable = available
    }
  }

  /** Mount (or re-mount on amount change) the Klarna Payments widget. */
  private async mountKlarnaIfNeeded(): Promise<void> {
    if (!this.klarnaAvailable || !this.open || !this.checkoutState) return
    // Only mount once Klarna is the chosen method — creating a session is a
    // backend call, so don't fire it until the user picks Klarna (or we're in
    // express mode, which is Klarna-only).
    if (this.checkoutState.paymentMethod !== 'klarna' && !this.express) return
    if (this.klarnaMounting) return
    // Make sure the real shippings are in before mounting — Klarna's total
    // needs to reflect them, not the (removed) static fallback.
    if (this.items.length > 0 && this.availableShippingsList.length === 0 && !this.shippingsAttempted) {
      await this.loadAvailableShippings()
    }
    const amount = this.checkoutState.subtotal
    // Re-mount when the amount OR the chosen shipping changes (a new shipping
    // option means a new session/total — Klarna's widget can't be updated live).
    if (
      this.klarnaHandle &&
      this.klarnaMountedAmount === amount &&
      this.klarnaMountedShipping === this.selectedShipping
    ) {
      return
    }
    const container = this.renderRoot?.querySelector(
      '#vio-klarna-payments-container',
    ) as HTMLElement | null
    if (!container) return

    this.klarnaMounting = true
    this.unmountKlarna()
    container.innerHTML = ''
    try {
      const handle = await Vio.checkout.mountKlarnaPayments(container, {
        withShipping: this.express,
        shippingId: this.selectedShipping,
      })
      this.klarnaHandle = handle
      this.klarnaMountedAmount = amount
      this.klarnaMountedShipping = this.selectedShipping
      this.klarnaCategories = handle.categories
      this.klarnaSelectedCat = handle.selected
      // Adopt the backend shippings the mount resolved; keep the selection valid.
      if (Array.isArray(handle.shippings) && handle.shippings.length > 0) {
        this.availableShippingsList = handle.shippings
        if (
          !this.selectedShipping ||
          !handle.shippings.some((s) => s.id === this.selectedShipping)
        ) {
          this.selectedShipping = handle.shippings[0]!.id
        }
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCheckout] Klarna Payments mount failed:', err)
      }
      this.paymentError = `Kunne ikke laste Klarna: ${
        err instanceof Error ? err.message : String(err)
      }`
    } finally {
      this.klarnaMounting = false
    }
  }

  private unmountKlarna(): void {
    if (this.klarnaHandle) {
      this.klarnaHandle.unmount()
      this.klarnaHandle = null
    }
    this.klarnaMountedAmount = null
    this.klarnaMountedShipping = null
    this.klarnaCategories = []
    this.klarnaSelectedCat = ''
    this.klarnaAuthorizing = false
  }

  /** Shippings in effect: backend per-supplier when loaded. */
  private get shippingList(): KlarnaShippingOption[] {
    return this.availableShippingsList
  }

  /** Selected shipping option (express flow). */
  private get shippingOption() {
    const list = this.shippingList
    return list.find((o) => o.id === this.selectedShipping) ?? list[0] ?? null
  }

  /** Pick a shipping option → re-mounts the Klarna widget with the new total.
   * Also persists the choice on the backend cart (per supplier). */
  private async onSelectShipping(id: string): Promise<void> {
    if (this.selectedShipping === id || this.klarnaMounting) return
    this.selectedShipping = id
    const selectedOpt = this.shippingList.find((s) => s.id === id)
    if (selectedOpt?.supplierId) {
      try {
        await Vio.checkout.updateShippingsBySupplier(
          [{ shipping_id: selectedOpt.id, supplier_id: Number(selectedOpt.supplierId) }],
          this.checkoutState?.sponsorId,
        )
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[VioCheckout] updateShippingsBySupplier failed:', err)
        }
      }
    }
  }

  /** Switch the Klarna widget to a different payment_method_category. */
  private async onKlarnaCategory(identifier: string): Promise<void> {
    if (!this.klarnaHandle) return
    this.klarnaSelectedCat = identifier
    if (typeof console !== 'undefined') {
      console.log('[VioCheckout] User selected payment_method_category:', identifier)
    }
    try {
      await this.klarnaHandle.load(identifier)
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCheckout] Klarna category switch failed:', err)
      }
    }
  }

  /** Authorize the selected Klarna method → backend creates the order. */
  private async onKlarnaAuthorize(): Promise<void> {
    if (!this.klarnaHandle || this.klarnaAuthorizing) return
    this.paymentError = null
    this.paymentNotice = null
    this.klarnaAuthorizing = true
    const cat = this.klarnaSelectedCat || this.klarnaHandle.selected || 'pay_now'
    if (typeof console !== 'undefined') {
      console.log('[VioCheckout] Authorizing Klarna with payment_method_category:', cat)
    }
    try {
      // Resolves once the order is created (payment-complete) or surfaces a
      // payment-error event handled by boundOnPaymentError.
      await this.klarnaHandle.authorize(cat)
    } finally {
      this.klarnaAuthorizing = false
    }
  }

  private onFieldChange<K extends keyof CheckoutAddress>(field: K, value: string): void {
    this.form = { ...this.form, [field]: value }
    Vio.checkout.setAddress(this.form)
  }

  private async onApplePay(): Promise<void> {
    if (this.applePayInProgress) return
    this.applePayInProgress = true
    try {
      // On authorize, startApplePay dispatches `payment-complete` →
      // boundOnPaymentComplete → confirmOrder shows the confirmation drawer
      // (and emits vio:payment-success). No manual close/emit here.
      await Vio.checkout.startApplePay({ country: 'NO', label: 'Vio' })
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCheckout] Apple Pay flow ended:', err)
      }
    } finally {
      this.applePayInProgress = false
    }
  }

  private async onPay(method: PaymentMethod): Promise<void> {
    this.paymentError = null
    this.paymentNotice = null
    // Apple Pay collects address, shipping AND email inside its own sheet —
    // skip the manual form validation entirely.
    if (method === 'apple-pay') {
      void this.onApplePay()
      return
    }
    // Kustom's embedded checkout collects address, shipping, email AND
    // payment — nothing to validate before mounting it.
    if (method === 'kustom') {
      Vio.checkout.selectPaymentMethod('kustom')
      return
    }
    // Qliro: same widget-does-everything category as Kustom.
    if (method === 'qliro') {
      Vio.checkout.selectPaymentMethod('qliro')
      return
    }
    // Vipps collects the address in its own flow but still needs an email
    // for the order receipt; every other method needs the full form + a
    // shipping choice before we mint sessions/links.
    if (method === 'vipps') {
      const email = String(this.form.email ?? '').trim()
      if (!email || !email.includes('@')) {
        this.paymentError = 'Vennligst fyll inn e-postadressen din.'
        return
      }
    } else {
      if (!this.isAddressValid) {
        this.paymentError = 'Vennligst fyll ut alle feltene i leveringsadresse.'
        return
      }
      if (!this.hasSelectedShipping) {
        this.paymentError = 'Vennligst velg en fraktmetode.'
        return
      }
    }
    Vio.checkout.selectPaymentMethod(method)
    // Stripe / Vipps: hosted payment pages — mint the link and redirect. The
    // return trip lands in checkReturnPaymentStatus().
    if (method === 'stripe') {
      // Persist the chosen shipping before the link is minted (total depends on it).
      const selectedOpt = this.shippingList.find((s) => s.id === this.selectedShipping)
      if (selectedOpt?.supplierId) {
        try {
          await Vio.checkout.updateShippingsBySupplier(
            [{ shipping_id: selectedOpt.id, supplier_id: Number(selectedOpt.supplierId) }],
            this.checkoutState?.sponsorId,
          )
        } catch (err) {
          if (typeof console !== 'undefined') {
            console.warn('[VioCheckout] updateShippingsBySupplier on stripe pay failed:', err)
          }
        }
      }
      this.stripeLoading = true
      void Vio.checkout
        .startStripePayment(this.checkoutState?.sponsorId, this.form)
        .catch((err: unknown) => {
          this.paymentError = `Kunne ikke starte Stripe-betaling: ${
            err instanceof Error ? err.message : String(err)
          }`
        })
        .finally(() => {
          this.stripeLoading = false
        })
    }
    if (method === 'vipps') {
      this.vippsLoading = true
      void Vio.checkout
        .startVippsPayment(this.checkoutState?.sponsorId, this.form)
        .catch((err: unknown) => {
          this.paymentError = `Kunne ikke starte Vipps-betaling: ${
            err instanceof Error ? err.message : String(err)
          }`
        })
        .finally(() => {
          this.vippsLoading = false
        })
    }
  }

  /**
   * Complete the order for the selected method. Apple Pay and Klarna Express
   * finish inside their own sheet/popup; Stripe and Vipps redirect to their
   * hosted pages (via onPay). Anything else confirms state-only.
   */
  private onCompleteOrder(): void {
    const s = this.checkoutState
    if (!s || !s.paymentMethod) return
    if (s.paymentMethod !== 'vipps' && !this.isAddressValid) {
      this.paymentError = 'Vennligst fyll ut alle feltene i leveringsadresse.'
      return
    }
    if (s.paymentMethod === 'stripe' || s.paymentMethod === 'vipps') {
      void this.onPay(s.paymentMethod)
      return
    }
    // Only methods with a real payment flow may confirm. 'card' has no PSP
    // wired — confirming would show success without charging.
    if (s.paymentMethod !== 'klarna' && s.paymentMethod !== 'apple-pay') {
      this.paymentError = 'Betalingsmetoden er ikke tilgjengelig ennå.'
      return
    }
    this.confirmOrder(s.paymentMethod, s.sponsorId)
  }

  /**
   * Shared order confirmation — reached from both the plain "Betal" CTA
   * (Vipps/Card/Klarna) and the Klarna Express authorize callback. Shows
   * the confirmation screen, emits `vio:payment-success`, and clears the
   * paid sponsor's cart so the badge + drawer reflect the purchase.
   */
  private confirmOrder(method: PaymentMethod, sponsorId: number, result?: unknown): void {
    // Snapshot the order BEFORE clearing the cart — the confirmation needs it.
    const r = (result ?? {}) as { order?: { orderId?: string }; chargedTotal?: number }
    this.confirmedOrder = {
      items: [...this.items],
      currency: this.checkoutState?.currency ?? '',
      total:
        typeof r.chargedTotal === 'number' ? r.chargedTotal : (this.checkoutState?.subtotal ?? 0),
      orderId: r.order?.orderId,
    }
    this.confirmedMethod = method
    this.orderConfirmed = true
    // A redirect completion lands with the overlay closed — open it so the
    // confirmation screen is visible.
    this.open = true
    this.dispatchEvent(
      new CustomEvent('vio:payment-success', {
        bubbles: true,
        composed: true,
        detail: { method, sponsorId, result },
      }),
    )
    Vio.cart.clearSponsorCart(sponsorId)
  }

  private methodLabel(method: PaymentMethod | null): string {
    switch (method) {
      case 'apple-pay':
        return 'Apple Pay'
      case 'klarna':
        return 'Klarna'
      case 'kustom':
        return 'Kustom'
      case 'qliro':
        return 'Qliro'
      case 'vipps':
        return 'Vipps'
      case 'stripe':
        return 'Stripe'
      case 'card':
        return 'Kort'
      default:
        return ''
    }
  }

  /** True for methods that complete via a separate sheet/widget, not the CTA. */
  private isExpressMethod(method: PaymentMethod | undefined): boolean {
    // Apple Pay finishes in its sheet; Klarna finishes via its widget's
    // authorize() button; Kustom's embedded checkout has its own buy button —
    // none of them uses the generic "Betal" CTA.
    return (
      method === 'apple-pay' ||
      method === 'klarna' ||
      method === 'kustom' ||
      method === 'qliro'
    )
  }

  private orderTotal(): string {
    const s = this.checkoutState
    if (!s) return ''
    return formatPrice(s.subtotal, s.currency)
  }

  /** Shipping cost (major units) whenever a shipping option is in effect —
   * express always has one; the normal flow has one once the backend
   * shippings loaded (the choice IS persisted on the cart and charged). */
  private shippingMajor(): number {
    if (!this.express && this.availableShippingsList.length === 0) return 0
    const o = this.shippingOption
    if (!o) return 0
    return o.priceMajor ?? o.price / 100
  }

  /** Total to charge — items + shipping (express). */
  private payTotalLabel(): string {
    const s = this.checkoutState
    if (!s) return ''
    return formatPrice(s.subtotal + this.shippingMajor(), s.currency)
  }

  override render() {
    return html`
      <div class="backdrop" @click=${this.close}></div>
      <div
        class="modal ${this.express ? 'as-side' : this.orderConfirmed ? 'as-confirm' : ''}"
        role="dialog"
        aria-label=${this.heading}
      >
        <div class="handle" @click=${this.close} aria-hidden="true"></div>
        <div class="topbar">
          <h2 class="heading">${this.orderConfirmed ? 'Takk!' : this.heading}</h2>
          <button class="close" @click=${this.close} aria-label="Lukk">×</button>
        </div>

        <div class="body">
          ${this.orderConfirmed
            ? this.renderConfirmation()
            : this.express
              ? this.renderKlarnaExpress()
              : this.renderCheckoutBody()}
        </div>
      </div>
    `
  }

  private renderConfirmation() {
    const o = this.confirmedOrder
    return html`
      <section class="confirmation">
        <div class="confirm-check" aria-hidden="true">✓</div>
        <h3 class="confirm-title">Takk for bestillingen!</h3>
        <p class="confirm-text">
          Betaling med ${this.methodLabel(this.confirmedMethod)} er bekreftet.${this.form.email
            ? html` Kvittering sendes til ${this.form.email}.`
            : ''}
        </p>
        ${o?.orderId
          ? html`<div class="confirm-order-id">Ordrenummer: <b>${o.orderId}</b></div>`
          : ''}
        ${o && o.items.length > 0
          ? html`
              <div class="confirm-summary">
                ${o.items.map(
                  (it) => html`
                    <div class="order-row">
                      <span>${it.brand ? `${it.brand} ` : ''}${it.name} ×${it.quantity}</span>
                      <span>${formatPrice(it.unitPrice * it.quantity, it.currency)}</span>
                    </div>
                  `,
                )}
                <div class="order-row total">
                  <span>Totalt</span><span>${formatPrice(o.total, o.currency)}</span>
                </div>
              </div>
            `
          : ''}
        <button class="confirm-close" @click=${this.close}>Lukk</button>
      </section>
    `
  }

  /** Klarna Payments widget panel: shipping + category chips + widget + pay button. */
  /** Mount the Kustom embedded checkout once it's the chosen method. */
  private async mountKustomIfNeeded(): Promise<void> {
    if (!this.open || !this.checkoutState) return
    if (this.checkoutState.paymentMethod !== 'kustom') return
    if (this.kustomMounting) return
    const container = this.renderRoot?.querySelector(
      '#vio-kustom-checkout-container',
    ) as HTMLElement | null
    if (!container) return
    // Already mounted for this session — the KCO iframe manages itself
    // (address, shipping and totals live inside it; no re-mount on change).
    if (this.kustomMountedOrderId && container.childElementCount > 0) return

    this.kustomMounting = true
    container.innerHTML = ''
    try {
      const order = await Vio.checkout.mountKustomCheckout(
        container,
        this.checkoutState.sponsorId,
      )
      this.kustomMountedOrderId = order.order_id
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCheckout] Kustom mount failed:', err)
      }
      this.paymentError = `Kunne ikke laste Kustom: ${
        err instanceof Error ? err.message : String(err)
      }`
      Vio.checkout.selectPaymentMethod('' as PaymentMethod)
    } finally {
      this.kustomMounting = false
    }
  }

  private unmountKustom(): void {
    this.kustomMountedOrderId = null
    const container = this.renderRoot?.querySelector(
      '#vio-kustom-checkout-container',
    ) as HTMLElement | null
    if (container) container.innerHTML = ''
  }

  private renderKustomPanel() {
    return html`
      <div class="kustom-panel">
        ${this.kustomMounting
          ? html`<div style="font-size:13px;opacity:0.7;padding:8px 0;">Laster Kustom…</div>`
          : ''}
        <div id="vio-kustom-checkout-container"></div>
      </div>
    `
  }

  /** Mount the Qliro embedded checkout once it's the chosen method. */
  private async mountQliroIfNeeded(): Promise<void> {
    if (!this.open || !this.checkoutState) return
    if (this.checkoutState.paymentMethod !== 'qliro') return
    if (this.qliroMounting) return
    const container = this.renderRoot?.querySelector(
      '#vio-qliro-checkout-container',
    ) as HTMLElement | null
    if (!container) return
    if (this.qliroMountedOrderId && container.childElementCount > 0) return

    this.qliroMounting = true
    container.innerHTML = ''
    try {
      const order = await Vio.checkout.mountQliroCheckout(
        container,
        this.checkoutState.sponsorId,
      )
      this.qliroMountedOrderId = order.order_id
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCheckout] Qliro mount failed:', err)
      }
      this.paymentError = `Kunne ikke laste Qliro: ${
        err instanceof Error ? err.message : String(err)
      }`
      Vio.checkout.selectPaymentMethod('' as PaymentMethod)
    } finally {
      this.qliroMounting = false
    }
  }

  private unmountQliro(): void {
    this.qliroMountedOrderId = null
    const container = this.renderRoot?.querySelector(
      '#vio-qliro-checkout-container',
    ) as HTMLElement | null
    if (container) container.innerHTML = ''
  }

  private renderQliroPanel() {
    return html`
      <div class="qliro-panel">
        ${this.qliroMounting
          ? html`<div style="font-size:13px;opacity:0.7;padding:8px 0;">Laster Qliro…</div>`
          : ''}
        <div id="vio-qliro-checkout-container"></div>
      </div>
    `
  }

  private renderKlarnaPanel() {
    const currency = this.checkoutState?.currency || getGlobalCurrency()
    return html`
      <div class="klarna-panel">
        ${this.express
          ? html`
              <div class="ship-select" role="radiogroup" aria-label="Frakt">
                ${this.shippingList.map(
                  (o) => html`
                    <button
                      class="ship-opt ${this.selectedShipping === o.id ? 'active' : ''}"
                      role="radio"
                      aria-checked=${this.selectedShipping === o.id}
                      ?disabled=${this.klarnaMounting}
                      @click=${() => void this.onSelectShipping(o.id)}
                    >
                      <span class="ship-meta">
                        <b>${o.method || o.name}</b><span>${o.description}</span>
                      </span>
                      <span class="ship-price">
                        ${formatPrice(o.priceMajor ?? o.price / 100, o.currency || currency)}
                      </span>
                    </button>
                  `,
                )}
              </div>
            `
          : ''}
        ${this.klarnaCategories.length > 1
          ? html`
              <div class="klarna-cats">
                ${this.klarnaCategories.map(
                  (c) => html`
                    <button
                      class="klarna-cat ${this.klarnaSelectedCat === c.identifier ? 'active' : ''}"
                      @click=${() => void this.onKlarnaCategory(c.identifier)}
                    >
                      ${c.name}
                    </button>
                  `,
                )}
              </div>
            `
          : ''}
        ${this.klarnaMounting
          ? html`
              <div style="padding: 20px; text-align: center; color: var(--vio-color-text-secondary, #666); font-size: 14px;">
                Klargjør Klarna-betaling…
              </div>
            `
          : ''}
        <div class="klarna-widget" id="vio-klarna-payments-container"></div>
        <button
          class="payment-btn primary complete-cta"
          @click=${() => void this.onKlarnaAuthorize()}
          ?disabled=${this.klarnaAuthorizing || !this.klarnaHandle || this.klarnaMounting}
        >
          ${this.klarnaAuthorizing
            ? 'Behandler…'
            : this.klarnaMounting
              ? 'Klargjør Klarna…'
              : `Betal ${this.payTotalLabel()} med Klarna`}
        </button>
      </div>
    `
  }

  /** Express layout — only the Klarna widget + a compact order summary. */
  private renderKlarnaExpress() {
    const currency = this.checkoutState?.currency || getGlobalCurrency()
    if (!this.klarnaAvailable) {
      // Klarna's script can be blocked (adblocker / CSP) — never leave the
      // buyer in a dead end with a permanently disabled button.
      return html`
        <section class="section">
          <h3 class="section-heading">Kjøp med Klarna</h3>
          <div class="payment-error">
            Klarna er ikke tilgjengelig akkurat nå (kan være blokkert av nettleseren).
          </div>
          <button
            class="payment-btn primary complete-cta"
            @click=${() => {
              this.express = false
            }}
          >
            Gå til vanlig kasse
          </button>
        </section>
      `
    }
    return html`
      <section class="section">
        <h3 class="section-heading">Kjøp med Klarna</h3>
        ${this.items.length > 0
          ? html`
              <div class="express-summary">
                ${this.items.map(
                  (item) => html`
                    <div class="order-row">
                      <span>${item.brand ? `${item.brand} ` : ''}${item.name} ×${item.quantity}</span>
                      <span>${formatPrice(item.unitPrice * item.quantity, item.currency || currency)}</span>
                    </div>
                  `,
                )}
                <div class="order-row">
                  <span>Frakt${this.shippingOption ? ` – ${this.shippingOption.method}` : ''}</span>
                  <span>${formatPrice(this.shippingMajor(), currency)}</span>
                </div>
                <div class="order-row total">
                  <span>Totalt</span><span>${this.payTotalLabel()}</span>
                </div>
              </div>
            `
          : ''}
        ${this.renderKlarnaPanel()}
        ${this.paymentNotice
          ? html`<div class="payment-notice">${this.paymentNotice}</div>`
          : ''}
        ${this.paymentError
          ? html`<div class="payment-error">${this.paymentError}</div>`
          : ''}
      </section>
    `
  }

  private renderCheckoutBody() {
    const method = this.checkoutState?.paymentMethod
    const showCompleteCta = !!method && !this.isExpressMethod(method)
    // Vipps collects the address in its own flow — skip the form entirely.
    const isVipps = method === 'vipps'
    // Kustom's and Qliro's embedded checkouts collect address, shipping AND
    // email themselves — skip the form AND the contact section entirely.
    const isKustom = method === 'kustom' || method === 'qliro'
    return html`
          ${!isVipps && !isKustom
            ? html`
          <section class="section">
            <div class="section-label">Steg 1</div>
            <h3 class="section-heading">Leveringsadresse</h3>
            <div class="form-row">
              <div class="field">
                <label>Fornavn *</label>
                <input
                  type="text"
                  required
                  autocomplete="given-name"
                  .value=${this.form.firstName}
                  @input=${(e: InputEvent) =>
                    this.onFieldChange('firstName', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="field">
                <label>Etternavn *</label>
                <input
                  type="text"
                  required
                  autocomplete="family-name"
                  .value=${this.form.lastName}
                  @input=${(e: InputEvent) =>
                    this.onFieldChange('lastName', (e.target as HTMLInputElement).value)}
                />
              </div>
            </div>
            <div class="field">
              <label>E-post *</label>
              <input
                type="email"
                required
                autocomplete="email"
                .value=${this.form.email}
                @input=${(e: InputEvent) =>
                  this.onFieldChange('email', (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label>Adresse *</label>
              <input
                type="text"
                required
                autocomplete="street-address"
                .value=${this.form.address}
                @input=${(e: InputEvent) =>
                  this.onFieldChange('address', (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="form-row">
              <div class="field">
                <label>Postnummer *</label>
                <input
                  type="text"
                  required
                  autocomplete="postal-code"
                  .value=${this.form.postalCode}
                  @input=${(e: InputEvent) =>
                    this.onFieldChange('postalCode', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="field">
                <label>Sted *</label>
                <input
                  type="text"
                  required
                  autocomplete="address-level2"
                  .value=${this.form.city}
                  @input=${(e: InputEvent) =>
                    this.onFieldChange('city', (e.target as HTMLInputElement).value)}
                />
              </div>
            </div>
            ${this.availableShippingsList.length > 0
              ? html`
                  <div style="margin-top: 16px;">
                    <label style="display: block; font-weight: 600; font-size: 13px; margin-bottom: 8px;">
                      Fraktmetode *
                    </label>
                    <div class="ship-select">
                      ${this.availableShippingsList.map(
                        (o) => html`
                          <button
                            type="button"
                            class="ship-opt ${this.selectedShipping === o.id ? 'active' : ''}"
                            @click=${() => void this.onSelectShipping(o.id)}
                          >
                            <span class="ship-meta">
                              <b>${o.method || o.name}</b>
                              ${o.description ? html`<span>${o.description}</span>` : ''}
                            </span>
                            <span class="ship-price">
                              ${formatPrice(
                                o.priceMajor ?? o.price / 100,
                                o.currency || this.checkoutState?.currency || 'NOK',
                              )}
                            </span>
                          </button>
                        `,
                      )}
                    </div>
                  </div>
                `
              : ''}
          </section>
          `
            : ''}

          ${isVipps
            ? html`
                <section class="section">
                  <div class="section-label">Kontakt</div>
                  <div class="field">
                    <label>E-post * <span style="font-weight:400;opacity:0.6">(for kvittering — adresse fylles ut i Vipps)</span></label>
                    <input
                      type="email"
                      required
                      autocomplete="email"
                      .value=${this.form.email}
                      @input=${(e: InputEvent) =>
                        this.onFieldChange('email', (e.target as HTMLInputElement).value)}
                    />
                  </div>
                </section>
              `
            : ''}

          <section class="section">
            <div class="section-label">${isVipps || isKustom ? 'Betaling' : 'Steg 2'}</div>
            ${method
              ? html`
                  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                    <h3 class="section-heading" style="margin:0;">
                      Betalingsmåte: <b>${this.methodLabel(method)}</b>
                    </h3>
                    <button
                      type="button"
                      style="background:none; border:none; color:var(--vio-color-accent, #c14a3b); text-decoration:underline; font-size:13px; cursor:pointer;"
                      @click=${() => {
                        this.unmountKlarna()
                        this.unmountKustom()
                        this.unmountQliro()
                        Vio.checkout.selectPaymentMethod('' as PaymentMethod)
                      }}
                    >
                      Endre
                    </button>
                  </div>

                  ${method === 'klarna' ? this.renderKlarnaPanel() : ''}
                  ${method === 'kustom' ? this.renderKustomPanel() : ''}
                  ${method === 'qliro' ? this.renderQliroPanel() : ''}
                  ${method === 'stripe'
                    ? html`
                        <button
                          class="payment-btn primary complete-cta"
                          @click=${() => void this.onPay('stripe')}
                          ?disabled=${this.stripeLoading || !this.isAddressValid || !this.hasSelectedShipping}
                          title=${!this.isAddressValid
                            ? 'Vennligst fyll ut leveringsadresse'
                            : !this.hasSelectedShipping
                              ? 'Vennligst velg en fraktmetode'
                              : ''}
                        >
                          ${this.stripeLoading
                            ? 'Går til Stripe…'
                            : `Betal ${this.payTotalLabel()} med Stripe`}
                        </button>
                      `
                    : ''}
                  ${method === 'vipps'
                    ? html`
                        <button
                          class="payment-btn primary complete-cta"
                          @click=${() => void this.onPay('vipps')}
                          ?disabled=${this.vippsLoading}
                        >
                          ${this.vippsLoading
                            ? 'Går til Vipps…'
                            : `Betal ${this.payTotalLabel()} med Vipps`}
                        </button>
                      `
                    : ''}
                  ${method === 'apple-pay'
                    ? html`
                        <button
                          class="payment-btn primary complete-cta"
                          @click=${() => void this.onPay('apple-pay')}
                          ?disabled=${this.applePayInProgress || !this.isAddressValid || !this.hasSelectedShipping}
                          title=${!this.isAddressValid
                            ? 'Vennligst fyll ut leveringsadresse'
                            : !this.hasSelectedShipping
                              ? 'Vennligst velg en fraktmetode'
                              : ''}
                        >
                          ${this.applePayInProgress
                            ? 'Åpner…'
                            : `Betal ${this.payTotalLabel()} med Apple Pay`}
                        </button>
                      `
                    : ''}
                  ${showCompleteCta && method !== 'stripe' && method !== 'vipps'
                    ? html`
                        <button
                          class="payment-btn primary complete-cta"
                          @click=${this.onCompleteOrder}
                          ?disabled=${!this.isAddressValid || !this.hasSelectedShipping}
                          title=${!this.isAddressValid
                            ? 'Vennligst fyll ut leveringsadresse'
                            : !this.hasSelectedShipping
                              ? 'Vennligst velg en fraktmetode'
                              : ''}
                        >
                          Betal ${this.payTotalLabel()} med ${this.methodLabel(method ?? null)}
                        </button>
                      `
                    : ''}
                  ${!isVipps && !this.isAddressValid
                    ? html`
                        <div style="font-size: 12px; color: var(--vio-color-accent, #c14a3b); text-align: center; margin-top: 8px;">
                          Vennligst fyll ut leveringsadresse for å fullføre betalingen
                        </div>
                      `
                    : !isVipps && !this.hasSelectedShipping
                      ? html`
                          <div style="font-size: 12px; color: var(--vio-color-accent, #c14a3b); text-align: center; margin-top: 8px;">
                            Vennligst velg en fraktmetode for å fullføre betalingen
                          </div>
                        `
                      : ''}
                `
              : html`
                  <h3 class="section-heading">Velg betalingsmåte</h3>
                  <div class="payment-grid">
                    ${this.methodEnabled('apple-pay') && this.applePayAvailable
                      ? html`
                          <button
                            class="payment-btn primary"
                            @click=${() => this.onPay('apple-pay')}
                            ?disabled=${this.applePayInProgress}
                          >
                            ${this.applePayInProgress
                              ? 'Åpner…'
                              : html`<span style="display:inline-flex;align-items:center;gap:6px"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:18px;height:18px"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>Apple Pay</span>`}
                          </button>
                        `
                      : ''}
                    ${this.methodEnabled('stripe')
                      ? html`
                          <button
                            class="payment-btn"
                            @click=${() => this.onPay('stripe')}
                            ?disabled=${this.stripeLoading}
                          >
                            <img src=${STRIPE_LOGO_SRC} style="height: 20px; display: block;" alt="Stripe" />
                          </button>
                        `
                      : ''}
                    ${this.methodEnabled('klarna') && this.klarnaAvailable
                      ? html`
                          <button class="payment-btn" @click=${() => this.onPay('klarna')}>
                            Klarna
                          </button>
                        `
                      : ''}
                    ${this.methodEnabled('kustom')
                      ? html`
                          <button class="payment-btn" @click=${() => this.onPay('kustom')}>
                            <span style="font-weight:800;font-size:16px;letter-spacing:-0.01em">Kustom</span>
                          </button>
                        `
                      : ''}
                    ${this.methodEnabled('qliro')
                      ? html`
                          <button class="payment-btn" @click=${() => this.onPay('qliro')}>
                            <span style="font-weight:800;font-size:16px;letter-spacing:-0.01em">Qliro</span>
                          </button>
                        `
                      : ''}
                    ${this.methodEnabled('vipps')
                      ? html`
                          <button class="payment-btn" @click=${() => this.onPay('vipps')}>
                            <span style="color:#ff5b24;font-weight:800;font-size:17px;letter-spacing:-0.02em">vipps</span>
                          </button>
                        `
                      : ''}
                    ${this.methodEnabled('apple-pay') && !this.applePayAvailable
                      ? html`
                          <div class="apple-pay-note">
                             Pay krever Safari på iOS eller macOS med Apple Pay konfigurert.
                          </div>
                        `
                      : ''}
                  </div>
                `}
            ${this.paymentNotice
              ? html`<div class="payment-notice">${this.paymentNotice}</div>`
              : ''}
            ${this.paymentError
              ? html`<div class="payment-error">${this.paymentError}</div>`
              : ''}
          </section>

          ${this.items.length > 0
            ? html`
                <section class="order-summary">
                  ${this.items.map(
                    (item) => html`
                      <div class="order-line">
                        <div class="order-line-img">
                          ${item.imageUrl
                            ? html`<img src=${item.imageUrl} alt=${item.name} />`
                            : ''}
                        </div>
                        <div class="order-line-meta">
                          <span>${item.brand}</span>
                          <b>${item.name}</b>
                          <span>×${item.quantity}</span>
                        </div>
                        <div class="order-line-price">
                          ${formatPrice(item.unitPrice * item.quantity, item.currency)}
                        </div>
                      </div>
                    `,
                  )}
                  <div class="order-row" style="margin-top: 16px;">
                    <span>Sum</span><span>${this.orderTotal()}</span>
                  </div>
                  <div class="order-row">
                    <span>Frakt${this.shippingMajor() > 0 && this.shippingOption ? ` – ${this.shippingOption.method || this.shippingOption.name}` : ''}</span>
                    <span>${this.shippingMajor() > 0
                      ? formatPrice(this.shippingMajor(), this.checkoutState?.currency)
                      : this.shippingLabel}</span>
                  </div>
                  <div class="order-row total">
                    <span>Totalt</span><span>${this.payTotalLabel()}</span>
                  </div>
                </section>
              `
            : ''}
        </div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vio-checkout': VioCheckout
  }
}
