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
import { formatPrice } from '../../core/types.js'
import type { CartLineItem } from '../../core/cart/types.js'
import {
  KLARNA_SHIPPING_OPTIONS,
  type CheckoutChangeDetail,
  type KlarnaPaymentsHandle,
} from '../../core/checkout/checkout-manager.js'
import type {
  CheckoutAddress,
  CheckoutState,
  PaymentMethod,
} from '../../core/checkout/types.js'

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
  @state() private selectedShipping =
    KLARNA_SHIPPING_OPTIONS.find((o) => o.preselected)?.id ?? KLARNA_SHIPPING_OPTIONS[0]?.id ?? ''
  @state() private form: CheckoutAddress = {
    firstName: '',
    lastName: '',
    email: '',
    address: '',
    postalCode: '',
    city: '',
  }

  private boundOnCheckoutChange = (e: Event): void => {
    const detail = (e as CustomEvent<CheckoutChangeDetail>).detail
    this.checkoutState = detail.state
    this.items = Vio.checkout.items
    // Re-check vendor availability when state changes (e.g. checkout reopens
    // with a different sponsor / amount).
    if (this.checkoutState) {
      this.refreshApplePay()
      this.refreshKlarna()
    } else {
      this.applePayAvailable = false
      this.klarnaAvailable = false
      this.orderConfirmed = false
      this.confirmedMethod = null
      this.confirmedOrder = null
      this.paymentError = null
      this.express = false
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
      cursor: progress;
      opacity: 0.6;
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
    .klarna-cats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
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
    /* "Betal" CTA — sits full-width below the method grid once a method is
       picked. Reuses .payment-btn.primary (its grid-column spans the row). */
    .complete-cta { margin-top: 8px; }

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
    }
  }

  override disconnectedCallback(): void {
    Vio.checkout.removeEventListener('change', this.boundOnCheckoutChange)
    Vio.checkout.removeEventListener('payment-complete', this.boundOnPaymentComplete)
    Vio.checkout.removeEventListener('payment-error', this.boundOnPaymentError)
    this.unmountKlarna()
    super.disconnectedCallback()
  }

  override updated(): void {
    // Mount the Klarna Express button once its slot is in the DOM, the
    // express flow is available, and the overlay is open. Re-mount when the
    // amount changes (the payment request is captured at mount time).
    void this.mountKlarnaIfNeeded()
  }

  close(): void {
    this.open = false
    this.express = false
    Vio.checkout.close()
  }

  show(): void { this.open = true }

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

  /** Selected shipping option (express flow). */
  private get shippingOption() {
    return KLARNA_SHIPPING_OPTIONS.find((o) => o.id === this.selectedShipping) ?? null
  }

  /** Pick a shipping option → re-mounts the Klarna widget with the new total. */
  private onSelectShipping(id: string): void {
    if (this.selectedShipping === id || this.klarnaMounting) return
    this.selectedShipping = id
  }

  /** Switch the Klarna widget to a different payment_method_category. */
  private async onKlarnaCategory(identifier: string): Promise<void> {
    if (!this.klarnaHandle || this.klarnaSelectedCat === identifier) return
    this.klarnaSelectedCat = identifier
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
    this.klarnaAuthorizing = true
    try {
      // Resolves once the order is created (payment-complete) or surfaces a
      // payment-error event handled by boundOnPaymentError.
      await this.klarnaHandle.authorize()
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

  private onPay(method: PaymentMethod): void {
    this.paymentError = null
    if (method === 'apple-pay') {
      void this.onApplePay()
      return
    }
    Vio.checkout.selectPaymentMethod(method)
  }

  /**
   * Complete the order for the selected method (Vipps / Card / plain Klarna).
   * Apple Pay and Klarna Express finish inside their own sheet/popup, so they
   * never reach here. No real PSP is wired for Vipps/Card in this iteration —
   * the capture happens backend-side in the full flow — so this confirms the
   * order state-only and shows the confirmation screen.
   */
  private onCompleteOrder(): void {
    const s = this.checkoutState
    if (!s || !s.paymentMethod) return
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
      case 'vipps':
        return 'Vipps'
      case 'card':
        return 'kort'
      default:
        return ''
    }
  }

  /** True for methods that complete via a separate sheet/widget, not the CTA. */
  private isExpressMethod(method: PaymentMethod | undefined): boolean {
    // Apple Pay finishes in its sheet; Klarna finishes via its widget's
    // authorize() button — neither uses the generic "Betal" CTA.
    return method === 'apple-pay' || method === 'klarna'
  }

  private orderTotal(): string {
    const s = this.checkoutState
    if (!s) return ''
    return formatPrice(s.subtotal, s.currency)
  }

  /** Shipping cost (major units) applied in express mode, else 0. */
  private shippingMajor(): number {
    return this.express ? (this.shippingOption?.price ?? 0) / 100 : 0
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
  private renderKlarnaPanel() {
    const currency = this.checkoutState?.currency ?? 'NOK'
    return html`
      <div class="klarna-panel">
        ${this.express
          ? html`
              <div class="ship-select" role="radiogroup" aria-label="Frakt">
                ${KLARNA_SHIPPING_OPTIONS.map(
                  (o) => html`
                    <button
                      class="ship-opt ${this.selectedShipping === o.id ? 'active' : ''}"
                      role="radio"
                      aria-checked=${this.selectedShipping === o.id}
                      ?disabled=${this.klarnaMounting}
                      @click=${() => this.onSelectShipping(o.id)}
                    >
                      <span class="ship-meta">
                        <b>${o.method}</b><span>${o.description}</span>
                      </span>
                      <span class="ship-price">${formatPrice(o.price / 100, currency)}</span>
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
        <div class="klarna-widget" id="vio-klarna-payments-container"></div>
        <button
          class="payment-btn primary complete-cta"
          @click=${() => void this.onKlarnaAuthorize()}
          ?disabled=${this.klarnaAuthorizing || !this.klarnaHandle || this.klarnaMounting}
        >
          ${this.klarnaAuthorizing ? 'Behandler…' : `Betal ${this.payTotalLabel()} med Klarna`}
        </button>
      </div>
    `
  }

  /** Express layout — only the Klarna widget + a compact order summary. */
  private renderKlarnaExpress() {
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
                      <span>${formatPrice(item.unitPrice * item.quantity, item.currency)}</span>
                    </div>
                  `,
                )}
                <div class="order-row">
                  <span>Frakt${this.shippingOption ? ` – ${this.shippingOption.method}` : ''}</span>
                  <span>${formatPrice(this.shippingMajor(), this.checkoutState?.currency ?? 'NOK')}</span>
                </div>
                <div class="order-row total">
                  <span>Totalt</span><span>${this.payTotalLabel()}</span>
                </div>
              </div>
            `
          : ''}
        ${this.renderKlarnaPanel()}
        ${this.paymentError
          ? html`<div class="payment-error">${this.paymentError}</div>`
          : ''}
      </section>
    `
  }

  private renderCheckoutBody() {
    const method = this.checkoutState?.paymentMethod
    const showCompleteCta = !!method && !this.isExpressMethod(method)
    return html`
          <section class="section">
            <div class="section-label">Steg 1</div>
            <h3 class="section-heading">Leveringsadresse</h3>
            <div class="form-row">
              <div class="field">
                <label>Fornavn</label>
                <input
                  type="text"
                  autocomplete="given-name"
                  .value=${this.form.firstName}
                  @input=${(e: InputEvent) =>
                    this.onFieldChange('firstName', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="field">
                <label>Etternavn</label>
                <input
                  type="text"
                  autocomplete="family-name"
                  .value=${this.form.lastName}
                  @input=${(e: InputEvent) =>
                    this.onFieldChange('lastName', (e.target as HTMLInputElement).value)}
                />
              </div>
            </div>
            <div class="field">
              <label>E-post</label>
              <input
                type="email"
                autocomplete="email"
                .value=${this.form.email}
                @input=${(e: InputEvent) =>
                  this.onFieldChange('email', (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label>Adresse</label>
              <input
                type="text"
                autocomplete="street-address"
                .value=${this.form.address}
                @input=${(e: InputEvent) =>
                  this.onFieldChange('address', (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="form-row">
              <div class="field">
                <label>Postnummer</label>
                <input
                  type="text"
                  autocomplete="postal-code"
                  .value=${this.form.postalCode}
                  @input=${(e: InputEvent) =>
                    this.onFieldChange('postalCode', (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="field">
                <label>Sted</label>
                <input
                  type="text"
                  autocomplete="address-level2"
                  .value=${this.form.city}
                  @input=${(e: InputEvent) =>
                    this.onFieldChange('city', (e.target as HTMLInputElement).value)}
                />
              </div>
            </div>
          </section>

          <section class="section">
            <div class="section-label">Steg 2</div>
            <h3 class="section-heading">Velg betalingsmåte</h3>
            <div class="payment-grid">
              ${this.applePayAvailable
                ? html`
                    <button
                      class="payment-btn primary"
                      @click=${() => this.onPay('apple-pay')}
                      ?disabled=${this.applePayInProgress}
                      aria-pressed=${this.checkoutState?.paymentMethod === 'apple-pay'}
                    >
                      ${this.applePayInProgress ? 'Åpner…' : ' Pay'}
                    </button>
                  `
                : ''}
              ${this.klarnaAvailable
                ? html`
                    <button
                      class="payment-btn"
                      @click=${() => this.onPay('klarna')}
                      aria-pressed=${this.checkoutState?.paymentMethod === 'klarna'}
                    >
                      Klarna
                    </button>
                  `
                : ''}
              <button
                class="payment-btn"
                @click=${() => this.onPay('vipps')}
                aria-pressed=${this.checkoutState?.paymentMethod === 'vipps'}
              >
                Vipps
              </button>
              <button
                class="payment-btn"
                @click=${() => this.onPay('card')}
                aria-pressed=${this.checkoutState?.paymentMethod === 'card'}
              >
                Kort
              </button>
              ${!this.applePayAvailable
                ? html`
                    <div class="apple-pay-note">
                       Pay krever Safari på iOS eller macOS med Apple Pay konfigurert.
                    </div>
                  `
                : ''}
              ${showCompleteCta
                ? html`
                    <button
                      class="payment-btn primary complete-cta"
                      @click=${this.onCompleteOrder}
                    >
                      Betal ${this.orderTotal()} med ${this.methodLabel(method ?? null)}
                    </button>
                  `
                : ''}
              ${method === 'klarna' ? this.renderKlarnaPanel() : ''}
              ${this.paymentError
                ? html`<div class="payment-error">${this.paymentError}</div>`
                : ''}
            </div>
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
                    <span>Frakt</span><span>${this.shippingLabel}</span>
                  </div>
                  <div class="order-row total">
                    <span>Totalt</span><span>${this.orderTotal()}</span>
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
