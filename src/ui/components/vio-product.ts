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
import { SlotRegistration } from '../slot-registration.js'

export class VioProduct extends LitElement {
  /** Brand label shown at the top (uppercase, gray, small). */
  @property({ type: String }) brand = ''
  /** Product display name. Two-line truncation. */
  @property({ type: String }) name = ''
  /** Pre-formatted price string (e.g. "990 kr"). Bold. */
  @property({ type: String }) price = ''
  /** Short text under the name (plain text, cut after --vio-card-description-lines, 4). Shown only with `show-description`. */
  @property({ type: String }) description = ''
  /** Show `description` under the name. Off by default. */
  @property({ type: Boolean, attribute: 'show-description' }) showDescription = false
  /**
   * The buy button, as in the Vev card: `icon` (the round bag on the image —
   * default), `bar` (a full-width button under the price) or `hidden`. Both
   * add to the cart, or open the product when it has sizes to pick.
   */
  @property({ type: String, attribute: 'button-style' }) buttonStyle: 'icon' | 'bar' | 'hidden' = 'icon'
  /** Text of the `bar` button (default «Kjøp»); «Kjøp · 2» once two are in the cart. */
  @property({ type: String, attribute: 'button-label' }) buttonLabel = 'Kjøp'
  /** Retailer / sponsor name shown at the bottom (uppercase, gray). */
  @property({ type: String }) retailer = ''
  /** Product image URL. Square aspect, gray bg if missing. */
  @property({ type: String, attribute: 'image-url' }) imageUrl = ''
  /** Vio product id, propagated to click event. */
  @property({ type: String, attribute: 'product-id' }) productId = ''
  /** Vio sponsor id, propagated to click event. */
  @property({ type: String, attribute: 'sponsor-id' }) sponsorId = ''
  /**
   * Slot this card sits in (ADR-0027). Optional: without it the card registers
   * itself as `card-N` (its position among the cards on the page). Set it to
   * name the place yourself or to make several elements share one slot. It is
   * carried by every event the card emits, so attribution goes to the campaign
   * assigned to the slot. The attribute is `vio-slot`, not `slot` — that one
   * is HTML's own (shadow DOM slotting).
   */
  @property({ type: String, attribute: 'vio-slot' }) vioSlot = ''
  /** Human name of the slot for the dashboard (`vio-slot-name`). Optional. */
  @property({ type: String, attribute: 'vio-slot-name' }) vioSlotName = ''
  /**
   * Scope of the auto id (`article-123-card-1`). Inherited: this attribute,
   * else the nearest ancestor's `data-vio-scope` (a page sets it ONCE on
   * `<body>` and every block gets a per-page slot). Optional.
   */
  @property({ type: String, attribute: 'vio-scope' }) vioScope = ''
  /** Human label of the scope (` · Title` in the slot name); inherited from `data-vio-scope-name`. */
  @property({ type: String, attribute: 'vio-scope-name' }) vioScopeName = ''
  /**
   * The campaign this element's PAGE belongs to (ADR-0034, amendment 3).
   * Inherited: this attribute, else the nearest ancestor's `data-vio-campaign`,
   * else `Vio.init({ campaignId })`. A dashboard assignment of the slot wins
   * over it. Optional.
   */
  @property({ type: String, attribute: 'vio-campaign' }) vioCampaign = ''
  /** Per-element override of the content (article) id the events carry; see `Vio.content()`. */
  @property({ type: String, attribute: 'vio-content-id' }) vioContentId = ''
  /** Per-element override of the content title. */
  @property({ type: String, attribute: 'vio-content-title' }) vioContentTitle = ''
  /**
   * What kind of SDK element this card stands for in analytics
   * (`component_template_id`): `product-card` on its own; a carousel sets
   * `product-carousel` on the cards it renders, so its impressions and its
   * clicks count under one component type.
   */
  @property({ type: String, attribute: 'component-template-id' }) componentTemplateId = ''
  private readonly slotRegistration = new SlotRegistration(this, 'card')

  /** The slot id in effect: `vio-slot`, else the auto id (`card-N`). Read-only. */
  get effectiveSlot(): string {
    return this.slotRegistration.effective
  }

  /** The element's own page campaign (`vio-campaign` / ancestor), if any; `Vio.init`'s applies otherwise. */
  get effectiveCampaignId(): number | undefined {
    return this.slotRegistration.campaignId
  }

  /** The slot campaign's sponsor as the string the attributes use ('' when unknown). */
  private sponsorFromAttribution(): string {
    const id =
      typeof Vio.attribution === 'function'
        ? Vio.attribution(this.effectiveSlot, { campaignId: this.slotRegistration.campaignHint }).sponsorId
        : undefined
    return id !== undefined ? String(id) : ''
  }

  private slotAttributes() {
    return {
      vioSlot: this.vioSlot,
      vioSlotName: this.vioSlotName,
      vioScope: this.vioScope,
      vioScopeName: this.vioScopeName,
      vioCampaign: this.vioCampaign,
    }
  }

  /**
   * What every event carries for attribution (`Vio.attribution`): the place,
   * its campaign and sponsor, and the content — overridden here when the host
   * set `vio-content-id` / `vio-content-title` on this card.
   */
  private attribution() {
    // A page whose `Vio` singleton comes from an older bundle has no attribution().
    const base =
      typeof Vio.attribution === 'function'
        ? Vio.attribution(this.effectiveSlot, {
            sponsorId: this.sponsorId || undefined,
            campaignId: this.slotRegistration.campaignHint,
          })
        : { slot: this.effectiveSlot || undefined }
    return {
      ...base,
      componentTemplateId: this.componentTemplateId || 'product-card',
      ...(this.vioContentId ? { contentId: this.vioContentId } : {}),
      ...(this.vioContentTitle ? { contentTitle: this.vioContentTitle } : {}),
    }
  }
  /** Whether the product has selectable variants — the quick-add button then
   * opens the detail to pick one instead of adding directly. */
  @property({ type: Boolean, attribute: 'has-variants' }) hasVariants = false
  /** Optional raw variants/options from the host — extra signal that a
   * variant must be picked before adding (selection is mandatory). */
  @property({ attribute: false }) variants: unknown[] | undefined = undefined
  @property({ attribute: false }) options: unknown[] | undefined = undefined

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
      font-family: var(--vio-card-font, var(--vio-font-sans, -apple-system, sans-serif));
      color: var(--vio-color-text, #0a0a0a);
      -webkit-tap-highlight-color: transparent;
    }
    /* Every --vio-card-* below defaults to the look the card always had; a
       host restyles the card with them (they cross the carousel's shadow
       root, ::part would not). E.g. a framed card with a buy button:
       --vio-card-border, --vio-card-meta-padding, --vio-card-image-fit: contain. */
    .card {
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      border: var(--vio-card-border, none);
      background: var(--vio-card-bg, transparent);
      transition: border-color 0.2s ease;
    }
    :host(:hover) .card { border-color: var(--vio-card-border-hover-color, var(--vio-color-border, #e5e5e5)); }
    .image {
      position: relative;
      aspect-ratio: var(--vio-card-image-aspect, 1 / 1);
      width: 100%;
      background-color: var(--vio-card-image-bg, var(--vio-color-surface-muted, #f2f2f2));
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
      width: var(--vio-card-add-size, 40px);
      height: var(--vio-card-add-size, 40px);
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
    .add-btn svg { width: var(--vio-card-add-icon-size, 18px); height: var(--vio-card-add-icon-size, 18px); }
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
      box-sizing: border-box;
      padding: var(--vio-card-image-padding, 0);
      object-fit: var(--vio-card-image-fit, cover);
      display: block;
    }
    .meta {
      padding: var(--vio-card-meta-padding, 14px 0 0);
      display: flex;
      flex-direction: column;
      flex: 1;
    }
    .brand {
      font-size: var(--vio-card-brand-size, var(--vio-size-xs, 12px));
      letter-spacing: var(--vio-card-brand-tracking, var(--vio-tracking-label, 0.1em));
      text-transform: uppercase;
      color: var(--vio-card-brand-color, var(--vio-color-text-secondary, #666));
      font-weight: var(--vio-card-brand-weight, 500);
      margin-bottom: var(--vio-card-brand-gap, 6px);
    }
    .name {
      font-family: var(--vio-card-name-font, inherit);
      font-size: var(--vio-card-name-size, var(--vio-size-md, 16px));
      font-weight: var(--vio-card-name-weight, 500);
      line-height: 1.3;
      margin: 0 0 var(--vio-card-name-gap, 10px);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    /* show-description: cut after --vio-card-description-lines (4). */
    .description {
      display: -webkit-box;
      -webkit-line-clamp: var(--vio-card-description-lines, 4);
      line-clamp: var(--vio-card-description-lines, 4);
      -webkit-box-orient: vertical;
      overflow: hidden;
      font-size: var(--vio-card-description-size, 14px);
      line-height: 1.45;
      color: var(--vio-card-description-color, var(--vio-color-text-secondary, #737373));
      margin: 0 0 var(--vio-card-description-gap, 12px);
    }
    .price {
      font-family: var(--vio-card-price-font, inherit);
      font-size: var(--vio-card-price-size, var(--vio-size-md, 16px));
      font-weight: var(--vio-card-price-weight, 700);
      margin-bottom: var(--vio-card-price-gap, 16px);
    }
    /* Who sells it. --vio-card-retailer-order: -1 lifts it above the name
       (where a brand line goes), for catalogues without a brand of their own. */
    .retailer {
      display: var(--vio-card-retailer-display, block);
      order: var(--vio-card-retailer-order, 0);
      font-size: var(--vio-card-retailer-size, var(--vio-size-xs, 12px));
      letter-spacing: var(--vio-card-retailer-tracking, var(--vio-tracking-label, 0.1em));
      text-transform: uppercase;
      color: var(--vio-card-retailer-color, var(--vio-color-text-tertiary, #999));
      font-weight: var(--vio-card-retailer-weight, 500);
      margin: var(--vio-card-retailer-margin, auto 0 0);
    }
    /* button-style="bar": the Vev card's bar — full width under the price,
       uppercase, the accent colour, 6px corners (--vio-card-bar-radius). */
    .bar-btn {
      width: 100%;
      margin-top: auto;
      padding: 14px;
      border: none;
      border-radius: var(--vio-card-bar-radius, 6px);
      background: var(--vio-card-accent, var(--vio-color-text, #0a0a0a));
      color: var(--vio-card-accent-text, #fff);
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
      transition: opacity 0.15s ease;
    }
    .bar-btn:hover { opacity: 0.88; }
    .bar-btn.pop { animation: vio-add-pop 0.42s cubic-bezier(0.34, 1.56, 0.64, 1); }
  `

  override connectedCallback(): void {
    super.connectedCallback()
    this.updateInCart()
    this.slotRegistration.connect(this.slotAttributes())
    Vio.cart.addEventListener('change', this.boundCartChange)
  }

  override disconnectedCallback(): void {
    Vio.cart.removeEventListener('change', this.boundCartChange)
    this.slotRegistration.clear()
    super.disconnectedCallback()
  }

  override updated(changed: Map<string, unknown>): void {
    // product-id / sponsor-id are set as attributes after construction.
    if (changed.has('productId') || changed.has('sponsorId')) this.updateInCart()
    // The slot attributes too (the React wrappers set properties after mount).
    if (changed.has('vioSlot') || changed.has('vioSlotName') || changed.has('vioScope') || changed.has('vioScopeName') || changed.has('vioCampaign')) {
      this.slotRegistration.sync(this.slotAttributes())
    }
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
          brand: this.brand,
          name: this.name,
          price: this.price,
          retailer: this.retailer,
          imageUrl: this.imageUrl,
          ...this.attribution(),
          // The host's sponsor-id wins; without one, the slot's campaign sponsor.
          sponsorId: this.sponsorId || this.sponsorFromAttribution(),
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
    if (
      this.hasVariants ||
      (Array.isArray(this.variants) && this.variants.length > 1) ||
      (Array.isArray(this.options) && this.options.length > 0)
    ) {
      this.onClick()
      return
    }
    const attribution = this.attribution()
    this.dispatchEvent(
      new CustomEvent('vio:product-add', {
        bubbles: true,
        composed: true,
        detail: {
          productId: this.productId,
          brand: this.brand,
          name: this.name,
          price: this.price,
          retailer: this.retailer,
          imageUrl: this.imageUrl,
          ...attribution,
          // The host's sponsor-id wins; without one, the slot's campaign sponsor.
          sponsorId: this.sponsorId || this.sponsorFromAttribution(),
          // The host adds to the cart: pass this through as `origin` so the
          // purchase is attributed to this place, campaign, kind of element
          // and page — the cart keeps it and Commerce receives it (ADR-0035).
          origin: {
            campaignId: attribution.campaignId,
            slot: attribution.slot,
            contentId: attribution.contentId,
            componentKind: attribution.componentTemplateId,
            contentUrl: attribution.contentUrl,
            contentTitle: attribution.contentTitle,
          },
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
          ${this.buttonStyle === 'icon'
            ? html`<button
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
          </button>`
            : ''}
        </div>
        ${this.hideMeta
          ? ''
          : html`
        <div class="meta">
          ${this.brand ? html`<div class="brand">${this.brand}</div>` : ''}
          ${this.name ? html`<div class="name">${this.name}</div>` : ''}
          ${this.showDescription && this.description ? html`<p class="description">${this.description}</p>` : ''}
          ${this.price ? html`<div class="price">${this.price}</div>` : ''}
          ${this.retailer ? html`<div class="retailer">${this.retailer}</div>` : ''}
          ${this.buttonStyle === 'bar'
            ? html`<button class="bar-btn ${this.justAdded ? 'pop' : ''}" @click=${this.onAdd}>
                ${this.inCart ? `${this.buttonLabel} · ${this.cartQty}` : this.buttonLabel}
              </button>`
            : ''}
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
