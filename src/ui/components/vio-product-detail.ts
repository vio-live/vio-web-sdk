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

import { LitElement, css, html, nothing } from 'lit'
import { property, state } from 'lit/decorators.js'
import { ensureVippsButton } from '../../core/checkout/payments/vipps-button.js'
import { beginPaymentRedirect, type PaymentRedirectHandle } from '../payment-redirect.js'
import { Vio } from '../../core/client.js'
import { shippingDescriptionOf } from '../../core/api/commerce.js'
import {
  formatPrice,
  getGlobalCurrency,
  type Product,
  type ProductImage,
  type ProductOption,
  type ProductVariant,
} from '../../core/types.js'
import { isMethodEnabled, NO_EXPRESS_BUTTON_METHODS } from '../../core/checkout/method-taxonomy.js'
import { DialogFocus } from '../dialog-focus.js'
import { BottomSheet } from '../bottom-sheet.js'
import { SlotRegistration } from '../slot-registration.js'
import { toCampaignId } from '../../core/slots.js'
import { renderSponsorMark, resolveSponsorIdentity, sponsorDetail, usableLogo } from '../sponsor-identity.js'
import {
  copyAppliedLayout,
  layoutOriginOf,
  layoutSignature,
  onGlobalDetailLayoutChange,
  resolveDetailLayout,
  type AppliedDetailLayout,
  type DetailLayout,
  type DetailSectionId,
} from '../../core/detail-layout.js'

/** The `layout` attribute: JSON; anything unreadable is no layout (warned once by the resolver). */
const layoutAttribute = {
  fromAttribute(value: string | null): unknown {
    if (value === null || value.trim() === '') return null
    try {
      return JSON.parse(value)
    } catch {
      // Not JSON: handed on as is, so the resolver says why it is ignored.
      return value
    }
  },
  toAttribute(value: unknown): string | null {
    return value === null || value === undefined ? null : JSON.stringify(value)
  },
}

/** How long «Lagt i handlekurven» stays without a tap. */
const ADDED_TOAST_MS = 8000

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

/** One of the brand's promises under the buy zone («Rask levering», «Designet i Norge»). */
export interface VioDetailHighlight {
  /** A built-in line icon (see HIGHLIGHT_ICONS: plane, heart, shirt, truck, return, leaf, star, shield) or an image URL. */
  icon?: string
  title: string
  text?: string
}

/** Line icons in the brand-strip style: 24×24, stroke = the text colour. */
const HIGHLIGHT_ICONS: Record<string, string> = {
  plane: 'M21.5 2.5 2.5 10l7 3m12-10.5-12 10.5m12-10.5L17 21l-7.5-8m0 0V20l3-4M5 17l-2.5 2.5M7.5 18.5 6 20',
  heart: 'M12 20.5s-8.5-5-8.5-11A4.75 4.75 0 0 1 12 6.75 4.75 4.75 0 0 1 20.5 9.5c0 6-8.5 11-8.5 11Z',
  shirt: 'M8.5 3.5 3 6l1.75 4.25L7 9.5v11h10v-11l2.25.75L21 6l-5.5-2.5a3.5 3.5 0 0 1-7 0Z',
  truck: 'M2.5 5.5h11v10h-11zM13.5 9.5h4l3 3.5v2.5h-7M6.5 18.5a2 2 0 1 0 0-.01M17 18.5a2 2 0 1 0 0-.01',
  return: 'M4 9h11.5a4.5 4.5 0 0 1 0 9H8M4 9l4-4M4 9l4 4',
  leaf: 'M5 19C5 10 10 4.5 20 4.5c0 10-5.5 15-14 15M5 19l7-7',
  star: 'm12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9-4.3-4.1 5.9-.8Z',
  shield: 'M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6Z',
  mailbox: 'M3 19v-8a4 4 0 0 1 8 0v8m-8 0h18v-7a4 4 0 0 0-4-4H7m8 0V4h3M6 12h2',
  home: 'M3 11 12 4l9 7M5.5 9.5V20h13V9.5M10 20v-5h4v5',
  pin: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2',
}

/** The icon for a way of delivering, from the words the brand used for it. */
function rateIcon(method: string): string {
  const m = method.toLowerCase()
  if (/postkasse|mailbox|brevkasse/.test(m)) return 'mailbox'
  if (/hente|pakkeboks|automat|postkontor|pickup|utlever/.test(m)) return 'pin'
  if (/dør|hjem|home|door/.test(m)) return 'home'
  return 'truck'
}

/** The logo the host gave for this carrier (case-insensitive), or ''. */
function carrierLogo(logos: Record<string, string> | null | undefined, carrier: string): string {
  if (!logos || !carrier) return ''
  const want = carrier.trim().toLowerCase()
  for (const [name, url] of Object.entries(logos)) if (name.trim().toLowerCase() === want && url) return url
  return ''
}

/** A small line icon from HIGHLIGHT_ICONS (the brand strip's set). */
function lineIcon(name: string, cls = 'line-icon') {
  return html`<svg class=${cls} viewBox="0 0 24 24" aria-hidden="true"><path d=${HIGHLIGHT_ICONS[name] ?? ''}></path></svg>`
}

export class VioProductDetail extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false
  @property({ type: String, attribute: 'product-id' }) productId = ''
  @property({ type: Number, attribute: 'sponsor-id' }) sponsorId = 0
  /** Subscribe to `vio:product-click` on the document and auto-open. */
  @property({ type: Boolean, attribute: 'auto-open' }) autoOpen = true
  @property({ type: String }) currency = 'NOK'
  /**
   * Slot this detail belongs to (ADR-0027). Optional: without it the detail
   * registers itself as `detail-N`. Carried by every event it emits. A
   * `vio:product-click` that names a slot (every card does — its own or the
   * carousel's) takes precedence while that product is open. The attribute is
   * `vio-slot`, not `slot` (HTML's own).
   */
  @property({ type: String, attribute: 'vio-slot' }) vioSlot = ''
  /** Human name of the slot for the dashboard (`vio-slot-name`). Optional. */
  @property({ type: String, attribute: 'vio-slot-name' }) vioSlotName = ''
  /**
   * Scope of the auto id (`article-123-detail-1`). Inherited: this attribute,
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
   * No «Lagt i handlekurven» toast after «Legg i handlekurv» — for a host
   * that answers `vio:added-to-cart` with its own (opening its cart drawer,
   * say). Off by default: the toast shows.
   */
  @property({ type: Boolean, attribute: 'no-added-toast' }) noAddedToast = false
  /**
   * How the images show: `thumbs` (one image, thumbnails under it — the
   * default) or `carousel` (every image in one swipeable row, no thumbnails:
   * less height). Unset = the theme's `detailGallery` (`--vio-detail-gallery`),
   * so a host sets it once for every detail on the page.
   */
  @property({ type: String }) gallery = ''
  /**
   * «Beskrivelse»: `preview` (default — the first lines fading out and «Les
   * mer»), `folded` (only the heading until a tap) or `open` (all of it).
   * Unset = the theme's `detailDescriptionMode` (`--vio-detail-description-mode`).
   */
  @property({ type: String, attribute: 'description-mode' }) descriptionMode = ''
  /**
   * The brand's promises, shown in a row under the buy zone. By default the
   * brand's own (dashboard Settings → Brand, in the bootstrap); this list
   * replaces them on this page — e.g.
   * `[{ icon: 'plane', title: 'Rask levering', text: '2-5 virkedager' }]`
   * (attribute: the same as JSON). Up to three read well. None by default.
   */
  @property({ type: Array }) highlights: VioDetailHighlight[] = []
  /**
   * How long delivery takes (`2-5 virkedager`), for a brand whose rates do not
   * say it: Commerce's own text on each rate («Leveringstid 1-5 dager») wins.
   * Shown under the rates in «Frakt & retur». None by default.
   */
  @property({ type: String, attribute: 'delivery-time' }) deliveryTime = ''
  /**
   * Carrier logos for «Frakt & retur», by the carrier's name as the rate
   * starts (`{ "Bring": "https://…/bring.svg", "Helthjem": "…" }`, any case;
   * attribute: the same as JSON), for rates without their own logo in
   * Commerce (which wins). A carrier with neither gets the line icon.
   */
  @property({ type: Object, attribute: 'carrier-logos' }) carrierLogos: Record<string, string> = {}
  /**
   * The order of the sections below the gallery (0.34): `{ id, revision,
   * sections, experimentId?, variantId? }` (attribute: the same as JSON). Wins
   * over `Vio.configureDetail({ layout })`; unset = the page's, else the
   * default. Section ids: `brand`, `title`, `stock`, `price`, `options`,
   * `purchase`, `highlights`, `description`, `shippingReturns`. See README
   * «Section order and layout tracking».
   */
  @property({ attribute: 'layout', converter: layoutAttribute }) layout: DetailLayout | null = null
  /** The layout the detail renders with now (resolved before each render). */
  private layoutNow: AppliedDetailLayout = resolveDetailLayout(null)
  /** The product and layout `vio:detail-layout-applied` was last said for. */
  private appliedFor: { product: Product; signature: string } | null = null
  private unsubscribeLayout: (() => void) | null = null

  /**
   * The layout this detail applies (0.34): `{ id, revision, experimentId?,
   * variantId?, sections, adjusted, source }` — `source` is `element` (its own
   * `layout`), `global` (`Vio.configureDetail`) or `default`. A copy.
   */
  get appliedLayout(): AppliedDetailLayout {
    // What the next render uses — after a render, what it used.
    return copyAppliedLayout(resolveDetailLayout(this.layout))
  }
  private readonly slotRegistration = new SlotRegistration(this, 'detail')
  /** What the click that opened the detail carried ('' when nothing), and for which product. */
  private eventSlot = ''
  private eventContentId = ''
  private eventContentTitle = ''
  private eventCampaignId: number | undefined = undefined
  private eventProductId = ''

  /** The card's context applies to the product it opened — not to one the host opened by hand later. */
  private get fromCard(): boolean {
    return this.eventProductId !== '' && this.eventProductId === String(this.productId)
  }

  /** The slot id in effect for this element: `vio-slot`, else the auto id (`detail-N`). Read-only. */
  get effectiveSlot(): string {
    return this.slotRegistration.effective
  }

  /** The element's own page campaign (`vio-campaign` / ancestor), if any; `Vio.init`'s applies otherwise. */
  get effectiveCampaignId(): number | undefined {
    return this.slotRegistration.campaignId
  }

  /** The slot the open product is attributed to: the opening card's, else this element's. */
  private get activeSlot(): string {
    return (this.fromCard && this.eventSlot) || this.effectiveSlot
  }

  /** The page-campaign candidates of the open product: the opening card's, then this element's own and its ancestor's. */
  private get activeCampaignHint(): number[] {
    const own = this.slotRegistration.campaignHint
    return this.fromCard && this.eventCampaignId !== undefined ? [this.eventCampaignId, ...own] : own
  }

  /**
   * The campaign whose channel sells the open product (one article = one
   * campaign = one channel): the campaign its events credit, then the opening
   * click's and this element's own — so the product, its rates and its
   * seller are read with that channel's key, the one the cart is created on.
   */
  private commerceCampaigns(): number[] {
    const hint = this.activeCampaignHint
    try {
      const resolved = this.attribution().campaignId
      return typeof resolved === 'number' ? [resolved, ...hint] : hint
    } catch {
      return hint
    }
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

  /** Attribution every event of the open product carries (`Vio.attribution` of the opening card's slot, else this element's). */
  private attribution() {
    const base =
      typeof Vio.attribution === 'function'
        ? Vio.attribution(this.activeSlot, {
            sponsorId: this.sponsorId > 0 ? this.sponsorId : undefined,
            campaignId: this.activeCampaignHint,
          })
        : { slot: this.activeSlot || undefined }
    const contentId = (this.fromCard && this.eventContentId) || this.vioContentId
    const contentTitle = (this.fromCard && this.eventContentTitle) || this.vioContentTitle
    return {
      ...base,
      componentTemplateId: 'product-detail',
      ...(contentId ? { contentId } : {}),
      ...(contentTitle ? { contentTitle } : {}),
    }
  }

  @state() private product: Product | null = null
  /**
   * The header: the seller's Company name (Settings → Company), not the
   * product's brand, which the body already shows (Angelo, 2026-10-08).
   * Asked on its own after the product; until it answers the header waits,
   * and if there is none it falls back to the brand.
   */
  @state() private sellerName: string | null = null
  @state() private sellerSettled = false
  /**
   * The cheapest shipping rate of the product for the page's market, in the
   * product's currency — under the price as «Frakt fra X» («Gratis frakt» at
   * 0). null = not known (not asked yet, none, or another currency): only the
   * right of withdrawal is said then.
   */
  @state() private shippingFrom: { price: number; currency: string } | null = null
  /** Every rate for the page's country, cheapest first — for «Frakt & retur». */
  @state() private shippingRates: Array<{ name: string; price: number; currency: string; description: string; logoUrl: string }> = []
  @state() private isLoading = false
  @state() private fetchError = ''
  @state() private selectedOptions: SelectedOptions = {}
  /** The option a buy button asked for and the shopper has not chosen yet ('' = none asked). */
  @state() private selectionPrompt = ''
  @state() private quantity = 1
  @state() private activeImageIndex = 0
  /** The thumbnail row is wider than its box (arrows shown with a mouse). */
  @state() private thumbsOverflow = false
  @state() private thumbsAtStart = true
  @state() private thumbsAtEnd = false
  /** «Beskrivelse» shows a preview until a tap opens it all. */
  @state() private descriptionOpen = false
  /** The description is longer than its preview (otherwise there is nothing to open). */
  @state() private descriptionClipped = false
  /** `gallery` resolved against the theme when the detail opens. */
  @state() private galleryMode: 'thumbs' | 'carousel' = 'thumbs'
  /** `description-mode` resolved against the theme when the detail opens. */
  @state() private resolvedDescriptionMode: 'preview' | 'folded' | 'open' = 'preview'
  /** The top bar's logo file is square-ish: a mark, so its name goes beside it. */
  @state() private logoSquare = false
  @state() private adding = false
  /**
   * «Lagt i handlekurven» after an add, with «Til kassen» and «Fortsett å
   * handle» (Mote & Livsstil, 2026-10-28: an add closed the detail and said
   * nothing). Outlives the detail: the brand and attribution of the add.
   */
  @state() private addedToast: { sponsorId: number; detail: Record<string, unknown> } | null = null
  private addedToastTimer: ReturnType<typeof setTimeout> | null = null
  /** Apple Pay actually usable (real Stripe + registered domain) — set on load. */
  @state() private applePayOk = false
  /** Payment method names enabled for the sponsor (backend-configured).
   * null = not loaded yet → all buy buttons render; [] = none enabled. */
  @state() private availableMethods: string[] | null = null
  /**
   * The brand's methods are being asked for. Meanwhile the buy zone shows a
   * neutral placeholder, never the buttons of every method: «null = render
   * all» painted Stripe and Klarna for a Vipps-only brand until the answer
   * came (Mote & Livsstil, 2026-10-28).
   */
  @state() private methodsLoading = false
  /**
   * The brand's Vipps is KNOWN to run Express: its method list came back,
   * with Vipps and no `config.express: false`. Only then does the line under
   * the button say the app fills in name and address — never on a guess
   * after a failed lookup.
   */
  @state() private vippsExpress = false
  /** Whose methods `availableMethods` are — another brand's are not shown while its own load. */
  private methodsSponsorId = 0
  @state() private vippsOfficial = false
  /** Race guard: only the latest fetch may write state (two quick taps on
   * different cards would otherwise let the slow response win). */
  private fetchSeq = 0
  /** Memoised option maps per variant object (recomputed per product). */
  private optMapCache = new WeakMap<object, { map: Record<string, string>; titleParts: string[] }>()
  /** Pre-prepared Apple Pay handle — show() fires synchronously on tap. */
  private applePayHandle: { show: () => Promise<void> } | null = null
  /** The amount `applePayHandle`'s sheet shows (product × quantity when it was prepared). */
  private applePayAmount: number | null = null
  /** The amount the latest preparation was asked for — a newer one supersedes it. */
  private applePayAskedFor: number | null = null
  /** Keyboard and focus while open: Escape closes, Tab stays inside, focus returns to the opener. */
  private readonly dialogFocus = new DialogFocus({
    host: this,
    container: () => this.renderRoot.querySelector<HTMLElement>('.modal'),
    close: () => this.close(),
  })
  /** Phones: the page behind is locked, and the sheet closes by pulling the bar or the top bar down. */
  private readonly bottomSheet = new BottomSheet({
    host: this,
    sheet: () => this.renderRoot.querySelector<HTMLElement>('.modal'),
    backdrop: () => this.renderRoot.querySelector<HTMLElement>('.backdrop'),
    dragZones: '.handle, .topbar',
    close: () => this.close(),
  })

  private boundProductClick = (e: Event): void => {
    if (!this.autoOpen) return
    const ev = e as CustomEvent<{
      productId: string
      sponsorId: string
      currency?: string
      slot?: string
      campaignId?: number | string
      contentId?: string | number
      contentTitle?: string
    }>
    const productIdNum = parseInt(ev.detail.productId, 10)
    // Skip non-numeric IDs (affiliate products) — host handles those.
    if (Number.isNaN(productIdNum)) return
    const slot = typeof ev.detail.slot === 'string' ? ev.detail.slot.trim() : ''
    let sponsorIdNum = parseInt(ev.detail.sponsorId, 10)
    if (Number.isNaN(sponsorIdNum) || sponsorIdNum <= 0) {
      // A card without a sponsor: the primary of the campaign its slot shows.
      const fromSlot =
        typeof Vio.campaignForSlot === 'function'
          ? Number(
              Vio.campaignForSlot(slot || this.effectiveSlot || null, {
                campaignId: [ev.detail.campaignId, ...this.slotRegistration.campaignHint],
              })?.primarySponsor?.id,
            )
          : NaN
      if (!Number.isFinite(fromSlot) || fromSlot <= 0) return
      sponsorIdNum = fromSlot
    }
    this.eventSlot = slot
    this.eventCampaignId = toCampaignId(ev.detail.campaignId)
    this.eventProductId = String(ev.detail.productId)
    this.eventContentId =
      ev.detail.contentId !== undefined && ev.detail.contentId !== null ? String(ev.detail.contentId).trim() : ''
    this.eventContentTitle = typeof ev.detail.contentTitle === 'string' ? ev.detail.contentTitle.trim() : ''
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
    /* Focus lands on the panel itself only as a fallback — no ring for it. */
    .modal:focus { outline: none; }

    .handle { display: none; }

    /* Mobile: bottom sheet (not fullscreen), rounded top, drag handle. */
    @media (max-width: 600px) {
      .modal {
        top: auto;
        height: 92vh;
        border-radius: var(--vio-radius-xl, 16px) var(--vio-radius-xl, 16px) 0 0;
        box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.08);
        overscroll-behavior: contain;
      }
      /* Pulled down to close (bottom-sheet.ts): the browser must not take the gesture for a scroll. */
      .handle, .topbar { touch-action: none; }
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
        border-radius: var(--vio-radius-sm, 2px);
      }
    }

    /* Desktop: right-side drawer (matches the cart/checkout), so the product
       shows "al lado" instead of a centered modal. Info stacks in one column. */
    @media (min-width: 601px) {
      .modal {
        inset: 0 0 0 auto;
        width: min(var(--vio-detail-width, 440px), 100%);
        max-width: var(--vio-detail-width, 440px);
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
        padding: var(--vio-detail-padding-top, 0px) var(--vio-detail-padding-x, var(--vio-space-lg, 24px)) 40px;
      }
      .modal .name { font-size: var(--vio-detail-title-size, 26px); line-height: 1.2; }
      .modal .gallery-main { width: auto; }
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      min-height: var(--vio-detail-topbar-height, 64px);
      box-sizing: border-box;
      padding: 10px var(--vio-detail-padding-x, var(--vio-space-lg, 24px));
      position: sticky;
      top: 0;
      background: var(--vio-color-surface, #fff);
      border-bottom: 1px solid var(--vio-color-border, #e5e5e5);
      z-index: 1;
    }
    /* Who sells it, top left beside the close: the sponsor's logo, else its name. */
    .topbar-sponsor { flex: 1 1 auto; display: flex; align-items: center; gap: 10px; min-width: 0; }
    /* The logo box clips, so --vio-detail-logo-zoom can crop the white a
       square file carries around its mark. */
    .topbar-logo-box {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      height: var(--vio-detail-logo-height, 44px);
      max-width: var(--vio-detail-logo-max-width, 220px);
      overflow: hidden;
    }
    .topbar-logo {
      display: block;
      width: auto;
      height: 100%;
      max-width: var(--vio-detail-logo-max-width, 220px);
      object-fit: contain;
      object-position: left center;
      transform: scale(var(--vio-detail-logo-zoom, 1));
      transform-origin: center;
    }
    /* A square (or near) logo is a mark, not a wordmark: say whose it is. */
    .topbar-sponsor:not(.is-square) .topbar-mark-name { display: none; }
    .topbar-name {
      font-size: var(--vio-detail-logo-name-size, 13px);
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
      .body {
        grid-template-columns: 1fr;
        gap: 24px;
        padding: var(--vio-detail-padding-top, 0px) var(--vio-detail-padding-x, var(--vio-space-lg, 24px)) 64px;
      }
    }

    /* Gallery. One fixed proportion for every image (4:5 by default) that the
       image fills (cover): no white bars, and the panel never jumps between
       photos of different shapes (Angelo, 2026-10-22). Its side margin is
       --vio-detail-image-inset (the panel's padding by default; 0 = edge to
       edge). Fit, proportion, a height cap and a zoom (to crop a white margin
       baked into the file) are the host's to set. */
    .gallery { display: flex; flex-direction: column; gap: var(--vio-detail-gallery-gap, 12px); min-width: 0; }
    .gallery-main {
      position: relative;
      margin-inline: calc(
        var(--vio-detail-image-inset, var(--vio-detail-padding-x, var(--vio-space-lg, 24px))) -
          var(--vio-detail-padding-x, var(--vio-space-lg, 24px))
      );
      aspect-ratio: var(--vio-detail-image-aspect, 4 / 5);
      max-height: var(--vio-detail-image-max-height, 85vh);
      background: var(--vio-detail-image-bg, var(--vio-color-surface-muted, #f2f2f2));
      border-radius: var(--vio-detail-image-radius, 0);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .gallery-main img {
      display: block;
      width: 100%;
      height: 100%;
      max-height: var(--vio-detail-image-max-height, 85vh);
      object-fit: var(--vio-detail-image-fit, cover);
      object-position: var(--vio-detail-image-position, center);
      transform: scale(var(--vio-detail-image-zoom, 1));
    }
    /* Thumbnails: one row, never a second line — swipe on touch, arrows with a
       mouse; the selected one scrolls into view by itself. */
    .thumbs { position: relative; min-width: 0; }
    .gallery-thumbs {
      display: flex;
      flex-wrap: nowrap;
      gap: var(--vio-detail-thumb-gap, 8px);
      overflow-x: auto;
      scroll-snap-type: x proximity;
      scroll-behavior: smooth;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
    }
    .gallery-thumbs::-webkit-scrollbar { display: none; }
    .gallery-thumb {
      flex: 0 0 auto;
      width: var(--vio-detail-thumb-size, 64px);
      height: var(--vio-detail-thumb-size, 64px);
      background: var(--vio-color-surface-muted, #f2f2f2);
      border: var(--vio-detail-thumb-border-width, 1px) solid transparent;
      border-radius: var(--vio-detail-thumb-radius, 0);
      cursor: pointer;
      padding: 0;
      overflow: hidden;
      scroll-snap-align: start;
      box-sizing: border-box;
      opacity: var(--vio-detail-thumb-opacity, 1);
    }
    .gallery-thumb img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: var(--vio-detail-thumb-fit, cover);
    }
    .gallery-thumb.active {
      border-color: var(--vio-detail-thumb-active-color, var(--vio-color-text, #0a0a0a));
      opacity: 1;
    }
    .thumbs-arrow {
      display: none;
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      z-index: 1;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1px solid var(--vio-color-border, #e5e5e5);
      background: var(--vio-color-surface, #fff);
      color: var(--vio-color-text, #0a0a0a);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      cursor: pointer;
      align-items: center;
      justify-content: center;
      padding: 0;
      font: 16px/1 sans-serif;
    }
    .thumbs-arrow.prev { left: -6px; }
    .thumbs-arrow.next { right: -6px; }
    .thumbs-arrow:disabled { visibility: hidden; }
    @media (hover: hover) and (pointer: fine) {
      .thumbs.overflows .thumbs-arrow { display: flex; }
    }

    /* Carousel (gallery="carousel" / theme detailGallery): the same box as the
       main image — proportion, fit, background, inset — one per photo, in a
       row that snaps. --vio-detail-carousel-peek shows the edge of the next. */
    .carousel {
      position: relative;
      margin-inline: calc(
        var(--vio-detail-image-inset, var(--vio-detail-padding-x, var(--vio-space-lg, 24px))) -
          var(--vio-detail-padding-x, var(--vio-space-lg, 24px))
      );
    }
    .carousel-track {
      display: flex;
      gap: var(--vio-detail-carousel-gap, 0px);
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scroll-behavior: smooth;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain;
      /* Sideways is the carousel's, up and down the panel's; no double-tap
         zoom delay. The sheet only drags from its top bar, never from here. */
      touch-action: pan-x pan-y;
      border-radius: var(--vio-detail-image-radius, 0);
    }
    .carousel-track::-webkit-scrollbar { display: none; }
    .carousel-slide {
      flex: 0 0 calc(100% - var(--vio-detail-carousel-peek, 0px));
      aspect-ratio: var(--vio-detail-image-aspect, 4 / 5);
      max-height: var(--vio-detail-image-max-height, 85vh);
      background: var(--vio-detail-image-bg, var(--vio-color-surface-muted, #f2f2f2));
      scroll-snap-align: start;
      scroll-snap-stop: always;
      overflow: hidden;
    }
    .carousel-slide img {
      display: block;
      /* A press on a photo is a swipe: no image drag, no long-press menu, no selection. */
      pointer-events: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-user-drag: none;
      -webkit-touch-callout: none;
      width: 100%;
      height: 100%;
      object-fit: var(--vio-detail-image-fit, cover);
      object-position: var(--vio-detail-image-position, center);
      transform: scale(var(--vio-detail-image-zoom, 1));
    }
    /* One dot per photo over the bottom of the image: there is more than one,
       and which one this is. White with a shadow reads on light and dark photos. */
    .carousel-dots {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 12px;
      display: flex;
      justify-content: center;
      gap: 6px;
      pointer-events: none;
    }
    .carousel-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vio-detail-dot-color, rgba(255, 255, 255, 0.6));
      box-shadow: 0 0 2px rgba(0, 0, 0, 0.35);
      transition: background 0.2s ease, transform 0.2s ease;
    }
    .carousel-dot.active {
      background: var(--vio-detail-dot-active-color, #fff);
      transform: scale(1.35);
    }
    .carousel-arrow {
      display: none;
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 1px solid var(--vio-color-border, #e5e5e5);
      background: var(--vio-color-surface, #fff);
      color: var(--vio-color-text, #0a0a0a);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      cursor: pointer;
      align-items: center;
      justify-content: center;
      padding: 0;
      font: 18px/1 sans-serif;
    }
    .carousel-arrow.prev { left: 12px; }
    .carousel-arrow.next { right: 12px; }
    .carousel-arrow:disabled { visibility: hidden; }
    @media (hover: hover) and (pointer: fine) {
      .carousel-arrow { display: flex; }
    }

    /* Info column */
    .info { display: flex; flex-direction: column; gap: var(--vio-detail-info-gap, 20px); min-width: 0; }
    .brand {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 500;
    }
    .name {
      font-family: var(--vio-font-serif, Georgia, serif);
      font-size: var(--vio-detail-title-size, clamp(28px, 4vw, 40px));
      font-weight: var(--vio-detail-title-weight, 400);
      line-height: 1.15;
      margin: 0;
      letter-spacing: -0.01em;
    }
    /* The brand's promises: one row, an icon over a title and a line of text,
       centred like a shop's own trust strip. */
    .highlights {
      list-style: none;
      /* --vio-detail-highlights-display: none hides the strip (theme detailHighlightsDisplay). */
      margin: 0;
      padding: var(--vio-detail-highlights-padding, 16px 0 2px);
      display: var(--vio-detail-highlights-display, grid);
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      gap: 10px;
      border-top: 1px solid var(--vio-color-border, #e5e5e5);
    }
    /* Like a shop's trust strip: a thin icon, the promise in regular weight,
       a smaller line under it — nothing bold. */
    .hl { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 2px; min-width: 0; }
    .hl-icon {
      width: var(--vio-detail-highlight-icon-size, 22px);
      height: var(--vio-detail-highlight-icon-size, 22px);
      margin-bottom: 8px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.2;
      stroke-linecap: round;
      stroke-linejoin: round;
      object-fit: contain;
    }
    .hl-title { font-size: 12px; font-weight: 400; line-height: 1.3; letter-spacing: 0.01em; color: var(--vio-color-text, #0a0a0a); }
    .hl-text { font-size: 10.5px; line-height: 1.35; letter-spacing: 0.01em; color: var(--vio-color-text-secondary, #666); }
    /* «Frakt & retur»: same fold as «Beskrivelse», with a small list of rates.
       --vio-detail-shipping-returns-display: none hides it (theme detailShippingReturnsDisplay). */
    .shipping-returns { display: var(--vio-detail-shipping-returns-display, block); }
    .description.shipping-returns-body { white-space: normal; }
    .shipping-returns-body p { margin: 0 0 10px; }
    .sr-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 600;
      margin: 4px 0 6px;
    }
    .sr-rates { list-style: none; margin: 0 0 10px; padding: 0; }
    /* One row per carrier: «Helthjem» over «Til postkasse/dørmatte», price right. */
    .sr-rates li {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--vio-color-border, #eee);
    }
    .sr-rates li:last-child { border-bottom: none; }
    .sr-rate { flex: 1; display: flex; flex-direction: column; min-width: 0; line-height: 1.35; }
    .line-icon { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
    .sr-icon { flex: 0 0 auto; width: 20px; height: 20px; color: var(--vio-color-text, #0a0a0a); }
    .sr-line { display: flex; align-items: center; gap: 12px; }
    /* A carrier's logo in a fixed box, so rows line up whatever its shape. */
    .sr-logo { flex: 0 0 auto; width: var(--vio-detail-carrier-logo-width, 56px); height: 24px; object-fit: contain; object-position: left center; }
    .sr-carrier { font-weight: 600; color: var(--vio-color-text, #0a0a0a); }
    .sr-method { font-size: 13px; }
    .sr-time { margin: 0 0 14px; }
    .sr-price { font-weight: 600; color: var(--vio-color-text, #0a0a0a); white-space: nowrap; }
    .sr-links { display: flex; gap: 16px; padding-left: 32px; }
    .sr-links a { color: inherit; }
    /* Name and price read as one block (stock on the name's line, right);
       the sizes come after a wider gap, then shipping/returns by the buttons. */
    .headline { display: flex; flex-direction: column; gap: var(--vio-detail-headline-gap, 8px); }
    .title-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
    }
    .title-row .name { min-width: 0; }
    .title-row .stock { flex: 0 0 auto; white-space: nowrap; }
    .price-row {
      display: flex;
      align-items: baseline;
      gap: 16px;
    }
    /* The sizes follow the price closely: they are the next thing to do. */
    .headline + .purchase { margin-top: calc(var(--vio-detail-sizes-gap, 2px) - var(--vio-detail-info-gap, 20px)); }
    /* A layout with the sizes apart from the buy zone (0.34): they follow the
       price closely instead, and the buy zone keeps the normal gap. */
    .headline + .buy-options.options-apart { margin-top: calc(var(--vio-detail-sizes-gap, 2px) - var(--vio-detail-info-gap, 20px)); }
    .headline + .purchase.options-apart { margin-top: 0; }
    .price {
      font-size: var(--vio-detail-price-size, 24px);
      font-weight: var(--vio-detail-price-weight, 700);
    }
    .compare-at {
      font-size: 16px;
      color: var(--vio-color-text-tertiary, #999);
      text-decoration: line-through;
    }
    .delivery-note {
      margin-top: calc(var(--vio-detail-info-gap, 20px) * -0.6);
      font-size: 13px;
      color: var(--vio-color-text-secondary, #666);
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
    /* The prompt sits on the label's own line: tapping a buy button before
       choosing must not push the pills down under the shopper's finger. */
    .option-label {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      min-height: 1.4em;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 500;
    }
    /* Sizes: compact, still comfortable to tap. wrap → several lines;
       nowrap → one line that scrolls sideways. */
    .option-values {
      display: flex;
      flex-wrap: var(--vio-detail-option-wrap, wrap);
      gap: var(--vio-detail-option-gap, 6px);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .option-values::-webkit-scrollbar { display: none; }
    .option-pill {
      flex: 0 0 auto;
      box-sizing: border-box;
      min-height: var(--vio-detail-option-height, 36px);
      min-width: var(--vio-detail-option-height, 36px);
      padding: 0 var(--vio-detail-option-padding-x, 12px);
      border-radius: var(--vio-detail-option-radius, 0);
      background: #fff;
      border: 1px solid var(--vio-color-border, #e5e5e5);
      cursor: pointer;
      font-family: inherit;
      font-size: var(--vio-detail-option-font-size, 13px);
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
    /* The value chosen, beside the option's name: «Størrelse: M». */
    .option-chosen { color: var(--vio-color-text, #0a0a0a); font-weight: 700; }
    /* A buy button was tapped before choosing: say what is missing. */
    .option-prompt {
      text-transform: none;
      letter-spacing: normal;
      font-size: 13px;
      font-weight: 600;
      color: var(--vio-color-accent, #c14a3b);
    }
    .option-group.needs-choice .option-pill:not(.unavailable) {
      border-color: var(--vio-color-accent, #c14a3b);
    }

    /* The buy zone: Vipps first, then quantity + add to cart, then the other
       ways to pay. --vio-detail-buy-position: sticky pins it to the bottom of
       the panel while the shopper scrolls (mobile, mostly). */
    .buy {
      display: flex;
      flex-direction: column;
      gap: var(--vio-detail-buy-gap, 10px);
      position: var(--vio-detail-buy-position, static);
      bottom: 0;
      z-index: 2;
      background: var(--vio-detail-buy-bg, var(--vio-color-surface, #fff));
      padding: var(--vio-detail-buy-padding, 0);
      box-shadow: var(--vio-detail-buy-shadow, none);
    }
    .buy > * { margin-top: 0 !important; }
    /* The buy zone and the description, apart from the name, price and stock:
       a pinned buy zone can slide up over what is in this box (the
       description) but never above it — never over the name, the price or
       the stock line (Mote & Livsstil, 2026-10-28). */
    .purchase { display: flex; flex-direction: column; gap: var(--vio-detail-info-gap, 20px); }
    /* The pickers live in the buy zone: when it is pinned to the bottom of the
       panel (desktop, or a host's sticky), it can never cover them — they
       travel with the buttons they gate (Mote & Livsstil, 2026-10-28). */
    .buy-options {
      display: flex;
      flex-direction: column;
      gap: var(--vio-detail-info-gap, 20px);
      padding-bottom: 4px;
    }
    /* Where the express buttons go while the brand's methods load: neutral,
       the height of one button, no method named. */
    .buy-pending {
      height: var(--vio-detail-button-height, 52px);
      border-radius: var(--vio-detail-button-radius, 0);
      background: linear-gradient(
        100deg,
        var(--vio-color-surface-muted, #f1f1f1) 30%,
        rgba(255, 255, 255, 0.65) 50%,
        var(--vio-color-surface-muted, #f1f1f1) 70%
      );
      background-size: 200% 100%;
      animation: vio-skeleton-shimmer 1.4s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .buy-pending { animation: none; background: var(--vio-color-surface-muted, #f1f1f1); }
    }
    /* Under the buttons: who the shopper is buying from. */
    .seller-note {
      margin: 2px 0 0;
      font-size: var(--vio-detail-seller-note-size, 12px);
      line-height: 1.4;
      color: var(--vio-color-text-secondary, #666);
      text-align: var(--vio-detail-seller-note-align, center);
    }
    .seller-note strong { font-weight: 600; color: var(--vio-color-text, #0a0a0a); }
    .seller-links { display: block; margin-top: 2px; }
    .seller-links a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
    .seller-links a + a::before { content: '·'; display: inline-block; margin: 0 6px; text-decoration: none; }

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
      height: var(--vio-detail-button-height, 52px);
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
      min-height: var(--vio-detail-button-height, 52px);
      border-radius: var(--vio-detail-button-radius, 0);
      padding: 0 24px;
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
    /* Generic buy-now for the embedded checkouts, which have no branded
       express button of their own. */
    .buy-now {
      width: 100%;
      margin-top: 10px;
      padding: 14px 24px;
      background: var(--vio-color-text, #0a0a0a);
      color: var(--vio-color-text-on-primary, #fff);
      border: none;
      border-radius: var(--vio-radius-md, 4px);
      font-family: var(--vio-font-sans, inherit);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      font-weight: 700;
      cursor: pointer;
    }
    .buy-now:hover:not(:disabled) { opacity: 0.9; }
    .buy-now:disabled { opacity: 0.5; cursor: not-allowed; }
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
    /* Under the Express button: what happens in the app. */
    .vipps-note {
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
      color: var(--vio-color-text-secondary, #666);
      text-align: center;
    }
    /* Vipps' own button (web component) — same slot, their drawing. */
    .buy-vipps-official { display: block; width: 100%; margin-top: 10px; cursor: pointer; }
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
    /* The description folds: a tap opens it, so it does not take the page. */
    .description-block { border-top: 1px solid var(--vio-color-border, #e5e5e5); }
    .description-block > summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 0;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 600;
    }
    .description-block > summary::-webkit-details-marker { display: none; }
    .description-block > summary::after {
      content: '';
      width: 8px;
      height: 8px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg) translateY(-2px);
      transition: transform 0.15s ease;
    }
    .description-block[open] > summary::after { transform: rotate(-135deg) translateY(-2px); }
    /* «Beskrivelse» with a preview: the same heading as the folds, then the
       first lines fading out, then «Les mer». */
    .desc-head {
      all: unset;
      box-sizing: border-box;
      width: 100%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 0 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--vio-tracking-label, 0.1em);
      color: var(--vio-color-text-secondary, #666);
      font-weight: 600;
      font-family: inherit;
    }
    .description-preview.clipped .desc-head::after {
      content: '';
      width: 8px;
      height: 8px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg) translateY(-2px);
      transition: transform 0.15s ease;
    }
    .description-preview.open .desc-head::after { transform: rotate(-135deg) translateY(-2px); }
    .description-preview .description { padding-bottom: 6px; }
    .description-preview.folded .desc-head, .description-preview.open:not(.clipped) .desc-head { padding-bottom: 14px; }
    .description-preview.folded.open .desc-head { padding-bottom: 6px; }
    .description-preview.folded .description { padding-bottom: 14px; }
    .description-preview:not(.clipped) .description { padding-bottom: 14px; }
    .description.collapsed {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: var(--vio-detail-description-preview-lines, 3);
      line-clamp: var(--vio-detail-description-preview-lines, 3);
      overflow: hidden;
      cursor: pointer;
      -webkit-mask-image: linear-gradient(to bottom, #000 45%, transparent);
      mask-image: linear-gradient(to bottom, #000 45%, transparent);
    }
    .desc-more {
      all: unset;
      cursor: pointer;
      display: inline-block;
      margin: 0 0 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--vio-color-text, #0a0a0a);
      text-decoration: underline;
      text-underline-offset: 3px;
      font-family: inherit;
    }
    .description {
      font-size: 14px;
      line-height: 1.6;
      color: var(--vio-color-text-secondary, #444);
      padding-bottom: 14px;
      white-space: pre-line;
    }
    /* Same order on every screen: buy, then the description at the very
       bottom (folded). Hosts that want the buy zone pinned can still set
       --vio-detail-buy-position: sticky. */
    @media (min-width: 601px) {
      .buy {
        position: var(--vio-detail-buy-position, static);
        padding: var(--vio-detail-buy-padding, 12px 0 16px);
      }
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
      border-radius: var(--vio-radius-lg, 8px);
    }
    .sk-image { width: 100%; aspect-ratio: 1; border-radius: var(--vio-radius-lg, 12px); }
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
    /* «Lagt i handlekurven»: above the page, below where a thumb reaches. */
    .added-toast {
      position: fixed;
      left: 50%;
      bottom: max(16px, env(safe-area-inset-bottom));
      transform: translateX(-50%);
      z-index: 1102;
      width: min(420px, calc(100vw - 32px));
      box-sizing: border-box;
      padding: 14px 16px;
      background: var(--vio-color-surface, #fff);
      color: var(--vio-color-text, #0a0a0a);
      border: 1px solid var(--vio-color-border, #e5e5e5);
      border-radius: var(--vio-radius-lg, 8px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .added-toast-text { font-size: 14px; font-weight: 600; }
    .added-toast-text::before { content: '✓ '; color: #2e7d32; }
    .added-toast-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .added-toast-actions button {
      min-height: 44px;
      padding: 0 12px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border-radius: var(--vio-detail-button-radius, 0);
    }
    .added-toast-checkout {
      background: var(--vio-color-text, #0a0a0a);
      color: var(--vio-color-text-on-primary, #fff);
      border: 1px solid var(--vio-color-text, #0a0a0a);
    }
    .added-toast-continue {
      background: transparent;
      color: var(--vio-color-text, #0a0a0a);
      border: 1px solid var(--vio-color-border, #e5e5e5);
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
    // The page's layout changed: open (and later) details render with it.
    this.unsubscribeLayout?.()
    this.unsubscribeLayout = onGlobalDetailLayoutChange(() => this.requestUpdate())
    this.slotRegistration.connect(this.slotAttributes())
    void this.loadVippsButton()
    document.addEventListener('vio:product-click', this.boundProductClick)
  }

  override disconnectedCallback(): void {
    if (this.addedToastTimer) clearTimeout(this.addedToastTimer)
    this.addedToastTimer = null
    document.removeEventListener('vio:product-click', this.boundProductClick)
    this.slotRegistration.clear()
    this.bottomSheet.disconnect()
    this.unsubscribeLayout?.()
    this.unsubscribeLayout = null
    super.disconnectedCallback()
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('open')) {
      this.dialogFocus.update(this.open)
      this.bottomSheet.update(this.open)
    }
    if (changed.has('product') || changed.has('open')) {
      this.measureThumbs()
      this.measureDescription()
    }
    // The sheet shows an amount fixed when it is prepared: another quantity or
    // variant (another price) prepares it again, so it shows what is bought.
    if ((changed.has('quantity') || changed.has('selectedOptions')) && this.product && this.applePayAskedFor !== null) {
      if (this.unitPrice * this.quantity !== this.applePayAskedFor) this.prepareApplePaySheet()
    }
    if (changed.has('activeImageIndex')) {
      this.revealActiveThumb()
      this.revealActiveSlide()
    }
    // A variant with its own photos starts the carousel over.
    if (changed.has('selectedOptions') && this.galleryMode === 'carousel') {
      if (this.activeImageIndex !== 0) this.activeImageIndex = 0
      else this.revealActiveSlide()
    }
    this.measureLogo()
    this.announceLayout()
    // The React wrappers set properties after mount.
    if (changed.has('vioSlot') || changed.has('vioSlotName') || changed.has('vioScope') || changed.has('vioScopeName') || changed.has('vioCampaign')) {
      this.slotRegistration.sync(this.slotAttributes())
    }
  }

  override willUpdate(changed: Map<string, unknown>): void {
    // Every update: the element's own layout or the page's may have changed.
    this.layoutNow = resolveDetailLayout(this.layout)
    if (changed.has('gallery') || (changed.has('open') && this.open)) this.galleryMode = this.resolveGalleryMode()
    if (changed.has('descriptionMode') || (changed.has('open') && this.open)) {
      const value = this.themeChoice(this.descriptionMode, '--vio-detail-description-mode')
      this.resolvedDescriptionMode = value === 'folded' || value === 'open' ? value : 'preview'
    }
  }

  /**
   * `vio:detail-layout-applied` (bubbles, composed), with the applied layout,
   * each time a product renders with a layout it has not been shown with yet:
   * every open of a product, and every change of layout while it is open.
   */
  private announceLayout(): void {
    const product = this.product
    if (!product || this.fetchError) return
    const signature = layoutSignature(this.layoutNow)
    if (this.appliedFor && this.appliedFor.product === product && this.appliedFor.signature === signature) return
    this.appliedFor = { product, signature }
    this.dispatchEvent(
      new CustomEvent('vio:detail-layout-applied', {
        bubbles: true,
        composed: true,
        detail: { ...copyAppliedLayout(this.layoutNow), productId: product.id, sponsorId: this.sponsorId },
      }),
    )
  }

  /** An option as the element says it, else as the theme's custom property says it (lower case, unquoted). */
  private themeChoice(own: string, cssVar: string): string {
    const fromTheme = typeof getComputedStyle === 'function' ? getComputedStyle(this).getPropertyValue(cssVar) : ''
    return (own || fromTheme).trim().replace(/^["']|["']$/g, '').toLowerCase()
  }

  /** The attribute wins; else the theme's `--vio-detail-gallery`; else thumbnails. */
  private resolveGalleryMode(): 'thumbs' | 'carousel' {
    return this.themeChoice(this.gallery, '--vio-detail-gallery') === 'carousel' ? 'carousel' : 'thumbs'
  }

  private carouselTrack(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.carousel-track')
  }

  /** The photo in view is the active one (dots, Apple Pay sheet, events). */
  private onCarouselScroll = (): void => {
    const track = this.carouselTrack()
    const step = this.carouselStep(track)
    if (!track || !step) return
    const last = track.children.length - 1
    const idx = Math.min(last, Math.max(0, Math.round(track.scrollLeft / step)))
    if (idx !== this.activeImageIndex) this.activeImageIndex = idx
  }

  /** One photo's width plus the gap (with a peek a photo is narrower than the row). */
  private carouselStep(track: HTMLElement | null): number {
    const slide = track?.firstElementChild as HTMLElement | null
    if (!track || !slide || slide.offsetWidth === 0) return 0
    return slide.offsetWidth + (parseFloat(getComputedStyle(track).columnGap) || 0)
  }

  /** Bring the active photo into view — only when it is not already the one a swipe is on. */
  private revealActiveSlide(): void {
    const track = this.carouselTrack()
    const step = this.carouselStep(track)
    if (!track || !step) return
    const target = Math.min(this.activeImageIndex * step, track.scrollWidth - track.clientWidth)
    if (Math.abs(track.scrollLeft - target) > step / 2) track.scrollTo({ left: target })
  }

  private stepCarousel(direction: 1 | -1): void {
    const last = this.allImages().length - 1
    this.activeImageIndex = Math.min(last, Math.max(0, this.activeImageIndex + direction))
  }

  private thumbRow(): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>('.gallery-thumbs')
  }

  /** Arrows only when the row overflows; each one off at its own end. */
  private measureThumbs(): void {
    const row = this.thumbRow()
    if (!row) return
    const overflow = row.scrollWidth > row.clientWidth + 1
    if (overflow !== this.thumbsOverflow) this.thumbsOverflow = overflow
    this.onThumbsScroll()
  }

  private onThumbsScroll = (): void => {
    const row = this.thumbRow()
    if (!row) return
    const atStart = row.scrollLeft <= 1
    const atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1
    if (atStart !== this.thumbsAtStart) this.thumbsAtStart = atStart
    if (atEnd !== this.thumbsAtEnd) this.thumbsAtEnd = atEnd
  }

  /** One arrow press moves most of a visible row. */
  private scrollThumbs(direction: 1 | -1): void {
    const row = this.thumbRow()
    if (row) row.scrollBy({ left: direction * row.clientWidth * 0.8 })
  }

  /** The selected thumbnail is always visible: the row scrolls to it, the page never does. */
  private revealActiveThumb(): void {
    const row = this.thumbRow()
    const thumb = row?.querySelectorAll<HTMLElement>('.gallery-thumb')[this.activeImageIndex]
    if (!row || !thumb) return
    const left = thumb.offsetLeft - row.offsetLeft
    if (left < row.scrollLeft || left + thumb.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollTo({ left: Math.max(0, left - (row.clientWidth - thumb.offsetWidth) / 2) })
    }
  }

  show(): void {
    this.open = true
    this.hideAddedToast()
  }
  close(): void {
    this.open = false
    // Reset state after the slide-out animation completes.
    setTimeout(() => {
      if (!this.open) {
        // What the opening card said belongs to that product, not the next.
        this.eventSlot = ''
        this.eventContentId = ''
        this.eventContentTitle = ''
        this.eventCampaignId = undefined
        this.eventProductId = ''
        this.product = null
        this.sellerName = null
        this.sellerSettled = false
        this.shippingFrom = null
        this.selectedOptions = {}
        this.selectionPrompt = ''
        this.quantity = 1
        this.activeImageIndex = 0
        this.descriptionOpen = false
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
    // Race guard: two quick taps on different cards → only the LATEST
    // request may write state (else the slow response paints product A
    // under product B's id).
    const seq = ++this.fetchSeq
    this.isLoading = true
    this.fetchError = ''
    this.sellerName = null
    this.sellerSettled = false
    this.shippingFrom = null

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
        const commerce = Vio.commerceFor(this.sponsorId, { campaignId: this.commerceCampaigns() })
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

    if (seq !== this.fetchSeq) return // superseded by a newer open

    if (lastError) {
      this.fetchError = lastError instanceof Error ? lastError.message : String(lastError)
      console.warn('[VioDetail] fetch failed after retries →', this.fetchError)
      this.isLoading = false
      return
    }

    this.optMapCache = new WeakMap()
    this.product = products?.[0] ?? null
    if (this.product) void this.loadSeller(productIdNum, seq)
    if (this.product) void this.loadShippingFrom(productIdNum, seq)
    if (this.product) {
      // Analytics (auto): the detail opened with a concrete product.
      try {
        const price = Number(
          this.product.price?.amount_incl_taxes ?? this.product.price?.amount,
        )
        // The layout it is shown with (0.34) — only a non-default one says so.
        const shown = layoutOriginOf(resolveDetailLayout(this.layout))
        Vio.analytics.track('view_item', {
          context: {
            sponsorId: this.sponsorId > 0 ? Number(this.sponsorId) : undefined,
            ...this.attribution(),
            ...(shown.layoutId
              ? {
                  layoutId: shown.layoutId,
                  layoutRevision: shown.layoutRevision ?? '',
                  experimentId: shown.experimentId,
                  variantId: shown.variantId,
                }
              : {}),
          },
          commerce: {
            items: [
              {
                productId: this.product.id,
                name: this.product.title,
                price: Number.isFinite(price) ? price : undefined,
              },
            ],
            value: Number.isFinite(price) ? price : undefined,
            currency: this.product.price?.currency_code,
          },
        })
      } catch {
        /* never break rendering */
      }
    }
    if (!this.product) {
      // Empty response without an exception — never leave a blank open modal.
      this.fetchError = 'Fant ikke produktet.'
    }

    if (this.product) {
      // Nothing is chosen for the shopper: an option with a single value is
      // the only one preselected (there is nothing to choose). A size picked
      // for them was bought without being looked at — the first size, the
      // wrong one (Mote & Livsstil, 2026-10-28). The buy buttons ask for the
      // missing choice instead (requireSelection).
      const initial: SelectedOptions = {}
      for (const opt of this.product.options ?? []) {
        const values = normalizeValues(opt.values)
        if (values.length === 1) initial[opt.name] = values[0]!
      }
      this.selectedOptions = initial
      this.selectionPrompt = ''
      // Pre-prepare Apple Pay so its sheet can open synchronously on tap
      // (Apple blocks it otherwise). The button only shows if Apple Pay actually
      // works (real Stripe account + domain registered for Apple Pay).
      this.prepareApplePaySheet()
      void this.loadAvailablePaymentMethods()
    }
    this.isLoading = false
  }

  /** Which buy buttons to render — backend-configured per sponsor. */
  private async loadAvailablePaymentMethods(): Promise<void> {
    const spId =
      this.sponsorId ||
      (typeof Vio.campaignForSlot === 'function'
        ? Number(Vio.campaignForSlot(this.activeSlot || null, { campaignId: this.activeCampaignHint })?.primarySponsor?.id)
        : 0) ||
      (globalThis as { __VIO_SPONSOR_ID__?: number }).__VIO_SPONSOR_ID__
    if (!spId) return
    if (spId !== this.methodsSponsorId) {
      this.availableMethods = null
      this.vippsExpress = false
    }
    this.methodsSponsorId = spId
    this.methodsLoading = true
    try {
      const methods = (await Vio.checkout.getAvailablePaymentMethods(spId)) as
        | Array<{ name: string }>
        | unknown
      if (Array.isArray(methods)) {
        this.availableMethods = methods.map((m) => m.name)
        // Read from the list itself (getVippsExpressEnabled answers «yes»
        // when it cannot tell; the line must not).
        const vipps = (methods as Array<{ name?: string; config?: Array<{ name?: string; value?: string }> }>).find(
          (m) => String(m?.name ?? '').toLowerCase() === 'vipps',
        )
        this.vippsExpress = !!vipps && vipps.config?.find((c) => c?.name === 'express')?.value !== 'false'
      } else {
        this.availableMethods = null
        this.vippsExpress = false
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioProductDetail] Failed to load payment methods:', err)
      }
      // Unknown (not "none") — render everything rather than nothing.
      this.availableMethods = null
      this.vippsExpress = false
    } finally {
      this.methodsLoading = false
    }
  }

  /** The methods are still on their way: a placeholder stands where the buttons go. */
  private get methodsPending(): boolean {
    return this.methodsLoading && this.availableMethods === null
  }

  /** Backend names arrive as e.g. "Apple Pay" — compare letters only. */
  private methodEnabled(...names: string[]): boolean {
    if (this.methodsPending) return false
    return isMethodEnabled(this.availableMethods, ...names)
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
    // Memoised per variant object — this runs per variant × option × render
    // (a 20-variant product recomputed it ~700× per render otherwise).
    if (v && typeof v === 'object') {
      const cached = this.optMapCache.get(v)
      if (cached) return cached
    }
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
          // Skip values that exist in ANOTHER option too — a title scan can't
          // tell which option "30" belongs to when Midje and Lengde both have
          // it, and guessing corrupts the whole map (wrong-variant purchases).
          // Ambiguous values are resolved by the positional fallback below.
          const rawValues = normalizeValues(opt.values).filter(
            (val) =>
              !productOptions.some(
                (other) =>
                  other !== opt &&
                  normalizeValues(other.values).some(
                    (ov) => ov.trim().toLowerCase() === val.trim().toLowerCase(),
                  ),
              ),
          )
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

    const result = { map, titleParts }
    if (v && typeof v === 'object') this.optMapCache.set(v, result)
    return result
  }

  /** Option values a variant represents (map values ∪ title parts). */
  private variantOptionValues(v: ProductVariant): string[] {
    const { map, titleParts } = this.getVariantOptionMap(v, this.product?.options)
    const set = new Set(titleParts.map((s) => s.toLowerCase()))
    for (const val of Object.values(map)) set.add(val)
    return Array.from(set)
  }

  /** Does a variant part represent this option value? Exact match, plus a
   * whole-token match ONLY for numeric values ("30" matches "30 ml") — word
   * subsets of text values are not matches ("Large" must NOT match
   * "Extra Large"). */
  private partMatchesValue(part: string, value: string): boolean {
    if (!part || !value) return false
    const p = String(part).trim().toLowerCase()
    const v = String(value).trim().toLowerCase()
    if (p === v) return true
    if (!/^[\d.,]+$/.test(v)) return false
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
   * availability flags win; a numeric field wins next; `null` = the feed does
   * not report stock for this variant (callers fall back to product stock —
   * never assume "in stock" from absent data). */
  private getVariantQty(v: ProductVariant | any): number | null {
    if (!v) return 0
    if (v.available === false || v.in_stock === false || v.is_available === false) return 0
    if (v.available === true || v.in_stock === true || v.is_available === true) return 999

    const rawQty =
      v.quantity ?? v.inventory_quantity ?? v.stock ?? v.available_quantity ?? v.stock_quantity
    if (rawQty !== null && rawQty !== undefined && rawQty !== '') {
      const parsed = Number(rawQty)
      if (!Number.isNaN(parsed)) return parsed
    }

    return null
  }

  /** Variant stock with the product-level fallback applied (0 = not sellable). */
  private variantSellableQty(v: ProductVariant | any): number {
    const q = this.getVariantQty(v)
    if (q !== null) return q
    return this.product?.quantity ?? 0
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
      (v) => this.variantMatchesSelection(v, sel) && this.variantSellableQty(v) > 0,
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

      if (this.variantSellableQty(v) > 0) score += 0.5

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
      if (this.variantSellableQty(v) <= 0) return false
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

  /**
   * There is something to pay for — whether the express buttons show. With
   * every option chosen, the chosen variant's price; before that, the
   * product's or any variant's: the first variant (what `unitPrice` falls
   * back to) at 0 must not hide Vipps for a size that costs 699.
   */
  private get hasPrice(): boolean {
    if (!this.missingOption()) return this.unitPrice > 0
    const priceOf = (p: { amount_incl_taxes?: number | null; amount?: number } | null | undefined) =>
      Number(p?.amount_incl_taxes ?? p?.amount ?? 0)
    return (
      priceOf(this.product?.price) > 0 ||
      (this.product?.variants ?? []).some((v) => priceOf(v.price) > 0)
    )
  }

  private get compareAt(): number | null {
    const v = this.selectedVariant()
    const price = v?.price ?? this.product?.price
    return price?.compare_at_incl_taxes ?? price?.compare_at ?? null
  }

  /** The options the shopper has to choose (those with values), in order. */
  private choosableOptions(): ProductOption[] {
    return (this.product?.options ?? []).filter((o) => normalizeValues(o.values).length > 0)
  }

  /** The first option still without a value, or null when every one is chosen. */
  private missingOption(): ProductOption | null {
    return this.choosableOptions().find((o) => !String(this.selectedOptions[o.name] ?? '').trim()) ?? null
  }

  /**
   * Units that can be sold. With every option chosen, the chosen variant's;
   * before that, the most any variant still matching the partial choice has
   * — so the stepper and «Utsolgt» do not speak for a variant (the first
   * one) the shopper never picked.
   */
  private get availableQuantity(): number {
    if (this.missingOption() && Array.isArray(this.product?.variants) && this.product!.variants.length > 0) {
      const sel = this.selectedOptions
      const qtys = this.product!.variants
        .filter((v) => this.variantMatchesSelection(v, sel))
        .map((v) => this.variantSellableQty(v))
      return qtys.length > 0 ? Math.max(0, ...qtys) : 0
    }
    const v = this.selectedVariant()
    if (v) return this.variantSellableQty(v)
    return this.product?.quantity ?? 0
  }

  /**
   * «Få igjen — N stk» only for the variant actually chosen: before a size is
   * picked the count belonged to the first variant, which said «Få igjen» of
   * a product with plenty of other sizes.
   */
  private stockLabel(): { text: string; cls: 'in-stock' | 'low-stock' | 'out-of-stock' } {
    const qty = this.availableQuantity
    if (qty <= 0) return { text: 'Utsolgt', cls: 'out-of-stock' }
    if (qty <= 3 && !this.missingOption()) return { text: `Få igjen — ${qty} stk`, cls: 'low-stock' }
    return { text: 'På lager', cls: 'in-stock' }
  }

  /** «Velg størrelse» for a size, «Velg farge» for a colour… */
  private promptFor(option: ProductOption): string {
    const name = String(option.name ?? '').trim()
    if (!name || /^(st(ø|o)rrelse|str\.?|size)$/i.test(name)) return 'Velg størrelse'
    return `Velg ${name.toLowerCase()}`
  }

  /**
   * Every buy button goes through here first: with an option not chosen yet,
   * nothing is added or paid — the picker says what is missing and comes
   * into view (it sits right above the buttons, inside the buy zone).
   */
  private requireSelection(): boolean {
    const missing = this.missingOption()
    if (!missing) {
      this.selectionPrompt = ''
      return true
    }
    this.selectionPrompt = missing.name
    void this.updateComplete.then(() => {
      const group = this.renderRoot.querySelector<HTMLElement>('.option-group.needs-choice')
      // In the buy zone the picker is right above the buttons; apart from it
      // (a layout, 0.34) it may be far away — brought to the middle then.
      const apart = !!group?.closest('.options-apart')
      group?.scrollIntoView?.({ behavior: 'smooth', block: apart ? 'center' : 'nearest' })
    })
    return false
  }

  /** Pick an option value. If the exact combination doesn't exist, jump to an
   * in-stock variant that carries the value and adopt its full option map
   * (keeps the selection always resolvable to a real variant). */
  private selectOption(optionName: string, value: string): void {
    this.applyOption(optionName, value)
    if (this.selectionPrompt && !this.missingOption()) this.selectionPrompt = ''
    else if (this.selectionPrompt) this.selectionPrompt = this.missingOption()?.name ?? ''
    // The chosen variant may have fewer units than the stepper shows.
    const max = this.availableQuantity
    if (max > 0 && this.quantity > max) this.quantity = max
  }

  private applyOption(optionName: string, value: string): void {
    const newSelection = { ...this.selectedOptions, [optionName]: value }
    const exactInStock = this.product?.variants?.find(
      (v) => this.variantMatchesSelection(v, newSelection) && this.variantSellableQty(v) > 0,
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
      if (this.variantSellableQty(v) <= 0) return false
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
    // The brand's display name by the one rule (config and campaigns[] sponsors).
    const sponsorName = resolveSponsorIdentity(this.sponsorId)?.name || undefined
    // Where these units come from: the campaign the place showed, the place,
    // this element and the article — the purchase is split per campaign from
    // it, and Commerce writes it on the order (ADR-0035).
    const { campaignId, slot, contentId, componentTemplateId, contentUrl, contentTitle } = this.attribution()
    // …and the layout the shopper saw (0.34), as shown now: a later change of
    // the page's layout never rewrites these units.
    const layout = layoutOriginOf(this.layoutNow)
    Vio.cart.addProduct({
      product: this.product,
      sponsorId: this.sponsorId,
      sponsorName,
      quantity: this.quantity,
      variantId: variant?.id,
      origin: { campaignId, slot, contentId, componentKind: componentTemplateId, contentUrl, contentTitle, ...layout },
    })
    return variant?.id
  }

  private async addToCart(): Promise<void> {
    if (!this.product || this.availableQuantity <= 0 || this.adding) return
    if (!this.requireSelection()) return
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
            ...this.attribution(),
            // The detail layout of the add (0.34) — `variantId` above is the product's.
            ...(this.layoutNow.source !== 'default' ? { layout: layoutOriginOf(this.layoutNow) } : {}),
          },
        }),
      )
      this.showAddedToast()
      this.close()
    } finally {
      this.adding = false
    }
  }

  /** The toast after an add; it goes by itself after a while. */
  private showAddedToast(): void {
    if (this.noAddedToast) return
    this.addedToast = {
      sponsorId: this.sponsorId,
      detail: { sponsorId: this.sponsorId, express: false, ...this.attribution(), ...sponsorDetail(this.sponsorId) },
    }
    if (this.addedToastTimer) clearTimeout(this.addedToastTimer)
    this.addedToastTimer = setTimeout(() => this.hideAddedToast(), ADDED_TOAST_MS)
  }

  private hideAddedToast(): void {
    if (this.addedToastTimer) clearTimeout(this.addedToastTimer)
    this.addedToastTimer = null
    this.addedToast = null
  }

  /** «Til kassen»: the checkout of the brand just added to — the host opens it on `vio:checkout-open`, as from the cart. */
  private toastToCheckout(): void {
    const toast = this.addedToast
    this.hideAddedToast()
    if (!toast) return
    const cart = Vio.cart.getCart(toast.sponsorId)
    const total = (cart?.items ?? []).reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)
    // Nothing to pay for (removed meanwhile, or 0 kr): no checkout.
    if (!cart || cart.items.length === 0 || !(total > 0)) return
    this.dispatchEvent(new CustomEvent('vio:checkout-open', { bubbles: true, composed: true, detail: toast.detail }))
  }

  private renderAddedToast() {
    if (!this.addedToast) return nothing
    return html`
      <div class="added-toast" part="added-toast" role="status" aria-live="polite">
        <div class="added-toast-text">Lagt i handlekurven</div>
        <div class="added-toast-actions">
          <button class="added-toast-checkout" part="added-toast-checkout" @click=${this.toastToCheckout}>Til kassen</button>
          <button class="added-toast-continue" part="added-toast-continue" @click=${this.hideAddedToast}>Fortsett å handle</button>
        </div>
      </div>
    `
  }

  /**
   * Express buy: add to cart, then open the checkout overlay with Klarna
   * preselected. The host app handles `vio:checkout-open` (same event the cart
   * uses) — the `paymentMethod` hint tells it to preselect Klarna so its widget
   * loads immediately. Reuses the working Klarna Payments flow (no express SDK).
   */
  private async buyWithKlarna(): Promise<void> {
    if (!this.product || this.availableQuantity <= 0 || this.adding) return
    if (!this.requireSelection()) return
    this.adding = true
    try {
      this.addCurrentToCart()
      this.close()
      this.dispatchEvent(
        new CustomEvent('vio:checkout-open', {
          bubbles: true,
          composed: true,
          detail: { sponsorId: this.sponsorId, paymentMethod: 'klarna', express: true, ...this.attribution(), ...sponsorDetail(this.sponsorId) },
        }),
      )
    } finally {
      this.adding = false
    }
  }

  /** Buy with Vipps — opens the checkout with Vipps preselected. */
  /**
   * Buy now with an embedded checkout (Kustom, Qliro, Walley).
   *
   * Those three have no express path of their own, so the product page showed
   * a "Kjøp nå" for Apple Pay, Stripe, Klarna and Vipps and nothing at all for
   * them — the same structural gap the cart footer had. Opens the checkout
   * without preselecting: with a single method the checkout selects it itself,
   * with several the shopper picks.
   *
   * Like every other "Kjøp nå" here, it adds to the cart first — so a cart
   * that already had items buys those too. Isolating a single-product purchase
   * needs a checkout that is not bound to the sponsor's cart, which is a
   * separate piece of work and deliberately not done here.
   */
  private buyNow(): void {
    if (!this.product || this.availableQuantity <= 0 || this.adding) return
    if (!this.requireSelection()) return
    this.addCurrentToCart()
    this.close()
    this.dispatchEvent(
      new CustomEvent('vio:checkout-open', {
        bubbles: true,
        composed: true,
        detail: { sponsorId: this.sponsorId, express: false, ...this.attribution(), ...sponsorDetail(this.sponsorId) },
      }),
    )
  }

  /**
   * Buy with Vipps — Express: the app opens with address and delivery
   * already there, nothing to fill in here (Vipps' own recommendation,
   * 2026-09-29). When this cart cannot have Express, or Vipps cannot be
   * started, the checkout opens with Vipps preselected, as before.
   */
  /** Vipps' own button when its script answers; our orange one otherwise. */
  private async loadVippsButton(): Promise<void> {
    this.vippsOfficial = await ensureVippsButton()
  }

  private buyWithVipps(): void {
    if (!this.product || this.availableQuantity <= 0 || this.adding) return
    if (!this.requireSelection()) return
    // Nothing to pay for: no Vipps payment of 0 kr (CheckoutManager refuses it too).
    if (!(this.unitPrice > 0)) return
    // Vipps pays the sponsor's WHOLE cart — the checkout is built on the cart,
    // not on this product (see buyNow). Straight to Vipps only when the cart
    // is empty, so what the Vipps page lists is what was tapped; with lines
    // already in it, the product is added and the checkout opens first, with
    // every line and the total, Vipps preselected (Mote & Livsstil,
    // 2026-10-23: a jumper left in the cart 13 minutes earlier was paid along
    // with the product bought «nå», and only Vipps' page had said so).
    if ((Vio.cart.getCart(this.sponsorId)?.items.length ?? 0) > 0) {
      this.addCurrentToCart()
      this.close()
      this.openCheckoutWithVipps()
      return
    }
    // The overlay first, then the close: no empty moment, no second tap.
    const redirect = beginPaymentRedirect({ method: 'vipps', sponsorId: this.sponsorId, source: 'detail' })
    this.addCurrentToCart()
    this.close()
    void this.startVippsExpressOrCheckout(redirect)
  }

  /**
   * The Vipps button will open the app with Express (see buyWithVipps): the
   * brand has Express on, and this brand's cart is empty — with lines in it
   * the checkout opens first.
   */
  private vippsGoesStraightToApp(): boolean {
    return this.vippsExpress && (Vio.cart.getCart(this.sponsorId)?.items.length ?? 0) === 0
  }

  private async startVippsExpressOrCheckout(redirect: PaymentRedirectHandle): Promise<void> {
    let fallback = true
    try {
      // The seller may have switched Express off on its Vipps row: then the
      // button is an ordinary way into the checkout, with Vipps preselected.
      if (!(await Vio.checkout.getVippsExpressEnabled(this.sponsorId))) {
        redirect.abort('express-off')
      } else {
        const res = await Vio.checkout.startVippsExpress(this.sponsorId)
        // A redirect is on its way; anything else opens the checkout.
        fallback = !res?.payment_url
        if (fallback) redirect.abort('not-started')
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[VioProductDetail] Vipps Express not started:', err)
      }
      redirect.fail(err instanceof Error ? err.message : String(err))
    }
    if (!fallback) return
    this.openCheckoutWithVipps()
  }

  /** The ordinary way in, Vipps preselected: the host opens the checkout on `vio:checkout-open`. */
  private openCheckoutWithVipps(): void {
    this.openCheckoutWith('vipps')
  }

  /** The ordinary way in with a method preselected: the host opens the checkout on `vio:checkout-open`. */
  private openCheckoutWith(paymentMethod: 'vipps' | 'apple-pay'): void {
    this.dispatchEvent(
      new CustomEvent('vio:checkout-open', {
        bubbles: true,
        composed: true,
        detail: { sponsorId: this.sponsorId, paymentMethod, express: false, ...this.attribution(), ...sponsorDetail(this.sponsorId) },
      }),
    )
  }

  /** Buy with Stripe — opens the checkout with Stripe preselected. */
  private buyWithStripe(): void {
    if (!this.product || this.availableQuantity <= 0 || this.adding) return
    if (!this.requireSelection()) return
    this.addCurrentToCart()
    this.close()
    this.dispatchEvent(
      new CustomEvent('vio:checkout-open', {
        bubbles: true,
        composed: true,
        detail: { sponsorId: this.sponsorId, paymentMethod: 'stripe', express: false, ...this.attribution(), ...sponsorDetail(this.sponsorId) },
      }),
    )
  }

  /** Prepare the Apple Pay sheet for this product × quantity; the newest preparation wins. */
  private prepareApplePaySheet(): void {
    const amount = this.unitPrice * this.quantity
    this.applePayAskedFor = amount
    void Vio.checkout
      .prepareApplePayFor(amount, this.currency)
      .then((handle) => {
        if (this.applePayAskedFor !== amount) return
        this.applePayHandle = handle
        this.applePayAmount = amount
        this.applePayOk = handle.available
      })
      .catch(() => {
        if (this.applePayAskedFor !== amount) return
        this.applePayHandle = null
        this.applePayAmount = null
        this.applePayOk = false
      })
  }

  /**
   * Express buy with Apple Pay. Runs synchronously inside the click so the
   * Apple Pay sheet keeps the user gesture: add to cart → open checkout (sets
   * state) → launch the sheet. On authorize, `payment-complete` drives the
   * confirmation drawer (same path as the in-checkout Apple Pay button).
   *
   * The sheet's amount is fixed before the tap (Apple blocks a sheet opened
   * after an await, so it cannot wait for the server's cart), while the
   * charge is the sponsor's WHOLE cart. So the sheet opens only when it shows
   * what will be charged: an empty cart, and a sheet prepared for this
   * product × quantity. Otherwise — lines already in the cart (as with Vipps,
   * see buyWithVipps), or a quantity whose sheet is still being prepared —
   * the product is added and the checkout opens with Apple Pay preselected:
   * every line and the total on screen, and its own Apple Pay button pays
   * that total.
   */
  private buyWithApplePay(): void {
    if (!this.product || this.availableQuantity <= 0 || !this.applePayHandle) return
    if (!this.requireSelection()) return
    if (!(this.unitPrice > 0)) return
    const cartHasLines = (Vio.cart.getCart(this.sponsorId)?.items.length ?? 0) > 0
    if (cartHasLines || this.applePayAmount !== this.unitPrice * this.quantity) {
      this.addCurrentToCart()
      this.close()
      this.openCheckoutWith('apple-pay')
      return
    }
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

  /**
   * The product's cheapest rate for the page's market — the rates the
   * backend cart offers for its line. A rate in another currency than the
   * product's price is not shown (never a price the shopper would not pay).
   */
  private async loadShippingFrom(productId: number, seq: number): Promise<void> {
    let rates: Array<{ name?: string; price: number; currency: string; description?: string; logoUrl?: string }> | null = null
    try {
      const product = Vio.commerceFor(this.sponsorId, { campaignId: this.commerceCampaigns() }).channel.product as {
        getShippingRates?: (
          id: number,
          o?: { currency?: string },
        ) => Promise<Array<{ name?: string; price: number; currency: string; description?: string; logoUrl?: string }> | null>
      }
      rates = typeof product.getShippingRates === 'function'
        ? await product.getShippingRates(productId, { currency: this.currency })
        : null
    } catch {
      rates = null
    }
    if (seq !== this.fetchSeq) return // another product opened meanwhile
    const currency = String(this.product?.price?.currency_code ?? this.currency ?? '').toUpperCase()
    const usable = (rates ?? []).filter((r) => !r.currency || r.currency.toUpperCase() === currency)
    const cheapest = usable[0]
    this.shippingFrom = cheapest ? { price: cheapest.price, currency: cheapest.currency || currency } : null
    this.shippingRates = usable.map((r) => ({
      name: String(r.name ?? ''),
      price: r.price,
      currency: r.currency || currency,
      description: String(r.description ?? '').trim(),
      logoUrl: String(r.logoUrl ?? ''),
    }))
  }

  /**
   * `gallery="carousel"`: every photo in one row that snaps one at a time —
   * swipe on touch, arrows with a mouse — and a dot per photo over it
   * instead of thumbnails, so the name, price and sizes come up higher.
   */
  private renderCarousel(images: ProductImage[], title: string) {
    const count = images.length
    const current = Math.min(this.activeImageIndex, Math.max(0, count - 1))
    return html`
      <div class="gallery carousel" part="gallery">
        <div class="carousel-track" part="image" @scroll=${this.onCarouselScroll}>
          ${images.map(
            (img, idx) => html`
              <div class="carousel-slide" part="slide" aria-label=${`Bilde ${idx + 1} av ${count}`}>
                <img src=${img.url} alt=${idx === 0 ? title : ''} loading=${idx === 0 ? 'eager' : 'lazy'} />
              </div>
            `,
          )}
        </div>
        ${count > 1
          ? html`
              <button
                class="carousel-arrow prev"
                part="carousel-arrow"
                aria-label="Forrige bilde"
                ?disabled=${current === 0}
                @click=${() => this.stepCarousel(-1)}
              >‹</button>
              <button
                class="carousel-arrow next"
                part="carousel-arrow"
                aria-label="Neste bilde"
                ?disabled=${current === count - 1}
                @click=${() => this.stepCarousel(1)}
              >›</button>
              <div class="carousel-dots" part="image-dots" aria-hidden="true">
                ${images.map((_, idx) => html`<span class="carousel-dot ${idx === current ? 'active' : ''}"></span>`)}
              </div>
            `
          : ''}
      </div>
    `
  }

  /**
   * «Beskrivelse», not shut: the first lines show, fading out, and a tap on
   * the heading, the text or «Les mer» opens the rest (Angelo, 2026-10-28).
   * A description that fits in the preview has nothing to open.
   */
  private renderDescription(text: string) {
    const mode = this.resolvedDescriptionMode
    if (mode === 'open') {
      return html`<div class="description-block description-preview open" part="description">
        <div class="desc-head">Beskrivelse</div>
        <div class="description">${text}</div>
      </div>`
    }
    // folded: only the heading until a tap, like the other folds. preview:
    // the first lines; only a description longer than them has a fold at all.
    const foldable = mode === 'folded' || this.descriptionClipped
    const open = this.descriptionOpen || !foldable
    const toggle = () => {
      if (foldable) this.descriptionOpen = !this.descriptionOpen
    }
    return html`<div class="description-block description-preview ${open ? 'open' : ''} ${foldable ? 'clipped' : ''} ${mode}" part="description">
      <button class="desc-head" type="button" aria-expanded=${open ? 'true' : 'false'} @click=${toggle}>Beskrivelse</button>
      ${mode === 'folded' && !open
        ? nothing
        : html`<div class="description ${open ? '' : 'collapsed'}" @click=${() => !this.descriptionOpen && toggle()}>${text}</div>`}
      ${mode === 'preview' && this.descriptionClipped
        ? html`<button class="desc-more" type="button" @click=${toggle}>${this.descriptionOpen ? 'Vis mindre' : 'Les mer'}</button>`
        : nothing}
    </div>`
  }

  /** Is the preview hiding part of the text? Measured with the preview applied. */
  private measureDescription(): void {
    const el = this.renderRoot.querySelector<HTMLElement>('.description-preview .description')
    if (!el || this.descriptionOpen) return
    const wasCollapsed = el.classList.contains('collapsed')
    el.classList.add('collapsed')
    const clipped = el.scrollHeight > el.clientHeight + 1
    if (!wasCollapsed) el.classList.remove('collapsed')
    if (clipped !== this.descriptionClipped) this.descriptionClipped = clipped
  }

  private renderHighlights() {
    // The host's list when it gives one; otherwise the brand's own (Settings → Brand).
    const own = (Array.isArray(this.highlights) ? this.highlights : []).filter((h) => h && h.title)
    const items = own.length ? own : resolveSponsorIdentity(this.sponsorId)?.highlights ?? []
    if (items.length === 0) return nothing
    return html`<ul class="highlights" part="highlights">
      ${items.map((h) => {
        const path = h.icon ? HIGHLIGHT_ICONS[h.icon] : undefined
        const icon = path
          ? html`<svg class="hl-icon" viewBox="0 0 24 24" aria-hidden="true"><path d=${path}></path></svg>`
          : h.icon
            ? html`<img class="hl-icon" src=${h.icon} alt="" />`
            : nothing
        return html`<li class="hl" part="highlight">
          ${icon}
          <span class="hl-title">${h.title}</span>
          ${h.text ? html`<span class="hl-text">${h.text}</span>` : nothing}
        </li>`
      })}
    </ul>`
  }

  /**
   * «Frakt & retur», folded like «Beskrivelse»: the delivery options for the
   * page's country with their price, and the right of withdrawal with the
   * brand's own terms and returns pages when it gave them.
   */
  private renderShippingReturns() {
    const identity = resolveSponsorIdentity(this.sponsorId)
    // A description that only repeats the product, the brand or the seller
    // (products writes those as defaults on imports) is no delivery time.
    const rates = shippingRatesShown(this.shippingRates, [
      this.product?.title,
      this.product?.brand,
      this.sellerName,
      identity?.name,
    ])
    // The delivery time is what the brand wrote on each rate («Leveringstid
    // 1-5 dager»): once under the list when every rate says the same, on each
    // row when they differ; the host's delivery-time when no rate says any.
    const times = [...new Set(rates.map((r) => r.description).filter(Boolean))]
    const perRateTime = times.length > 1
    const sharedTime =
      times.length === 1 ? times[0] : times.length === 0 && this.deliveryTime.trim() ? `Leveringstid: ${this.deliveryTime.trim()}` : ''
    const links = [
      identity?.refundPolicyUrl
        ? html`<a href=${identity.refundPolicyUrl} target="_blank" rel="noopener noreferrer">Angrerett og retur</a>`
        : null,
      identity?.termsUrl ? html`<a href=${identity.termsUrl} target="_blank" rel="noopener noreferrer">Kjøpsvilkår</a>` : null,
    ].filter(Boolean)
    return html`<details class="description-block shipping-returns" part="shipping-returns">
      <summary>Frakt &amp; retur</summary>
      <div class="description shipping-returns-body">
        <div class="sr-title">Frakt</div>
        ${rates.length
          ? html`<ul class="sr-rates">
              ${rates.map((r) => {
                const { carrier, method } = splitRateName(r.name)
                const logo = r.logoUrl || carrierLogo(this.carrierLogos, carrier)
                return html`<li>
                  ${logo
                    ? html`<img class="sr-logo" src=${logo} alt=${carrier} />`
                    : lineIcon(rateIcon(r.name ?? ''), 'line-icon sr-icon')}
                  <span class="sr-rate">
                    <span class="sr-carrier">${carrier || method || 'Frakt'}</span>
                    ${carrier && method ? html`<span class="sr-method">${method}</span>` : nothing}
                    ${perRateTime && r.description ? html`<span class="sr-method">${r.description}</span>` : nothing}
                  </span>
                  <span class="sr-price">${r.price <= 0 ? 'Gratis' : formatPrice(r.price, r.currency)}</span>
                </li>`
              })}
            </ul>`
          : html`<p>Fraktprisen vises i kassen.</p>`}
        ${sharedTime
          ? html`<p class="sr-line sr-time">${lineIcon('clock', 'line-icon sr-icon')}<span>${sharedTime}</span></p>`
          : nothing}
        <div class="sr-title">Retur</div>
        <p class="sr-line">${lineIcon('return', 'line-icon sr-icon')}<span>Du har 14 dagers angrerett fra du mottar varen.</span></p>
        ${links.length ? html`<p class="sr-links">${links}</p>` : nothing}
      </div>
    </details>`
  }

  /** Under the price: «Frakt fra X · 14 dagers angrerett» (or «Gratis frakt · …»). */
  private renderDeliveryNote() {
    const ship = this.shippingFrom
    const shipping = ship ? (ship.price <= 0 ? 'Gratis frakt' : `Frakt fra ${formatPrice(ship.price, ship.currency)}`) : ''
    return html`<div class="delivery-note" part="delivery-note">
      ${shipping ? html`<span part="delivery-shipping">${shipping}</span><span aria-hidden="true"> · </span>` : ''}<span
        part="delivery-withdrawal"
        >14 dagers angrerett</span
      >
    </div>`
  }

  /** The seller's Company name; the brand when there is none; nothing while asking. */
  private headerName(): string {
    if (this.sellerName) return this.sellerName
    return this.sellerSettled ? (this.product?.brand ?? '') : ''
  }

  private async loadSeller(productId: number, seq: number): Promise<void> {
    let name: string | null = null
    try {
      name = await Vio.commerceFor(this.sponsorId, { campaignId: this.commerceCampaigns() }).channel.product.getSellerCompany(productId)
    } catch {
      name = null
    }
    if (seq !== this.fetchSeq) return // another product opened meanwhile
    this.sellerName = name
    this.sellerSettled = true
  }

  /**
   * Who sells the product, top left beside the close (Mote & Livsstil,
   * 2026-10-22): the logo of the sponsor the product was fetched with — the
   * product's brand, never the article's — with its name as `alt`; without a
   * logo that loads, its name; without an identity, the seller's Company name
   * (or the product's brand) once known. Size: --vio-detail-logo-height.
   */
  private renderTopbarSponsor() {
    const identity = resolveSponsorIdentity(this.sponsorId)
    const mark = identity ? renderSponsorMark(this, identity, { logo: 'topbar-logo', name: 'topbar-name' }) : nothing
    if (mark !== nothing) {
      // A logo: in a clipping box (for the zoom), and — when the file turns
      // out square, a mark rather than a wordmark — with the name beside it,
      // so the shopper can tell whose it is.
      if (identity && usableLogo(identity)) {
        return html`<span class="topbar-logo-box">${mark}</span
          ><span class="topbar-name topbar-mark-name">${identity.name}</span>`
      }
      return mark
    }
    const name = this.headerName()
    return name ? html`<span class="topbar-name">${name}</span>` : nothing
  }

  /**
   * Under the buy buttons: «Du handler direkte hos {brand}.» — the brand the
   * product was fetched with (the sponsor; its Company name or the product's
   * brand when no identity is known), never the article's. Nothing when no
   * name is known.
   */
  private renderSellerNote() {
    const identity = resolveSponsorIdentity(this.sponsorId)
    const name = identity?.name || this.headerName()
    if (!name) return nothing
    // The brand's own pages, when it gave them (Settings → Brand): its terms
    // and its returns policy, opened in a new tab.
    const links = [
      identity?.termsUrl ? html`<a href=${identity.termsUrl} target="_blank" rel="noopener noreferrer" part="seller-terms">Kjøpsvilkår</a>` : null,
      identity?.refundPolicyUrl ? html`<a href=${identity.refundPolicyUrl} target="_blank" rel="noopener noreferrer" part="seller-refund">Angrerett og retur</a>` : null,
    ].filter(Boolean)
    return html`<p class="seller-note" part="seller-note">
      Du handler direkte hos <strong>${name}</strong>.${links.length ? html`<span class="seller-links">${links}</span>` : nothing}
    </p>`
  }

  /** Square-ish logo (4:5 to 5:4) → the top bar shows the name beside it. */
  private measureLogo(): void {
    const img = this.renderRoot.querySelector<HTMLImageElement>('.topbar-logo')
    if (!img) {
      if (this.logoSquare) this.logoSquare = false
      return
    }
    const decide = () => {
      if (!img.naturalWidth || !img.naturalHeight) return
      const ratio = img.naturalWidth / img.naturalHeight
      const square = ratio >= 0.8 && ratio <= 1.25
      if (square !== this.logoSquare) this.logoSquare = square
    }
    if (img.complete) decide()
    else img.addEventListener('load', decide, { once: true })
  }

  override render() {
    return html`
      <div class="backdrop" @click=${this.close}></div>
      <div class="modal" role="dialog" aria-modal="true" aria-label="Produkt" tabindex="-1">
        <div class="handle" @click=${this.close} aria-hidden="true"></div>
        <div class="topbar" part="topbar">
          <div class="topbar-sponsor ${this.logoSquare ? 'is-square' : ''}" part="sponsor">${this.renderTopbarSponsor()}</div>
          <button class="close" part="close" @click=${this.close} aria-label="Lukk">×</button>
        </div>

        ${this.renderBody()}
      </div>
      ${this.renderAddedToast()}
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
    const images = this.allImages()
    const activeImage = this.activeImage

    return html`
      <div class="body">
        ${this.galleryMode === 'carousel' ? this.renderCarousel(images, p.title) : html`<div class="gallery" part="gallery">
          <div class="gallery-main" part="image">
            ${activeImage?.url
              ? html`<img src=${activeImage.url} alt=${p.title} />`
              : ''}
          </div>
          ${images.length > 1
            ? html`
                <div class="thumbs ${this.thumbsOverflow ? 'overflows' : ''}">
                  <button
                    class="thumbs-arrow prev"
                    part="thumbs-arrow"
                    aria-label="Forrige bilder"
                    ?disabled=${this.thumbsAtStart}
                    @click=${() => this.scrollThumbs(-1)}
                  >‹</button>
                  <div class="gallery-thumbs" part="thumbs" @scroll=${this.onThumbsScroll}>
                    ${images.map(
                      (img, idx) => html`
                        <button
                          class="gallery-thumb ${idx === this.activeImageIndex ? 'active' : ''}"
                          part=${idx === this.activeImageIndex ? 'thumb thumb-active' : 'thumb'}
                          @click=${() => (this.activeImageIndex = idx)}
                          aria-label=${`Bilde ${idx + 1}`}
                          aria-current=${idx === this.activeImageIndex ? 'true' : 'false'}
                        >
                          <img src=${img.url} alt="" loading="lazy" />
                        </button>
                      `,
                    )}
                  </div>
                  <button
                    class="thumbs-arrow next"
                    part="thumbs-arrow"
                    aria-label="Neste bilder"
                    ?disabled=${this.thumbsAtEnd}
                    @click=${() => this.scrollThumbs(1)}
                  >›</button>
                </div>
              `
            : ''}
        </div>`}

        <div class="info" part="info">
          ${this.renderSections(this.layoutNow.sections)}
        </div>
      </div>
    `
  }

  /**
   * The info column in the applied layout's order (0.34) — the real DOM in
   * that order, never CSS `order`, the same on every screen. The default
   * order renders exactly the column before 0.34: brand, `.headline` (the
   * title row with the stock, the price row), then `.purchase` — `.buy` with
   * the options first — and highlights, description, «Frakt & retur» in it.
   *
   * A run of `title` / `stock` / `price` is one `.headline`; `title`
   * right before `stock` share the title row. `options` right before
   * `purchase` live in `.buy` (a pinned buy zone keeps them); elsewhere they
   * are a block of their own. Everything after `purchase` goes in
   * `.purchase`, as the description does by default: a pinned buy zone may
   * slide over it, never over what comes before.
   */
  private renderSections(sections: ReadonlyArray<DetailSectionId>): unknown[] {
    const out: unknown[] = []
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i]!
      if (s === 'title' || s === 'stock' || s === 'price') {
        let j = i
        while (j < sections.length && ['title', 'stock', 'price'].includes(sections[j]!)) j++
        out.push(this.renderHeadline(sections.slice(i, j)))
        i = j - 1
        continue
      }
      if (s === 'options' && sections[i + 1] === 'purchase') continue
      if (s === 'purchase') {
        const optionsInBuy = sections[i - 1] === 'options'
        out.push(this.renderPurchase(optionsInBuy, sections.slice(i + 1)))
        break
      }
      out.push(this.renderSection(s))
    }
    return out
  }

  /** A run of title / stock / price: one `.headline`. */
  private renderHeadline(run: ReadonlyArray<DetailSectionId>) {
    const p = this.product!
    const stock = this.stockLabel()
    const compare = this.compareAt
    const showCompare = compare !== null && compare > this.unitPrice
    const name = html`<h2 class="name" part="title">${p.title}</h2>`
    const stockLine = html`<div class="stock ${stock.cls}" part="stock">${stock.text}</div>`
    const parts: unknown[] = []
    for (let i = 0; i < run.length; i++) {
      const s = run[i]
      if (s === 'title' && run[i + 1] === 'stock') {
        parts.push(html`<div class="title-row">
              ${name}
              ${stockLine}
            </div>`)
        i++
      } else if (s === 'title') {
        parts.push(html`<div class="title-row">${name}</div>`)
      } else if (s === 'stock') {
        parts.push(stockLine)
      } else {
        parts.push(html`<div class="price-row">
              <span class="price" part="price">${formatPrice(this.unitPrice, p.price.currency_code)}</span>
              ${showCompare
                ? html`<span class="compare-at">${formatPrice(
                    compare,
                    p.price.currency_code,
                  )}</span>`
                : ''}
            </div>`)
      }
    }
    return html`<div class="headline">
            ${parts}
          </div>`
  }

  /** One section that is not the headline nor the purchase group. */
  private renderSection(section: DetailSectionId) {
    const p = this.product!
    switch (section) {
      case 'brand':
        return p.brand ? html`<div class="brand" part="brand">${p.brand}</div>` : ''
      case 'options':
        // Apart from the buttons: they still ask for the choice (requireSelection).
        return p.options.length > 0
          ? html`<div class="buy-options options-apart" part="buy-options">${this.renderOptionPickers(p.options)}</div>`
          : ''
      case 'highlights':
        return this.renderHighlights()
      case 'description':
        return p.description ? this.renderDescription(this.stripHtml(p.description)) : ''
      case 'shippingReturns':
        return this.renderShippingReturns()
      default:
        return ''
    }
  }

  /**
   * The SDK-managed buy group, never split: «Frakt fra…», Vipps / Apple Pay /
   * the other ways to pay, quantity + «Legg i handlekurv», «Du handler direkte
   * hos …». The options when they come right before it; then what follows it.
   */
  private renderPurchase(optionsInBuy: boolean, rest: ReadonlyArray<DetailSectionId>) {
    const p = this.product!
    const optionsApart = !optionsInBuy && p.options.length > 0
    return html`<div class=${optionsApart ? 'purchase options-apart' : 'purchase'}>
          <div class="buy" part="buy">
          ${optionsInBuy && p.options.length > 0
            ? html`<div class="buy-options" part="buy-options">${this.renderOptionPickers(p.options)}</div>`
            : ''}
          ${this.renderDeliveryNote()}
          ${this.methodsPending && this.availableQuantity > 0
            ? html`<div class="buy-pending" part="buy-pending" role="status" aria-label="Laster betalingsmåter"></div>`
            : ''}
          ${this.availableQuantity > 0 && this.hasPrice && this.methodEnabled('vipps')
            ? this.vippsOfficial
              ? html`
                  <vipps-mobilepay-button
                    class="buy-vipps-official"
                    part="buy-vipps"
                    brand="vipps"
                    language="no"
                    verb="buy"
                    variant="primary"
                    rounded="true"
                    stretched="true"
                    role="button"
                    aria-label="Kjøp nå med Vipps"
                    @click=${this.buyWithVipps}
                  ></vipps-mobilepay-button>
                `
              : html`
                  <button
                    class="buy-vipps"
                    part="buy-vipps"
                    @click=${this.buyWithVipps}
                    ?disabled=${this.adding}
                    aria-label="Kjøp nå med Vipps"
                  >
                    <span>Kjøp nå med</span>
                    <span class="vipps-badge">vipps</span>
                  </button>
                `
            : ''}
          ${this.availableQuantity > 0 && this.hasPrice && this.methodEnabled('vipps') && this.vippsGoesStraightToApp()
            ? html`<p class="vipps-note" part="vipps-note">Vipps fyller inn navn og adresse – du godkjenner og betaler i appen</p>`
            : ''}

          <div class="qty-cta-row" part="quantity-row">
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
              part="add-to-cart"
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
          this.methodEnabled(...NO_EXPRESS_BUTTON_METHODS)
            ? html`
                <button
                  class="buy-now"
                  @click=${this.buyNow}
                  ?disabled=${this.adding}
                  aria-label="Kjøp nå"
                >
                  Kjøp nå
                </button>
              `
            : ''}

          ${this.availableQuantity > 0 &&
          this.hasPrice &&
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

          ${this.renderSellerNote()}
          </div>

          ${this.renderSections(rest)}
          </div>`
  }

  private renderOptionPickers(options: ProductOption[]) {
    if (options.length === 0) return ''
    return html`${options.map((opt) => {
      const values = normalizeValues(opt.values)
      if (values.length === 0) return ''
      const chosen = String(this.selectedOptions[opt.name] ?? '').trim()
      const asked = this.selectionPrompt === opt.name && !chosen
      return html`
        <div class="option-group ${asked ? 'needs-choice' : ''}" part="option-group">
          <div class="option-label" part="option-label">
            <span
              >${opt.name}${chosen ? html`: <span class="option-chosen" part="option-chosen">${chosen}</span>` : ''}</span
            >
            ${asked
              ? html`<span class="option-prompt" part="option-prompt" role="alert">${this.promptFor(opt)}</span>`
              : ''}
          </div>
          <div class="option-values" part="options">
            ${values.map((val) => {
              const available = this.isValueAvailable(opt.name, val)
              const currentVal = this.selectedOptions[opt.name] ?? ''
              const isSelected =
                String(currentVal).trim().toLowerCase() === String(val).trim().toLowerCase()
              return html`
                <button
                  class="option-pill ${available ? '' : 'unavailable'}"
                  part=${isSelected ? 'option option-selected' : 'option'}
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

/**
 * The rates «Frakt & retur» shows: each description through
 * `shippingDescriptionOf` — filler, a repeat of the rate's own name, or of
 * any of `repeats` (the product's title, its brand, the seller's and the
 * sponsor's display names) is no description (''). Pure; copies.
 */
export function shippingRatesShown<T extends { name: string; description: string }>(
  rates: ReadonlyArray<T>,
  repeats: ReadonlyArray<unknown> = [],
): T[] {
  return rates.map((r) => ({ ...r, description: shippingDescriptionOf(r.description, [r.name, ...repeats]) }))
}

/**
 * A rate name as the brand typed it, «Carrier - how» («Helthjem - til
 * postkasse/dørmatte», «Bring - Pakke i postkasse»): the carrier, and the way
 * it delivers with a capital. A name without the dash is all `method`.
 */
export function splitRateName(name: string | undefined): { carrier: string; method: string } {
  const text = String(name ?? '').trim()
  const m = text.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  if (!m?.[1] || !m[2]) return { carrier: '', method: text }
  const method = m[2].trim()
  return { carrier: m[1].trim(), method: method.charAt(0).toUpperCase() + method.slice(1) }
}
