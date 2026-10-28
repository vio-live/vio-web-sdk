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
import { property, query, state } from 'lit/decorators.js'
import { Vio } from '../../core/client.js'
import type { AnalyticsCommerce } from '../../core/analytics/analytics-manager.js'
import {
  displayPrice,
  primaryImageUrl,
  type Product,
} from '../../core/types.js'
import { SlotRegistration } from '../slot-registration.js'
import { resolveSponsorIdentity } from '../sponsor-identity.js'

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
  /**
   * `carousel` (default: one row that scrolls sideways) or `list` (the cards
   * one under the other, full width, like products inside an article). Unset
   * = the theme's `carouselLayout` (`--vio-carousel-layout`).
   */
  @property({ type: String, reflect: true }) layout = ''
  /** Every card shows its product's description (see `descriptions` to write your own). Off by default. */
  @property({ type: Boolean, attribute: 'show-description' }) showDescription = false
  /**
   * The editor's own text per product, over the catalogue's: `{ "<productId>": "text" }`
   * (attribute: the same as JSON). Shown even without `show-description`; `""`
   * hides that product's description.
   */
  @property({ type: Object }) descriptions: Record<string, string> = {}
  /** The cards' buy button: `icon` (default), `bar` or `hidden` — see `<vio-product>`. */
  @property({ type: String, attribute: 'button-style' }) buttonStyle: 'icon' | 'bar' | 'hidden' = 'icon'
  /** Text of the `bar` button (default «Kjøp»). */
  @property({ type: String, attribute: 'button-label' }) buttonLabel = 'Kjøp'
  /** `layout` resolved against the theme on connect. */
  @state() private resolvedLayout: 'carousel' | 'list' = 'carousel'
  /**
   * Slot this carousel sits in (ADR-0027). Optional: without it the carousel
   * registers itself as `carousel-N` (its position among the carousels on the
   * page). Set it to name the place yourself or to share one slot between
   * elements. Passed to every card it renders, carried by its analytics, and
   * — without a `sponsor-id` — the source of the sponsor (the primary of the
   * campaign assigned to the slot). The attribute is `vio-slot`, not `slot`
   * (that one is HTML's own, shadow DOM slotting).
   */
  @property({ type: String, attribute: 'vio-slot' }) vioSlot = ''
  /** Human name of the slot for the dashboard (`vio-slot-name`). Optional. */
  @property({ type: String, attribute: 'vio-slot-name' }) vioSlotName = ''
  /**
   * Scope of the auto id (`article-123-carousel-1`). Inherited: this attribute,
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
  private readonly slotRegistration = new SlotRegistration(this, 'carousel')

  /** The slot id in effect: `vio-slot`, else the auto id (`carousel-N`). Read-only. */
  get effectiveSlot(): string {
    return this.slotRegistration.effective
  }

  /** The element's own page campaign (`vio-campaign` / ancestor), if any; `Vio.init`'s applies otherwise. */
  get effectiveCampaignId(): number | undefined {
    return this.slotRegistration.campaignId
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

  /** Attribution every analytics event of this carousel carries (`Vio.attribution` + the content overrides). */
  private attribution() {
    const base =
      typeof Vio.attribution === 'function'
        ? Vio.attribution(this.effectiveSlot, {
            sponsorId: this.sponsorId > 0 ? this.sponsorId : undefined,
            campaignId: this.slotRegistration.campaignHint,
          })
        : { slot: this.effectiveSlot || undefined }
    return {
      ...base,
      componentTemplateId: 'product-carousel',
      ...(this.vioContentId ? { contentId: this.vioContentId } : {}),
      ...(this.vioContentTitle ? { contentTitle: this.vioContentTitle } : {}),
    }
  }

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
    /* layout="list": one card under the other, as wide as the column. */
    .viewport.list .scroller {
      flex-direction: column;
      align-items: stretch;
      gap: var(--vio-carousel-list-gap, 32px);
      max-width: var(--vio-carousel-list-max-width, 480px);
      margin: 0 auto;
      padding: 0 var(--vio-space-lg, 24px);
      overflow: visible;
      scroll-snap-type: none;
    }
    .viewport.list .scroller vio-product,
    .viewport.list ::slotted(*),
    .viewport.list .skeleton { flex: 0 0 auto; width: 100%; }
    .viewport.list .nav-btn { display: none; }
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

  private overrideFor(p: Product): string | undefined {
    const own = this.descriptions?.[String(p.id)]
    return typeof own === 'string' ? own : undefined
  }

  private descriptionFor(p: Product): string {
    return this.overrideFor(p) ?? cardDescription(p.description)
  }

  /** The editor's text always shows (unless empty); the catalogue's only with show-description. */
  private showsDescription(p: Product): boolean {
    const own = this.overrideFor(p)
    return own !== undefined ? own.trim() !== '' : this.showDescription
  }

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('layout') || !this.hasUpdated) {
      const fromTheme = typeof getComputedStyle === 'function' ? getComputedStyle(this).getPropertyValue('--vio-carousel-layout') : ''
      const value = (this.layout || fromTheme).trim().replace(/^["']|["']$/g, '').toLowerCase()
      this.resolvedLayout = value === 'list' ? 'list' : 'carousel'
    }
  }

  override connectedCallback(): void {
    super.connectedCallback()
    this.slotRegistration.connect(this.slotAttributes())
    if (this.productRefs.trim() || this.productIds.trim()) {
      void this.autoFetch()
    }
    // After the fetch has started: while products load, the impression waits for them.
    this.observeForAnalytics()
  }

  override disconnectedCallback(): void {
    this.unobserveImpression?.()
    this.unobserveImpression = null
    this.slotRegistration.clear()
    super.disconnectedCallback()
  }

  override updated(changed: Map<string, unknown>): void {
    // The React wrappers set properties after mount; the Vev editor changes them live.
    if (changed.has('vioSlot') || changed.has('vioSlotName') || changed.has('vioScope') || changed.has('vioScopeName') || changed.has('vioCampaign')) {
      this.slotRegistration.sync(this.slotAttributes())
    }
    const propChanged =
      changed.has('productRefs') ||
      changed.has('productIds') ||
      changed.has('commerceKey') ||
      changed.has('sponsorId') ||
      changed.has('vioSlot') ||
      changed.has('vioCampaign') // another campaign → another sponsor → refetch
    if (propChanged && (this.productRefs.trim() || this.productIds.trim())) {
      void this.autoFetch()
    }
  }

  /**
   * The sponsor of this carousel: the host's `sponsor-id`, else the primary
   * sponsor of the campaign the slot shows (ADR-0034 — "the campaign of the
   * block is its sponsor"), else 0 (unknown).
   */
  private effectiveSponsorId(): number {
    if (this.sponsorId > 0) return this.sponsorId
    const fromSlot =
      typeof Vio.campaignForSlot === 'function'
        ? Number(Vio.campaignForSlot(this.effectiveSlot || null, { campaignId: this.slotRegistration.campaignHint })?.primarySponsor?.id)
        : NaN
    return Number.isFinite(fromSlot) && fromSlot > 0 ? fromSlot : 0
  }

  private async autoFetch(): Promise<void> {
    if (!Vio.isInitialized) {
      this.fetchError = 'Vio not initialized — call Vio.init({ apiKey }) first'
      return
    }
    this.isLoading = true
    this.fetchError = ''
    // The impression carries the products shown: one not counted yet starts
    // again once they are here (the dwell counts on what the reader sees).
    if (!this.impressed) {
      this.unobserveImpression?.()
      this.unobserveImpression = null
    }
    try {
      // Without a sponsor-id the slot's campaign supplies the sponsor — that
      // needs the bootstrap, which the host may still be fetching.
      if (this.productRefs.trim() === '' && !this.commerceKey && this.sponsorId <= 0 && !Vio.bootstrapCache) {
        try {
          await Vio.bootstrap()
        } catch {
          /* commerceFor() below reports the missing sponsor as before */
        }
      }
      const sponsorId = this.effectiveSponsorId()
      const refs = this.productRefs.trim()
        ? this.parseRefs(this.productRefs)
        : this.productIds
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !Number.isNaN(n))
            .map((id) => ({ sponsorId, productId: id }))

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
      this.maybeTrackList()
    } catch (err) {
      this.fetchError = err instanceof Error ? err.message : String(err)
      // Keep `fetched` null so slotted fallback can still render.
    } finally {
      this.isLoading = false
      this.observeForAnalytics()
    }
  }

  // ── Analytics (auto) ──────────────────────────────────────────────
  // component_impression on the contract rule (≥50% visible ≥1s, once per
  // session) with the products shown in `commerce.items` (ADR-0041: the
  // collector counts per-product impressions from them) + view_item_list with
  // the rendered products. While products load the impression is not
  // observed: it starts once they are here (or the fetch failed — slotted
  // fallback is still an impression, without items). No-ops unless
  // Vio.analytics.start() ran.
  private unobserveImpression: (() => void) | null = null
  private impressed = false
  private listTracked = false

  private observeForAnalytics(): void {
    if (this.unobserveImpression || this.isLoading || !this.isConnected) return
    try {
      this.unobserveImpression = Vio.analytics.observeImpression(
        this,
        {
          sponsorId: this.sponsorId > 0 ? this.sponsorId : undefined,
          // The slot is the real location id; the label only stands in for it.
          locationId: this.effectiveSlot || this.label || undefined,
          ...this.attribution(),
        },
        {
          key: `carousel:${this.effectiveSlot || this.label || this.productIds || this.productRefs || 'default'}`,
          onImpression: () => {
            this.impressed = true
            this.maybeTrackList()
          },
          commerce: () => this.listCommerce(),
        },
      )
    } catch {
      /* analytics must never break rendering */
    }
  }

  /** view_item_list needs BOTH the viewport dwell and loaded products —
   * whichever lands last fires it (once). */
  private maybeTrackList(): void {
    if (!this.impressed || this.listTracked) return
    const entries = this.fetched ?? []
    if (entries.length === 0) return
    this.listTracked = true
    try {
      const sponsorId = this.effectiveSponsorId()
      Vio.analytics.track('view_item_list', {
        context: {
          sponsorId: sponsorId > 0 ? sponsorId : undefined,
          locationId: this.effectiveSlot || this.label || undefined,
          ...this.attribution(),
        },
        commerce: this.listCommerce() ?? undefined,
        props: this.label ? { list_name: this.label } : undefined,
      })
    } catch {
      /* never break rendering */
    }
  }

  /** The products on show as analytics lines (impression and view_item_list); null before they load. */
  private listCommerce(): AnalyticsCommerce | null {
    const entries = this.fetched ?? []
    if (entries.length === 0) return null
    return {
      items: entries.map(({ product }) => ({
        productId: product.id,
        name: product.title,
        price: Number(product.price?.amount_incl_taxes ?? product.price?.amount) || undefined,
      })),
      currency: entries[0]?.product.price?.currency_code,
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
        const retailer = resolveSponsorIdentity(sponsorId)?.name || p.brand || ''
        return html`
          <vio-product
            product-id=${String(p.id)}
            sponsor-id=${String(sponsorId)}
            brand=${p.brand ?? ''}
            name=${p.title}
            price=${displayPrice(p)}
            retailer=${retailer}
            description=${this.descriptionFor(p)}
            ?show-description=${this.showsDescription(p)}
            button-style=${this.buttonStyle}
            button-label=${this.buttonLabel}
            image-url=${img}
            ?has-variants=${(p.variants?.length ?? 0) > 1}
            .vioSlot=${this.effectiveSlot}
            .componentTemplateId=${'product-carousel'}
            .vioCampaign=${this.effectiveCampaignId !== undefined ? String(this.effectiveCampaignId) : ''}
            .vioContentId=${this.vioContentId}
            .vioContentTitle=${this.vioContentTitle}
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
      <div class="viewport ${this.resolvedLayout}">
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

/** The product's description as one plain-text paragraph for a card (the card clamps it). */
function cardDescription(description: string | null | undefined): string {
  if (!description) return ''
  return description
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}
