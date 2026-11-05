/**
 * <vio-reel> — a managed shoppable-video experience (ADR-0042).
 *
 *   <vio-reel experience-id="7"></vio-reel>
 *
 * The page names the experience; Vio decides what it shows: ordered videos
 * with the products on screen and when they appear. Vertical feed with snap,
 * the neighbour visible during the swipe, loop, muted autoplay, the next
 * video preloaded (only the next), skeletons while it loads, product cards
 * that open `<vio-product-detail>` without stopping the video, a cue badge
 * («I videoen nå») on the product the current second names.
 *
 * What it reads: `GET /v2/experiences/:id` with the surface key, through
 * `Vio.api.experience()`; the products through the sponsor's commerce client
 * (`Vio.commerceFor(sponsorId, { campaignId })`), as the carousel does.
 *
 * Rules (ADR-0042 points 6–9):
 *   - the revision it mounted with stays until the next mount; a newer one is
 *     stored for the next open, never swapped under the reader;
 *   - the last good revision is kept in localStorage and used when the
 *     network fails (never a revision older than a week);
 *   - an experience of another campaign than the page's renders NOTHING (a
 *     console warning and an `sdk_error` with `error_code: reel_incompatible`);
 *     never products of another campaign, never a default sponsor;
 *   - only declarative config: the `theme` tokens are applied as `--vio-*`
 *     custom properties on the element, nothing else executes.
 *
 * Preview for editors: set the `experience` PROPERTY (the same JSON the API
 * answers, e.g. the draft resolved by `?preview=draft`) and nothing is fetched.
 */

import { LitElement, css, html, nothing } from 'lit'
import { property, state } from 'lit/decorators.js'
import { Vio } from '../../core/client.js'
import type { AnalyticsCommerce } from '../../core/analytics/analytics-manager.js'
import {
  cueProductAt,
  experienceCacheKey,
  experienceCompatible,
  experienceProductRefs,
  parseExperience,
  readCachedExperience,
  safeThemeEntries,
  writeCachedExperience,
  type Experience,
  type ExperienceProduct,
  type ExperienceVideo,
} from '../../core/experience.js'
import { displayPrice, primaryImageUrl, type Product } from '../../core/types.js'
import { SlotRegistration } from '../slot-registration.js'
import { resolveSponsorIdentity } from '../sponsor-identity.js'
import { attachSource, type AttachedSource } from '../hls.js'

/** How much of the reel has to be on the page's screen to play; below it everything pauses. */
const ACTIVE_RATIO = 0.6
export const REEL_TEMPLATE_ID = 'reel'

type Status = 'idle' | 'loading' | 'ready' | 'empty' | 'incompatible' | 'error'

export class VioReel extends LitElement {
  /** The experience to show (`GET /v2/experiences/:id`). */
  @property({ type: Number, attribute: 'experience-id' }) experienceId = 0
  /**
   * An experience handed over by the host instead of fetched: the editor's
   * preview (`?preview=draft`) or a page that already has the JSON. Same shape
   * as the API's answer. Property only.
   */
  @property({ attribute: false }) experience: Experience | Record<string, unknown> | null = null
  /** Currency for the product prices. */
  @property({ type: String }) currency = 'NOK'
  /** Start playing when the reel scrolls into view (default). `false` = tap to play. */
  @property({ type: Boolean, attribute: 'no-autoplay' }) noAutoplay = false
  /** Badge on the product the current second names (default Norwegian). */
  @property({ type: String, attribute: 'cue-label' }) cueLabel = 'I videoen nå'
  /** Slot this reel sits in (ADR-0027); without it, `reel-N`. See `<vio-product-carousel>`. */
  @property({ type: String, attribute: 'vio-slot' }) vioSlot = ''
  @property({ type: String, attribute: 'vio-slot-name' }) vioSlotName = ''
  @property({ type: String, attribute: 'vio-scope' }) vioScope = ''
  @property({ type: String, attribute: 'vio-scope-name' }) vioScopeName = ''
  /** The campaign this element's PAGE belongs to (ADR-0034); the experience has to be of it. */
  @property({ type: String, attribute: 'vio-campaign' }) vioCampaign = ''
  @property({ type: String, attribute: 'vio-content-id' }) vioContentId = ''
  @property({ type: String, attribute: 'vio-content-title' }) vioContentTitle = ''

  private readonly slotRegistration = new SlotRegistration(this, 'reel')

  @state() private doc: Experience | null = null
  @state() private products = new Map<number, Product>()
  @state() private status: Status = 'idle'
  @state() private active = 0
  @state() private muted = true
  @state() private playing = false
  @state() private progress = 0
  @state() private cueProductId: number | null = null
  @state() private fullscreen = false

  private attached = new Map<number, AttachedSource | Promise<AttachedSource>>()
  private observer: IntersectionObserver | null = null
  private unobserveImpression: (() => void) | null = null
  private listTracked = new Set<string>()
  private loadToken = 0
  private readonly onFullscreenChange = () => {
    this.fullscreen = typeof document !== 'undefined' && document.fullscreenElement === this
  }

  get effectiveSlot(): string {
    return this.slotRegistration.effective
  }
  get effectiveCampaignId(): number | undefined {
    return this.slotRegistration.campaignId
  }

  static override styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      font-family: var(--vio-font-sans, -apple-system, sans-serif);
      color: var(--vio-color-text, #0a0a0a);
      --_h: var(--vio-reel-height, min(85vh, calc(100vw * 16 / 9)));
      --_radius: var(--vio-reel-radius, var(--vio-radius-lg, 12px));
    }
    :host(:fullscreen) { --_h: 100vh; --_radius: 0; background: #000; }
    .reel { position: relative; height: var(--_h); border-radius: var(--_radius); overflow: hidden; background: #000; }
    .feed {
      height: 100%;
      overflow-y: auto;
      scroll-snap-type: y mandatory;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
    }
    .feed::-webkit-scrollbar { display: none; }
    .item { position: relative; height: 100%; scroll-snap-align: start; scroll-snap-stop: always; background: #000; }
    video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: var(--vio-reel-video-fit, cover); background: #000; }
    .poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .shade {
      position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(to bottom, rgba(0,0,0,.45) 0, transparent 22%, transparent 55%, rgba(0,0,0,.6) 100%);
    }
    .top { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: flex-start; gap: 10px; padding: 14px 14px 0; color: #fff; }
    .brand { display: inline-flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
    .brand img { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; background: #fff; }
    .brand-name { font-size: 10px; letter-spacing: var(--vio-tracking-label, .1em); text-transform: uppercase; opacity: .9; }
    .title { display: block; font-family: var(--vio-font-serif, Georgia, serif); font-size: 15px; line-height: 1.25; margin-top: 2px; text-shadow: 0 1px 8px rgba(0,0,0,.4); }
    .controls { display: flex; gap: 6px; flex: 0 0 auto; }
    .ctrl {
      width: 34px; height: 34px; border-radius: 50%; border: 0; cursor: pointer;
      background: rgba(255,255,255,.18); color: #fff; backdrop-filter: blur(6px);
      display: inline-flex; align-items: center; justify-content: center; font-size: 14px; padding: 0; font-family: inherit;
    }
    .ctrl:hover { background: rgba(255,255,255,.3); }
    .counter { position: absolute; right: 14px; top: 56px; color: #fff; font-size: 11px; opacity: .85; }
    .tap { position: absolute; inset: 0; border: 0; background: transparent; cursor: pointer; padding: 0; }
    .play-hint {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: 56px; height: 56px; border-radius: 50%; background: rgba(255,255,255,.85); color: #000;
      display: flex; align-items: center; justify-content: center; font-size: 22px; pointer-events: none;
    }
    .bottom { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 0 12px; }
    .products {
      display: flex; gap: 8px; overflow-x: auto; padding: 28px 12px 6px; scroll-snap-type: x proximity;
      scrollbar-width: none;
    }
    .products::-webkit-scrollbar { display: none; }
    .card {
      position: relative; flex: 0 0 auto; width: var(--vio-reel-card-width, 232px); display: flex; gap: 10px; align-items: center;
      padding: 8px; border: 0; cursor: pointer; text-align: left; font-family: inherit; color: var(--vio-color-text, #0a0a0a);
      background: var(--vio-color-surface, #fff); border-radius: var(--vio-radius-md, 10px); scroll-snap-align: start;
      box-shadow: 0 2px 12px rgba(0,0,0,.18);
    }
    .card.current { outline: 2px solid var(--vio-color-accent, #c14a3b); outline-offset: 0; }
    .card img, .card .ph { width: 56px; height: 72px; object-fit: cover; border-radius: var(--vio-radius-sm, 6px); background: var(--vio-color-surface-muted, #f2f2f2); flex: 0 0 auto; }
    .card .txt { min-width: 0; flex: 1; }
    .card .b { font-size: 9px; letter-spacing: var(--vio-tracking-label, .1em); text-transform: uppercase; color: var(--vio-color-text-tertiary, #999); }
    .card .n { font-size: 12px; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .card .p { font-size: 12px; font-weight: 600; margin-top: 2px; }
    .cue {
      position: absolute; top: -18px; left: 8px; padding: 3px 8px; border-radius: 999px;
      background: var(--vio-color-accent, #c14a3b); color: var(--vio-color-text-on-primary, #fff);
      font-size: 9px; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; white-space: nowrap;
    }
    .progress { height: 3px; margin: 0 12px; background: rgba(255,255,255,.3); border-radius: 2px; overflow: hidden; }
    .progress > i { display: block; height: 100%; width: 0; background: #fff; transition: width .2s linear; }
    .nav { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 8px; }
    @media (max-width: 600px), (pointer: coarse) { .nav { display: none; } }
    .skeleton { height: 100%; background: linear-gradient(90deg, #1a1a1a 25%, #262626 37%, #1a1a1a 63%); background-size: 400% 100%; animation: vio-reel-shimmer 1.4s ease infinite; }
    @keyframes vio-reel-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  `

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  override connectedCallback(): void {
    super.connectedCallback()
    this.slotRegistration.connect(this.slotAttributes())
    if (typeof document !== 'undefined') document.addEventListener('fullscreenchange', this.onFullscreenChange)
    void this.load()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.loadToken++
    this.teardownPlayback()
    this.unobserveImpression?.()
    this.unobserveImpression = null
    this.slotRegistration.clear()
    if (typeof document !== 'undefined') document.removeEventListener('fullscreenchange', this.onFullscreenChange)
  }

  override updated(changed: Map<string, unknown>): void {
    this.slotRegistration.sync(this.slotAttributes())
    // A new experience (id or object) after the first load: load again. The
    // first render also reports these as changed; `loadedFor` tells them apart.
    if ((changed.has('experienceId') || changed.has('experience')) && this.loadKey() !== this.loadedFor) void this.load()
    // After the ready render, off the update cycle: activating a video sets state.
    if (changed.has('status') && this.status === 'ready') queueMicrotask(() => this.setupPlayback())
  }

  /** What the last `load()` was for: the object itself, or the id. */
  private loadedFor: unknown = undefined
  private loadKey(): unknown {
    return this.experience ?? (this.experienceId > 0 ? this.experienceId : null)
  }

  private slotAttributes() {
    return { vioSlot: this.vioSlot, vioSlotName: this.vioSlotName, vioScope: this.vioScope, vioScopeName: this.vioScopeName, vioCampaign: this.vioCampaign }
  }

  // ── Loading (ADR-0042 points 6–8) ──────────────────────────────────────────

  private async load(): Promise<void> {
    const token = ++this.loadToken
    this.loadedFor = this.loadKey()
    this.teardownPlayback()
    this.doc = null
    this.products = new Map()

    let experience: Experience | null = null
    if (this.experience) {
      experience = parseExperience(this.experience)
      if (!experience) {
        this.status = 'error'
        return
      }
    } else {
      if (!(this.experienceId > 0)) {
        this.status = 'idle'
        return
      }
      if (!Vio.isInitialized) {
        this.status = 'error'
        this.warn('Vio not initialized — call Vio.init({ apiKey }) first')
        return
      }
      this.status = 'loading'
      experience = await this.fetchExperience(this.experienceId)
      if (token !== this.loadToken) return
      if (!experience) {
        this.status = 'error'
        return
      }
    }

    // The page's campaign decides: an experience of another one is not shown.
    const pageCampaigns = this.slotRegistration.campaignHint
    if (!experienceCompatible(experience, pageCampaigns)) {
      this.status = 'incompatible'
      this.warn(`experience ${experience.id} belongs to campaign ${experience.campaignId}, the page to ${pageCampaigns.join('/')} — not shown`)
      this.trackSafe('sdk_error', {
        context: { errorCode: 'reel_incompatible', ...this.attribution(experience) },
        props: { experience_id: experience.id, revision: experience.revision, page_campaigns: pageCampaigns },
      })
      return
    }

    this.doc = experience
    this.applyTheme(experience)
    if (!experience.videos.length) {
      this.status = 'empty'
      return
    }
    this.status = 'loading'
    const products = await this.fetchProducts(experience)
    if (token !== this.loadToken) return
    this.products = products
    this.active = 0
    this.status = 'ready'
    this.observeForAnalytics()
  }

  /**
   * Cache first: the revision the reader last saw is shown at once and a
   * newer one is only STORED (applied on the next mount). Without a cached
   * copy the network answer is shown. Network down: the cached copy, if any.
   */
  private async fetchExperience(id: number): Promise<Experience | null> {
    const key = experienceCacheKey(Vio.config.apiKey, id)
    const cached = readCachedExperience(key)
    const refresh = async (): Promise<Experience | null> => {
      const res = await Vio.api.experience(id, { ifNoneMatch: cached?.etag ?? null })
      if (res.status === 304) return cached?.experience ?? null
      const fresh = parseExperience(res.body)
      if (fresh && fresh.revision !== null) writeCachedExperience(key, { etag: res.etag, experience: fresh, savedAt: Date.now() })
      return fresh
    }
    if (cached) {
      // Show the known revision now; learn about a new one in the background.
      void refresh().catch(() => undefined)
      return cached.experience
    }
    try {
      return await refresh()
    } catch (err) {
      this.warn(`experience ${id} could not be loaded —`, err)
      return null
    }
  }

  private async fetchProducts(experience: Experience): Promise<Map<number, Product>> {
    const refs = experienceProductRefs(experience)
    const out = new Map<number, Product>()
    if (!refs.length) return out
    try {
      // The sponsor's channel key comes from the bootstrap, which the host may not have fetched yet (as the carousel does).
      if (!Vio.bootstrapCache) {
        try {
          await Vio.bootstrap()
        } catch {
          /* commerceFor() reports the missing sponsor below */
        }
      }
      const commerce = Vio.commerceFor(experience.sponsorId, { campaignId: experience.campaignId })
      const list = await commerce.channel.product.getByIds({
        product_ids: refs.map((r) => r.productId),
        currency: this.currency,
        image_size: 'large',
      })
      for (const p of list) out.set(Number(p.id), p)
    } catch (err) {
      // The videos still play; the cards of the products that did not load are left out.
      this.warn('products of the experience could not be loaded —', err)
    }
    return out
  }

  private applyTheme(experience: Experience): void {
    for (const [k, v] of safeThemeEntries(experience.theme)) this.style.setProperty(k, v)
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  private get videoEls(): HTMLVideoElement[] {
    return Array.from(this.renderRoot.querySelectorAll('video'))
  }

  /** The document and the videos the current playback wiring is for: a second call for the same render is a no-op (it must not detach what the first activated). */
  private playbackFor: { doc: Experience; videos: HTMLVideoElement[] } | null = null
  private feedEl: HTMLElement | null = null
  private activatedOnce = false
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null
  /** Whether the reel itself is on the page's screen (pauses when scrolled away). */
  private visible = true
  private readonly onFeedScroll = () => {
    const index = this.indexFromScroll()
    if (index !== this.active) void this.activate(index)
  }

  /**
   * Which video the feed is snapped to. The feed's own scroll position is the
   * source of truth for the active video; the page-level observer only says
   * whether the reel is on screen at all.
   */
  private indexFromScroll(): number {
    const feed = this.feedEl
    const n = this.doc?.videos.length ?? 0
    if (!feed || n === 0) return 0
    const h = feed.clientHeight
    const index = h > 0 ? Math.round(feed.scrollTop / h) : 0
    return Math.max(0, Math.min(n - 1, index))
  }

  private setupPlayback(): void {
    const doc = this.doc
    const videos = this.videoEls
    if (!doc) return
    const same =
      this.playbackFor &&
      this.playbackFor.doc === doc &&
      this.playbackFor.videos.length === videos.length &&
      this.playbackFor.videos.every((v, i) => v === videos[i])
    if (same && this.feedEl) return
    this.teardownPlayback()
    this.playbackFor = { doc, videos }
    if (!videos.length) return
    this.feedEl = this.renderRoot.querySelector('.feed')
    this.feedEl?.addEventListener('scroll', this.onFeedScroll, { passive: true })
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            this.visible = e.isIntersecting && e.intersectionRatio >= ACTIVE_RATIO
            if (this.visible) void this.activate(this.indexFromScroll())
            else this.pauseAll()
          }
        },
        { threshold: [0, ACTIVE_RATIO] },
      )
      this.observer.observe(this)
    }
    // Belt and braces: if no observer callback arrives (an environment without
    // one, or one that stays silent), the first video still starts.
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null
      if (!this.activatedOnce) void this.activate(this.indexFromScroll())
    }, 400)
  }

  private teardownPlayback(): void {
    this.observer?.disconnect()
    this.observer = null
    this.feedEl?.removeEventListener('scroll', this.onFeedScroll)
    this.feedEl = null
    this.playbackFor = null
    this.activatedOnce = false
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
    this.fallbackTimer = null
    for (const [, a] of this.attached) void Promise.resolve(a).then((s) => s.detach()).catch(() => undefined)
    this.attached.clear()
  }

  private pauseAll(): void {
    // Unconditional: pausing a paused video is free, and `paused` lies in some environments.
    for (const v of this.videoEls) v.pause?.()
    this.playing = false
  }

  /** Make `index` THE video: wire it and the next one, play it, pause the rest, unload the far ones. */
  private async activate(index: number): Promise<void> {
    const videos = this.videoEls
    const doc = this.doc
    if (!doc || !videos[index]) return
    this.activatedOnce = true
    const sameVideo = this.active === index && this.attached.has(index)
    this.active = index
    if (!sameVideo) this.progress = 0
    this.cueProductId = cueProductAt(doc.videos[index]!.cues, 0)
    for (const [i, v] of videos.entries()) {
      if (Math.abs(i - index) > 1) {
        const a = this.attached.get(i)
        if (a) {
          this.attached.delete(i)
          void Promise.resolve(a).then((s) => s.detach()).catch(() => undefined)
        }
        if (!v.paused) v.pause()
      } else if (i !== index && !v.paused) {
        v.pause()
      }
    }
    await this.ensureAttached(index)
    // Only the next neighbour is preloaded (ADR-0042 point 3: limited preload).
    if (videos[index + 1]) void this.ensureAttached(index + 1)
    if (this.active !== index) return
    const video = videos[index]!
    video.muted = this.muted
    if (!this.noAutoplay && this.visible && video.paused) this.tryPlay(video)
    if (this.visible) this.trackVideoList(index)
  }

  private ensureAttached(index: number): Promise<AttachedSource> {
    const existing = this.attached.get(index)
    if (existing) return Promise.resolve(existing)
    const video = this.videoEls[index]!
    const src = this.doc!.videos[index]!.media.playbackUrl
    const pending = attachSource(video, src)
    this.attached.set(index, pending)
    pending.then((s) => this.attached.get(index) === pending && this.attached.set(index, s)).catch(() => this.attached.delete(index))
    return pending
  }

  private tryPlay(video: HTMLVideoElement): void {
    try {
      const p = video.play?.()
      if (p && typeof (p as Promise<void>).catch === 'function') {
        ;(p as Promise<void>).then(() => (this.playing = true)).catch(() => {
          // Autoplay with sound refused: fall back to muted, as every reel does.
          if (!video.muted) {
            video.muted = true
            this.muted = true
            video.play?.()?.then?.(() => (this.playing = true)).catch(() => (this.playing = false))
          } else {
            this.playing = false
          }
        })
      } else {
        this.playing = true
      }
    } catch {
      this.playing = false
    }
  }

  private togglePlay(): void {
    const video = this.videoEls[this.active]
    if (!video) return
    if (video.paused) this.tryPlay(video)
    else {
      video.pause()
      this.playing = false
    }
  }

  private toggleMute(): void {
    this.muted = !this.muted
    for (const v of this.videoEls) v.muted = this.muted
  }

  private toggleFullscreen(): void {
    try {
      if (document.fullscreenElement === this) void document.exitFullscreen?.()
      else void this.requestFullscreen?.()
    } catch {
      /* not allowed here */
    }
  }

  private go(delta: 1 | -1): void {
    const target = this.videoEls[this.active + delta]
    target?.closest('.item')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  private onTimeUpdate(index: number, ev: Event): void {
    if (index !== this.active || !this.doc) return
    const video = ev.currentTarget as HTMLVideoElement
    const d = video.duration
    this.progress = Number.isFinite(d) && d > 0 ? Math.min(100, (video.currentTime / d) * 100) : 0
    const cue = cueProductAt(this.doc.videos[index]!.cues, video.currentTime)
    if (cue !== this.cueProductId) {
      this.cueProductId = cue
      if (cue !== null) this.scrollCardIntoView(index, cue)
    }
  }

  private scrollCardIntoView(index: number, productId: number): void {
    const card = this.renderRoot.querySelector(`.item[data-index="${index}"] .card[data-product="${productId}"]`)
    card?.scrollIntoView?.({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }

  // ── Products → the detail (and the cart, the analytics) ───────────────────

  /** Same event a `<vio-product>` emits: `<vio-product-detail>` opens, the analytics listener records `select_item`. The video keeps playing. */
  private openProduct(video: ExperienceVideo, ref: ExperienceProduct): void {
    const doc = this.doc
    const product = this.products.get(ref.productId)
    if (!doc) return
    this.dispatchEvent(
      new CustomEvent('vio:product-click', {
        bubbles: true,
        composed: true,
        detail: {
          productId: String(ref.productId),
          brand: product?.brand ?? '',
          name: product?.title ?? '',
          price: product ? displayPrice(product) : '',
          retailer: resolveSponsorIdentity(doc.sponsorId)?.name ?? '',
          imageUrl: this.imageOf(ref, product),
          ...this.attribution(doc),
          sponsorId: String(doc.sponsorId),
          campaignId: doc.campaignId,
          experienceId: doc.id,
          videoId: video.id,
          revision: doc.revision,
        },
      }),
    )
  }

  private imageOf(ref: ExperienceProduct, product: Product | undefined): string {
    return ref.imageOverrideUrl ?? (product ? (primaryImageUrl(product) ?? '') : '')
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  private attribution(doc: Experience) {
    const base =
      typeof Vio.attribution === 'function'
        ? Vio.attribution(this.effectiveSlot, { sponsorId: doc.sponsorId, campaignId: [doc.campaignId, ...this.slotRegistration.campaignHint] })
        : { slot: this.effectiveSlot || undefined }
    return {
      ...base,
      sponsorId: doc.sponsorId,
      componentTemplateId: REEL_TEMPLATE_ID,
      locationId: this.effectiveSlot || undefined,
      ...(this.vioContentId ? { contentId: this.vioContentId } : {}),
      ...(this.vioContentTitle ? { contentTitle: this.vioContentTitle } : {}),
    }
  }

  private commerceOf(videos: ExperienceVideo[]): AnalyticsCommerce | null {
    const items: NonNullable<AnalyticsCommerce['items']> = []
    const seen = new Set<number>()
    let currency: string | undefined
    for (const v of videos) {
      for (const ref of v.products) {
        if (seen.has(ref.productId)) continue
        seen.add(ref.productId)
        const p = this.products.get(ref.productId)
        items.push({
          productId: ref.productId,
          name: p?.title,
          price: p ? Number(p.price?.amount_incl_taxes ?? p.price?.amount) || undefined : undefined,
        })
        currency ??= p?.price?.currency_code
      }
    }
    return items.length ? { items, currency } : null
  }

  private observeForAnalytics(): void {
    const doc = this.doc
    if (!doc || this.unobserveImpression || !this.isConnected) return
    try {
      this.unobserveImpression = Vio.analytics.observeImpression(this, this.attribution(doc), {
        key: `reel:${this.effectiveSlot || doc.id}`,
        commerce: () => this.commerceOf(doc.videos),
        props: { experience_id: doc.id, revision: doc.revision, videos: doc.videos.length },
      })
    } catch {
      /* analytics never breaks rendering */
    }
  }

  /** `view_item_list` once per video, when it becomes the one on screen. */
  private trackVideoList(index: number): void {
    const doc = this.doc
    const video = doc?.videos[index]
    if (!doc || !video || this.listTracked.has(video.id) || !video.products.length) return
    this.listTracked.add(video.id)
    this.trackSafe('view_item_list', {
      context: this.attribution(doc),
      commerce: this.commerceOf([video]) ?? undefined,
      props: { experience_id: doc.id, video_id: video.id, revision: doc.revision, list_name: video.title ?? doc.title },
    })
  }

  private trackSafe(name: Parameters<typeof Vio.analytics.track>[0], opts: Parameters<typeof Vio.analytics.track>[1]): void {
    try {
      Vio.analytics.track(name, opts)
    } catch {
      /* never break rendering */
    }
  }

  private warn(...args: unknown[]): void {
    try {
      console.warn('[vio-reel]', ...args)
    } catch {
      /* ignore */
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  override render() {
    if (this.status === 'idle' || this.status === 'incompatible' || this.status === 'error' || this.status === 'empty') return nothing
    if (this.status === 'loading' || !this.doc) return html`<div class="reel" aria-busy="true"><div class="skeleton"></div></div>`
    const doc = this.doc
    const identity = resolveSponsorIdentity(doc.sponsorId)
    return html`
      <div class="reel" part="reel">
        <div class="feed" role="list" aria-label=${doc.title || 'Reel'}>
          ${doc.videos.map((video, i) => this.renderItem(doc, video, i, identity))}
        </div>
        ${doc.videos.length > 1
          ? html`<div class="nav">
              <button class="ctrl" @click=${() => this.go(-1)} aria-label="Forrige" ?disabled=${this.active === 0}>↑</button>
              <button class="ctrl" @click=${() => this.go(1)} aria-label="Neste" ?disabled=${this.active >= doc.videos.length - 1}>↓</button>
            </div>`
          : nothing}
      </div>
    `
  }

  private renderItem(doc: Experience, video: ExperienceVideo, i: number, identity: { name?: string; logoUrl?: string | null } | null) {
    const isActive = i === this.active
    return html`
      <section class="item" data-index=${i} role="listitem" aria-label=${video.title ?? `${i + 1}/${doc.videos.length}`}>
        <video
          data-index=${i}
          playsinline
          loop
          .muted=${this.muted}
          preload=${i === 0 ? 'auto' : 'metadata'}
          poster=${video.media.posterUrl ?? ''}
          @timeupdate=${(ev: Event) => this.onTimeUpdate(i, ev)}
          @play=${() => isActive && (this.playing = true)}
          @pause=${() => isActive && (this.playing = false)}
          aria-hidden=${isActive ? 'false' : 'true'}
        ></video>
        <div class="shade"></div>
        <button class="tap" aria-label=${this.playing && isActive ? 'Pause' : 'Spill av'} @click=${() => this.togglePlay()}></button>
        ${isActive && !this.playing ? html`<div class="play-hint" aria-hidden="true">▶</div>` : nothing}
        <div class="top">
          <div class="brand">
            ${identity?.logoUrl ? html`<img src=${identity.logoUrl} alt="" />` : nothing}
            <div style="min-width:0">
              ${identity?.name ? html`<span class="brand-name">${identity.name}</span>` : nothing}
              ${video.title || doc.title ? html`<span class="title">${video.title ?? doc.title}</span>` : nothing}
            </div>
          </div>
          <div class="controls">
            <button class="ctrl" @click=${() => this.toggleMute()} aria-label=${this.muted ? 'Lyd på' : 'Lyd av'} aria-pressed=${!this.muted}>${this.muted ? '🔇' : '🔊'}</button>
            <button class="ctrl" @click=${() => this.toggleFullscreen()} aria-label=${this.fullscreen ? 'Avslutt fullskjerm' : 'Fullskjerm'}>${this.fullscreen ? '⤡' : '⤢'}</button>
          </div>
        </div>
        ${doc.videos.length > 1 ? html`<div class="counter">${i + 1}/${doc.videos.length}</div>` : nothing}
        <div class="bottom">
          ${video.products.length ? html`<div class="products" role="list">${video.products.map((ref) => this.renderCard(video, ref, isActive))}</div>` : nothing}
          <div class="progress" aria-hidden="true"><i style=${`width:${isActive ? this.progress : 0}%`}></i></div>
        </div>
      </section>
    `
  }

  private renderCard(video: ExperienceVideo, ref: ExperienceProduct, isActive: boolean) {
    const p = this.products.get(ref.productId)
    const img = this.imageOf(ref, p)
    const current = isActive && this.cueProductId === ref.productId
    const focal = ref.focal ? `object-position:${Math.round(ref.focal.x * 100)}% ${Math.round(ref.focal.y * 100)}%` : ''
    return html`
      <button class="card ${current ? 'current' : ''}" data-product=${ref.productId} role="listitem" @click=${() => this.openProduct(video, ref)} aria-label=${p?.title ?? `Produkt ${ref.productId}`}>
        ${current ? html`<span class="cue">${this.cueLabel}</span>` : nothing}
        ${img ? html`<img src=${img} alt="" loading="lazy" style=${focal} />` : html`<span class="ph"></span>`}
        <span class="txt">
          ${p?.brand ? html`<span class="b">${p.brand}</span>` : nothing}
          <span class="n">${p?.title ?? ''}</span>
          ${p ? html`<span class="p">${displayPrice(p)}</span>` : nothing}
        </span>
      </button>
    `
  }
}
