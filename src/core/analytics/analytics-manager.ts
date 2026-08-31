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
import { SDK_VERSION } from '../version.js'
import type { CartManager, CartChangeDetail } from '../cart/cart-manager.js'
import type { CartLineItem } from '../cart/types.js'

// ── Taxonomy (client-side subset of contract v1) ────────────────────────────

export const ANALYTICS_EVENT_NAMES = [
  // commerce (GA4-compatible)
  'view_item_list',
  'select_item',
  'view_item',
  'add_to_cart',
  'view_cart',
  'begin_checkout',
  'purchase',
  // engagement
  'component_impression',
  'component_click',
  'ad_impression',
  'ad_click',
  'poll_impression',
  'contest_impression',
  // session
  'session_start',
  'session_end',
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

/** Camel-case for DX; mapped to the snake_case wire format at build time. */
export interface AnalyticsContext {
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
  variant?: string
}

export interface AnalyticsItemInput {
  productId: number | string
  name?: string
  brand?: string
  variantId?: number | string
  price?: number
  quantity?: number
}

export interface AnalyticsCommerce {
  items?: AnalyticsItemInput[]
  value?: number
  currency?: string
  orderId?: string
  paymentMethod?: string
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
  /** Send to the Vio collector. Default true. */
  collector?: boolean
  /** Also push GA4 e-commerce events to window.dataLayer (publisher feature). */
  dataLayer?: boolean
  /** console.debug every event. */
  debug?: boolean
}

// ── Tunables (contract-aligned) ─────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 60 * 1000 // rolling 30-min session
const FLUSH_INTERVAL_MS = 5_000
const FLUSH_AT_COUNT = 20
const MAX_QUEUE = 500 // drop-oldest beyond this
const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000]
const ANON_KEY = 'vio.anon.v1'
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
  props?: Record<string, unknown>
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class AnalyticsManager extends EventTarget {
  private started = false
  private options: Required<
    Pick<AnalyticsStartOptions, 'collector' | 'dataLayer' | 'debug' | 'autoTrack'>
  > & {
    host: string
  } = { host: 'custom', collector: true, dataLayer: false, debug: false, autoTrack: true }

  private queue: WireEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private retryAttempt = 0
  private retryNotBefore = 0
  private externalUserId: string | undefined

  private sessionId: string | null = null

  /** Set via start({ sessionId }) — the host owns the session, we follow. */
  private externalSessionId: string | null = null
  private sessionStartedAt = 0
  /** Impression once-per-(session, component) guard; reset on session rotation. */
  private impressedComponents = new Set<string>()

  /** Last NON-EMPTY cart snapshot — `purchase` uses it because several flows
   * (Apple Pay) clear the cart BEFORE `vio:payment-success` fires. */
  private lastCartSnapshot: { items: CartLineItem[]; currency?: string } | null = null

  private teardown: Array<() => void> = []

  // MARK: - Public API

  /**
   * Install listeners + begin flushing. Explicit on purpose (no module
   * side-effects). Safe to call twice (second call only updates options).
   */
  start(options: AnalyticsStartOptions = {}): void {
    this.options = {
      host: options.host ?? this.options.host,
      collector: options.collector ?? this.options.collector,
      dataLayer: options.dataLayer ?? this.options.dataLayer,
      debug: options.debug ?? this.options.debug,
      autoTrack: options.autoTrack ?? this.options.autoTrack,
    }
    // A host-supplied session id wins over our own: it is the only way the
    // host can join Vio's funnel onto the events it already collects.
    if (options.sessionId) this.externalSessionId = options.sessionId

    if (this.started || !hasDom()) return
    this.started = true

    this.ensureSession() // emits session_start

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)

    const onPageHide = () => {
      this.trackSessionEnd()
      this.flushWithBeacon()
    }
    window.addEventListener('pagehide', onPageHide)
    this.teardown.push(() => window.removeEventListener('pagehide', onPageHide))

    if (this.options.autoTrack) this.installAutoListeners()
  }

  /** Stop timers + listeners (tests / SPA unmount). Queue survives. */
  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
    for (const fn of this.teardown.splice(0)) fn()
    this.started = false
  }

  /** Attach the partner's user id (opaque) to all subsequent events. */
  identify(externalUserId: string | null): void {
    this.externalUserId = externalUserId ?? undefined
  }

  /** Queue one event. Works pre-init and pre-start (SSR: no-op). */
  track(name: AnalyticsEventName, opts: TrackOptions = {}): void {
    if (!hasDom()) return
    const event = this.buildEvent(name, opts)
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
              this.track(name, { context })
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
    const body = JSON.stringify({
      apiKey: Configuration.get().apiKey,
      sent_at: new Date().toISOString(),
      events: batch,
    })
    try {
      const res = await fetch(`${eventsBase()}/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    const context: Record<string, unknown> = compact({
      campaign_id: ctx.campaignId ?? boot?.campaignId,
      broadcast_id: ctx.broadcastId,
      campaign_component_id: ctx.campaignComponentId,
      app_placement_id: ctx.appPlacementId,
      location_id: ctx.locationId,
      component_template_id: ctx.componentTemplateId,
      sponsor_id: ctx.sponsorId,
      activation_id: ctx.activationId,
      content_url: ctx.contentUrl ?? (typeof location !== 'undefined' ? location.href : undefined),
      // The host's own content id — its join key back onto its reporting.
      content_id: ctx.contentId,
      // Deletion-proof reporting: sources have no trash bin — the title
      // snapshotted at event time keeps reports legible if content dies.
      content_title:
        ctx.contentTitle ??
        (typeof document !== 'undefined' && document.title
          ? document.title.slice(0, 255)
          : undefined),
      variant: ctx.variant,
    })

    const com = opts.commerce
    const commerce = com
      ? compact({
          items: com.items?.map((i) =>
            compact({
              product_id: String(i.productId),
              name: i.name,
              brand: i.brand,
              variant_id: i.variantId !== undefined ? String(i.variantId) : undefined,
              price: i.price,
              quantity: i.quantity,
            }),
          ),
          value: com.value,
          currency: com.currency,
          order_id: com.orderId,
          payment_method: com.paymentMethod,
        })
      : undefined

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
      ...(opts.props ? { props: opts.props } : {}),
    }
  }

  private anonId(): string | null {
    const stored = safeStorageGet(ANON_KEY)
    if (stored) return stored
    const id = `a-${uuid()}`
    safeStorageSet(ANON_KEY, id)
    return safeStorageGet(ANON_KEY) ?? id // storage may be blocked — ephemeral id still works
  }

  /** Rolling session: renewed by activity, rotated after 30 min idle. */
  private ensureSession(): void {
    const now = Date.now()
    if (!this.sessionId) {
      const stored = safeStorageGet(SESSION_KEY)
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
      const stored = safeStorageGet(SESSION_KEY)
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
      safeStorageSet(
        SESSION_KEY,
        JSON.stringify({ id: this.sessionId, ts: now, startedAt: now }),
      )
      this.track('session_start')
    } else {
      safeStorageSet(
        SESSION_KEY,
        JSON.stringify({ id: this.sessionId, ts: now, startedAt: this.sessionStartedAt }),
      )
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
      const d = (ev as CustomEvent<{ productId?: number | string; sponsorId?: number; quantity?: number; variantId?: number | string }>).detail ?? {}
      const line = this.findLine(d.productId, d.variantId)
      this.track('add_to_cart', {
        context: { sponsorId: d.sponsorId !== undefined ? Number(d.sponsorId) : undefined },
        commerce: {
          items: [
            {
              productId: d.productId ?? line?.productId ?? '',
              name: line?.name,
              brand: line?.brand,
              variantId: d.variantId ?? line?.variantId,
              price: line?.unitPrice,
              quantity: d.quantity ?? 1,
            },
          ],
          value: line ? line.unitPrice * (d.quantity ?? 1) : undefined,
          currency: line?.currency,
        },
      })
    })

    on('vio:product-click', (ev) => {
      const d = (ev as CustomEvent<{
        productId?: number | string
        sponsorId?: number
        name?: string
        brand?: string
        price?: number | string
      }>).detail ?? {}
      if (d.productId === undefined) return
      const price = Number(d.price)
      this.track('select_item', {
        context: { sponsorId: d.sponsorId !== undefined ? Number(d.sponsorId) : undefined },
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

    on('vio:open-cart', () => {
      const snap = this.cartCommerce()
      this.track('view_cart', snap ? { commerce: snap } : {})
    })

    on('vio:checkout-open', (ev) => {
      const d = (ev as CustomEvent<{ sponsorId?: number }>).detail ?? {}
      const snap = this.cartCommerce(d.sponsorId)
      this.track('begin_checkout', {
        context: { sponsorId: d.sponsorId },
        ...(snap ? { commerce: snap } : {}),
      })
    })

    on('vio:payment-success', (ev) => {
      const d = (ev as CustomEvent<{ method?: string; sponsorId?: number | string; orderId?: string }>).detail ?? {}
      const sponsorId = d.sponsorId !== undefined ? Number(d.sponsorId) : undefined
      const snap = this.cartCommerce(sponsorId) // falls back to pre-clear snapshot
      this.track('purchase', {
        context: { sponsorId },
        commerce: {
          ...(snap ?? {}),
          orderId: d.orderId,
          paymentMethod: d.method,
        },
      })
    })
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
      items: items.map((i) => ({
        productId: i.productId,
        name: i.name,
        brand: i.brand,
        variantId: i.variantId,
        price: i.unitPrice,
        quantity: i.quantity,
      })),
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

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode / blocked — ephemeral ids are acceptable */
  }
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
  bootstrapCache: { campaignId?: number } | null
  cart: CartManager
}
function vioFacade(): FacadeLike | null {
  const g = globalThis as unknown as { __VIO_FACADE__?: FacadeLike }
  return g.__VIO_FACADE__ ?? null
}
function vioBootstrapCache(): { campaignId?: number } | null {
  return vioFacade()?.bootstrapCache ?? null
}
function vioCart(): CartManager | null {
  try {
    return vioFacade()?.cart ?? null
  } catch {
    return null
  }
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
  }
  // GA4 best practice: clear the previous ecommerce object before each push.
  w.dataLayer.push({ ecommerce: null })
  w.dataLayer.push({
    event: event.name,
    ecommerce: compact({
      currency: commerce.currency,
      value: commerce.value,
      transaction_id: commerce.order_id,
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
