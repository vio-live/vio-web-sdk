/**
 * <vio-cart> — slide-in cart drawer, reactively bound to `Vio.cart`.
 *
 * Subscribes to CartManager's `change` events on connect; auto-renders
 * the current multi-sponsor state. Express-only checkout: Apple Pay pays
 * the whole cart in-drawer; the Klarna button dispatches `vio:checkout-open`
 * (express) for the host to open <vio-checkout>.
 *
 * For the visual demo without `Vio.init`, the CartManager works standalone
 * (state is purely local + localStorage).
 */

import { LitElement, css, html } from 'lit'
import { property, state } from 'lit/decorators.js'
import { Vio } from '../../core/client.js'
import { formatPrice } from '../../core/types.js'
import type { CartChangeDetail } from '../../core/cart/cart-manager.js'
import type { SponsorCartState } from '../../core/cart/types.js'

/** Stripe wordmark, inlined so the published article needs no asset path. */
const STRIPE_LOGO_SRC =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg width="360" height="150" viewBox="0 0 360 150" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M360 77.4001C360 51.8001 347.6 31.6001 323.9 31.6001C300.1 31.6001 285.7 51.8001 285.7 77.2001C285.7 107.3 302.7 122.5 327.1 122.5C339 122.5 348 119.8 354.8 116V96.0001C348 99.4001 340.2 101.5 330.3 101.5C320.6 101.5 312 98.1001 310.9 86.3001H359.8C359.8 85.0001 360 79.8001 360 77.4001ZM310.6 67.9001C310.6 56.6001 317.5 51.9001 323.8 51.9001C329.9 51.9001 336.4 56.6001 336.4 67.9001H310.6Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M247.1 31.6001C237.3 31.6001 231 36.2001 227.5 39.4001L226.2 33.2001H204.2V149.8L229.2 144.5L229.3 116.2C232.9 118.8 238.2 122.5 247 122.5C264.9 122.5 281.2 108.1 281.2 76.4001C281.1 47.4001 264.6 31.6001 247.1 31.6001ZM241.1 100.5C235.2 100.5 231.7 98.4001 229.3 95.8001L229.2 58.7001C231.8 55.8001 235.4 53.8001 241.1 53.8001C250.2 53.8001 256.5 64.0001 256.5 77.1001C256.5 90.5001 250.3 100.5 241.1 100.5Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M169.8 25.7L194.9 20.3V0L169.8 5.3V25.7Z" fill="#533AFD"/><path d="M194.9 33.3H169.8V120.8H194.9V33.3Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M142.9 40.7L141.3 33.3H119.7V120.8H144.7V61.5C150.6 53.8 160.6 55.2 163.7 56.3V33.3C160.5 32.1 148.8 29.9 142.9 40.7Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M92.8999 11.6001L68.4999 16.8001L68.3999 96.9001C68.3999 111.7 79.4999 122.6 94.2999 122.6C102.5 122.6 108.5 121.1 111.8 119.3V99.0001C108.6 100.3 92.7999 104.9 92.7999 90.1001V54.6001H111.8V33.3001H92.7999L92.8999 11.6001Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M25.3 58.7001C25.3 54.8001 28.5 53.3001 33.8 53.3001C41.4 53.3001 51 55.6001 58.6 59.7001V36.2001C50.3 32.9001 42.1 31.6001 33.8 31.6001C13.5 31.6001 0 42.2001 0 59.9001C0 87.5001 38 83.1001 38 95.0001C38 99.6001 34 101.1 28.4 101.1C20.1 101.1 9.5 97.7001 1.1 93.1001V116.9C10.4 120.9 19.8 122.6 28.4 122.6C49.2 122.6 63.5 112.3 63.5 94.4001C63.4 64.6001 25.3 69.9001 25.3 58.7001Z" fill="#533AFD"/></svg>',
  )

export class VioCart extends LitElement {
  /** Drawer visibility. Reflects to attribute for `:host([open])`. */
  @property({ type: Boolean, reflect: true }) open = false
  @property({ type: String }) heading = 'Handlekurv'
  @property({ type: String, attribute: 'empty-label' }) emptyLabel = 'Handlekurven er tom'
  @property({ type: String, attribute: 'subtotal-label' }) subtotalLabel = 'Sum'

  @state() private carts: Map<number, SponsorCartState> = new Map()
  @state() private itemCount = 0
  /** True when Apple Pay is usable (Safari + device + Stripe configured). */
  @state() private applePayAvailable = false
  /** Payment method names enabled for the sponsor (backend-configured).
   * Empty = not loaded yet → all buttons render (graceful default). */
  @state() private availableMethods: string[] = []
  /** Set after an Apple Pay express purchase — switches the drawer to the
   * confirmation screen (so the rest of the cart/checkout is not shown). */
  @state() private confirmedOrder: {
    items: Array<{
      brand?: string
      name: string
      quantity: number
      unitPrice: number
      currency: string
    }>
    total: number
    currency: string
  } | null = null

  /** Pre-resolved Apple Pay handle; `show()` fires the sheet synchronously. */
  private applePayHandle: { available: boolean; show: () => Promise<unknown> } | null = null
  /** Cart total Apple Pay was last prepared for (avoids redundant prep). */
  private preparedTotal = -1
  /** In-flight guard for loadAvailablePaymentMethods. */
  private loadingPaymentMethods = false

  private boundOnCartChange = (e: Event): void => {
    const detail = (e as CustomEvent<CartChangeDetail>).detail
    this.carts = detail.cartsBySponsor
    this.itemCount = detail.itemCount
    // Cart changes fire often — only fetch methods if we don't have them yet.
    if (this.availableMethods.length === 0) {
      void this.loadAvailablePaymentMethods()
    }
  }

  static override styles = css`
    :host { display: contents; }

    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
      z-index: 998;
    }
    :host([open]) .backdrop { opacity: 1; pointer-events: auto; }

    .drawer {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(440px, 100%);
      background: var(--vio-color-surface, #fff);
      transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
      display: flex;
      flex-direction: column;
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
      color: var(--vio-color-text, #0a0a0a);
      z-index: 999;
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.06);
    }
    :host([open]) .drawer { transform: translateX(0); }

    .handle { display: none; }

    /* Mobile: bottom sheet (slide up, rounded top, drag handle). */
    @media (max-width: 600px) {
      .drawer {
        top: auto;
        right: 0;
        left: 0;
        bottom: 0;
        width: 100%;
        height: 88vh;
        border-radius: 16px 16px 0 0;
        transform: translateY(100%);
        box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.08);
      }
      :host([open]) .drawer { transform: translateY(0); }
      .handle {
        display: flex;
        justify-content: center;
        padding: 10px 0 4px;
      }
      .handle::before {
        content: '';
        width: 40px;
        height: 4px;
        background: var(--vio-color-border, #e5e5e5);
        border-radius: 2px;
      }
    }

    .header {
      padding: var(--vio-space-lg, 24px);
      border-bottom: 1px solid var(--vio-color-border, #e5e5e5);
      display: flex;
      justify-content: space-between;
      align-items: center;
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
      flex: 1;
      overflow-y: auto;
    }

    .sponsor-group {
      padding: var(--vio-space-md, 16px) var(--vio-space-lg, 24px);
      border-bottom: 1px solid var(--vio-color-border, #e5e5e5);
    }
    .sponsor-group:last-child { border-bottom: none; }
    .sponsor-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-tertiary, #999);
      font-weight: 500;
      margin: 0 0 var(--vio-space-md, 16px);
    }

    .item {
      display: grid;
      grid-template-columns: 80px 1fr;
      gap: var(--vio-space-md, 16px);
      padding: var(--vio-space-md, 16px) 0;
      border-bottom: 1px solid var(--vio-color-border, #e5e5e5);
    }
    .item:last-child { border-bottom: none; }
    .item-image {
      aspect-ratio: 1;
      background: var(--vio-color-surface-muted, #f2f2f2);
      overflow: hidden;
    }
    .item-image img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .item-brand {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 500;
    }
    .item-name {
      font-size: 14px;
      margin: 4px 0;
      font-weight: 500;
      line-height: 1.3;
    }
    .item-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: var(--vio-space-sm, 8px);
    }
    .item-qty {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vio-color-text-secondary, #666);
      font-size: 12px;
    }
    .qty-btn {
      width: 24px;
      height: 24px;
      border: 1px solid var(--vio-color-border, #e5e5e5);
      background: #fff;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
      color: var(--vio-color-text, #0a0a0a);
      line-height: 1;
      padding: 0;
      font-family: inherit;
    }
    .qty-btn:hover { border-color: var(--vio-color-text, #0a0a0a); }
    .item-price { font-size: 14px; font-weight: 700; }

    .empty {
      padding: 80px var(--vio-space-lg, 24px);
      text-align: center;
      color: var(--vio-color-text-secondary, #666);
      font-size: 14px;
    }

    .footer {
      padding: var(--vio-space-lg, 24px);
      border-top: 1px solid var(--vio-color-border, #e5e5e5);
      background: var(--vio-color-surface, #fff);
    }
    .subtotal-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: var(--vio-space-md, 16px);
      font-size: 14px;
    }
    .subtotal-label { color: var(--vio-color-text-secondary, #666); }
    .subtotal-value { font-weight: 700; font-size: 16px; }

    /* Apple Pay express — pay the whole cart directly. */
    .applepay-btn {
      width: 100%;
      padding: 15px;
      margin-bottom: 10px;
      background: #000;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 19px;
      font-weight: 500;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      transition: opacity 0.15s;
    }
    .applepay-btn:hover { opacity: 0.86; }
    .applepay-btn .ap-logo { width: 20px; height: 20px; }
    /* Klarna express — pink brand button, same express row as Apple Pay. */
    .klarna-btn {
      width: 100%;
      padding: 15px;
      margin-bottom: 10px;
      background: #ffb3c7;
      color: #0a0a0a;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
      transition: background 0.15s;
    }
    .klarna-btn:hover { background: #ffa1ba; }
    .klarna-btn .klarna-logo { height: 15px; width: auto; display: inline-block; }
    /* Vipps — brand orange button, same express row. */
    .vipps-btn {
      width: 100%;
      padding: 15px;
      margin-bottom: 10px;
      background: #ff5b24;
      color: #fff;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
      transition: background 0.15s;
    }
    .vipps-btn:hover { background: #ec4f1c; }
    .vipps-btn .vipps-logo {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1;
    }
    /* Stripe — brand blurple button, same express row. */
    .stripe-btn {
      width: 100%;
      padding: 15px;
      margin-bottom: 10px;
      background: #635bff;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
      transition: background 0.15s;
    }
    .stripe-btn:hover { background: #5248ff; }
    .stripe-btn .stripe-logo { height: 20px; width: auto; display: inline-block; filter: brightness(0) invert(1); }

    /* In-drawer confirmation after Apple Pay (nothing else is shown). */
    .confirm {
      padding: 56px var(--vio-space-lg, 24px) 40px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .confirm-check {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: #0a8a3f;
      color: #fff;
      font-size: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
    }
    .confirm h3 {
      font-family: var(--vio-font-serif, Georgia, serif);
      font-size: 24px;
      font-weight: 400;
      margin: 0 0 8px;
    }
    .confirm p {
      color: var(--vio-color-text-secondary, #666);
      font-size: 14px;
      margin: 0 0 24px;
    }
    .confirm-summary {
      width: 100%;
      border-top: 1px solid var(--vio-color-border, #e5e5e5);
      padding-top: 16px;
      margin-bottom: 28px;
      text-align: left;
    }
    .order-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 14px;
      margin-bottom: 10px;
      color: var(--vio-color-text, #0a0a0a);
    }
    .order-row.total {
      border-top: 1px solid var(--vio-color-border, #e5e5e5);
      padding-top: 12px;
      margin-top: 4px;
      font-weight: 700;
    }
    .confirm-close {
      width: 100%;
      padding: 16px;
      background: var(--vio-color-text, #0a0a0a);
      color: #fff;
      border: none;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      cursor: pointer;
      font-weight: 600;
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
    }
    .confirm-close:hover { background: #222; }
  `

  override connectedCallback(): void {
    super.connectedCallback()
    // Seed initial state from manager.
    this.carts = Vio.cart.getAllCarts()
    this.itemCount = Vio.cart.itemCount
    Vio.cart.addEventListener('change', this.boundOnCartChange)
    void this.loadAvailablePaymentMethods()
  }

  override disconnectedCallback(): void {
    Vio.cart.removeEventListener('change', this.boundOnCartChange)
    super.disconnectedCallback()
  }

  close(): void { this.open = false }
  show(): void {
    this.open = true
    void this.loadAvailablePaymentMethods()
  }

  /** Which payment buttons to render — backend-configured per sponsor.
   * Falls back to showing everything if the query fails or none is set. */
  private async loadAvailablePaymentMethods(): Promise<void> {
    if (this.loadingPaymentMethods) return
    this.loadingPaymentMethods = true
    const firstSponsorId =
      [...this.carts.keys()][0] ??
      (globalThis as { __VIO_SPONSOR_ID__?: number }).__VIO_SPONSOR_ID__
    if (firstSponsorId === undefined) {
      this.loadingPaymentMethods = false
      return
    }
    try {
      const methods = (await Vio.checkout.getAvailablePaymentMethods(firstSponsorId)) as
        | Array<{ name: string }>
        | unknown
      if (Array.isArray(methods)) {
        this.availableMethods = methods.map((m) => m.name)
      } else {
        this.availableMethods = ['Stripe', 'Klarna', 'Vipps']
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioCart] Failed to load payment methods:', err)
      }
      this.availableMethods = ['Stripe', 'Klarna', 'Vipps']
    } finally {
      this.loadingPaymentMethods = false
    }
  }

  private methodEnabled(name: string): boolean {
    return (
      this.availableMethods.length === 0 ||
      this.availableMethods.some((m) => m.toLowerCase() === name)
    )
  }

  override updated(changed: Map<string, unknown>): void {
    // Fresh open → drop any previous confirmation, force an Apple Pay re-prep.
    if (changed.has('open') && this.open) {
      this.confirmedOrder = null
      this.preparedTotal = -1
    }
    // (Re)prepare Apple Pay whenever the open cart's total changes.
    if (this.open && this.itemCount > 0) {
      const total = this.totalAcrossSponsors
      if (total !== this.preparedTotal) {
        this.preparedTotal = total
        void this.refreshApplePay(total)
      }
    }
  }

  /** Pre-resolve the Apple Pay sheet for the current cart total. */
  private async refreshApplePay(total: number): Promise<void> {
    if (total <= 0) {
      this.applePayHandle = null
      this.applePayAvailable = false
      return
    }
    try {
      const handle = await Vio.checkout.prepareApplePayExpress(total, this.primaryCurrency)
      // A newer prep may have superseded this one while awaiting.
      if (this.preparedTotal !== total) return
      this.applePayHandle = handle
      this.applePayAvailable = handle.available
    } catch {
      this.applePayHandle = null
      this.applePayAvailable = false
    }
  }

  /** Apple Pay express — pay the whole cart, then show the confirmation. */
  private onApplePay(): void {
    const handle = this.applePayHandle
    if (!handle || !handle.available || this.itemCount === 0) return
    // Snapshot items + total BEFORE clearing the cart (confirmation needs them).
    const snapshot = this.buildConfirmation()
    // Fire the sheet synchronously inside the tap (Apple gesture rule); handle
    // the result asynchronously.
    void handle.show().then((result) => {
      if (!result) return // user cancelled / failed — keep the cart as-is
      this.confirmedOrder = snapshot
      for (const sponsorId of [...this.carts.keys()]) {
        Vio.cart.clearSponsorCart(sponsorId)
      }
      this.dispatchEvent(
        new CustomEvent('vio:payment-success', {
          bubbles: true,
          composed: true,
          detail: { method: 'apple-pay', result },
        }),
      )
    })
  }

  private buildConfirmation(): NonNullable<VioCart['confirmedOrder']> {
    const items: NonNullable<VioCart['confirmedOrder']>['items'] = []
    for (const cart of this.carts.values()) {
      for (const it of cart.items) {
        items.push({
          brand: it.brand,
          name: it.name,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          currency: it.currency,
        })
      }
    }
    return { items, total: this.totalAcrossSponsors, currency: this.primaryCurrency }
  }

  private closeConfirmation(): void {
    this.confirmedOrder = null
    this.close()
  }

  /** Klarna express — opens the side-drawer Klarna checkout for the whole cart,
   * skipping the address form (leveringsadresse) and method picker
   * (betalingsmetode). The host's checkout-open handler closes this cart and
   * opens <vio-checkout> in express mode with Klarna preselected. */
  private onKlarnaExpress(): void {
    if (this.itemCount === 0) return
    const firstSponsorId = [...this.carts.keys()][0]
    if (firstSponsorId === undefined) return
    this.dispatchEvent(
      new CustomEvent('vio:checkout-open', {
        bubbles: true,
        composed: true,
        detail: { sponsorId: firstSponsorId, paymentMethod: 'klarna', express: true },
      }),
    )
  }

  /** Vipps — opens the checkout with Vipps preselected. */
  private onVipps(): void {
    if (this.itemCount === 0) return
    const firstSponsorId = [...this.carts.keys()][0]
    if (firstSponsorId === undefined) return
    this.dispatchEvent(
      new CustomEvent('vio:checkout-open', {
        bubbles: true,
        composed: true,
        detail: { sponsorId: firstSponsorId, paymentMethod: 'vipps', express: false },
      }),
    )
  }

  /** Stripe — opens the checkout with Stripe preselected. */
  private onStripe(): void {
    if (this.itemCount === 0) return
    const firstSponsorId = [...this.carts.keys()][0]
    if (firstSponsorId === undefined) return
    this.dispatchEvent(
      new CustomEvent('vio:checkout-open', {
        bubbles: true,
        composed: true,
        detail: { sponsorId: firstSponsorId, paymentMethod: 'stripe', express: false },
      }),
    )
  }

  private get totalAcrossSponsors(): number {
    let sum = 0
    for (const cart of this.carts.values()) {
      for (const item of cart.items) sum += item.unitPrice * item.quantity
    }
    return sum
  }

  private get primaryCurrency(): string {
    for (const cart of this.carts.values()) return cart.currency
    return 'NOK'
  }

  private onIncrement(item: { id: string; sponsorId: number; quantity: number }): void {
    Vio.cart.updateQuantity(item.id, item.sponsorId, item.quantity + 1)
  }

  private onDecrement(item: { id: string; sponsorId: number; quantity: number }): void {
    Vio.cart.updateQuantity(item.id, item.sponsorId, item.quantity - 1)
  }

  private onRemove(item: { id: string; sponsorId: number }): void {
    Vio.cart.removeItem(item.id, item.sponsorId)
  }

  override render() {
    const isEmpty = this.itemCount === 0
    const sponsorCarts = [...this.carts.values()].filter((c) => c.items.length > 0)

    return html`
      <div class="backdrop" @click=${this.close}></div>
      <aside class="drawer" role="dialog" aria-label=${this.heading}>
        <div class="handle" @click=${this.close} aria-hidden="true"></div>
        <div class="header">
          <h2 class="heading">${this.confirmedOrder ? 'Takk!' : this.heading}</h2>
          <button class="close" @click=${this.close} aria-label="Lukk">×</button>
        </div>

        ${this.confirmedOrder
          ? this.renderConfirmation()
          : isEmpty
          ? html`<div class="empty">${this.emptyLabel}</div>`
          : html`
              <div class="body">
                ${sponsorCarts.map(
                  (cart) => html`
                    <div class="sponsor-group">
                      ${cart.sponsorName
                        ? html`<div class="sponsor-label">${cart.sponsorName}</div>`
                        : ''}
                      ${cart.items.map(
                        (item) => html`
                          <div class="item">
                            <div class="item-image">
                              ${item.imageUrl
                                ? html`<img src=${item.imageUrl} alt=${item.name} />`
                                : ''}
                            </div>
                            <div>
                              <div class="item-brand">${item.brand}</div>
                              <div class="item-name">${item.name}</div>
                              <div class="item-row">
                                <span class="item-qty">
                                  <button
                                    class="qty-btn"
                                    @click=${() => this.onDecrement(item)}
                                    aria-label="Reduser"
                                  >
                                    −
                                  </button>
                                  ${item.quantity}
                                  <button
                                    class="qty-btn"
                                    @click=${() => this.onIncrement(item)}
                                    aria-label="Øk"
                                  >
                                    +
                                  </button>
                                  <button
                                    class="qty-btn"
                                    @click=${() => this.onRemove(item)}
                                    aria-label="Fjern"
                                    style="margin-left: 8px;"
                                  >
                                    ×
                                  </button>
                                </span>
                                <span class="item-price">
                                  ${formatPrice(
                                    item.unitPrice * item.quantity,
                                    item.currency,
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>
                        `,
                      )}
                    </div>
                  `,
                )}
              </div>
              <div class="footer">
                <div class="subtotal-row">
                  <span class="subtotal-label">${this.subtotalLabel}</span>
                  <span class="subtotal-value">
                    ${formatPrice(this.totalAcrossSponsors, this.primaryCurrency)}
                  </span>
                </div>
                ${this.applePayAvailable
                  ? html`
                      <button
                        class="applepay-btn"
                        @click=${this.onApplePay}
                        aria-label="Betal med Apple Pay"
                      >
                        <svg class="ap-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
                        Apple Pay
                      </button>
                    `
                  : ''}
                ${this.methodEnabled('stripe')
                  ? html`
                      <button
                        class="stripe-btn"
                        @click=${this.onStripe}
                        aria-label="Betal med Stripe"
                      >
                        <img class="stripe-logo" src=${STRIPE_LOGO_SRC} alt="Stripe" />
                      </button>
                    `
                  : ''}
                ${this.methodEnabled('klarna')
                  ? html`
                      <button
                        class="klarna-btn"
                        @click=${this.onKlarnaExpress}
                        aria-label="Betal med Klarna"
                      >
                        Kjøp med
                        <img
                          class="klarna-logo"
                          src="https://x.klarnacdn.net/payment-method/assets/badges/generic/klarna.svg"
                          alt="Klarna"
                        />
                      </button>
                    `
                  : ''}
                ${this.methodEnabled('vipps')
                  ? html`
                      <button
                        class="vipps-btn"
                        @click=${this.onVipps}
                        aria-label="Betal med Vipps"
                      >
                        <span class="vipps-logo">vipps</span>
                      </button>
                    `
                  : ''}
              </div>
            `}
      </aside>
    `
  }

  private renderConfirmation() {
    const o = this.confirmedOrder
    if (!o) return html``
    return html`
      <div class="confirm">
        <div class="confirm-check" aria-hidden="true">✓</div>
        <h3>Takk for handelen!</h3>
        <p>Betaling med Apple Pay er bekreftet.</p>
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
            <span>Totalt</span>
            <span>${formatPrice(o.total, o.currency)}</span>
          </div>
        </div>
        <button class="confirm-close" @click=${this.closeConfirmation}>Lukk</button>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vio-cart': VioCart
  }
}
