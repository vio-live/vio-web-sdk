/**
 * <vio-product-carousel> — horizontal product carousel matching the
 * Allermedia "Shop Favorittene" pattern.
 *
 * Two render modes:
 *   1. Slotted — the consumer puts <vio-product> children inside the tag
 *      (manual / SSR-friendly).
 *   2. Auto-fetch — set `product-ids="123,456,789"` plus either
 *      `commerce-key="..."` (explicit per-sponsor commerce apiKey) or
 *      `sponsor-id="3"` (looked up via Vio.bootstrap). The carousel
 *      fetches products from Vio Commerce GraphQL and renders them.
 *
 * Visual layout in both modes:
 *   - Editorial label (red, uppercase) above the heading
 *   - Serif heading + inline gray disclaimer
 *   - "Se alle" link right-aligned
 *   - Snap-scroll viewport with round white chevron nav buttons
 */

import { LitElement, css, html } from 'lit'
import { customElement, property, query, state } from 'lit/decorators.js'
import { Vio } from '../../core/client.js'
import {
  displayPrice,
  primaryImageUrl,
  type Product,
} from '../../core/types.js'

@customElement('vio-product-carousel')
export class VioProductCarousel extends LitElement {
  /** Small uppercase label in accent color (e.g. "REDAKSJONENS FAVORITTER"). */
  @property({ type: String }) label = ''
  /** Big serif heading (e.g. "Shop Favorittene"). */
  @property({ type: String }) heading = ''
  /** Inline gray disclaimer next to the heading (e.g. "annonselenker"). */
  @property({ type: String }) disclaimer = ''
  /** URL for the "Se alle" link. Hidden if empty. */
  @property({ type: String, attribute: 'see-all-href' }) seeAllHref = ''
  /** Label for the see-all link. Defaults to Norwegian. */
  @property({ type: String, attribute: 'see-all-label' }) seeAllLabel = 'Se alle'

  /** Auto-fetch mode: comma-separated product ids (e.g. "408895,408896"). */
  @property({ type: String, attribute: 'product-ids' }) productIds = ''
  /** Auto-fetch mode option A: explicit per-sponsor commerce apiKey. */
  @property({ type: String, attribute: 'commerce-key' }) commerceKey = ''
  /** Auto-fetch mode option B: sponsor id looked up via Vio.bootstrap. */
  @property({ type: Number, attribute: 'sponsor-id' }) sponsorId = 0
  /**
   * Multi-sponsor mode: `"sponsorId:productId,sponsorId:productId,…"`. Each
   * pair resolves its own commerce client via `Vio.commerceFor(sponsorId)`;
   * fetches run in parallel and results are merged preserving input order.
   * Each rendered <vio-product> carries the per-item sponsor-id so taps go
   * to <vio-product-detail> with the right commerce context.
   *
   * Takes precedence over `product-ids` if both are set.
   */
  @property({ type: String, attribute: 'product-refs' }) productRefs = ''
  /** Currency for product prices. */
  @property({ type: String }) currency = 'NOK'

  @query('.scroller') private scroller!: HTMLElement
  @state() private fetched: Array<{ product: Product; sponsorId: number }> | null = null
  @state() private isLoading = false
  @state() private fetchError = ''

  static override styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
      color: var(--vio-color-text, #0a0a0a);
      padding: var(--vio-space-xl, 32px) 0;
    }
    .header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: var(--vio-space-md, 16px);
      margin-bottom: var(--vio-space-lg, 24px);
      padding: 0 var(--vio-space-lg, 24px);
    }
    .header-text { flex: 1; min-width: 0; }
    .label {
      font-size: var(--vio-size-xs, 12px);
      letter-spacing: var(--vio-tracking-label, 0.1em);
      text-transform: uppercase;
      color: var(--vio-color-accent, #c14a3b);
      font-weight: 500;
      margin-bottom: var(--vio-space-sm, 8px);
    }
    .heading-row {
      display: flex;
      align-items: baseline;
      gap: var(--vio-space-sm, 8px);
      flex-wrap: wrap;
    }
    .heading {
      font-family: var(--vio-font-serif, Georgia, serif);
      font-size: clamp(28px, 4vw, 40px);
      font-weight: 400;
      line-height: 1.1;
      margin: 0;
    }
    .disclaimer {
      color: var(--vio-color-text-tertiary, #999);
      font-size: var(--vio-size-sm, 14px);
      font-style: italic;
    }
    .see-all {
      font-size: var(--vio-size-sm, 14px);
      color: var(--vio-color-text, #0a0a0a);
      text-decoration: underline;
      text-underline-offset: 4px;
      white-space: nowrap;
      font-weight: 500;
    }
    .see-all:hover { color: var(--vio-color-text-secondary, #666); }

    .viewport {
      position: relative;
    }
    .scroller {
      display: flex;
      gap: var(--vio-space-md, 16px);
      /* Extra left padding so the first card clears the prev chevron. */
      padding: 0 var(--vio-space-lg, 24px) 8px 72px;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scrollbar-width: none;
      -ms-overflow-style: none;
      -webkit-overflow-scrolling: touch;
    }
    @media (max-width: 600px) {
      .scroller { padding: 0 var(--vio-space-lg, 24px) 8px; }
    }
    .scroller::-webkit-scrollbar { display: none; }
    ::slotted(*),
    vio-product {
      flex: 0 0 240px;
      scroll-snap-align: start;
    }
    @media (max-width: 600px) {
      ::slotted(*),
      vio-product {
        /* Two complete cards per screen (+ a sliver of the next), matching the
           reference: card = (viewport − side padding − gap) / 2. */
        flex: 0 0 calc((100vw - 64px) / 2);
      }
    }

    .nav-btn {
      position: absolute;
      top: 30%;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: #fff;
      border: none;
      box-shadow: 0 2px 14px rgba(0, 0, 0, 0.1);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      color: #0a0a0a;
      z-index: 2;
      transition: background 0.15s, transform 0.15s;
      font-family: inherit;
      padding: 0;
    }
    .nav-btn:hover { background: #fafafa; transform: scale(1.05); }
    .nav-btn:active { transform: scale(0.98); }
    .nav-btn.prev { left: 8px; }
    .nav-btn.next { right: 8px; }
    @media (max-width: 600px) {
      .nav-btn { display: none; }
    }

    .state {
      padding: 60px var(--vio-space-lg, 24px);
      text-align: center;
      color: var(--vio-color-text-secondary, #666);
      font-size: 14px;
    }
    .state.error { color: var(--vio-color-accent, #c14a3b); }
    .skeleton {
      flex: 0 0 240px;
      scroll-snap-align: start;
    }
    .skeleton-image {
      aspect-ratio: 1 / 1;
      background: var(--vio-color-surface-muted, #f2f2f2);
      animation: vio-pulse 1.6s ease-in-out infinite;
    }
    .skeleton-text {
      height: 12px;
      background: var(--vio-color-surface-muted, #f2f2f2);
      margin-top: 12px;
      animation: vio-pulse 1.6s ease-in-out infinite;
    }
    .skeleton-text.shorter { width: 60%; }
    @keyframes vio-pulse {
      0%,
      100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `

  override connectedCallback(): void {
    super.connectedCallback()
    if (this.productRefs.trim() || this.productIds.trim()) {
      void this.autoFetch()
    }
  }

  override updated(changed: Map<string, unknown>): void {
    const propChanged =
      changed.has('productRefs') ||
      changed.has('productIds') ||
      changed.has('commerceKey') ||
      changed.has('sponsorId')
    if (propChanged && (this.productRefs.trim() || this.productIds.trim())) {
      void this.autoFetch()
    }
  }

  private async autoFetch(): Promise<void> {
    if (!Vio.isInitialized) {
      this.fetchError = 'Vio not initialized — call Vio.init({ apiKey }) first'
      return
    }
    this.isLoading = true
    this.fetchError = ''
    try {
      const refs = this.productRefs.trim()
        ? this.parseRefs(this.productRefs)
        : this.productIds
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !Number.isNaN(n))
            .map((id) => ({ sponsorId: this.sponsorId, productId: id }))

      if (refs.length === 0) {
        this.fetched = []
        return
      }

      // Group by sponsorId so we can issue one GraphQL request per sponsor.
      const bySponsor = new Map<number, number[]>()
      for (const r of refs) {
        const arr = bySponsor.get(r.sponsorId) ?? []
        arr.push(r.productId)
        bySponsor.set(r.sponsorId, arr)
      }

      const fetched = await Promise.all(
        Array.from(bySponsor.entries()).map(async ([sponsorId, ids]) => {
          const commerce =
            this.commerceKey && this.productRefs.trim() === ''
              ? Vio.commerceWithKey(this.commerceKey)
              : Vio.commerceFor(sponsorId)
          const products = await commerce.channel.product.getByIds({
            product_ids: ids,
            currency: this.currency,
            image_size: 'large',
          })
          return { sponsorId, products }
        }),
      )

      // Index for O(1) lookup, then re-emit in original ref order.
      const lookup = new Map<string, Product>()
      for (const { sponsorId, products } of fetched) {
        for (const p of products) lookup.set(`${sponsorId}:${p.id}`, p)
      }
      this.fetched = refs
        .map(({ sponsorId, productId }) => {
          const product = lookup.get(`${sponsorId}:${productId}`)
          return product ? { product, sponsorId } : null
        })
        .filter((x): x is { product: Product; sponsorId: number } => x !== null)
    } catch (err) {
      this.fetchError = err instanceof Error ? err.message : String(err)
      // Keep `fetched` null so slotted fallback can still render.
    } finally {
      this.isLoading = false
    }
  }

  private parseRefs(raw: string): Array<{ sponsorId: number; productId: number }> {
    return raw
      .split(',')
      .map((pair) => pair.trim())
      .filter((s) => s.length > 0)
      .map((pair) => {
        const [sidStr, pidStr] = pair.split(':')
        const sid = parseInt((sidStr ?? '').trim(), 10)
        const pid = parseInt((pidStr ?? '').trim(), 10)
        if (Number.isNaN(sid) || Number.isNaN(pid)) return null
        return { sponsorId: sid, productId: pid }
      })
      .filter((x): x is { sponsorId: number; productId: number } => x !== null)
  }

  private scrollByDirection(direction: 1 | -1): void {
    if (!this.scroller) return
    const item = this.scroller.querySelector(':scope > *') as HTMLElement | null
    const step = (item?.offsetWidth ?? 240) + 16
    this.scroller.scrollBy({ left: direction * step * 2, behavior: 'smooth' })
  }

  private renderScrollerContent() {
    if (this.isLoading && !this.fetched) {
      // Skeleton cards while fetching.
      return html`${Array.from({ length: 5 }).map(
        () => html`
          <div class="skeleton">
            <div class="skeleton-image"></div>
            <div class="skeleton-text"></div>
            <div class="skeleton-text shorter"></div>
          </div>
        `,
      )}`
    }
    if (this.fetched && this.fetched.length > 0) {
      return html`${this.fetched.map(({ product: p, sponsorId }) => {
        const img = primaryImageUrl(p) ?? ''
        const retailer = sponsorNameFromBootstrap(sponsorId) ?? p.brand ?? ''
        return html`
          <vio-product
            product-id=${String(p.id)}
            sponsor-id=${String(sponsorId)}
            brand=${p.brand ?? ''}
            name=${p.title}
            price=${displayPrice(p)}
            retailer=${retailer}
            image-url=${img}
            ?has-variants=${(p.variants?.length ?? 0) > 1}
          ></vio-product>
        `
      })}`
    }
    // Fallback to slotted children (manual mode) — also used when fetch fails.
    return html`<slot></slot>`
  }

  override render() {
    return html`
      <div class="header">
        <div class="header-text">
          ${this.label ? html`<div class="label">${this.label}</div>` : ''}
          <div class="heading-row">
            ${this.heading ? html`<h2 class="heading">${this.heading}</h2>` : ''}
            ${this.disclaimer ? html`<span class="disclaimer">(${this.disclaimer})</span>` : ''}
          </div>
        </div>
        ${this.seeAllHref
          ? html`<a class="see-all" href=${this.seeAllHref}>${this.seeAllLabel}</a>`
          : ''}
      </div>
      <div class="viewport">
        <button
          class="nav-btn prev"
          @click=${() => this.scrollByDirection(-1)}
          aria-label="Forrige"
        >
          ‹
        </button>
        <div class="scroller">${this.renderScrollerContent()}</div>
        <button
          class="nav-btn next"
          @click=${() => this.scrollByDirection(1)}
          aria-label="Neste"
        >
          ›
        </button>
      </div>
      ${this.fetchError && !this.fetched
        ? html`<div class="state error">${this.fetchError}</div>`
        : ''}
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'vio-product-carousel': VioProductCarousel
  }
}

/** Resolve a sponsor's display name from `Vio.bootstrap()` cache. */
function sponsorNameFromBootstrap(sponsorId: number): string | undefined {
  const boot = Vio.bootstrapCache
  if (!boot) return undefined
  if (boot.primarySponsor?.id === sponsorId) return boot.primarySponsor.name
  return boot.secondarySponsors?.find((s) => s.id === sponsorId)?.name
}
