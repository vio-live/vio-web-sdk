/**
 * Vio.analytics — the web SDK's half of the Vio Analytics pipeline.
 *
 * Events flow to the Vio collector (`POST <eventsBase>/v1/events`, repo
 * vio-live/vio-analytics) which owns raw storage (ClickHouse) and vendor
 * fan-out (Mixpanel today). THE SDK NEVER TALKS TO VENDORS — swapping or
 * dropping a vendor is a server-side change, zero client releases.
 * Wire contract: vio-analytics `docs/EVENTS_CONTRACT.md` (v1, snake_case).
 *
 * Design rules:
 * - SIDE-EFFECT-FREE MODULE. Nothing runs at import time (tsup/tree-shaking
 *   contract, see lessons/web-sdk-tsup-singleton-and-build). Listeners are
 *   installed by an explicit `Vio.analytics.start()`.
 * - `track()` works BEFORE `Vio.init()` — events queue and flush once the
 *   SDK is configured (transport resolves at flush time, not at track time).
 * - SSR-safe: without `window` every call is a silent no-op.
 * - Retries are safe: `event_id` is stable per event, the collector
 *   dedupes. Queue is bounded (drop-oldest) so a dead collector can never
 *   grow memory unbounded.
 * - Anti-double-count: the SDK only reports what the server can't see.
 *   Votes/participations are server truth; `ad_activation`/`cart_intent`
 *   are mirrored server-side, never from here.
 *
 * Three sinks, matching the Vev precedent (vio-vev analytics.ts, which
 * becomes an adapter over this in F3):
 *   1. collector (default ON once started)
 *   2. window.dataLayer — GA4/GTM (opt-in `start({ dataLayer: true })`,
 *      the publisher-facing feature; NOT part of the Vio pipeline)
 *   3. `vio:analytics` DOM event — always when started (inspector/bridges)
 */

import { Configuration } from '../configuration.js'
import { CONTENT_ID_MAX_LENGTH, CONTENT_TITLE_MAX_LENGTH, capContentUrl, resolveContent, type ContentRef } from '../content.js'
import {
  activeCampaignEntry,
  assignmentApplies,
  findSlotAssignmentDetail,
  sponsorCampaignEntry,
  toNumber,
  type CampaignHint,
} from '../slots.js'
import { SDK_VERSION } from '../version.js'
import { normalizeBuyerRef } from '../buyer-ref.js'
import {
  persistLanding,
  removeLanding,
  resolveClientContext,
  resolveLanding,
  type ClientContext,
  type Landing,
} from './client-context.js'
import { readInternal, resolveInternal, writeInternal } from './internal-traffic.js'
import { ctaContextOf, type CtaClickDetail, type CtaInput } from './cta.js'
import type { CartManager, CartChangeDetail } from '../cart/cart-manager.js'
import { cartSlicesFrom, hasExplicitCampaign, itemLayoutOf, lineItemsByLayout, type CartSlice } from '../cart/slices.js'
import { layoutToken, normalizeLayoutOrigin } from '../detail-layout.js'
import type { CartLineItem } from '../cart/types.js'
import type { CheckoutReference } from '../api/cart-queries.js'
import type { BootstrapCampaignEntry, BootstrapResponse } from '../types.js'
import type { CheckoutSponsor } from '../sponsor-identity.js'

// ── Taxonomy (client-side subset of contract v1) ────────────────────────────

export const ANALYTICS_EVENT_NAMES = [
  // commerce (GA4-compatible)
  'view_item_list',
  'select_item',
  'view_item',
  'add_to_cart',
  'remove_from_cart',
  'view_cart',
  'begin_checkout',
  'add_payment_info',
  'purchase',
  // engagement
  'component_impression',
  'component_click',
  'ad_impression',
  'ad_click',
  'poll_impression',
  'contest_impression',
  // which button a shopper tapped (see ./cta.ts, README «Button tracking»)
  'cta_click',
  // session
  'session_start',
  'session_end',
  // diagnóstico — lo que salió MAL (ver EVENTS_CONTRACT.md)
  'checkout_error',
  'sdk_error',
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

/** Camel-case for DX; mapped to the snake_case wire format at build time. */
export interface AnalyticsContext {
  /**
   * The `<vio-product-detail>` layout shown (0.34), on `view_item` and only
   * for a non-default layout: `layout_id`, `layout_revision`, `experiment_id`,
   * `variant_id` in the event's `context` (next to `campaign_id` /
   * `location_id`). `variantId` is the experiment variant.
   */
  layoutId?: string
  layoutRevision?: string
  experimentId?: string
  variantId?: string
  campaignId?: number
  broadcastId?: string
  campaignComponentId?: number
  appPlacementId?: number
  locationId?: string
  componentTemplateId?: string
  sponsorId?: number
  activationId?: number
  contentUrl?: string
  /**
   * The host's own id for the piece of content the component sits in — an
   * article id in a CMS, a page id in a site builder. Carried verbatim so the
   * host can join Vio's funnel back onto its own per-article reporting
   * (revenue stops being an estimate). Left alone by the SDK.
   */
  contentId?: string | number
  /** Human-readable content snapshot; auto-filled from document.title. */
  contentTitle?: string
  /** Código corto del fallo (`sdk_error` / `checkout_error`). */
  errorCode?: string
  variant?: string
  /**
   * `cta_click` only (see ./cta.ts): the button's id (`cta`), where it is
   * (`cta_location`), its visible text (`cta_label`), the host's name of the
   * button option it tests (`cta_variant`), the option value chosen
   * (`option_value`), the product (`product_id`) and the PRODUCT variant
   * (`product_variant_id` — `variantId` above is the layout's experiment
   * variant). Build them with `ctaContextOf()`, which validates them.
   */
  cta?: string
  ctaLocation?: string
  ctaLabel?: string
  ctaVariant?: string
  optionValue?: string
  productId?: string
  productVariantId?: string
  /**
   * The slot (ADR-0027) the component sits in — its `vio-slot`. Attribution
   * follows it: the event's `campaign_id` is the campaign assigned to the slot
   * right now, before the sponsor rule. On the wire it fills `location_id`
   * when no explicit `locationId` is given (a slot IS a location id to the
   * campaigns service).
   */
  slot?: string
}

export interface AnalyticsItemInput {
  productId: number | string
  name?: string
  brand?: string
  /** The PRODUCT variant (`variant_id` on the wire). */
  variantId?: number | string
  price?: number
  quantity?: number
  /**
   * The `<vio-product-detail>` layout these units were added from (0.34), from
   * the cart line's origin: `layout_id`, `layout_revision`, `experiment_id`,
   * `experiment_variant_id` on the wire. When any of them is given, all four
   * go out (`''` for the missing ones); the SDK's events with cart items give
   * them always (`''` when the units came from no layout).
   */
  layoutId?: string
  layoutRevision?: string
  experimentId?: string
  /** The EXPERIMENT variant of the layout — not the product variant. */
  experimentVariantId?: string
}

export interface AnalyticsCommerce {
  items?: AnalyticsItemInput[]
  value?: number
  currency?: string
  /**
   * `order_id` on the wire. On a `purchase` it is Vio's order number (`4415`,
   * the number the dashboard and Commerce's cancellations use), else the
   * checkout id standing in for it (`props.order_id_kind` says which).
   */
  orderId?: string
  /** `checkout_id` on the wire: Vio's checkout id (uuid). Always on the SDK's own `purchase`. */
  checkoutId?: string
  paymentMethod?: string
  /**
   * The buyer reference (`buyer_id` on the wire): shopcart's `buyer_ref`, a
   * keyed hash of the buyer's email — one person, one ref across orders and
   * devices, nothing reversible. Never an email (see core/buyer-ref.ts).
   */
  buyerId?: string
}

export interface TrackOptions {
  context?: AnalyticsContext
  commerce?: AnalyticsCommerce
  props?: Record<string, unknown>
}

export interface AnalyticsStartOptions {
  /** Where the SDK is embedded: 'vev' | 'replit' | 'custom' | … Default 'custom'. */
  host?: string
  /**
   * Arrancar en modo cookieless hasta que el host llame `setConsent(true)`.
   * Default false: el SDK asume que el CMP del publisher ya decidió si nos
   * carga. Los publishers EU que necesitan medir antes del consentimiento
   * (o no pueden persistir sin él) ponen true.
   */
  requireConsent?: boolean
  /**
   * Install the automatic funnel listeners (vio:added-to-cart,
   * vio:checkout-open, vio:open-cart, vio:payment-success). Default true.
   * Hosts with their OWN instrumentation choke point (e.g. the Vev module,
   * which forwards every event through trackEvent()) set false so the same
   * user action is never tracked twice — they keep the session/batching/
   * transport engine and call track() themselves.
   */
  autoTrack?: boolean
  /**
   * Adopt the host's session id instead of minting one. A host that already
   * tracks its readers (its own impressions, dwell, clicks) needs Vio's
   * purchases to land in the SAME session, or the two datasets cannot be
   * joined. Pass the id the host already stores; omit it and the SDK keeps
   * its own rotating session.
   */
  sessionId?: string
  /**
   * Dejar de capturar QUÉ contenido se está viendo: sin `content_url`,
   * `content_title`, `content_id` ni nombre/marca de producto. Default false
   * (se captura).
   *
   * Para superficies donde el contenido ES el dato sensible — una app de
   * salud: la pantalla abierta y el producto comprado revelan la condición
   * aunque el dispositivo sea anónimo. El funnel se sigue midiendo: ids de
   * campaña y componente, cantidades e importes.
   *
   * El colector lo aplica igual del lado del servidor para las surfaces
   * marcadas (`client_apps.privacy_mode = 'minimal'`); este interruptor evita
   * que el dato salga del dispositivo.
   */
  privateContent?: boolean
  /** Send to the Vio collector. Default true. */
  collector?: boolean
  /** Also push GA4 e-commerce events to window.dataLayer (publisher feature). */
  dataLayer?: boolean
  /** console.debug every event. */
  debug?: boolean
}

// ── Tunables (contract-aligned) ─────────────────────────────────────────────

/**
 * A `purchase` whose payment event did not bring Vio's order number (a
 * redirect return, an order a webhook creates) waits for it: the checkout is
 * asked at once and again after each of these waits — ~10 s in all.
 */
const ORDER_NUMBER_BACKOFF_MS = [500, 1_000, 2_000, 3_000, 3_000] as const
/** Longest a `purchase` waits for its order number; then it goes out with the checkout id. */
const ORDER_NUMBER_MAX_WAIT_MS = 10_000

const SESSION_TTL_MS = 30 * 60 * 1000 // rolling 30-min session
const FLUSH_INTERVAL_MS = 5_000
const FLUSH_AT_COUNT = 20
const MAX_QUEUE = 500 // drop-oldest beyond this
const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000]
const ANON_KEY = 'vio.anon.v1'
/** The collector's cap on commerce lines per event (`ANALYTICS_LIMITS.MAX_ITEMS`). */
const MAX_ITEMS = 100
const SESSION_KEY = 'vio.session.v1'

/** Impression rule: ≥50% visible for ≥1s, once per (session, component). */
const IMPRESSION_THRESHOLD = 0.5
const IMPRESSION_DWELL_MS = 1_000

// ── Wire shape (snake_case, contract v1) ────────────────────────────────────

interface WireEvent {
  event_id: string
  name: AnalyticsEventName
  ts: string
  surface: 'web'
  host?: string
  sdk_version: string
  session_id: string
  anon_id: string
  external_user_id?: string
  context?: Record<string, unknown>
  commerce?: Record<string, unknown>
  /** The standard context of the visit (contract "client"); the same object on every event of a page load. */
  client?: Record<string, unknown>
  props?: Record<string, unknown>
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class AnalyticsManager extends EventTarget {
  private started = false
  private options: Required<
    Pick<
      AnalyticsStartOptions,
      'collector' | 'dataLayer' | 'debug' | 'autoTrack' | 'privateContent'
    >
  > & {
    host: string
  } = {
    host: 'custom',
    collector: true,
    dataLayer: false,
    debug: false,
    autoTrack: true,
    privateContent: false,
  }

  private queue: WireEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private retryAttempt = 0
  private retryNotBefore = 0
  private externalUserId: string | undefined

  private sessionId: string | null = null
  private requireConsent = false
  private consentGranted = false
  private anonIdCache: string | null = null

  /** Set via start({ sessionId }) — the host owns the session, we follow. */
  private externalSessionId: string | null = null
  private sessionStartedAt = 0
  /** Impression once-per-(session, component) guard; reset on session rotation. */
  private impressedComponents = new Set<string>()

  /** Last NON-EMPTY cart snapshot — `purchase` uses it because several flows
   * (Apple Pay) clear the cart BEFORE `vio:payment-success` fires. */
  private lastCartSnapshot: { items: CartLineItem[]; currency?: string } | null = null

  /** The `client` block (language, landing referrer / utm, screen, tz): read once per page load, reused on every event. */
  private client: ClientContext | null = null
  /** The landing it was read from — persisted later when consent arrives after the first event. */
  private landing: Landing | null = null
  /**
   * Internal traffic (ADR-0041): `client.internal: true` on every event while
   * set. Read once (`?vio_internal=1|0`, else `localStorage`) at `Vio.init()`
   * or on the first event; `setInternal()` changes it. `null` = not read yet.
   */
  private internal: boolean | null = null
  /** The console line for testers goes out once per page load. */
  private internalAnnounced = false

  /** Checkouts (`c:<id>`) and orders (`o:<number>`) this page load reported a `purchase` for: one each. */
  private readonly purchased = new Set<string>()
  /** Checkouts this page load reported an `add_payment_info` for: one each. */
  private readonly paymentInfoReported = new Set<string>()
  /** Purchases still waiting for Vio's order number: each sends at once, with what it has, when called. */
  private readonly pendingPurchases = new Set<() => void>()
  /** Between `pagehide` and `pageshow` (bfcache): nothing waits, it all goes out now. */
  private pageHiding = false

  /** The landing this manager resolved on this page load (the first event's), or null before it; read only — for the order's entry context when nothing is stored yet. */
  get currentLanding(): Landing | null {
    return this.landing
  }

  private teardown: Array<() => void> = []

  // MARK: - Public API

  /**
   * Install listeners + begin flushing. Explicit on purpose (no module
   * side-effects). Safe to call twice (second call only updates options).
   */
  /**
   * Consentimiento (ePrivacy/GDPR). Por defecto el SDK asume que el host ya
   * lo gestionó — su CMP decide si nos carga. Con `requireConsent: true`
   * arranca en modo **cookieless**: mide la visita con ids efímeros en
   * memoria y NO escribe nada en localStorage hasta que el host llame
   * `setConsent(true)`. Retirarlo borra lo persistido.
   */
  setConsent(granted: boolean): void {
    this.consentGranted = granted
    if (granted) {
      // Promueve los ids efímeros a persistentes: la visita en curso no se
      // parte en dos por haber aceptado a mitad de camino.
      if (this.anonIdCache) safeStorageSet(ANON_KEY, this.anonIdCache)
      if (this.sessionId) this.persistSession()
      // And the landing (referrer / utm), so the next pages of the session inherit it.
      if (this.landing) persistLanding(this.landing)
      return
    }
    safeStorageRemove(ANON_KEY)
    safeStorageRemove(SESSION_KEY)
    removeLanding()
  }

  /** ¿Podemos escribir en el dispositivo? */
  private get canPersist(): boolean {
    return !this.requireConsent || this.consentGranted
  }

  start(options: AnalyticsStartOptions = {}): void {
    this.requireConsent = options.requireConsent === true
    this.options = {
      host: options.host ?? this.options.host,
      collector: options.collector ?? this.options.collector,
      dataLayer: options.dataLayer ?? this.options.dataLayer,
      debug: options.debug ?? this.options.debug,
      autoTrack: options.autoTrack ?? this.options.autoTrack,
      privateContent: options.privateContent ?? this.options.privateContent,
    }
    // A host-supplied session id wins over our own: it is the only way the
    // host can join Vio's funnel onto the events it already collects.
    if (options.sessionId) this.externalSessionId = options.sessionId

    if (this.started || !hasDom()) return
    this.started = true

    this.ensureSession() // emits session_start

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)

    const onPageHide = () => {
      this.pageHiding = true
      // A purchase still waiting for its order number goes out now, with the
      // checkout id: the page will not wait for it.
      this.settlePendingPurchases()
      this.trackSessionEnd()
      this.flushWithBeacon()
    }
    const onPageShow = () => {
      this.pageHiding = false
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    this.teardown.push(() => window.removeEventListener('pagehide', onPageHide))
    this.teardown.push(() => window.removeEventListener('pageshow', onPageShow))
    // On a phone the page may never see `pagehide`: hidden is the last word it
    // is sure to get, and a hidden tab may be discarded without running another
    // timer. A purchase still waiting for its order number goes out now, and
    // whatever is queued leaves with it, by beacon (order 4128, 2026-10-23: a
    // purchase already in the queue stayed there when the page hid).
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      const onVisibility = () => {
        if (document.visibilityState !== 'hidden') return
        this.settlePendingPurchases()
        this.flushWithBeacon()
      }
      document.addEventListener('visibilitychange', onVisibility)
      this.teardown.push(() => document.removeEventListener('visibilitychange', onVisibility))
    }

    if (this.options.autoTrack) this.installAutoListeners()
  }

  /** Stop timers + listeners (tests / SPA unmount). Queue survives — a purchase still waiting for its order number joins it now. */
  stop(): void {
    this.settlePendingPurchases()
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
    for (const fn of this.teardown.splice(0)) fn()
    this.started = false
  }

  /** Attach the partner's user id (opaque) to all subsequent events. */
  identify(externalUserId: string | null): void {
    this.externalUserId = externalUserId ?? undefined
  }

  /**
   * Mark (or unmark) this browser as Vio's own traffic (ADR-0041): while
   * marked, every event carries `client.internal: true` and the collector's
   * reads leave it out. Remembered in `localStorage` (`vio.internal.v1`) —
   * the same mark `?vio_internal=1` / `?vio_internal=0` sets on any page.
   */
  setInternal(internal: boolean): void {
    this.internal = internal === true
    writeInternal(this.internal)
    this.announceInternal()
  }

  /** Whether this browser is marked as internal traffic (reads the mark the first time). */
  get isInternal(): boolean {
    return this.syncInternal()
  }

  /**
   * Read the mark: the page's `?vio_internal=1|0` (remembered), else what the
   * browser remembers. Once per page load — `Vio.init()` calls it so a page
   * with the parameter marks the browser even if it never starts analytics;
   * `force` reads again.
   */
  syncInternal(force = false): boolean {
    if (this.internal === null || force) {
      this.internal = hasDom() ? resolveInternal() : readInternal(null)
      this.announceInternal()
    }
    return this.internal
  }

  /** One console line when marked, so a tester can see the mark took. */
  private announceInternal(): void {
    if (!this.internal || this.internalAnnounced) return
    this.internalAnnounced = true
    try {
      console.info('[Vio.analytics] this browser is marked as internal traffic (vio_internal=1): its events are not counted. Open any page with ?vio_internal=0 to undo.')
    } catch {
      /* no console */
    }
  }

  /** Queue one event. Works pre-init and pre-start (SSR: no-op). */
  track(name: AnalyticsEventName, opts: TrackOptions = {}): void {
    if (!hasDom()) return
    this.record(this.buildEvent(name, opts))
  }

  /** The sinks and the queue for one built event — `track`'s second half. */
  private record(event: WireEvent | null): void {
    if (!event) return

    if (this.options.debug) {
      console.debug('[Vio.analytics]', event.name, event)
    }
    // DOM sink — inspector/bridges (always once started; harmless before).
    try {
      window.dispatchEvent(new CustomEvent('vio:analytics', { detail: event }))
    } catch {
      /* CustomEvent unavailable — ignore */
    }
    if (this.options.dataLayer) pushGa4(event)

    this.queue.push(event)
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE)
    if (this.queue.length >= FLUSH_AT_COUNT) void this.flush()
  }

  /**
   * One `cta_click` — a tap on a button (README «Button tracking»). What
   * `Vio.trackCta()` calls for a host's own buttons; the SDK's elements reach
   * it through `vio:cta-click`. Only once `start()` ran — like the funnel
   * events of the elements, never queued before. An invalid `cta` is ignored
   * with one `console.warn`; consent, `privateContent`, internal traffic,
   * batching and attribution are those of every event.
   */
  trackCta(input: CtaInput): void {
    if (!hasDom() || !this.started) return
    const context = ctaContextOf(input)
    if (!context) return
    this.track('cta_click', { context })
  }

  /**
   * Impression helper: observes an element and tracks ONE
   * `component_impression` per (session, campaignComponentId) when the
   * contract's rule is met (≥50% visible, ≥1s dwell). Returns an
   * unobserve function.
   */
  observeImpression(
    element: Element,
    context: AnalyticsContext = {},
    opts: {
      name?: Extract<AnalyticsEventName, 'component_impression' | 'ad_impression'>
      /** Dedupe key override. Defaults to the strongest id available:
       *  campaignComponentId → locationId → componentTemplateId. */
      key?: string
      /** Called the one time the impression is tracked (e.g. to fire a
       *  companion view_item_list). */
      onImpression?: () => void
      /** What the element shows, read when the impression fires: its
       *  products go out as `commerce.items` (the collector counts a
       *  per-product impression from them, ADR-0041). Nothing when it
       *  answers no items. */
      commerce?: () => AnalyticsCommerce | null | undefined
    } = {},
  ): () => void {
    if (!hasDom() || typeof IntersectionObserver === 'undefined') return () => {}
    const name = opts.name ?? 'component_impression'
    const dedupe =
      opts.key ??
      String(
        context.campaignComponentId ??
          context.locationId ??
          context.componentTemplateId ??
          'component',
      )
    let dwellTimer: ReturnType<typeof setTimeout> | null = null

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= IMPRESSION_THRESHOLD) {
            if (dwellTimer) continue
            dwellTimer = setTimeout(() => {
              const key = `${name}:${dedupe}`
              this.ensureSession()
              if (this.impressedComponents.has(key)) return
              this.impressedComponents.add(key)
              this.track(name, { context, commerce: impressionCommerce(opts.commerce) })
              opts.onImpression?.()
              observer.disconnect()
            }, IMPRESSION_DWELL_MS)
          } else if (dwellTimer) {
            clearTimeout(dwellTimer) // left the viewport before the dwell — not an impression
            dwellTimer = null
          }
        }
      },
      { threshold: [IMPRESSION_THRESHOLD] },
    )
    observer.observe(element)
    return () => {
      if (dwellTimer) clearTimeout(dwellTimer)
      observer.disconnect()
    }
  }

  /** Force a flush (mostly for tests). */
  async flush(): Promise<void> {
    if (!this.options.collector) {
      this.queue = []
      return
    }
    if (this.queue.length === 0) return
    if (!Configuration.isInitialized) return // transport unknown — hold the queue
    if (Date.now() < this.retryNotBefore) return

    const batch = this.queue.splice(0, MAX_QUEUE)
    const apiKey = Configuration.get().apiKey
    const body = JSON.stringify({
      apiKey,
      sent_at: new Date().toISOString(),
      events: batch,
    })
    try {
      // The key travels in the body too (sendBeacon can't set headers), but
      // the collector rate-limits by X-Api-Key and only falls back to the IP:
      // without the header every publisher behind one NAT shares a bucket.
      const res = await fetch(`${eventsBase()}/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body,
        keepalive: batch.length <= 20, // keepalive caps payload at ~64KB
      })
      if (res.status === 401 || res.status === 400) {
        // Config problem, not transient — drop, don't loop forever.
        console.warn(`[Vio.analytics] collector rejected batch (HTTP ${res.status}) — dropped`)
        this.retryAttempt = 0
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.retryAttempt = 0
    } catch {
      // Requeue at the FRONT (same event_ids — server dedupes) + backoff.
      this.queue.unshift(...batch)
      const backoff =
        RETRY_BACKOFF_MS[Math.min(this.retryAttempt, RETRY_BACKOFF_MS.length - 1)] ?? 8_000
      this.retryAttempt++
      this.retryNotBefore = Date.now() + backoff
    }
  }

  // MARK: - Internals

  private buildEvent(name: AnalyticsEventName, opts: TrackOptions): WireEvent | null {
    this.ensureSession()
    if (!this.sessionId) return null
    const anonId = this.anonId()
    if (!anonId) return null

    const boot = vioBootstrapCache()
    const ctx = opts.context ?? {}
    // The article/page this instance renders in — resolved by the SDK when the
    // event brings no explicit content, or when the explicit id does not fit
    // the collector (see core/content.ts). The ONE place the collector's caps
    // are enforced: it rejects a whole event over a long id, silently.
    const explicitContentId = fitsId(ctx.contentId)
    const content =
      explicitContentId === undefined || ctx.contentTitle === undefined ? vioContent() : {}
    const context: Record<string, unknown> = compact({
      campaign_id: resolveCampaignId(ctx, boot),
      broadcast_id: ctx.broadcastId,
      campaign_component_id: ctx.campaignComponentId,
      app_placement_id: ctx.appPlacementId,
      // A slot is a location id to the campaigns service (ADR-0027). An
      // explicit location id that does not fit gives way to the slot.
      location_id: fitsId(ctx.locationId) ?? fitsId(ctx.slot),
      component_template_id: ctx.componentTemplateId,
      sponsor_id: ctx.sponsorId,
      activation_id: ctx.activationId,
      // Cut to the collector's 2 048 — the query string first, since a long
      // one is usually the tracking tail, not the page. The other host-given
      // fields (broadcastId, componentTemplateId, errorCode, variant, …) are
      // the host's responsibility: the SDK does not touch them.
      // Con `privateContent` ninguno de los tres sale del dispositivo.
      content_url: this.options.privateContent
        ? undefined
        : capContentUrl(ctx.contentUrl ?? (typeof location !== 'undefined' ? location.href : undefined)),
      // The host's own content id — its join key back onto its reporting.
      // Explicit on the event when it fits, else what the SDK resolved for
      // the page (already capped per source), else nothing.
      content_id: this.options.privateContent ? undefined : (explicitContentId ?? fitsId(content.id)),
      // Deletion-proof reporting: sources have no trash bin — the title
      // snapshotted at event time keeps reports legible if content dies.
      error_code: ctx.errorCode,
      content_title: this.options.privateContent
        ? undefined
        : capTitle(
            ctx.contentTitle ??
              content.title ??
              (typeof document !== 'undefined' && document.title ? document.title : undefined),
          ),
      variant: ctx.variant,
      // The detail layout shown (0.34) — `view_item` of a non-default layout.
      layout_id: ctx.layoutId,
      layout_revision: ctx.layoutRevision,
      experiment_id: ctx.experimentId,
      variant_id: ctx.variantId,
      // `cta_click` (./cta.ts). Con `privateContent` el texto del botón y el
      // valor elegido no salen del dispositivo: pueden nombrar el producto.
      cta: ctx.cta,
      cta_location: ctx.ctaLocation,
      cta_label: this.options.privateContent ? undefined : ctx.ctaLabel,
      cta_variant: ctx.ctaVariant,
      option_value: this.options.privateContent ? undefined : ctx.optionValue,
      product_id: ctx.productId,
      product_variant_id: ctx.productVariantId,
    })

    const com = opts.commerce
    const commerce = com
      ? compact({
          // The collector rejects an event with more lines than its cap, whole.
          items: com.items?.slice(0, MAX_ITEMS).map((i) => ({
            ...compact({
              product_id: String(i.productId),
              name: this.options.privateContent ? undefined : i.name,
              brand: this.options.privateContent ? undefined : i.brand,
              variant_id: i.variantId !== undefined ? String(i.variantId) : undefined,
              price: i.price,
              quantity: i.quantity,
            }),
            ...itemLayoutWire(i),
          })),
          value: com.value,
          currency: com.currency,
          order_id: com.orderId,
          // A uuid always fits; anything over the collector's 128 is left out, not cut.
          checkout_id: fitsId(com.checkoutId),
          payment_method: com.paymentMethod,
          // Only a reference survives — never an email, whatever a host passes —
          // and only with consent to persist: a visit measured with ephemeral
          // ids does not carry a stable identifier of a person either.
          buyer_id: this.canPersist ? normalizeBuyerRef(com.buyerId) : undefined,
        })
      : undefined
    const base = this.clientBlock()
    // Internal traffic rides in the `client` block, as `client.internal`.
    const client = this.syncInternal() ? { ...(base ?? {}), internal: true } : base

    return {
      event_id: uuid(),
      name,
      ts: new Date().toISOString(),
      surface: 'web',
      host: this.options.host,
      sdk_version: SDK_VERSION,
      session_id: this.sessionId,
      anon_id: anonId,
      ...(this.externalUserId ? { external_user_id: this.externalUserId } : {}),
      ...(Object.keys(context).length ? { context } : {}),
      ...(commerce ? { commerce } : {}),
      ...(client ? { client } : {}),
      ...(opts.props ? { props: opts.props } : {}),
    }
  }

  /**
   * The `client` block: read once — the landing is remembered for the session
   * only when we may persist — then the same (frozen) object on every event.
   * `null` when there is nothing to say (no browser).
   */
  private clientBlock(): Record<string, unknown> | null {
    if (!this.client) {
      this.landing = resolveLanding(undefined, this.canPersist)
      this.client = Object.freeze(resolveClientContext(undefined, this.landing))
    }
    return Object.keys(this.client).length ? (this.client as Record<string, unknown>) : null
  }

  /** Guarda la sesión solo si podemos escribir en el dispositivo. */
  private persistSession(now: number = Date.now()): void {
    if (!this.canPersist || !this.sessionId) return
    safeStorageSet(
      SESSION_KEY,
      JSON.stringify({
        id: this.sessionId,
        ts: now,
        startedAt: this.sessionStartedAt ?? now,
      }),
    )
  }

  private anonId(): string | null {
    if (this.anonIdCache) return this.anonIdCache
    const stored = this.canPersist ? safeStorageGet(ANON_KEY) : null
    if (stored) {
      this.anonIdCache = stored
      return stored
    }
    const id = `a-${uuid()}`
    // Sin consentimiento el id vive solo en memoria: se mide la visita, no
    // queda rastro en el dispositivo.
    if (this.canPersist) safeStorageSet(ANON_KEY, id)
    this.anonIdCache = (this.canPersist ? safeStorageGet(ANON_KEY) : null) ?? id
    return this.anonIdCache
  }

  /** Rolling session: renewed by activity, rotated after 30 min idle. */
  private ensureSession(): void {
    const now = Date.now()
    if (!this.sessionId) {
      const stored = this.canPersist ? safeStorageGet(SESSION_KEY) : null
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { id: string; ts: number; startedAt: number }
          if (now - parsed.ts < SESSION_TTL_MS) {
            this.sessionId = parsed.id
            this.sessionStartedAt = parsed.startedAt ?? now
          }
        } catch {
          /* corrupted — rotate */
        }
      }
    } else {
      const stored = this.canPersist ? safeStorageGet(SESSION_KEY) : null
      if (stored) {
        try {
          if (now - (JSON.parse(stored) as { ts: number }).ts >= SESSION_TTL_MS) {
            this.sessionId = null // idle too long — rotate
          }
        } catch {
          this.sessionId = null
        }
      }
    }

    if (this.externalSessionId) {
      // The host rotates its own session; we never expire or replace it.
      if (this.sessionId !== this.externalSessionId) {
        this.sessionId = this.externalSessionId
        this.sessionStartedAt = now
        this.impressedComponents.clear()
      }
    }

    if (!this.sessionId) {
      this.sessionId = `s-${uuid()}`
      this.sessionStartedAt = now
      this.impressedComponents.clear()
      this.persistSession(now)
      this.track('session_start')
    } else {
      this.persistSession(now)
    }
  }

  private trackSessionEnd(): void {
    if (!this.sessionId) return
    this.track('session_end', {
      props: { duration_ms: Date.now() - this.sessionStartedAt },
    })
  }

  private flushWithBeacon(): void {
    if (!this.options.collector || this.queue.length === 0) return
    if (!Configuration.isInitialized) return
    const batch = this.queue.splice(0, MAX_QUEUE)
    const body = JSON.stringify({
      apiKey: Configuration.get().apiKey,
      sent_at: new Date().toISOString(),
      events: batch,
    })
    // text/plain skips the CORS preflight a beacon can't perform; the
    // collector parses it as JSON (contract §transport).
    const ok =
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      navigator.sendBeacon(`${eventsBase()}/v1/events`, new Blob([body], { type: 'text/plain' }))
    if (!ok) this.queue.unshift(...batch) // beacon refused — keep for a live flush
  }

  /**
   * Auto-instrumentation over the SDK's own DOM events — the host app
   * writes ZERO tracking code for the commerce funnel.
   */
  private installAutoListeners(): void {
    const on = (type: string, handler: (ev: Event) => void) => {
      window.addEventListener(type, handler)
      this.teardown.push(() => window.removeEventListener(type, handler))
    }

    // Cart snapshot — kept fresh so `purchase` survives the pre-success
    // cart clear (Apple Pay flow).
    const cart = vioCart()
    if (cart) {
      const onChange = (ev: Event) => {
        const detail = (ev as CustomEvent<CartChangeDetail>).detail
        if (!detail) return
        const items: CartLineItem[] = []
        detail.cartsBySponsor?.forEach((state) => items.push(...state.items))
        if (items.length > 0) {
          this.lastCartSnapshot = { items: items.map((i) => ({ ...i })), currency: items[0]?.currency }
        }
      }
      cart.addEventListener('change', onChange)
      this.teardown.push(() => cart.removeEventListener('change', onChange))
    }

    on('vio:added-to-cart', (ev) => {
      const d = (ev as CustomEvent<{ productId?: number | string; sponsorId?: number; campaignId?: number; quantity?: number; variantId?: number | string; slot?: string; contentId?: string | number; contentTitle?: string; componentTemplateId?: string; layout?: unknown }>).detail ?? {}
      const line = this.findLine(d.productId, d.variantId)
      this.track('add_to_cart', {
        context: { sponsorId: d.sponsorId !== undefined ? Number(d.sponsorId) : undefined, campaignId: campaignOf(d), slot: slotOf(d), componentTemplateId: templateOf(d), ...contentOf(d) },
        commerce: {
          // The detail layout the units were added from (0.34): the add's own
          // (`detail.layout`, set by <vio-product-detail>), '' when none.
          items: withLineLayouts([
            {
              productId: d.productId ?? line?.productId ?? '',
              name: line?.name,
              brand: line?.brand,
              variantId: d.variantId ?? line?.variantId,
              price: line?.unitPrice,
              quantity: d.quantity ?? 1,
              ...itemLayoutOf(normalizeLayoutOrigin(d.layout)),
            },
          ]),
          value: line ? line.unitPrice * (d.quantity ?? 1) : undefined,
          currency: line?.currency,
        },
      })
    })

    on('vio:removed-from-cart', (ev) => {
      const d = (ev as CustomEvent<{
        productId?: number | string
        variantId?: number | string
        name?: string
        brand?: string
        price?: number
        quantity?: number
        currency?: string
        sponsorId?: number
        campaignId?: number
        slot?: string
        contentId?: string | number
        contentTitle?: string
        layout?: unknown
      }>).detail ?? {}
      if (d.productId === undefined) return
      this.track('remove_from_cart', {
        context: { sponsorId: d.sponsorId, campaignId: campaignOf(d), slot: slotOf(d), ...contentOf(d) },
        commerce: {
          items: withLineLayouts([
            {
              productId: d.productId,
              variantId: d.variantId,
              name: d.name,
              brand: d.brand,
              price: d.price,
              quantity: d.quantity,
              ...itemLayoutOf(normalizeLayoutOrigin(d.layout)),
            },
          ]),
          value: (d.price ?? 0) * (d.quantity ?? 1),
          currency: d.currency,
        },
      })
    })

    // Diagnóstico: sin esto, "el carrito falló" es indistinguible de
    // "el usuario se fue".
    on('vio:cart-error', (ev) => {
      const d = (ev as CustomEvent<{ message?: string }>).detail ?? {}
      this.track('sdk_error', {
        context: { errorCode: 'cart_error' },
        props: d.message ? { message: String(d.message).slice(0, 500) } : undefined,
      })
    })

    on('vio:product-click', (ev) => {
      const d = (ev as CustomEvent<{
        productId?: number | string
        sponsorId?: number
        name?: string
        brand?: string
        price?: number | string
        campaignId?: number
        slot?: string
        contentId?: string | number
        contentTitle?: string
        componentTemplateId?: string
      }>).detail ?? {}
      if (d.productId === undefined) return
      const price = Number(d.price)
      this.track('select_item', {
        context: { sponsorId: d.sponsorId !== undefined ? Number(d.sponsorId) : undefined, campaignId: campaignOf(d), slot: slotOf(d), componentTemplateId: templateOf(d), ...contentOf(d) },
        commerce: {
          items: [
            {
              productId: d.productId,
              name: d.name,
              brand: d.brand,
              price: Number.isFinite(price) ? price : undefined,
            },
          ],
        },
      })
    })

    // A tap on one of the SDK's buttons (src/ui/cta.ts) → `cta_click`.
    on('vio:cta-click', (ev) => {
      const d = (ev as CustomEvent<CtaClickDetail>).detail
      if (d) this.trackCta(d)
    })

    on('vio:open-cart', () => {
      const snap = this.cartCommerce()
      this.track('view_cart', snap ? { commerce: snap } : {})
    })

    on('vio:checkout-open', (ev) => {
      const d = (ev as CustomEvent<{ sponsorId?: number; campaignId?: number; slot?: string; contentId?: string | number; contentTitle?: string; componentTemplateId?: string; buyerRef?: string }>).detail ?? {}
      const base: AnalyticsContext = { sponsorId: d.sponsorId, campaignId: campaignOf(d), slot: slotOf(d), componentTemplateId: templateOf(d), ...contentOf(d) }
      // The buyer reference only when the emitter already has it (a host's checkout); the SDK's own has none this early.
      const buyerId = buyerRefOf(d)
      const buyer = buyerId !== undefined ? { buyerId } : {}
      const { slices, explicit } = this.cartSlices(d.sponsorId)
      if (slices.length > 1) {
        // Several campaigns in the cart: one begin_checkout per campaign, each
        // with its own items and value (see cart/slices.ts).
        for (const slice of slices) {
          this.track('begin_checkout', {
            context: this.sliceContext(slice, base),
            commerce: { ...sliceCommerce(slice), ...buyer },
            props: { slice: slice.slice, slices: slice.slices },
          })
        }
        return
      }
      const snap = this.cartCommerce(d.sponsorId)
      this.track('begin_checkout', {
        context: this.singleSliceContext(slices[0], explicit, base),
        ...(snap || buyerId !== undefined ? { commerce: { ...(snap ?? {}), ...buyer } } : {}),
      })
    })

    // The checkout exists (ADR-0039): the one link from the order Commerce
    // confirms (`order_paid`, by `checkout_id`) back to this session, sent
    // before the page leaves for the provider — so a sale whose `purchase`
    // never comes back (a closed tab, a phone that discards the page) still
    // has its session, page and slot. Per campaign, like begin_checkout.
    on('vio:checkout-created', (ev) => {
      const d = (ev as CustomEvent<CheckoutCreatedDetail>).detail ?? {}
      const checkoutId = firstId(d.checkoutId)
      if (!checkoutId || this.paymentInfoReported.has(checkoutId)) return
      this.paymentInfoReported.add(checkoutId)
      const sponsorId = toNumber(d.sponsorId)
      const base: AnalyticsContext = { sponsorId, campaignId: campaignOf(d), slot: slotOf(d), ...contentOf(d) }
      const payment: AnalyticsCommerce = {
        checkoutId,
        ...(typeof d.paymentMethod === 'string' && d.paymentMethod ? { paymentMethod: d.paymentMethod } : {}),
      }
      const { slices, explicit } = this.cartSlices(sponsorId)
      if (slices.length > 1) {
        for (const slice of slices) {
          this.track('add_payment_info', {
            context: this.sliceContext(slice, base),
            commerce: { ...sliceCommerce(slice), ...payment },
            props: { slice: slice.slice, slices: slice.slices },
          })
        }
      } else {
        this.track('add_payment_info', {
          context: this.singleSliceContext(slices[0], explicit, base),
          commerce: { ...(this.cartCommerce(sponsorId) ?? {}), ...payment },
        })
      }
      // Leaving for the provider now: a beacon outlives the navigation.
      if (d.redirect === true) this.flushWithBeacon()
    })

    on('vio:payment-success', (ev) => {
      const d = (ev as CustomEvent<PaymentSuccessDetail>).detail ?? {}
      const ids = purchaseIdsOf(d)
      // One purchase per checkout: another event for a checkout (or an order)
      // this page already reported — or is waiting to — adds nothing.
      if (!this.claimPurchase(ids)) return
      const sponsorId = d.sponsorId !== undefined ? Number(d.sponsorId) : undefined
      const base: AnalyticsContext = { sponsorId, campaignId: campaignOf(d), slot: slotOf(d), ...contentOf(d) }
      // Read NOW, whenever the event leaves: the cart is cleared right after
      // this event (the pre-clear snapshot covers the paths that clear first).
      const { slices, explicit } = this.cartSlices(sponsorId)
      const parts: TrackOptions[] =
        slices.length > 1
          ? // Several campaigns paid in one go: one purchase per campaign — its
            // items and value, the SAME order_id — so each campaign's revenue is
            // its own and the order still adds up. `props.slice/slices` lets the
            // collector count the order once.
            slices.map((slice) => ({
              context: this.sliceContext(slice, base),
              commerce: { ...sliceCommerce(slice), paymentMethod: d.method },
              props: { slice: slice.slice, slices: slice.slices },
            }))
          : [
              {
                context: this.singleSliceContext(slices[0], explicit, base),
                // value / currency / items: the cart snapshot, on every path.
                commerce: { ...(this.cartCommerce(sponsorId) ?? {}), paymentMethod: d.method },
              },
            ]
      this.reportPurchase(parts, ids, buyerRefOf(d), sponsorId)
    })
  }

  /**
   * Claims the purchase of a payment for this page load: false when its
   * checkout (or its order) already has one, reported or waiting.
   */
  private claimPurchase(ids: PurchaseIds): boolean {
    const keys: string[] = []
    if (ids.checkoutId) keys.push(`c:${ids.checkoutId}`)
    if (ids.orderIdKind === 'order' && ids.orderId) keys.push(`o:${ids.orderId}`)
    if (keys.some((key) => this.purchased.has(key))) return false
    for (const key of keys) this.purchased.add(key)
    return true
  }

  /**
   * Sends the `purchase` event(s) of one payment — ONCE, with Vio's order
   * number as `order_id` (`props.order_id_kind: 'order'`) and the checkout id
   * as `checkout_id`. When the payment event did not bring the number (a
   * redirect return, an order a webhook creates) the checkout is asked for it
   * — the receipt's own path, `Vio.checkout.getOrderReference` — at once and
   * after 0.5 / 1 / 2 / 3 / 3 s, for at most 10 s; nothing else waits for it.
   * Unanswered, or when the page hides or `stop()` comes first, the events go
   * out with what they have: the checkout id as `order_id`
   * (`order_id_kind: 'checkout'`), as before — and the late number adds no
   * second event. The events are BUILT at the payment — its moment (`ts`),
   * `event_id`, session, page and content — and only the order number (and a
   * buyer reference the payment did not bring) is filled in when it comes.
   */
  private reportPurchase(
    parts: TrackOptions[],
    ids: PurchaseIds,
    buyerId: string | undefined,
    sponsorId: number | undefined,
  ): void {
    const events = parts.map((part) =>
      this.buildEvent('purchase', {
        ...part,
        commerce: {
          ...part.commerce,
          ...(ids.orderId !== undefined ? { orderId: ids.orderId } : {}),
          ...(ids.checkoutId !== undefined ? { checkoutId: ids.checkoutId } : {}),
          ...(buyerId !== undefined ? { buyerId } : {}),
        },
        ...(ids.orderIdKind ? { props: { ...part.props, order_id_kind: ids.orderIdKind } } : {}),
      }),
    )
    const send = (found: OrderReferenceFound = {}) => {
      if (found.orderNumber) this.purchased.add(`o:${found.orderNumber}`)
      // Through the same filter as `buildEvent`: a reference, and only with consent to persist.
      const lateBuyer = this.canPersist ? normalizeBuyerRef(found.buyerRef) : undefined
      for (const event of events) {
        if (!event) continue
        if (found.orderNumber) {
          event.commerce = { ...event.commerce, order_id: found.orderNumber }
          event.props = { ...event.props, order_id_kind: 'order' }
        }
        if (lateBuyer && event.commerce && event.commerce.buyer_id === undefined) {
          event.commerce = { ...event.commerce, buyer_id: lateBuyer }
        }
        this.record(event)
      }
      // The purchase does not wait for the next tick: a phone may hide or
      // discard the page first (order 4128). Hidden or going away: by beacon.
      this.sendNow()
    }
    const ask = ids.orderIdKind === 'checkout' ? this.orderReferenceAsker(ids.checkoutId, sponsorId) : null
    if (!ask) {
      send()
      return
    }
    if (this.isPageHidden()) {
      // The page is going away (an emitter settling early on `pagehide`):
      // nothing can wait — out now (by beacon, see `sendNow`).
      send()
      return
    }
    let done = false
    const settle = (found?: OrderReferenceFound) => {
      if (done) return
      done = true
      this.pendingPurchases.delete(settleNow)
      send(found)
    }
    const settleNow = () => settle()
    this.pendingPurchases.add(settleNow)
    void waitForOrderNumber(ask, () => done).then(settle, () => settle())
  }

  /**
   * Sends the queue now, not at the next tick: by beacon when the page is
   * hidden or going away (a request may not survive it), else by fetch.
   */
  private sendNow(): void {
    if (this.isPageHidden()) this.flushWithBeacon()
    else void this.flush()
  }

  /** Sends every purchase still waiting for its order number, at once, with what it has. */
  private settlePendingPurchases(): void {
    for (const settle of [...this.pendingPurchases]) settle()
  }

  /** Whether the page is hidden or going away (`pagehide` until `pageshow`). */
  private isPageHidden(): boolean {
    if (this.pageHiding) return true
    try {
      return typeof document !== 'undefined' && document.visibilityState === 'hidden'
    } catch {
      return false
    }
  }

  /**
   * How a purchase asks a checkout for Vio's order number: through the SDK's
   * checkout manager (`getOrderReference`, which never throws and shares its
   * in-flight ask with the receipt's). `null` when there is nothing to ask —
   * no checkout id, or no checkout manager on this page.
   */
  private orderReferenceAsker(
    checkoutId: string | undefined,
    sponsorId: number | undefined,
  ): (() => Promise<CheckoutReference>) | null {
    if (!checkoutId) return null
    try {
      const checkout = vioFacade()?.checkout
      if (!checkout || typeof checkout.getOrderReference !== 'function') return null
      return () => checkout.getOrderReference!(checkoutId, sponsorId || undefined)
    } catch {
      return null
    }
  }

  /** The lines of the cart (current, else the pre-clear snapshot), optionally one sponsor's. */
  private cartLines(sponsorId?: number): CartLineItem[] {
    let items: CartLineItem[] = []
    const cart = vioCart()
    if (cart) {
      cart.getAllCarts().forEach((state, id) => {
        if (sponsorId === undefined || id === sponsorId) items.push(...state.items)
      })
    }
    if (items.length === 0 && this.lastCartSnapshot) {
      items = this.lastCartSnapshot.items.filter(
        (i) => sponsorId === undefined || i.sponsorId === sponsorId,
      )
    }
    return items
  }

  /**
   * The cart split per campaign — the shared rule of cart/slices.ts over the
   * current cart (else the pre-clear snapshot), plus whether any unit named
   * its campaign itself (a cart without origins is reported as before).
   */
  private cartSlices(sponsorId?: number): { slices: CartSlice[]; explicit: boolean } {
    const lines = this.cartLines(sponsorId)
    if (lines.length === 0) return { slices: [], explicit: false }
    const boot = vioBootstrapCache()
    const slices = cartSlicesFrom(
      lines,
      (slot, lineSponsorId) => resolveCampaignId({ slot, sponsorId: lineSponsorId }, boot),
      this.lastCartSnapshot?.currency,
    )
    return { slices, explicit: hasExplicitCampaign(lines) }
  }

  /**
   * The context of one of several per-campaign events: the slice's campaign,
   * slot and content — only its own; when the slice spans several slots or
   * articles the event names none rather than the one the click came from.
   */
  private sliceContext(slice: CartSlice, base: AnalyticsContext): AnalyticsContext {
    return compact({
      ...base,
      sponsorId: slice.sponsorId ?? base.sponsorId,
      campaignId: slice.campaignId,
      slot: slice.slot,
      contentId: slice.contentId,
      // The click's title only describes the click's content: when the slice
      // is another article (or several), the page's own title applies instead.
      contentTitle:
        slice.contentId !== undefined && slice.contentId === base.contentId ? base.contentTitle : undefined,
    }) as AnalyticsContext
  }

  /**
   * The context of a single-campaign checkout/purchase: when the cart's origins
   * say which campaign they came from, the event says it too (plus the slot /
   * content when unique) — a cart without origins is exactly as before.
   */
  private singleSliceContext(
    slice: CartSlice | undefined,
    explicit: boolean,
    base: AnalyticsContext,
  ): AnalyticsContext {
    if (!slice || !explicit) return base
    return compact({
      ...base,
      campaignId: base.campaignId ?? slice.campaignId,
      slot: base.slot ?? slice.slot,
      contentId: base.contentId ?? slice.contentId,
    }) as AnalyticsContext
  }

  /** Current cart → commerce payload; falls back to the pre-clear snapshot. */
  private cartCommerce(sponsorId?: number): AnalyticsCommerce | null {
    let items: CartLineItem[] = []
    const cart = vioCart()
    if (cart) {
      cart.getAllCarts().forEach((state, id) => {
        if (sponsorId === undefined || id === sponsorId) items.push(...state.items)
      })
    }
    if (items.length === 0 && this.lastCartSnapshot) {
      items = this.lastCartSnapshot.items.filter(
        (i) => sponsorId === undefined || i.sponsorId === sponsorId,
      )
    }
    if (items.length === 0) return null
    return {
      // One item per line and detail layout (0.34), each saying its layout.
      items: withLineLayouts(lineItemsByLayout(items)),
      value: items.reduce((sum, i) => sum + i.unitPrice * (i.quantity ?? 1), 0),
      currency: items[0]?.currency ?? this.lastCartSnapshot?.currency,
    }
  }

  private findLine(
    productId?: number | string,
    variantId?: number | string,
  ): CartLineItem | undefined {
    const pool: CartLineItem[] = []
    vioCart()
      ?.getAllCarts()
      .forEach((state) => pool.push(...state.items))
    if (pool.length === 0 && this.lastCartSnapshot) pool.push(...this.lastCartSnapshot.items)
    return pool.find(
      (i) =>
        String(i.productId) === String(productId) &&
        (variantId === undefined || String(i.variantId) === String(variantId)),
    )
  }
}

// ── Module-level helpers (pure; no side effects) ────────────────────────────

function hasDom(): boolean {
  return typeof window !== 'undefined'
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Ancient-browser fallback (non-cryptographic is fine for event ids).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeStorageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* private mode / blocked */
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode / blocked — ephemeral ids are acceptable */
  }
}

/** An impression's commerce: what the element shows when it fires — only when it has items. */
function impressionCommerce(
  read: (() => AnalyticsCommerce | null | undefined) | undefined,
): AnalyticsCommerce | undefined {
  if (!read) return undefined
  try {
    const commerce = read()
    return commerce?.items?.length ? commerce : undefined
  } catch {
    return undefined // analytics never breaks the page
  }
}

/**
 * The detail layout of an item on the wire (0.34): all four keys when the
 * item states any of them — `''` for the missing ones, never left out, so a
 * line from no layout reads as `''` — else nothing (items that are not cart
 * lines: impressions, `view_item`, `select_item`).
 */
function itemLayoutWire(i: AnalyticsItemInput): Record<string, string> {
  if (
    i.layoutId === undefined &&
    i.layoutRevision === undefined &&
    i.experimentId === undefined &&
    i.experimentVariantId === undefined
  ) {
    return {}
  }
  const token = (v: unknown) => layoutToken(v) ?? ''
  return {
    layout_id: token(i.layoutId),
    layout_revision: token(i.layoutRevision),
    experiment_id: token(i.experimentId),
    experiment_variant_id: token(i.experimentVariantId),
  }
}

/** Cart items as the events with items send them: every item states its layout (`''` when none). */
function withLineLayouts(items: AnalyticsItemInput[] | undefined): AnalyticsItemInput[] | undefined {
  return items?.map((i) => ({
    ...i,
    layoutId: i.layoutId ?? '',
    layoutRevision: i.layoutRevision ?? '',
    experimentId: i.experimentId ?? '',
    experimentVariantId: i.experimentVariantId ?? '',
  }))
}

function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out
}

/** Collector base URL for the active environment (override: `eventsBase`). */
function eventsBase(): string {
  return Configuration.get().eventsBase
}

// Late imports via the global facade to avoid a circular module edge
// (client.ts imports this file for the getter type).
interface FacadeLike {
  bootstrapCache: BootstrapResponse | null
  cart: CartManager
  content?: () => ContentRef
  /** The checkout manager: a purchase asks it for Vio's order number, as the receipt does. */
  checkout?: {
    getOrderReference?: (checkoutId: string, sponsorId?: number) => Promise<CheckoutReference>
  }
}
function vioFacade(): FacadeLike | null {
  const g = globalThis as unknown as { __VIO_FACADE__?: FacadeLike }
  return g.__VIO_FACADE__ ?? null
}
function vioBootstrapCache(): BootstrapResponse | null {
  return vioFacade()?.bootstrapCache ?? null
}
/** The page's content (article) — through the facade (live, init options included), else resolved here. */
function vioContent(): ContentRef {
  try {
    const facade = vioFacade()
    return typeof facade?.content === 'function' ? facade.content() : resolveContent()
  } catch {
    return {}
  }
}
function vioCart(): CartManager | null {
  try {
    return vioFacade()?.cart ?? null
  } catch {
    return null
  }
}

// ── Attribution helpers (pure; exported for tests and hosts) ────────────────

/**
 * The `campaign_id` of an event. In order: the context's explicit id; the
 * campaign assigned to the context's `slot` right now (ADR-0027 — only an
 * open assignment for the init platform counts, see `findSlotAssignment`);
 * the PAGE's campaign (`opts.pageCampaignId`, else `Vio.init({ campaignId })`)
 * when `campaigns[]` lists it as active (ADR-0034, amendment 3);
 * the active campaign of `campaigns[]` the event's sponsor takes part in, as
 * its primary or one of its secondaries — when it is in several, the
 * surface's default campaign if it is one of them, else the first one the
 * backend lists; the default campaign (`campaign.id`). `/v2/mobile/config`
 * has no top-level `campaignId` — reading one is why every event used to
 * leave with `campaign_id: 0` and the campaigns screen stayed empty.
 *
 * A malformed `campaigns[]` (not an array, a null entry) never breaks
 * `track()`: it falls back to `campaign.id`.
 */
export function resolveCampaignId(
  ctx: Pick<AnalyticsContext, 'campaignId' | 'sponsorId' | 'slot'>,
  boot: Pick<BootstrapResponse, 'campaign' | 'campaigns'> | null | undefined,
  opts: { pageCampaignId?: CampaignHint } = {},
): number | undefined {
  if (ctx.campaignId !== undefined) return ctx.campaignId
  const defaultId = boot?.campaign?.id
  const config = Configuration.isInitialized ? Configuration.get() : undefined
  const sponsorId = toNumber(ctx.sponsorId)
  // The page's campaign (ADR-0034, amendment 3): the element's candidates
  // first, then Vio.init's; an unusable level falls through to the next. With
  // a known sponsor it applies only when that sponsor takes part in it —
  // otherwise the sponsor rule below says where the sponsor's campaign is.
  const candidates = [
    ...(Array.isArray(opts.pageCampaignId) ? opts.pageCampaignId : [opts.pageCampaignId]),
    config?.campaignId,
  ]
  const page = activeCampaignEntry(boot, candidates, sponsorId)
  if (ctx.slot) {
    const assignment = findSlotAssignmentDetail(boot, ctx.slot, Date.now(), config?.platform)
    // A dashboard assignment always wins; one this page made itself counts
    // like the page campaign: not when the page now declares another active
    // campaign, nor for a sponsor that takes no part in it (see slots.ts).
    if (assignment && assignmentApplies(assignment, activeCampaignEntry(boot, candidates), sponsorId)) {
      const assigned = toNumber(assignment.campaign.id)
      if (assigned !== undefined) return assigned
    }
  }
  const pageId = toNumber(page?.id)
  if (pageId !== undefined) return pageId
  if (sponsorId === undefined) return defaultId
  // The sponsor rule (shared with resolveSlotCampaign); a malformed
  // campaigns[] never breaks track(): it answers null and campaign.id applies.
  return toNumber(sponsorCampaignEntry(boot, sponsorId)?.id) ?? defaultId
}

/** The explicit `campaignId` a `vio:*` event detail carries (the element's attribution). */
function campaignOf(detail: { campaignId?: unknown }): number | undefined {
  return toNumber(detail.campaignId)
}

/** An id the collector accepts (≤ 128 chars, as given — it coerces numbers); `undefined` otherwise. */
function fitsId<T extends string | number>(value: T | null | undefined): T | undefined {
  if (value === undefined || value === null) return undefined
  const s = String(value)
  return s && s.length <= CONTENT_ID_MAX_LENGTH ? value : undefined
}

/** A title cut to what the collector accepts (≤ 255 chars). */
function capTitle(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length > CONTENT_TITLE_MAX_LENGTH ? value.slice(0, CONTENT_TITLE_MAX_LENGTH) : value
}

/** A slice as the commerce block of its event. */
function sliceCommerce(slice: CartSlice): AnalyticsCommerce {
  return { items: withLineLayouts(slice.items), value: slice.value, currency: slice.currency }
}

/** The `slot` a `vio:*` event detail carries, when it is a non-empty string. */
function slotOf(detail: { slot?: unknown }): string | undefined {
  return typeof detail.slot === 'string' && detail.slot.trim() ? detail.slot.trim() : undefined
}

/** The `componentTemplateId` a `vio:*` event detail carries — the kind of SDK element that emitted it (`product-card`, `product-carousel`, `product-detail`); omitted over the collector's 128. */
function templateOf(detail: { componentTemplateId?: unknown }): string | undefined {
  const value = typeof detail.componentTemplateId === 'string' ? detail.componentTemplateId.trim() : ''
  return fitsId(value || undefined)
}

/** The per-element content override a `vio:*` event detail carries (`vio-content-id` / `vio-content-title`). */
function contentOf(detail: { contentId?: unknown; contentTitle?: unknown }): Pick<AnalyticsContext, 'contentId' | 'contentTitle'> {
  const out: Pick<AnalyticsContext, 'contentId' | 'contentTitle'> = {}
  if (typeof detail.contentId === 'number' && Number.isFinite(detail.contentId)) out.contentId = detail.contentId
  else if (typeof detail.contentId === 'string' && detail.contentId.trim()) out.contentId = detail.contentId.trim()
  if (typeof detail.contentTitle === 'string' && detail.contentTitle.trim()) out.contentTitle = detail.contentTitle.trim()
  return out
}


/**
 * `detail` of `vio:payment-success` as the checkout emits it. Four paths,
 * three shapes: a redirect return (`orderId` = Vio's checkout id), the
 * confirmation drawer and a provider's own receipt (`result` from the
 * provider or the backend, plus Vio's `checkoutId`), and Apple Pay express
 * from the cart (`result` with the backend's `confirmation`, no sponsor).
 */
export interface PaymentSuccessDetail {
  method?: string
  sponsorId?: number | string
  /** The slot the purchase started from, when the emitter knows it. */
  slot?: string
  /** The campaign the emitter attributed the purchase to (its `Vio.attribution`). */
  campaignId?: number
  /** Per-element content override (`vio-content-id` / `vio-content-title`), when the emitter carries one. */
  contentId?: string | number
  contentTitle?: string
  /**
   * Redirect return: Vio's checkout id (the name predates `checkoutId`). A
   * value that is a whole number is read as Vio's order number instead — a
   * checkout id is a uuid, never one.
   */
  orderId?: string | number
  /** Vio's checkout id — from the checkout state or the return URL. */
  checkoutId?: string | number
  /**
   * Vio's order number (`4415`), when the emitter knows it: the SDK's checkout
   * adds it when its ask for the buyer reference already found the order.
   * Becomes the purchase's `order_id`.
   */
  orderNumber?: string | number | null
  /**
   * The buyer reference the emitter learned with the payment — shopcart's
   * `buyer_ref`, a keyed hash of the email (`buyerRef` from the SDK's own
   * checkout; `buyer_ref` when a host passes the backend's answer through).
   * Becomes `commerce.buyer_id`; never an email.
   */
  buyerRef?: string | null
  buyer_ref?: string | null
  result?: PaymentSuccessResult | null
  /**
   * The sponsor the order is with — the CHECKOUT's (its cart's sponsor),
   * never the page's: `{ id, name, logoUrl }` by the `Vio.sponsorIdentity`
   * rule, when it can be named. For the host's own receipt; analytics does
   * not read it.
   */
  sponsor?: CheckoutSponsor
}

/**
 * What the checkout attaches as `result`. Only `confirmation` carries Vio
 * ids: the order `ConfirmPaymentApplePay` created (its number) and the
 * checkout it paid. `order.orderId` / `orderId`
 * are the PROVIDER's references (Qliro's, Walley's — the checkout itself
 * shows them as `providerRef`), and `chargedTotal` includes shipping on some
 * methods only. Analytics reads none of those.
 */
export interface PaymentSuccessResult {
  confirmation?: {
    orderId?: string | number | null
    /** The checkout the confirmation paid (Apple Pay from the cart names no other). */
    checkoutId?: string | null
    status?: string
    buyerRef?: string | null
    buyer_ref?: string | null
  } | null
  /** The checkout as a host's backend answered it, when the host passes it through. */
  checkout?: { buyerRef?: string | null; buyer_ref?: string | null } | null
  buyerRef?: string | null
  buyer_ref?: string | null
  [key: string]: unknown
}

/**
 * The buyer reference of a `vio:payment-success` / `vio:checkout-open`
 * detail, wherever its emitter put it: top-level (`buyerRef`, or `buyer_ref`
 * as the backend spells it), on the result, on the result's `confirmation`
 * (Apple Pay) or `checkout`. Only a reference survives — never an email
 * (`normalizeBuyerRef`).
 */
export function buyerRefOf(
  d: { buyerRef?: unknown; buyer_ref?: unknown; result?: PaymentSuccessResult | null } | null | undefined,
): string | undefined {
  if (!d) return undefined
  const r = d.result ?? {}
  const candidates = [
    d.buyerRef,
    d.buyer_ref,
    r.buyerRef,
    r.buyer_ref,
    r.confirmation?.buyerRef,
    r.confirmation?.buyer_ref,
    r.checkout?.buyerRef,
    r.checkout?.buyer_ref,
  ]
  for (const candidate of candidates) {
    const ref = normalizeBuyerRef(candidate)
    if (ref) return ref
  }
  return undefined
}

/**
 * `detail` of `vio:checkout-created` (the checkout manager, the moment a
 * backend checkout exists for a payment): what `add_payment_info` says.
 */
export interface CheckoutCreatedDetail {
  sponsorId?: number | string
  /** Vio's checkout id (uuid) — `commerce.checkout_id`. */
  checkoutId?: string
  /** The SDK's name of the method the checkout was created for (`vipps`, `stripe`, `apple-pay`…). */
  paymentMethod?: string
  /** The campaign the checkout was born attributed to (ADR-0035 B), when it was. */
  campaignId?: number
  slot?: string
  contentId?: string | number
  contentTitle?: string
  /** The page leaves for the provider right after. */
  redirect?: boolean
}

/** The ids of a `purchase`, as a `vio:payment-success` detail gives them (`purchaseIdsOf`). */
export interface PurchaseIds {
  /**
   * `commerce.order_id`: Vio's order number when the detail has it, else the
   * checkout id standing in for it.
   */
  orderId?: string
  /** `commerce.checkout_id`: Vio's checkout id (uuid), when the detail has it. */
  checkoutId?: string
  /** `props.order_id_kind`: what `orderId` is — `'order'` (the number) or `'checkout'` (the stand-in). */
  orderIdKind?: 'order' | 'checkout'
}

/**
 * The ids of a `purchase` — ALWAYS Vio's, never a provider's reference. The
 * order number: `orderNumber` (an emitter that knows it) →
 * `result.confirmation.orderId` (Apple Pay: the order `ConfirmPaymentApplePay`
 * created) → an `orderId` that is a whole number. The checkout id: `orderId`
 * (the redirect return's, a uuid) → `checkoutId` → `result.confirmation.checkoutId`
 * (Apple Pay from the cart). `orderId` is the number
 * when there is one, else the checkout id — the SDK's own `purchase` then
 * waits for the number (see `AnalyticsManager`); a host with its own sink can
 * ask `Vio.checkout.getOrderReference(checkoutId)` the same way.
 */
export function purchaseIdsOf(d: PaymentSuccessDetail | null | undefined): PurchaseIds {
  if (!d) return {}
  const r = d.result ?? {}
  const legacy = firstId(d.orderId)
  const legacyIsNumber = legacy !== undefined && isOrderNumber(legacy)
  const orderNumber = firstId(d.orderNumber, r.confirmation?.orderId, legacyIsNumber ? legacy : undefined)
  const checkoutId = firstId(legacyIsNumber ? undefined : legacy, d.checkoutId, r.confirmation?.checkoutId)
  if (orderNumber !== undefined) {
    return { orderId: orderNumber, ...(checkoutId !== undefined ? { checkoutId } : {}), orderIdKind: 'order' }
  }
  if (checkoutId !== undefined) return { orderId: checkoutId, checkoutId, orderIdKind: 'checkout' }
  return {}
}

/**
 * The `order_id`, `checkout_id` and `buyer_id` of a `purchase`, as far as the
 * detail says them NOW (`purchaseIdsOf`; the SDK's own `purchase` may still
 * wait for the order number). `value` and `currency` are deliberately NOT
 * read from the result: on every path they come from the cart snapshot (sum
 * of the items, no shipping), so revenue stays comparable across payment
 * methods — the charged total will arrive through the server-side
 * `order_paid` event. With nothing to say it returns `{}`, so the cart
 * snapshot keeps its keys.
 */
export function purchaseFromPaymentSuccess(
  d: PaymentSuccessDetail,
): Pick<AnalyticsCommerce, 'orderId' | 'checkoutId' | 'buyerId'> {
  const { orderId, checkoutId } = purchaseIdsOf(d)
  const buyerId = buyerRefOf(d)
  return {
    ...(orderId !== undefined ? { orderId } : {}),
    ...(checkoutId !== undefined ? { checkoutId } : {}),
    ...(buyerId !== undefined ? { buyerId } : {}),
  }
}

/** Vio's order numbers are whole numbers (`4415`); its checkout ids are uuids. */
function isOrderNumber(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value)
}

/** What asking the checkout found: the order number once the order exists, and the buyer reference. */
interface OrderReferenceFound {
  orderNumber?: string
  buyerRef?: string
}

/**
 * Asks (`ask`) for Vio's order number until the checkout has one: at once,
 * then after each wait of `ORDER_NUMBER_BACKOFF_MS`, all within
 * `ORDER_NUMBER_MAX_WAIT_MS` — a slow answer counts against it too. A failed
 * ask is asked again. Resolves `{}` (or just the buyer reference) when the
 * time is up or `stopped()`; never rejects.
 */
async function waitForOrderNumber(
  ask: () => Promise<CheckoutReference>,
  stopped: () => boolean,
): Promise<OrderReferenceFound> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  const timeUp = new Promise<null>((resolve) => {
    deadline = setTimeout(() => resolve(null), ORDER_NUMBER_MAX_WAIT_MS)
  })
  let buyerRef: string | undefined
  const found = (orderNumber?: string): OrderReferenceFound => ({
    ...(orderNumber ? { orderNumber } : {}),
    ...(buyerRef ? { buyerRef } : {}),
  })
  try {
    for (let attempt = 0; attempt <= ORDER_NUMBER_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) {
        const wait = ORDER_NUMBER_BACKOFF_MS[attempt - 1]!
        const slept = await Promise.race([new Promise<true>((resolve) => setTimeout(() => resolve(true), wait)), timeUp])
        if (slept === null) break
      }
      if (stopped()) break
      try {
        const reference = await Promise.race([ask(), timeUp])
        if (reference === null) break // time is up
        buyerRef ??= normalizeBuyerRef(reference?.buyerRef)
        const orderNumber = firstId(reference?.orderNumber)
        if (orderNumber !== undefined && isOrderNumber(orderNumber)) return found(orderNumber)
      } catch {
        /* ask again, or give up */
      }
    }
    return found()
  } finally {
    clearTimeout(deadline)
  }
}

function firstId(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (c === undefined || c === null) continue
    const s = String(c)
    if (s !== '') return s
  }
  return undefined
}

// ── GA4 dataLayer sink (publisher feature; NOT the Vio pipeline) ────────────

function pushGa4(event: WireEvent): void {
  const commerceNames = new Set([
    'view_item_list',
    'select_item',
    'view_item',
    'add_to_cart',
    'view_cart',
    'begin_checkout',
    'add_payment_info',
    'purchase',
  ])
  if (!commerceNames.has(event.name)) return
  const w = window as unknown as { dataLayer?: unknown[] }
  w.dataLayer = w.dataLayer || []
  const commerce = (event.commerce ?? {}) as {
    items?: Array<Record<string, unknown>>
    value?: number
    currency?: string
    order_id?: string
    payment_method?: string
  }
  // GA4 best practice: clear the previous ecommerce object before each push.
  w.dataLayer.push({ ecommerce: null })
  w.dataLayer.push({
    event: event.name,
    ecommerce: compact({
      currency: commerce.currency,
      value: commerce.value,
      transaction_id: commerce.order_id,
      payment_type: event.name === 'add_payment_info' ? commerce.payment_method : undefined,
      items: commerce.items?.map((i) =>
        compact({
          item_id: i.product_id,
          item_name: i.name,
          item_brand: i.brand,
          item_variant: i.variant_id,
          price: i.price,
          quantity: i.quantity,
        }),
      ),
    }),
  })
}
