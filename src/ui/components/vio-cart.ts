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
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 25" fill="none"><path d="M5.4 12.8c0-1.8 1.4-2.8 3.8-2.8 1.5 0 2.9.4 3.7.8V7.4c-.8-.3-2.1-.6-3.5-.6-3.8 0-6.4 2-6.4 5.9 0 5.4 7.2 4.5 7.2 6.9 0 1.9-1.5 2.8-3.9 2.8-1.8 0-3.3-.4-4.2-1v3.5c1 .5 2.4.8 4 .8 4 0 6.6-2 6.6-6 0-5.8-7.3-4.7-7.3-6.9zM19.1 7.2c-1.3 0-2.1.6-2.5 1.1v-6.7h-2.5v17.4h2.5V11c0-1.6 1.1-2.4 2.4-2.4 1.3 0 2.2.8 2.2 2.4v8h2.5v-8.3c0-2.3-1.6-3.5-4.7-3.5zM27 7.2h-2.5v11.8H27V7.2zM27 3.3h-2.5v2.5H27V3.3zM34.9 7.2c-1.4 0-2.3.6-2.8 1.3V7.2h-2.5v16.1h2.5v-4.5c.5.7 1.4 1.3 2.8 1.3 2.9 0 5-2.2 5-6.6s-2.1-6.3-5-6.3zm-.6 9.8c-1.4 0-2.3-1-2.3-2.6s.9-2.6 2.3-2.6c1.4 0 2.4 1 2.4 2.6s-1 2.6-2.4 2.6zM46.7 13c-.3-.2-1.3-.7-2.4-.7-1.5 0-2.4.9-2.4 2.2 0 1.3 1.1 1.9 2.7 2.3 2.2.6 4.3 1.3 4.3 4.1 0 3.3-2.7 4.8-6.1 4.8-1.9 0-3.7-.5-4.8-1.2v-3.4c1.1.7 2.7 1.2 4.4 1.2 1.7 0 2.8-.7 2.8-2 0-1.4-1.1-1.9-2.9-2.3-2.4-.6-4.1-1.5-4.1-4 0-3 2.4-4.5 5.5-4.5 1.7 0 3.1.4 4 .9V13z" fill="#635BFF"/></svg>',
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

  private boundOnCartChange = (e: Event): void => {
    const detail = (e as CustomEvent<CartChangeDetail>).detail
    this.carts = detail.cartsBySponsor
    this.itemCount = detail.itemCount
    void this.loadAvailablePaymentMethods()
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
    const firstSponsorId =
      [...this.carts.keys()][0] ??
      (globalThis as { __VIO_SPONSOR_ID__?: number }).__VIO_SPONSOR_ID__
    if (firstSponsorId === undefined) return
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
