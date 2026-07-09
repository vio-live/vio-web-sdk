/**
 * <vio-product> — single product card matching the editorial style of the
 * Allermedia "Shop Favorittene" carousel. Image-forward, brand top,
 * sans-serif body, bold price, retailer at the bottom. Whole card is
 * clickable; emits `vio:product-click` with productId/sponsorId for the
 * host site to drive checkout opening.
 */

import { LitElement, css, html } from 'lit'
import { property, state } from 'lit/decorators.js'
import { Vio } from '../../core/client.js'

export class VioProduct extends LitElement {
  /** Brand label shown at the top (uppercase, gray, small). */
  @property({ type: String }) brand = ''
  /** Product display name. Two-line truncation. */
  @property({ type: String }) name = ''
  /** Pre-formatted price string (e.g. "990 kr"). Bold. */
  @property({ type: String }) price = ''
  /** Retailer / sponsor name shown at the bottom (uppercase, gray). */
  @property({ type: String }) retailer = ''
  /** Product image URL. Square aspect, gray bg if missing. */
  @property({ type: String, attribute: 'image-url' }) imageUrl = ''
  /** Vio product id, propagated to click event. */
  @property({ type: String, attribute: 'product-id' }) productId = ''
  /** Vio sponsor id, propagated to click event. */
  @property({ type: String, attribute: 'sponsor-id' }) sponsorId = ''
  /** Whether the product has selectable variants — the quick-add button then
   * opens the detail to pick one instead of adding directly. */
  @property({ type: Boolean, attribute: 'has-variants' }) hasVariants = false

  /** Image-only mode: hide the meta block (brand / name / price / retailer)
   * and show just the image + the quick-add button. Click still opens the
   * detail. */
  @property({ type: Boolean, attribute: 'hide-meta' }) hideMeta = false

  /** True when this product currently sits in the cart (persistent mark). */
  @state() private inCart = false
  /** Total units of this product in the cart (shown as a count when > 1). */
  @state() private cartQty = 0
  /** Transient flag driving the add "pop" animation. */
  @state() private justAdded = false

  private boundCartChange = (): void => this.updateInCart()

  static override styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      cursor: pointer;
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
      color: var(--vio-color-text, #0a0a0a);
      -webkit-tap-highlight-color: transparent;
    }
    .card {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .image {
      position: relative;
      aspect-ratio: 1 / 1;
      width: 100%;
      background-color: var(--vio-color-surface-muted, #f2f2f2);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      transition: opacity 0.2s ease;
    }
    :host(:hover) .image img { opacity: 0.92; }

    /* Quick add-to-cart button — overlaid bottom-right of the image, like the
       reference card's wishlist heart but wired to add the product to the cart. */
    .add-btn {
      position: absolute;
      right: 10px;
      bottom: 10px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.96);
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: #0a0a0a;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
      transition: transform 0.14s ease, background 0.14s ease, color 0.14s ease;
      padding: 0;
      z-index: 2;
    }
    .add-btn:hover { background: #fff; transform: scale(1.08); }
    .add-btn:active { transform: scale(0.95); }
    /* In cart → black circle with a white tick (matches the floating cart). */
    .add-btn.in-cart { background: #0a0a0a; color: #fff; }
    .add-btn.in-cart:hover { background: #222; }
    .add-btn.pop { animation: vio-add-pop 0.42s cubic-bezier(0.34, 1.56, 0.64, 1); }
    .add-btn svg { width: 18px; height: 18px; }
    .add-btn .add-count { font-size: 15px; font-weight: 700; line-height: 1; }
    @keyframes vio-add-pop {
      0% { transform: scale(1); }
      35% { transform: scale(1.32); }
      60% { transform: scale(0.9); }
      100% { transform: scale(1); }
    }
    .image img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .meta {
      padding-top: 14px;
      display: flex;
      flex-direction: column;
      flex: 1;
    }
    .brand {
      font-size: var(--vio-size-xs, 12px);
      letter-spacing: var(--vio-tracking-label, 0.1em);
      text-transform: uppercase;
      color: var(--vio-color-text-secondary, #666);
      font-weight: 500;
      margin-bottom: 6px;
    }
    .name {
      font-size: var(--vio-size-md, 16px);
      font-weight: 500;
      line-height: 1.3;
      margin: 0 0 10px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .price {
      font-size: var(--vio-size-md, 16px);
      font-weight: 700;
      margin-bottom: 16px;
    }
    .retailer {
      font-size: var(--vio-size-xs, 12px);
      letter-spacing: var(--vio-tracking-label, 0.1em);
      text-transform: uppercase;
      color: var(--vio-color-text-tertiary, #999);
      font-weight: 500;
      margin-top: auto;
    }
  `

  override connectedCallback(): void {
    super.connectedCallback()
    this.updateInCart()
    Vio.cart.addEventListener('change', this.boundCartChange)
  }

  override disconnectedCallback(): void {
    Vio.cart.removeEventListener('change', this.boundCartChange)
    super.disconnectedCallback()
  }

  override updated(changed: Map<string, unknown>): void {
    // product-id / sponsor-id are set as attributes after construction.
    if (changed.has('productId') || changed.has('sponsorId')) this.updateInCart()
  }

  /** Reflect whether (and how many units of) this product sit in the cart. */
  private updateInCart(): void {
    const pid = Number(this.productId)
    if (!Number.isFinite(pid) || pid <= 0) {
      this.inCart = false
      this.cartQty = 0
      return
    }
    const sid = Number(this.sponsorId)
    let qty = 0
    for (const cart of Vio.cart.getAllCarts().values()) {
      if (Number.isFinite(sid) && sid > 0 && cart.sponsorId !== sid) continue
      for (const i of cart.items) if (Number(i.productId) === pid) qty += i.quantity
    }
    this.inCart = qty > 0
    this.cartQty = qty
  }

  private onClick(): void {
    this.dispatchEvent(
      new CustomEvent('vio:product-click', {
        bubbles: true,
        composed: true,
        detail: {
          productId: this.productId,
          sponsorId: this.sponsorId,
          brand: this.brand,
          name: this.name,
          price: this.price,
          retailer: this.retailer,
          imageUrl: this.imageUrl,
        },
      }),
    )
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      this.onClick()
    }
  }

  /** Quick add-to-cart. If the product has selectable variants, open the detail
   * to pick one instead (the host can't choose for the user). Otherwise emit
   * `vio:product-add` so the host adds it (bumping quantity on repeat taps). */
  private onAdd(e: Event): void {
    e.stopPropagation()
    if (this.hasVariants) {
      this.onClick()
      return
    }
    this.dispatchEvent(
      new CustomEvent('vio:product-add', {
        bubbles: true,
        composed: true,
        detail: {
          productId: this.productId,
          sponsorId: this.sponsorId,
          brand: this.brand,
          name: this.name,
          price: this.price,
          retailer: this.retailer,
          imageUrl: this.imageUrl,
        },
      }),
    )
    // Optimistic pop; the persistent "in cart" mark follows from the cart event.
    this.justAdded = true
    setTimeout(() => {
      this.justAdded = false
    }, 450)
  }

  override render() {
    return html`
      <div
        class="card"
        @click=${this.onClick}
        @keydown=${this.onKeydown}
        role="button"
        tabindex="0"
        aria-label=${`${this.brand} ${this.name} ${this.price}`}
      >
        <div class="image">
          ${this.imageUrl
            ? html`<img src=${this.imageUrl} alt=${this.name || this.brand} loading="lazy" />`
            : ''}
          <button
            class="add-btn ${this.inCart ? 'in-cart' : ''} ${this.justAdded ? 'pop' : ''}"
            @click=${this.onAdd}
            aria-label=${this.inCart ? 'I handlekurven – legg til en til' : 'Legg i kurv'}
            title=${this.inCart ? 'I handlekurven' : 'Legg i kurv'}
          >
            ${this.inCart
              ? this.cartQty > 1
                ? html`<span class="add-count">${this.cartQty}</span>`
                : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>`
              : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
                  <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <path d="M16 10a4 4 0 0 1-8 0"></path>
                </svg>`}
          </button>
        </div>
        ${this.hideMeta
          ? ''
          : html`
        <div class="meta">
          ${this.brand ? html`<div class="brand">${this.brand}</div>` : ''}
          ${this.name ? html`<div class="name">${this.name}</div>` : ''}
          ${this.price ? html`<div class="price">${this.price}</div>` : ''}
          ${this.retailer ? html`<div class="retailer">${this.retailer}</div>` : ''}
        </div>`}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vio-product': VioProduct
  }
}
