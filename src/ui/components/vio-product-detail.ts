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
  getGlobalCurrency,
  type Product,
  type ProductImage,
  type ProductOption,
  type ProductVariant,
} from '../../core/types.js'

interface SelectedOptions {
  [optionName: string]: string
}

/** Stripe wordmark, inlined so the published article needs no asset path.
 * (Also in vio-cart.ts / vio-checkout.ts — tiny constant, no shared module.) */
const STRIPE_LOGO_SRC =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg width="360" height="150" viewBox="0 0 360 150" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M360 77.4001C360 51.8001 347.6 31.6001 323.9 31.6001C300.1 31.6001 285.7 51.8001 285.7 77.2001C285.7 107.3 302.7 122.5 327.1 122.5C339 122.5 348 119.8 354.8 116V96.0001C348 99.4001 340.2 101.5 330.3 101.5C320.6 101.5 312 98.1001 310.9 86.3001H359.8C359.8 85.0001 360 79.8001 360 77.4001ZM310.6 67.9001C310.6 56.6001 317.5 51.9001 323.8 51.9001C329.9 51.9001 336.4 56.6001 336.4 67.9001H310.6Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M247.1 31.6001C237.3 31.6001 231 36.2001 227.5 39.4001L226.2 33.2001H204.2V149.8L229.2 144.5L229.3 116.2C232.9 118.8 238.2 122.5 247 122.5C264.9 122.5 281.2 108.1 281.2 76.4001C281.1 47.4001 264.6 31.6001 247.1 31.6001ZM241.1 100.5C235.2 100.5 231.7 98.4001 229.3 95.8001L229.2 58.7001C231.8 55.8001 235.4 53.8001 241.1 53.8001C250.2 53.8001 256.5 64.0001 256.5 77.1001C256.5 90.5001 250.3 100.5 241.1 100.5Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M169.8 25.7L194.9 20.3V0L169.8 5.3V25.7Z" fill="#533AFD"/><path d="M194.9 33.3H169.8V120.8H194.9V33.3Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M142.9 40.7L141.3 33.3H119.7V120.8H144.7V61.5C150.6 53.8 160.6 55.2 163.7 56.3V33.3C160.5 32.1 148.8 29.9 142.9 40.7Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M92.8999 11.6001L68.4999 16.8001L68.3999 96.9001C68.3999 111.7 79.4999 122.6 94.2999 122.6C102.5 122.6 108.5 121.1 111.8 119.3V99.0001C108.6 100.3 92.7999 104.9 92.7999 90.1001V54.6001H111.8V33.3001H92.7999L92.8999 11.6001Z" fill="#533AFD"/><path fill-rule="evenodd" clip-rule="evenodd" d="M25.3 58.7001C25.3 54.8001 28.5 53.3001 33.8 53.3001C41.4 53.3001 51 55.6001 58.6 59.7001V36.2001C50.3 32.9001 42.1 31.6001 33.8 31.6001C13.5 31.6001 0 42.2001 0 59.9001C0 87.5001 38 83.1001 38 95.0001C38 99.6001 34 101.1 28.4 101.1C20.1 101.1 9.5 97.7001 1.1 93.1001V116.9C10.4 120.9 19.8 122.6 28.4 122.6C49.2 122.6 63.5 112.3 63.5 94.4001C63.4 64.6001 25.3 69.9001 25.3 58.7001Z" fill="#533AFD"/></svg>',
  )

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
  /** Payment method names enabled for the sponsor (backend-configured).
   * Empty = not loaded yet → all buy buttons render (graceful default). */
  @state() private availableMethods: string[] = []
  /** Pre-prepared Apple Pay handle — show() fires synchronously on tap. */
  private applePayHandle: { show: () => Promise<void> } | null = null

  private boundProductClick = (e: Event): void => {
    if (!this.autoOpen) return
    const ev = e as CustomEvent<{ productId: string; sponsorId: string; currency?: string }>
    const productIdNum = parseInt(ev.detail.productId, 10)
    // Skip non-numeric IDs (affiliate products) — host handles those.
    if (Number.isNaN(productIdNum)) return
    const sponsorIdNum = parseInt(ev.detail.sponsorId, 10)
    if (Number.isNaN(sponsorIdNum) || sponsorIdNum <= 0) return
    this.productId = ev.detail.productId
    this.sponsorId = sponsorIdNum
    // The event may carry the page currency; otherwise use the global one.
    this.currency = ev.detail.currency || getGlobalCurrency()
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
        // Re-resolve the page currency on every fetch — the host may have
        // switched it since this element was mounted.
        const activeCurrency = getGlobalCurrency() || this.currency
        this.currency = activeCurrency
        const commerce = Vio.commerceFor(this.sponsorId)
        products = await commerce.channel.product.getByIds({
          product_ids: [productIdNum],
          currency: activeCurrency,
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
      void this.loadAvailablePaymentMethods()
    }
    this.isLoading = false
  }

  /** Which buy buttons to render — backend-configured per sponsor. */
  private async loadAvailablePaymentMethods(): Promise<void> {
    const spId =
      this.sponsorId ||
      (globalThis as { __VIO_SPONSOR_ID__?: number }).__VIO_SPONSOR_ID__
    if (!spId) return
    try {
      const methods = (await Vio.checkout.getAvailablePaymentMethods(spId)) as
        | Array<{ name: string }>
        | unknown
      if (Array.isArray(methods)) {
        this.availableMethods = methods.map((m) => m.name)
      } else {
        this.availableMethods = ['Stripe', 'Klarna', 'Vipps']
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioProductDetail] Failed to load payment methods:', err)
      }
      this.availableMethods = ['Stripe', 'Klarna', 'Vipps']
    }
  }

  private methodEnabled(...names: string[]): boolean {
    return (
      this.availableMethods.length === 0 ||
      this.availableMethods.some((m) => names.includes(m.toLowerCase()))
    )
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */

  /**
   * Build an option-name → value map for a variant, from every shape the feeds
   * ship: option1/2/3 columns, options/selected_options/variant arrays, plain
   * object maps, and finally the title (value scan first, position fallback).
   */
  private getVariantOptionMap(
    v: ProductVariant | any,
    productOptions: ProductOption[] | undefined,
  ): { map: Record<string, string>; titleParts: string[] } {
    const map: Record<string, string> = {}
    if (!v) return { map, titleParts: [] }

    if (v.option1 != null && productOptions?.[0]) {
      map[productOptions[0].name.toLowerCase()] = String(v.option1).trim().toLowerCase()
    }
    if (v.option2 != null && productOptions?.[1]) {
      map[productOptions[1].name.toLowerCase()] = String(v.option2).trim().toLowerCase()
    }
    if (v.option3 != null && productOptions?.[2]) {
      map[productOptions[2].name.toLowerCase()] = String(v.option3).trim().toLowerCase()
    }

    const optArray = Array.isArray(v.options)
      ? v.options
      : Array.isArray(v.selected_options)
        ? v.selected_options
        : Array.isArray(v.variant)
          ? v.variant
          : null
    if (optArray) {
      for (const item of optArray) {
        const key = (item.name || item.option || '').trim().toLowerCase()
        const val = (item.value || '').trim().toLowerCase()
        if (key && val) map[key] = val
      }
    } else if (v.options && typeof v.options === 'object') {
      for (const [k, val] of Object.entries(v.options)) {
        map[k.trim().toLowerCase()] = String(val).trim().toLowerCase()
      }
    }

    const title = String(v.title ?? '').trim()
    const titleLower = title.toLowerCase()

    if (Array.isArray(productOptions)) {
      for (const opt of productOptions) {
        const key = opt.name.toLowerCase()
        if (!map[key]) {
          const rawValues = normalizeValues(opt.values)
          const sortedVals = [...rawValues].sort((a, b) => b.length - a.length)
          for (const valStr of sortedVals) {
            const valLower = valStr.trim().toLowerCase()
            const escaped = valLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const regex = new RegExp(`(?:^|[/|\\-,;\\s])${escaped}(?:$|[/|\\-,;\\s])`, 'i')
            if (regex.test(titleLower) || titleLower === valLower) {
              map[key] = valLower
              break
            }
          }
        }
      }
    }

    const titleParts = title
      .split(/\s*[/|,]\s*|\s+-\s+/)
      .map((s) => s.trim())
      .filter(Boolean)

    if (Array.isArray(productOptions)) {
      productOptions.forEach((opt, idx) => {
        const key = opt.name.toLowerCase()
        if (!map[key] && titleParts[idx] != null) {
          map[key] = titleParts[idx]!.toLowerCase()
        }
      })
    }

    return { map, titleParts }
  }

  /** Option values a variant represents (map values ∪ title parts). */
  private variantOptionValues(v: ProductVariant): string[] {
    const { map, titleParts } = this.getVariantOptionMap(v, this.product?.options)
    const set = new Set(titleParts.map((s) => s.toLowerCase()))
    for (const val of Object.values(map)) set.add(val)
    return Array.from(set)
  }

  /** Does a variant part represent this option value? Whole-token match, so the
   * value "30" matches the part "30 ml" but "M" does NOT match "Medium". */
  private partMatchesValue(part: string, value: string): boolean {
    if (!part || !value) return false
    const p = String(part).trim().toLowerCase()
    const v = String(value).trim().toLowerCase()
    if (p === v) return true
    return p.split(/\s+/).includes(v)
  }

  /** Does a variant satisfy every currently-selected option value? */
  private variantMatchesSelection(v: ProductVariant, selection: SelectedOptions): boolean {
    if (!v || !selection) return false
    const entries = Object.entries(selection)
    if (entries.length === 0) return true

    const { map, titleParts } = this.getVariantOptionMap(v, this.product?.options)
    const titlePartsLower = titleParts.map((t) => t.toLowerCase())

    return entries.every(([optName, val]) => {
      const key = optName.trim().toLowerCase()
      const targetVal = String(val).trim().toLowerCase()
      if (map[key]) {
        return this.partMatchesValue(map[key]!, targetVal)
      }
      return titlePartsLower.some((part) => this.partMatchesValue(part, targetVal))
    })
  }

  /** Sellable quantity for a variant, across the stock field zoo. Boolean
   * availability flags win; unknown stock is treated as sellable (999). */
  private getVariantQty(v: ProductVariant | any): number {
    if (!v) return 0
    if (v.available === false || v.in_stock === false || v.is_available === false) return 0
    if (v.available === true || v.in_stock === true || v.is_available === true) return 999

    const rawQty =
      v.quantity ?? v.inventory_quantity ?? v.stock ?? v.available_quantity ?? v.stock_quantity
    if (rawQty !== null && rawQty !== undefined && rawQty !== '') {
      const parsed = Number(rawQty)
      if (!Number.isNaN(parsed)) return parsed
    }

    return 999
  }

  /** Resolve the active variant: full in-stock match → full match → best score
   * (2 per mapped option match, 1 per title match, +0.5 if in stock). */
  private selectedVariant(): ProductVariant | null {
    if (!this.product || !Array.isArray(this.product.variants) || this.product.variants.length === 0) {
      return null
    }
    const sel = this.selectedOptions
    const entries = Object.entries(sel)
    if (entries.length === 0) return this.product.variants[0] ?? null

    const fullInStock = this.product.variants.find(
      (v) => this.variantMatchesSelection(v, sel) && this.getVariantQty(v) > 0,
    )
    if (fullInStock) return fullInStock

    const full = this.product.variants.find((v) => this.variantMatchesSelection(v, sel))
    if (full) return full

    let bestVariant: ProductVariant | null = null
    let maxScore = -1

    for (const v of this.product.variants) {
      const { map, titleParts } = this.getVariantOptionMap(v, this.product?.options)
      const titlePartsLower = titleParts.map((t) => t.toLowerCase())
      let score = 0

      for (const [optName, val] of entries) {
        const key = optName.trim().toLowerCase()
        const targetVal = String(val).trim().toLowerCase()
        if (map[key] && this.partMatchesValue(map[key]!, targetVal)) {
          score += 2
        } else if (titlePartsLower.some((part) => this.partMatchesValue(part, targetVal))) {
          score += 1
        }
      }

      if (this.getVariantQty(v) > 0) score += 0.5

      if (score > maxScore) {
        maxScore = score
        bestVariant = v
      }
    }

    return bestVariant ?? this.product.variants[0] ?? null
  }

  /** True if some in-stock variant carries this option value. */
  private isValueAvailable(optionName: string, value: string): boolean {
    if (!this.product || !Array.isArray(this.product.variants) || this.product.variants.length === 0) {
      return true
    }
    const valLower = String(value).trim().toLowerCase()
    const key = optionName.trim().toLowerCase()

    return this.product.variants.some((v) => {
      const { map, titleParts } = this.getVariantOptionMap(v, this.product?.options)
      if (this.getVariantQty(v) <= 0) return false
      if (map[key]) return this.partMatchesValue(map[key]!, valLower)
      return titleParts.some((part) => this.partMatchesValue(part.toLowerCase(), valLower))
    })
  }

  private get unitPrice(): number {
    const v = this.selectedVariant()
    const price = v?.price ?? this.product?.price
    // Tax-inclusive is the consumer-facing price (NO convention); `amount` is the
    // fallback when the feed doesn't ship it.
    return price?.amount_incl_taxes ?? price?.amount ?? 0
  }

  private get compareAt(): number | null {
    const v = this.selectedVariant()
    const price = v?.price ?? this.product?.price
    return price?.compare_at_incl_taxes ?? price?.compare_at ?? null
  }

  private get availableQuantity(): number {
    const v = this.selectedVariant()
    if (v) return this.getVariantQty(v)
    return this.product?.quantity ?? 0
  }

  private stockLabel(): { text: string; cls: 'in-stock' | 'low-stock' | 'out-of-stock' } {
    const qty = this.availableQuantity
    if (qty <= 0) return { text: 'Utsolgt', cls: 'out-of-stock' }
    if (qty <= 3) return { text: `Få igjen — ${qty} stk`, cls: 'low-stock' }
    return { text: 'På lager', cls: 'in-stock' }
  }

  /** Pick an option value. If the exact combination doesn't exist, jump to an
   * in-stock variant that carries the value and adopt its full option map
   * (keeps the selection always resolvable to a real variant). */
  private selectOption(optionName: string, value: string): void {
    const newSelection = { ...this.selectedOptions, [optionName]: value }
    const exactInStock = this.product?.variants?.find(
      (v) => this.variantMatchesSelection(v, newSelection) && this.getVariantQty(v) > 0,
    )
    if (exactInStock) {
      this.selectedOptions = newSelection
      return
    }
    const exactAnyStock = this.product?.variants?.find((v) =>
      this.variantMatchesSelection(v, newSelection),
    )
    if (exactAnyStock) {
      this.selectedOptions = newSelection
      return
    }

    const valLower = String(value).trim().toLowerCase()
    const key = optionName.trim().toLowerCase()
    const anyInStockWithVal = this.product?.variants?.find((v) => {
      const { map, titleParts } = this.getVariantOptionMap(v, this.product?.options)
      if (this.getVariantQty(v) <= 0) return false
      if (map[key]) return this.partMatchesValue(map[key]!, valLower)
      return titleParts.some((p) => this.partMatchesValue(p.toLowerCase(), valLower))
    })

    if (anyInStockWithVal) {
      const { map } = this.getVariantOptionMap(anyInStockWithVal, this.product?.options)
      const updated = { ...newSelection }
      for (const opt of this.product?.options ?? []) {
        const k = opt.name.toLowerCase()
        if (map[k]) {
          const optValues = normalizeValues(opt.values)
          const origCase = optValues.find((val) => val.toLowerCase() === map[k]) || map[k]!
          updated[opt.name] = origCase
        }
      }
      this.selectedOptions = updated
    } else {
      this.selectedOptions = newSelection
    }
  }

  /* eslint-enable @typescript-eslint/no-explicit-any */

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

  /** Buy with Stripe — opens the checkout with Stripe preselected. */
  private buyWithStripe(): void {
    if (!this.product || this.availableQuantity <= 0 || this.adding) return
    this.addCurrentToCart()
    this.close()
    this.dispatchEvent(
      new CustomEvent('vio:checkout-open', {
        bubbles: true,
        composed: true,
        detail: { sponsorId: this.sponsorId, paymentMethod: 'stripe', express: false },
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

          ${this.availableQuantity > 0 &&
          this.applePayOk &&
          this.methodEnabled('apple-pay', 'applepay')
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
          ${this.availableQuantity > 0 && this.methodEnabled('stripe')
            ? html`
                <button
                  class="buy-stripe"
                  @click=${this.buyWithStripe}
                  ?disabled=${this.adding}
                  aria-label="Kjøp nå med Stripe"
                  style="width: 100%; margin-top: 10px; display: flex; align-items: center; justify-content: center; gap: 6px; background: #635bff; color: #fff; border: none; padding: 14px 24px; font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit;"
                >
                  <span>Kjøp nå med</span>
                  <img
                    src=${STRIPE_LOGO_SRC}
                    style="height: 20px; display: block; filter: brightness(0) invert(1);"
                    alt="Stripe"
                  />
                </button>
              `
            : ''}
          ${this.availableQuantity > 0 && this.methodEnabled('klarna')
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

          ${this.availableQuantity > 0 && this.methodEnabled('vipps')
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
              const currentVal = this.selectedOptions[opt.name] ?? ''
              const isSelected =
                String(currentVal).trim().toLowerCase() === String(val).trim().toLowerCase()
              return html`
                <button
                  class="option-pill ${available ? '' : 'unavailable'}"
                  @click=${() => this.selectOption(opt.name, val)}
                  aria-pressed=${isSelected}
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
