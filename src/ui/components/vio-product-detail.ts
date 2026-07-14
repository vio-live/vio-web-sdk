/**
 * <vio-product-detail> — full-screen product detail modal.
 *
 * Auto-opens when `vio:product-click` fires anywhere in the document
 * (delegated). Fetches the full Product DTO via `Vio.commerceFor(sponsorId)`,
 * shows brand + name + price + description + image gallery + variant
 * pickers + stock indicator + add-to-cart CTA.
 *
 * For affiliate products (non-numeric productId), the modal skips —
 * those are handled by the host page's direct cart logic.
 */

import { LitElement, css, html } from 'lit'
import { property, state } from 'lit/decorators.js'
import { Vio } from '../../core/client.js'
import {
  formatPrice,
  type Product,
  type ProductImage,
  type ProductOption,
  type ProductVariant,
} from '../../core/types.js'

interface SelectedOptions {
  [optionName: string]: string
}

export class VioProductDetail extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false
  @property({ type: String, attribute: 'product-id' }) productId = ''
  @property({ type: Number, attribute: 'sponsor-id' }) sponsorId = 0
  /** Subscribe to `vio:product-click` on the document and auto-open. */
  @property({ type: Boolean, attribute: 'auto-open' }) autoOpen = true
  @property({ type: String }) currency = 'NOK'

  @state() private product: Product | null = null
  @state() private isLoading = false
  @state() private fetchError = ''
  @state() private selectedOptions: SelectedOptions = {}
  @state() private quantity = 1
  @state() private activeImageIndex = 0
  @state() private adding = false
  /** Apple Pay actually usable (real Stripe + registered domain) — set on load. */
  @state() private applePayOk = false
  /** Pre-prepared Apple Pay handle — show() fires synchronously on tap. */
  private applePayHandle: { show: () => Promise<void> } | null = null

  private boundProductClick = (e: Event): void => {
    if (!this.autoOpen) return
    const ev = e as CustomEvent<{ productId: string; sponsorId: string }>
    const productIdNum = parseInt(ev.detail.productId, 10)
    // Skip non-numeric IDs (affiliate products) — host handles those.
    if (Number.isNaN(productIdNum)) return
    const sponsorIdNum = parseInt(ev.detail.sponsorId, 10)
    if (Number.isNaN(sponsorIdNum) || sponsorIdNum <= 0) return
    this.productId = ev.detail.productId
    this.sponsorId = sponsorIdNum
    console.log("[VioDetail] product-click →", { productId: this.productId, sponsorId: this.sponsorId })
    this.show()
    void this.fetchProduct()
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
      z-index: 1100;
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
      z-index: 1101;
      overflow-y: auto;
    }
    :host([open]) .modal { transform: translateY(0); }

    .handle { display: none; }

    /* Mobile: bottom sheet (not fullscreen), rounded top, drag handle. */
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

    /* Desktop: right-side drawer (matches the cart/checkout), so the product
       shows "al lado" instead of a centered modal. Info stacks in one column. */
    @media (min-width: 601px) {
      .modal {
        inset: 0 0 0 auto;
        width: min(440px, 100%);
        max-width: 440px;
        border-radius: 0;
        box-shadow: -8px 0 24px rgba(0, 0, 0, 0.1);
        transform: translateX(100%);
        transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
      }
      :host([open]) .modal { transform: translateX(0); }
      /* Content overrides are prefixed with .modal so they beat the base
         .body / .name / .gallery-main rules defined LATER in this stylesheet
         (equal specificity, later wins; the extra class tips the cascade). */
      .modal .body {
        max-width: none;
        grid-template-columns: 1fr;
        gap: 20px;
        padding: 20px 24px 40px;
      }
      .modal .name { font-size: 26px; line-height: 1.2; }
      .modal .gallery-main { width: 100%; }
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px var(--vio-space-lg, 24px);
      position: sticky;
      top: 0;
      background: var(--vio-color-surface, #fff);
      border-bottom: 1px solid var(--vio-color-border, #e5e5e5);
      z-index: 1;
    }
    .topbar-brand {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 500;
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
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
      padding: 48px var(--vio-space-lg, 24px) 80px;
      box-sizing: border-box;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 64px;
    }
    @media (max-width: 800px) {
      .body { grid-template-columns: 1fr; gap: 32px; padding: 24px var(--vio-space-lg, 24px) 64px; }
    }

    /* Gallery */
    .gallery { display: flex; flex-direction: column; gap: 16px; }
    .gallery-main {
      aspect-ratio: 1;
      background: var(--vio-color-surface-muted, #f2f2f2);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .gallery-main img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      padding: 24px;
      box-sizing: border-box;
    }
    .gallery-thumbs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .gallery-thumb {
      width: 72px;
      height: 72px;
      background: var(--vio-color-surface-muted, #f2f2f2);
      border: 1px solid transparent;
      cursor: pointer;
      padding: 0;
      overflow: hidden;
    }
    .gallery-thumb img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      padding: 6px;
      box-sizing: border-box;
    }
    .gallery-thumb.active { border-color: var(--vio-color-text, #0a0a0a); }

    /* Info column */
    .info { display: flex; flex-direction: column; gap: 24px; }
    .brand {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 500;
    }
    .name {
      font-family: var(--vio-font-serif, Georgia, serif);
      font-size: clamp(28px, 4vw, 40px);
      font-weight: 400;
      line-height: 1.15;
      margin: 0;
      letter-spacing: -0.01em;
    }
    .price-row {
      display: flex;
      align-items: baseline;
      gap: 16px;
    }
    .price {
      font-size: 24px;
      font-weight: 700;
    }
    .compare-at {
      font-size: 16px;
      color: var(--vio-color-text-tertiary, #999);
      text-decoration: line-through;
    }
    .stock {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      font-weight: 500;
    }
    .stock.in-stock { color: #2e7d32; }
    .stock.low-stock { color: #ed6c02; }
    .stock.out-of-stock { color: var(--vio-color-text-tertiary, #999); }

    /* Option pickers */
    .option-group { display: flex; flex-direction: column; gap: 8px; }
    .option-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 500;
    }
    .option-values { display: flex; flex-wrap: wrap; gap: 8px; }
    .option-pill {
      padding: 10px 18px;
      background: #fff;
      border: 1px solid var(--vio-color-border, #e5e5e5);
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      color: inherit;
      transition: border-color 0.15s, background 0.15s;
    }
    .option-pill:hover { border-color: var(--vio-color-text, #0a0a0a); }
    .option-pill[aria-pressed='true'] {
      border-color: var(--vio-color-text, #0a0a0a);
      background: var(--vio-color-text, #0a0a0a);
      color: var(--vio-color-text-on-primary, #fff);
    }
    .option-pill.unavailable {
      opacity: 0.4;
      cursor: not-allowed;
      text-decoration: line-through;
      background: repeating-linear-gradient(-45deg, #fafafa, #fafafa 5px, #f0f0f0 5px, #f0f0f0 10px);
    }
    .option-pill.unavailable:hover { border-color: var(--vio-color-border, #e5e5e5); }

    /* Qty + CTA row */
    .qty-cta-row {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 16px;
      align-items: stretch;
    }
    .qty-stepper {
      display: flex;
      align-items: center;
      border: 1px solid var(--vio-color-border, #e5e5e5);
    }
    .qty-btn {
      width: 44px;
      height: 56px;
      background: #fff;
      border: none;
      cursor: pointer;
      font-size: 18px;
      color: var(--vio-color-text, #0a0a0a);
      font-family: inherit;
    }
    .qty-btn:hover { background: var(--vio-color-surface-hover, #fafafa); }
    .qty-value {
      width: 40px;
      text-align: center;
      font-weight: 600;
    }
    .add-to-cart {
      background: var(--vio-color-text, #0a0a0a);
      color: var(--vio-color-text-on-primary, #fff);
      border: none;
      padding: 18px 24px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s;
    }
    .add-to-cart:hover:not(:disabled) { background: #222; }
    .add-to-cart:disabled {
      background: var(--vio-color-text-tertiary, #999);
      cursor: not-allowed;
    }
    /* Klarna express button — sits full-width below the add-to-cart row. */
    .buy-klarna {
      width: 100%;
      margin-top: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: #ffb3c7; /* Klarna pink */
      color: #0b051d;
      border: none;
      padding: 14px 24px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s;
    }
    .buy-klarna .klarna-badge { height: 22px; width: auto; display: block; }
    .buy-klarna:hover:not(:disabled) { background: #ffa0b9; }
    .buy-klarna:disabled { opacity: 0.5; cursor: not-allowed; }
    .buy-applepay .ap-logo { width: 20px; height: 20px; }
    /* Vipps — brand orange buy button. */
    .buy-vipps {
      width: 100%;
      margin-top: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: #ff5b24;
      color: #fff;
      border: none;
      padding: 14px 24px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      font-weight: 700;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s;
    }
    .buy-vipps .vipps-badge {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.02em;
      text-transform: none;
    }
    .buy-vipps:hover:not(:disabled) { background: #ec4f1c; }
    .buy-vipps:disabled { opacity: 0.5; cursor: not-allowed; }
    /* Apple Pay express button — black, per Apple's button guidelines. Only
       shown in Safari (canApplePay). The  glyph is the Apple logo (Safari). */
    .buy-applepay {
      width: 100%;
      margin-top: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: #000;
      color: #fff;
      border: none;
      padding: 15px 24px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      letter-spacing: 0.01em;
    }
    .buy-applepay:hover:not(:disabled) { background: #1a1a1a; }
    .buy-applepay:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Description */
    .description {
      font-size: 14px;
      line-height: 1.6;
      color: var(--vio-color-text-secondary, #444);
      margin-top: 8px;
    }
    .description-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 500;
      margin-bottom: 8px;
    }

    /* Skeleton loader: shimmer placeholders mirroring the product layout
       (image, brand, title, price, CTA) for a smooth load-in. */
    .skeleton {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 20px 24px 40px;
    }
    .skeleton > * {
      background: linear-gradient(
        100deg,
        var(--vio-color-surface-muted, #f1f1f1) 30%,
        rgba(255, 255, 255, 0.65) 50%,
        var(--vio-color-surface-muted, #f1f1f1) 70%
      );
      background-size: 200% 100%;
      animation: vio-skeleton-shimmer 1.4s ease-in-out infinite;
      border-radius: 8px;
    }
    .sk-image { width: 100%; aspect-ratio: 1; border-radius: 12px; }
    .sk-line { height: 14px; }
    .sk-brand { width: 38%; height: 10px; margin-top: 6px; }
    .sk-title { width: 85%; height: 26px; }
    .sk-title-2 { width: 55%; height: 26px; }
    .sk-price { width: 30%; height: 20px; margin-top: 6px; }
    .sk-button { width: 100%; height: 54px; border-radius: 0; margin-top: 10px; }
    @keyframes vio-skeleton-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .skeleton > * {
        animation: none;
        background: var(--vio-color-surface-muted, #f1f1f1);
      }
    }
    .error {
      padding: 80px 24px;
      text-align: center;
      color: var(--vio-color-accent, #c14a3b);
      font-size: 14px;
    }
  `

  override connectedCallback(): void {
    super.connectedCallback()
    document.addEventListener('vio:product-click', this.boundProductClick)
  }

  override disconnectedCallback(): void {
    document.removeEventListener('vio:product-click', this.boundProductClick)
    super.disconnectedCallback()
  }

  show(): void { this.open = true }
  close(): void {
    this.open = false
    // Reset state after the slide-out animation completes.
    setTimeout(() => {
      if (!this.open) {
        this.product = null
        this.selectedOptions = {}
        this.quantity = 1
        this.activeImageIndex = 0
        this.fetchError = ''
      }
    }, 400)
  }

  private async fetchProduct(): Promise<void> {
    const productIdNum = parseInt(this.productId, 10)
    if (Number.isNaN(productIdNum) || !this.sponsorId) {
      this.product = null
      return
    }
    this.isLoading = true
    this.fetchError = ''

    // Fetch with retry: the commerce backend intermittently returns
    // "Authentication failed" under concurrent requests (many cards + the
    // detail firing at once). Retry a few times before surfacing the error.
    let products: Product[] | null = null
    let lastError: unknown = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const commerce = Vio.commerceFor(this.sponsorId)
        products = await commerce.channel.product.getByIds({
          product_ids: [productIdNum],
          currency: this.currency,
          image_size: 'large',
        })
        lastError = null
        break
      } catch (err) {
        lastError = err
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }

    if (lastError) {
      this.fetchError = lastError instanceof Error ? lastError.message : String(lastError)
      console.warn('[VioDetail] fetch failed after retries →', this.fetchError)
      this.isLoading = false
      return
    }

    this.product = products?.[0] ?? null
    console.log('[VioDetail] fetched →', {
      count: products?.length ?? 0,
      hasProduct: !!this.product,
      options: this.product?.options?.length,
      variants: this.product?.variants?.length,
      images: this.product?.images?.length,
    })

    if (this.product) {
      // Auto-select the first value of each option (so qty + add fire correctly
      // even when the user doesn't actively pick).
      const initial: SelectedOptions = {}
      for (const opt of this.product.options ?? []) {
        const values = normalizeValues(opt.values)
        if (values.length > 0) initial[opt.name] = values[0]!
      }
      this.selectedOptions = initial
      // Pre-prepare Apple Pay so its sheet can open synchronously on tap
      // (Apple blocks it otherwise). The button only shows if Apple Pay actually
      // works (real Stripe account + domain registered for Apple Pay).
      void Vio.checkout
        .prepareApplePayFor(this.unitPrice * this.quantity, this.currency)
        .then((handle) => {
          this.applePayHandle = handle
          this.applePayOk = handle.available
        })
        .catch(() => {
          this.applePayHandle = null
          this.applePayOk = false
        })
    }
    this.isLoading = false
  }

  /** Option values a variant represents — variant titles join them with " / "
   * (or "|"). Exact parts, lowercased, so matching is combination-accurate
   * (avoids "M" matching "Medium"). */
  private variantOptionValues(v: ProductVariant): string[] {
    return (v.title ?? '')
      .split(/\s*[/|]\s*/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  }

  /** Does a variant part represent this option value? Whole-token match, so the
   * value "30" matches the part "30 ml" but "M" does NOT match "Medium". */
  private partMatchesValue(part: string, value: string): boolean {
    if (part === value) return true
    return part.split(/\s+/).includes(value)
  }

  /** Does a variant satisfy every currently-selected option value? */
  private variantMatchesSelection(v: ProductVariant, selection: SelectedOptions): boolean {
    const wanted = Object.values(selection).map((s) => s.trim().toLowerCase())
    if (wanted.length === 0) return true
    const parts = this.variantOptionValues(v)
    return wanted.every((w) => parts.some((part) => this.partMatchesValue(part, w)))
  }

  /** Resolve the active variant from the selected combination. Prefers a FULL
   * match (all options accounted for), then a partial match, then the first. */
  private selectedVariant(): ProductVariant | null {
    if (!this.product || this.product.variants.length === 0) return null
    const sel = this.selectedOptions
    const wanted = Object.values(sel).map((s) => s.trim().toLowerCase())
    if (wanted.length === 0) return this.product.variants[0] ?? null
    const full = this.product.variants.find(
      (v) => this.variantOptionValues(v).length === wanted.length && this.variantMatchesSelection(v, sel),
    )
    if (full) return full
    const partial = this.product.variants.find((v) => this.variantMatchesSelection(v, sel))
    return partial ?? this.product.variants[0] ?? null
  }

  /** True if picking `value` for `optionName` (with the rest of the current
   * selection) still yields an in-stock variant. When no variant reports stock
   * (missing data), never disables — lets the backend be the source of truth. */
  private isValueAvailable(optionName: string, value: string): boolean {
    if (!this.product) return true
    const anyStock = this.product.variants.some((v) => (v.quantity ?? 0) > 0)
    if (!anyStock) return true
    const trial = { ...this.selectedOptions, [optionName]: value }
    return this.product.variants.some(
      (v) => this.variantMatchesSelection(v, trial) && (v.quantity ?? 0) > 0,
    )
  }

  private get unitPrice(): number {
    const v = this.selectedVariant()
    const price = v?.price ?? this.product?.price
    // Use `amount` (matches the card / catalog display). Some feeds ship a broken
    // `amount_incl_taxes`, so it's only a fallback.
    return price?.amount ?? price?.amount_incl_taxes ?? 0
  }

  private get compareAt(): number | null {
    const v = this.selectedVariant()
    const price = v?.price ?? this.product?.price
    return price?.compare_at ?? price?.compare_at_incl_taxes ?? null
  }

  private get availableQuantity(): number {
    const v = this.selectedVariant()
    if (v) return v.quantity ?? 0
    return this.product?.quantity ?? 0
  }

  private stockLabel(): { text: string; cls: 'in-stock' | 'low-stock' | 'out-of-stock' } {
    const qty = this.availableQuantity
    if (qty <= 0) return { text: 'Utsolgt', cls: 'out-of-stock' }
    if (qty <= 3) return { text: `Få igjen — ${qty} stk`, cls: 'low-stock' }
    return { text: 'På lager', cls: 'in-stock' }
  }

  private selectOption(optionName: string, value: string): void {
    this.selectedOptions = { ...this.selectedOptions, [optionName]: value }
  }

  private allImages(): ProductImage[] {
    if (!this.product) return []
    const variantImages = this.selectedVariant()?.images ?? []
    if (variantImages.length > 0) return variantImages
    return this.product.images
  }

  private get activeImage(): ProductImage | undefined {
    return this.allImages()[this.activeImageIndex]
  }

  /** Add the current product + selected variant + qty to the cart. Returns the variant id used. */
  private addCurrentToCart(): number | undefined {
    if (!this.product) return undefined
    const variant = this.selectedVariant()
    const sponsor = Vio.bootstrapCache?.primarySponsor
    const secondaries = Vio.bootstrapCache?.secondarySponsors ?? []
    const sponsorName =
      sponsor?.id === this.sponsorId
        ? sponsor.name
        : secondaries.find((s) => s.id === this.sponsorId)?.name
    Vio.cart.addProduct({
      product: this.product,
      sponsorId: this.sponsorId,
      sponsorName,
      quantity: this.quantity,
      variantId: variant?.id,
    })
    return variant?.id
  }

  private async addToCart(): Promise<void> {
    if (!this.product || this.availableQuantity <= 0 || this.adding) return
    this.adding = true
    try {
      const variantId = this.addCurrentToCart()
      this.dispatchEvent(
        new CustomEvent('vio:added-to-cart', {
          bubbles: true,
          composed: true,
          detail: {
            productId: this.product.id,
            sponsorId: this.sponsorId,
            quantity: this.quantity,
            variantId,
          },
        }),
      )
      this.close()
    } finally {
      this.adding = false
    }
  }

  /**
   * Express buy: add to cart, then open the checkout overlay with Klarna
   * preselected. The host app handles `vio:checkout-open` (same event the cart
   * uses) — the `paymentMethod` hint tells it to preselect Klarna so its widget
   * loads immediately. Reuses the working Klarna Payments flow (no express SDK).
   */
  private async buyWithKlarna(): Promise<void> {
    if (!this.product || this.availableQuantity <= 0 || this.adding) return
    this.adding = true
    try {
      this.addCurrentToCart()
      this.close()
      this.dispatchEvent(
        new CustomEvent('vio:checkout-open', {
          bubbles: true,
          composed: true,
          detail: { sponsorId: this.sponsorId, paymentMethod: 'klarna', express: true },
        }),
      )
    } finally {
      this.adding = false
    }
  }

  /** Buy with Vipps — opens the checkout with Vipps preselected. */
  private buyWithVipps(): void {
    if (!this.product || this.availableQuantity <= 0 || this.adding) return
    this.addCurrentToCart()
    this.close()
    this.dispatchEvent(
      new CustomEvent('vio:checkout-open', {
        bubbles: true,
        composed: true,
        detail: { sponsorId: this.sponsorId, paymentMethod: 'vipps', express: false },
      }),
    )
  }

  /**
   * Express buy with Apple Pay. Runs synchronously inside the click so the
   * Apple Pay sheet keeps the user gesture: add to cart → open checkout (sets
   * state) → launch the sheet. On authorize, `payment-complete` drives the
   * confirmation drawer (same path as the in-checkout Apple Pay button).
   */
  private buyWithApplePay(): void {
    if (!this.product || this.availableQuantity <= 0 || !this.applePayHandle) return
    this.addCurrentToCart()
    try {
      Vio.checkout.open(this.sponsorId)
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioProductDetail] checkout open failed:', err)
      }
      return
    }
    // Fire the pre-prepared Apple Pay sheet SYNCHRONOUSLY (no await before it)
    // so it stays inside the tap gesture — Apple blocks the sheet otherwise.
    // On approval, show() dispatches payment-complete → the confirmation drawer.
    void this.applePayHandle.show()
    this.close()
  }

  override render() {
    return html`
      <div class="backdrop" @click=${this.close}></div>
      <div class="modal" role="dialog" aria-label="Produkt">
        <div class="handle" @click=${this.close} aria-hidden="true"></div>
        <div class="topbar">
          <span class="topbar-brand">${this.product?.brand ?? ''}</span>
          <button class="close" @click=${this.close} aria-label="Lukk">×</button>
        </div>

        ${this.renderBody()}
      </div>
    `
  }

  private renderBody() {
    if (this.isLoading && !this.product) {
      return html`
        <div class="skeleton" role="status" aria-busy="true" aria-label="Laster produkt">
          <div class="sk-image"></div>
          <div class="sk-line sk-brand"></div>
          <div class="sk-line sk-title"></div>
          <div class="sk-line sk-title-2"></div>
          <div class="sk-line sk-price"></div>
          <div class="sk-button"></div>
        </div>
      `
    }
    if (this.fetchError) {
      return html`<div class="error">Kunne ikke laste produkt: ${this.fetchError}</div>`
    }
    if (!this.product) return html``

    const p = this.product
    const stock = this.stockLabel()
    const compare = this.compareAt
    const showCompare = compare !== null && compare > this.unitPrice
    const images = this.allImages()
    const activeImage = this.activeImage

    return html`
      <div class="body">
        <div class="gallery">
          <div class="gallery-main">
            ${activeImage?.url
              ? html`<img src=${activeImage.url} alt=${p.title} />`
              : ''}
          </div>
          ${images.length > 1
            ? html`
                <div class="gallery-thumbs">
                  ${images.map(
                    (img, idx) => html`
                      <button
                        class="gallery-thumb ${idx === this.activeImageIndex ? 'active' : ''}"
                        @click=${() => (this.activeImageIndex = idx)}
                        aria-label=${`Bilde ${idx + 1}`}
                      >
                        <img src=${img.url} alt="" />
                      </button>
                    `,
                  )}
                </div>
              `
            : ''}
        </div>

        <div class="info">
          ${p.brand ? html`<div class="brand">${p.brand}</div>` : ''}
          <h2 class="name">${p.title}</h2>

          <div class="price-row">
            <span class="price">${formatPrice(this.unitPrice, p.price.currency_code)}</span>
            ${showCompare
              ? html`<span class="compare-at">${formatPrice(
                  compare,
                  p.price.currency_code,
                )}</span>`
              : ''}
          </div>

          <div class="stock ${stock.cls}">${stock.text}</div>

          ${this.renderOptionPickers(p.options)}

          <div class="qty-cta-row">
            <div class="qty-stepper">
              <button
                class="qty-btn"
                @click=${() => (this.quantity = Math.max(1, this.quantity - 1))}
                aria-label="Reduser antall"
              >
                −
              </button>
              <span class="qty-value">${this.quantity}</span>
              <button
                class="qty-btn"
                @click=${() =>
                  (this.quantity = Math.min(this.availableQuantity, this.quantity + 1))}
                aria-label="Øk antall"
                ?disabled=${this.quantity >= this.availableQuantity}
              >
                +
              </button>
            </div>
            <button
              class="add-to-cart"
              @click=${this.addToCart}
              ?disabled=${this.availableQuantity <= 0 || this.adding}
            >
              ${this.adding
                ? 'Legger til…'
                : this.availableQuantity <= 0
                ? 'Utsolgt'
                : 'Legg i handlekurv'}
            </button>
          </div>

          ${this.availableQuantity > 0 && this.applePayOk
            ? html`
                <button
                  class="buy-applepay"
                  @click=${this.buyWithApplePay}
                  ?disabled=${this.adding}
                  aria-label="Kjøp nå med Apple Pay"
                >
                  <span>Kjøp nå med</span>
                  <svg class="ap-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>
                  <span>Apple Pay</span>
                </button>
              `
            : ''}
          ${this.availableQuantity > 0
            ? html`
                <button
                  class="buy-klarna"
                  @click=${this.buyWithKlarna}
                  ?disabled=${this.adding}
                >
                  <span>Kjøp nå med</span>
                  <img
                    class="klarna-badge"
                    src="https://x.klarnacdn.net/payment-method/assets/badges/generic/klarna.svg"
                    alt="Klarna"
                  />
                </button>
              `
            : ''}

          ${this.availableQuantity > 0
            ? html`
                <button
                  class="buy-vipps"
                  @click=${this.buyWithVipps}
                  ?disabled=${this.adding}
                  aria-label="Kjøp nå med Vipps"
                >
                  <span>Kjøp nå med</span>
                  <span class="vipps-badge">vipps</span>
                </button>
              `
            : ''}

          ${p.description
            ? html`
                <div>
                  <div class="description-label">Beskrivelse</div>
                  <div class="description">${this.stripHtml(p.description)}</div>
                </div>
              `
            : ''}
        </div>
      </div>
    `
  }

  private renderOptionPickers(options: ProductOption[]) {
    if (options.length === 0) return ''
    return html`${options.map((opt) => {
      const values = normalizeValues(opt.values)
      if (values.length === 0) return ''
      return html`
        <div class="option-group">
          <div class="option-label">${opt.name}</div>
          <div class="option-values">
            ${values.map((val) => {
              const available = this.isValueAvailable(opt.name, val)
              return html`
                <button
                  class="option-pill ${available ? '' : 'unavailable'}"
                  @click=${() => this.selectOption(opt.name, val)}
                  aria-pressed=${this.selectedOptions[opt.name] === val}
                  ?disabled=${!available}
                  title=${available ? '' : 'Utsolgt'}
                >
                  ${val}
                </button>
              `
            })}
          </div>
        </div>
      `
    })}`
  }

  /** Best-effort HTML strip for description. */
  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()
  }
}

/**
 * GraphQL sometimes returns `ProductOption.values` as a comma-joined string
 * ("S,M,L,XL") instead of an array. Normalize defensively.
 */
function normalizeValues(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

declare global {
  interface HTMLElementTagNameMap {
    'vio-product-detail': VioProductDetail
  }
}
