/**
 * Vio — public SDK entry point + facade.
 *
 * Usage:
 *   import { Vio } from 'vio'
 *   Vio.init({ apiKey: 'xxx' })          // backend-bound calls require this
 *   await Vio.bootstrap()                 // GET /v2/mobile/config
 *
 *   // Client-side primitives — no init needed:
 *   Vio.cart.addProduct({ product, sponsorId: 3 })
 *   Vio.checkout.open(3)
 *
 *   // Backend-bound:
 *   const products = await Vio.commerceFor(3).channel.product.getByIds({
 *     product_ids: [408895],
 *   })
 */

import { Configuration, type VioConfig } from './configuration.js'
import { VioApiError, createVioApi, type VioApi } from './api/vio.js'
import { createCommerceClient, type CommerceClient } from './api/commerce.js'
import { CartManager } from './cart/cart-manager.js'
import { CheckoutManager } from './checkout/checkout-manager.js'
import { AnalyticsManager, resolveCampaignId } from './analytics/analytics-manager.js'
import { resolveContent, type ContentRef } from './content.js'
import { storedLanding, type Landing } from './analytics/client-context.js'
import { checkoutAttributionOf, type CheckoutAttributionWire } from './checkout/attribution.js'
import {
  MAX_DECLARATIONS_PER_LOAD,
  MAX_LOCATIONS_PER_DECLARATION,
  SLOT_DECLARATION_FAILURE_TTL_MS,
  SLOT_DECLARATION_TTL_MS,
  activeCampaignEntry,
  campaignCandidates,
  normalizeSlotId,
  normalizeSlotKind,
  normalizeSlotLocations,
  pendingSlotKeys,
  readSlotDeclaration,
  rememberSlotKeys,
  resolveSlotCampaign,
  slotDeclarationKey,
  slotDeclarationStorageKey,
  toCampaignId,
  toNumber,
  writeSlotDeclaration,
  type CampaignHint,
  type RegisterSlotOptions,
  type SlotInput,
} from './slots.js'
import { cartSlicesFrom, type CartSlice } from './cart/slices.js'
import type { CartLineItem } from './cart/types.js'
import type {
  Attribution,
  BootstrapCampaignEntry,
  BootstrapResponse,
  ManifestLocation,
  ManifestResult,
  Sponsor,
  SurfacePrivacyMode,
} from './types.js'

/** Mount storms (a carousel of cards, Vev blocks) collapse into ONE manifest. */
const SLOT_DECLARATION_DEBOUNCE_MS = 1_000

/** How long the surface is given to answer its privacy mode (preloaded at init; never awaited by the payment path). */
const PRIVACY_MODE_TIMEOUT_MS = 1_500
/** How long "could not tell" (a timeout, a failure) is believed before the surface is asked again. */
const PRIVACY_UNKNOWN_TTL_MS = 60_000

type PrivacyAnswer = SurfacePrivacyMode | 'unknown'

/** `standard` | `minimal` as the backend says it; anything else is "not said". */
function privacyModeOf(value: unknown): SurfacePrivacyMode | undefined {
  return value === 'minimal' || value === 'standard' ? value : undefined
}

/**
 * What `GET /v2/mobile/surface` says of the mode: the field absent or null is
 * the default (`standard`); a word the SDK does not know is NOT — it may be
 * a stricter mode of a newer service — so it reads as `unknown`, as does an
 * answer without a surface at all.
 */
function privacyModeOfSurface(res: unknown): PrivacyAnswer {
  const surface = (res as { surface?: unknown } | null | undefined)?.surface
  if (!surface || typeof surface !== 'object') return 'unknown'
  const raw = (surface as { privacyMode?: unknown }).privacyMode
  if (raw === undefined || raw === null) return 'standard'
  return privacyModeOf(raw) ?? 'unknown'
}

class VioFacade {
  private apiInstance: VioApi | null = null
  private commerceClients = new Map<number, CommerceClient>()
  private bootstrapPromise: Promise<BootstrapResponse> | null = null
  private cachedBootstrap: BootstrapResponse | null = null
  /** Last bootstrap failure — short backoff so cart mutations don't hammer a
   * dead endpoint on every call. */
  private bootstrapFailedAt = 0
  /** Bumped by every init(). A bootstrap started under an older configuration
   * (another key or environment) is still in flight after a re-init; its answer
   * belongs to that configuration and must not land in this one. */
  private generation = 0

  /** Slot ids present on the page (`Vio.registerSlot`): how many elements hold each, its display name, its own campaign and its kind. */
  private slotRegistry = new Map<string, { count: number; displayName?: string; campaignId?: number; kind?: string }>()
  /** Slots already warned about (`dashboard`: the dashboard's assignment stands; `replaced`: this page moved it). */
  private warnedDashboardSlots = new Set<string>()
  private warnedReplacedSlots = new Set<string>()
  /** Pending debounced declaration of the registry. */
  private slotDeclareTimer: ReturnType<typeof setTimeout> | null = null
  /** A name appeared (or the key changed) since the registry was last declared. */
  private slotsDirty = false
  /** Manifests POSTed by this page load (abuse / rollout guard, see declareSlots). */
  private declarationsThisLoad = 0
  /** Each cap warns once per page load. */
  private warnedLocationCap = false
  private warnedDeclarationCap = false

  // Client-side managers — created lazily on first access. They don't
  // need Vio.init() to work (state is purely local).
  private cartManager: CartManager | null = null
  private checkoutManager: CheckoutManager | null = null
  private analyticsManager: AnalyticsManager | null = null
  /** What the surface answered of its privacy mode (`GET /v2/mobile/surface`) and when; `unknown` expires after a minute. */
  private surfaceMode: { mode: PrivacyAnswer; at: number } | null = null
  /** The request in flight for it, if any. */
  private surfaceRequest: Promise<PrivacyAnswer> | null = null

  init(config: VioConfig): void {
    Configuration.init(config)
    // Reset cached backend instances so a re-init picks up the new config.
    this.apiInstance = null
    this.commerceClients.clear()
    this.bootstrapPromise = null
    this.cachedBootstrap = null
    this.bootstrapFailedAt = 0
    this.generation++
    // The surface (its privacy mode) is the key's: forgotten, and asked again
    // for the new one right away — so it is known by the time anything is
    // added to the cart or paid for, and nothing on that path waits for it.
    this.surfaceMode = null
    this.surfaceRequest = null
    this.preloadPrivacyMode()
    // A new key/environment invalidates the per-sponsor payment methods too.
    this.checkoutManager?.clearPaymentMethodsCache()
    // The page's slots stay; they are declared again once the NEW key has
    // bootstrapped (a declaration pending for the old key is dropped).
    if (this.slotDeclareTimer) {
      clearTimeout(this.slotDeclareTimer)
      this.slotDeclareTimer = null
    }
    this.slotsDirty = this.slotRegistry.size > 0
    // The declaration caps are per configuration: a new key starts afresh.
    this.declarationsThisLoad = 0
    this.warnedLocationCap = false
    this.warnedDeclarationCap = false
    this.warnedDashboardSlots.clear()
    this.warnedReplacedSlots.clear()
    // NOTE: cart / checkout managers are NOT reset — user cart state is
    // independent of SDK re-config.
  }

  /**
   * The content (article, page) this SDK instance is rendered in — what every
   * analytics event carries as `content_id` / `content_title` when the event
   * has no explicit one: init option → URL query → `vio:content-*` metas →
   * canonical/og:url → pathname (see `resolveContent`). Resolved LIVE on each
   * call — a few querySelectors — so an SPA route change, a new canonical or
   * a new title are seen without any re-init. Never throws; `{}` without a
   * document.
   */
  content(): ContentRef {
    let init: { contentId?: string | number; contentTitle?: string } | undefined
    if (Configuration.isInitialized) {
      const cfg = Configuration.get()
      init = { contentId: cfg.contentId, contentTitle: cfg.contentTitle }
    }
    return resolveContent(init)
  }

  get isInitialized(): boolean { return Configuration.isInitialized }
  get config() { return Configuration.get() }

  // MARK: - Client-side managers (no init required)

  /** Multi-sponsor cart manager. Reactive — listen via addEventListener('change', ...). */
  get cart(): CartManager {
    if (!this.cartManager) this.cartManager = new CartManager()
    return this.cartManager
  }

  /** Checkout flow manager. Subscribes to cart state via the CartManager; asks here for the order's attribution. */
  get checkout(): CheckoutManager {
    if (!this.checkoutManager) {
      this.checkoutManager = new CheckoutManager(this.cart, {
        orderAttribution: (sponsorId) => this.orderAttribution(sponsorId),
      })
    }
    return this.checkoutManager
  }

  /**
   * Analytics — track() queues even pre-init; nothing is sent (and no
   * listeners are installed) until an explicit `Vio.analytics.start()`.
   */
  get analytics(): AnalyticsManager {
    if (!this.analyticsManager) this.analyticsManager = new AnalyticsManager()
    return this.analyticsManager
  }

  // MARK: - Backend-bound

  /** Lazy VioApi for REST endpoints on `api-staging.vio.live`. */
  get api(): VioApi {
    if (!this.apiInstance) {
      const cfg = Configuration.get()
      this.apiInstance = createVioApi({ apiBase: cfg.apiBase, apiKey: cfg.apiKey })
    }
    return this.apiInstance
  }

  /**
   * Bootstrap — fetches client config and caches it. Dedupes in-flight
   * concurrent requests.
   *
   * A request that was started before the last init() (Vev starts with the key
   * the browser remembers, then the page's own key arrives) answers for a key
   * that is gone: it neither fills the cache nor arms the failure backoff, and
   * whoever awaited it gets the current configuration's bootstrap instead.
   */
  async bootstrap(): Promise<BootstrapResponse> {
    if (this.cachedBootstrap) return this.cachedBootstrap
    if (this.bootstrapPromise) return this.bootstrapPromise
    // Failure backoff: don't re-fire a request for 5s after a failure —
    // every cart mutation awaits bootstrap, so a dead endpoint would
    // otherwise add a failed round-trip per click.
    if (this.bootstrapFailedAt && Date.now() - this.bootstrapFailedAt < 5_000) {
      throw new Error('[Vio] bootstrap recently failed — backing off')
    }
    const generation = this.generation
    const promise: Promise<BootstrapResponse> = this.api
      .bootstrap(Configuration.get().platform)
      .then(
        (res) => {
          if (generation !== this.generation) return this.bootstrap()
          this.cachedBootstrap = res
          this.bootstrapFailedAt = 0
          // The slots that mounted before this answer can be declared now.
          if (this.slotsDirty) this.scheduleSlotDeclaration()
          // The surface's privacy mode, in case init's ask failed or expired.
          this.preloadPrivacyMode()
          return res
        },
        (err) => {
          if (generation !== this.generation) return this.bootstrap()
          this.bootstrapFailedAt = Date.now()
          throw err
        },
      )
      .finally(() => {
        // Only clear our own slot: after a re-init it may hold the new request.
        if (this.bootstrapPromise === promise) this.bootstrapPromise = null
      })
    this.bootstrapPromise = promise
    return promise
  }

  get bootstrapCache(): BootstrapResponse | null {
    return this.cachedBootstrap
  }

  /**
   * Get a CommerceClient scoped to a specific sponsor (via bootstrap).
   * Throws if bootstrap hasn't been called or the sponsor is unknown.
   */
  commerceFor(sponsorId: number): CommerceClient {
    // Coacción a número: los web-components pasan sponsorId como string
    // (atributo), y findSponsor compara con `===` contra el id numérico.
    sponsorId = Number(sponsorId) as number
    const existing = this.commerceClients.get(sponsorId)
    if (existing) return existing
    const sponsor = this.findSponsor(sponsorId)
    if (!sponsor) {
      throw new Error(
        `[Vio] Sponsor ${sponsorId} not found in bootstrap. Call Vio.bootstrap() first or pass commerce-key directly.`,
      )
    }
    const cfg = Configuration.get()
    const client = createCommerceClient({ endpoint: cfg.graphQLBase, apiKey: sponsor.commerce.apiKey })
    this.commerceClients.set(sponsorId, client)
    return client
  }

  /** Get a CommerceClient using an explicit commerce apiKey (skip bootstrap). */
  commerceWithKey(commerceApiKey: string): CommerceClient {
    const cfg = Configuration.get()
    return createCommerceClient({ endpoint: cfg.graphQLBase, apiKey: commerceApiKey })
  }

  // MARK: - Slots (ADR-0027 / ADR-0034)

  /**
   * Declare this page's slots to the campaigns service
   * (`POST /v2/mobile/components/manifest`, `mode: 'merge'`, the init
   * platform). Best-effort: it NEVER throws — a failure is logged and resolves
   * `null`. The same set is not re-posted from this browser for 24 h unless
   * `force` (then `null` also means "skipped, already declared"). Ids are
   * trimmed, cut at 100 chars, deduped; empties are dropped.
   */
  async declareSlots(
    slots: ReadonlyArray<SlotInput>,
    opts: { force?: boolean } = {},
  ): Promise<ManifestResult | null> {
    let storageKey: string | undefined
    let keys: string[] = []
    let now = Date.now()
    try {
      const all = normalizeSlotLocations(slots)
      if (all.length === 0) return null
      if (!Configuration.isInitialized) {
        warn('declareSlots() before Vio.init() — nothing declared')
        return null
      }
      const cfg = Configuration.get()
      storageKey = slotDeclarationStorageKey(cfg.platform, cfg.apiKey)
      now = Date.now()
      // The page's campaign goes top-level; a location names its own only when
      // it differs from the page's (ADR-0034, amendment 3).
      const pageCampaignId = cfg.campaignId
      for (const l of all) {
        if (l.campaignId !== undefined && l.campaignId === pageCampaignId) delete l.campaignId
      }
      // Per id, not per set: only what this browser has not declared (under
      // this name and campaign) in the last 24 h goes out — a multi-page site
      // declares each page's new ids once, a renamed block or a page that
      // changed campaign again, a failed attempt after 1 h.
      const memory = readSlotDeclaration(storageKey)
      const keyOf = (l: ManifestLocation) => slotDeclarationKey(l, pageCampaignId)
      const pending = new Set(pendingSlotKeys(memory, all.map(keyOf), now))
      let locations = opts.force ? all : all.filter((l) => pending.has(keyOf(l)))
      if (locations.length === 0) return null
      if (locations.length > MAX_LOCATIONS_PER_DECLARATION) {
        if (!this.warnedLocationCap) {
          this.warnedLocationCap = true
          warn(
            `declareSlots(): ${locations.length} slots on one page — only the first ${MAX_LOCATIONS_PER_DECLARATION} are declared`,
          )
        }
        locations = locations.slice(0, MAX_LOCATIONS_PER_DECLARATION)
      }
      keys = locations.map(keyOf)
      if (!opts.force && this.declarationsThisLoad >= MAX_DECLARATIONS_PER_LOAD) {
        if (!this.warnedDeclarationCap) {
          this.warnedDeclarationCap = true
          warn(
            `declareSlots(): already ${MAX_DECLARATIONS_PER_LOAD} manifests this page load — further ones are skipped (force: true to override)`,
          )
        }
        return null
      }
      this.declarationsThisLoad++
      const result = await this.api.declareManifest({
        platform: cfg.platform,
        mode: 'merge',
        locations,
        ...(pageCampaignId !== undefined ? { campaignId: pageCampaignId } : {}),
      })
      this.reportAssignments(result, locations, pageCampaignId, cfg.debug)
      // A server that predates `mode` drops the field, answers 200 without it
      // and REPLACES (it deprecates the other pages' slots). Only a declaration
      // the server confirms as merged is remembered for 24 h — a replace is
      // remembered for 1 h, so the next load (not every view) tries again,
      // and succeeds once the server is updated. A location whose campaign the
      // micro did not take up (no `assignment` at all — an older micro — or
      // `none` for a campaign the bootstrap lists as active) is remembered for
      // 1 h too, so the page's campaign lands once the micro is updated.
      if (result?.mode === 'merge') {
        const unhandled = this.campaignNotTakenUp(result, locations, pageCampaignId)
        const settled = keys.filter((k) => !unhandled.has(k))
        let next = rememberSlotKeys(memory, settled, now)
        if (unhandled.size > 0) next = rememberSlotKeys(next, [...unhandled], failedAt(now))
        writeSlotDeclaration(storageKey, next)
      } else {
        writeSlotDeclaration(storageKey, rememberSlotKeys(memory, keys, failedAt(now)))
        warn(
          'slots declared but the server ignored mode=merge (old server); not caching, will retry next load',
        )
      }
      return result
    } catch (err) {
      // Not retried for an hour: a failing micro must not get a POST per view.
      if (storageKey && keys.length > 0) {
        writeSlotDeclaration(storageKey, rememberSlotKeys(readSlotDeclaration(storageKey), keys, failedAt(now)))
      }
      warn('declareSlots() failed —', err)
      return null
    }
  }

  /**
   * Register a slot present on the page (the `<vio-*>` elements call it with
   * their effective id — the host's `vio-slot` or the auto-generated one —
   * the optional display name, and the element's own campaign when it has
   * one: `vio-campaign` or an ancestor's `data-vio-campaign`). The registry is
   * declared ONCE, debounced, after the first successful bootstrap — and again
   * whenever a new id, display name, campaign or kind appears. A `displayName` /
   * `campaignId` given later for an id already registered replaces the one
   * kept; `undefined` leaves it alone. The third argument is the campaign id
   * (as before) or `{ campaignId?, kind? }`, and a fourth `{ kind? }` may
   * follow a positional campaign — the elements call
   * `registerSlot(id, name, campaignId, { kind })` so a facade from an older
   * bundle, which reads only three arguments, still gets the campaign. `kind`
   * is what kind of element holds the slot (`card` | `carousel` | `detail`);
   * the FIRST kind an id gets stays (the cards a carousel renders share its
   * id: the slot is the carousel's). The returned function unregisters;
   * removal never re-declares.
   */
  registerSlot(
    name: string,
    displayName?: string,
    campaignIdOrOptions?: number | string | null | RegisterSlotOptions,
    options?: RegisterSlotOptions,
  ): () => void {
    const id = normalizeSlotId(name)
    if (!id) return () => {}
    const label = typeof displayName === 'string' && displayName.trim() ? displayName.trim() : undefined
    const positional: RegisterSlotOptions =
      campaignIdOrOptions !== null && typeof campaignIdOrOptions === 'object'
        ? campaignIdOrOptions
        : { campaignId: campaignIdOrOptions }
    const merged: RegisterSlotOptions = { ...positional, ...(options ?? {}) }
    const campaign = toCampaignId(merged.campaignId) // invalid (0, -5, 'x') = absent: leaves the kept one alone
    const kind = normalizeSlotKind(merged.kind)
    const entry = this.slotRegistry.get(id)
    let changed = false
    if (!entry) {
      this.slotRegistry.set(id, { count: 1, displayName: label, campaignId: campaign, kind })
      changed = true
    } else {
      entry.count++
      if (label !== undefined && label !== entry.displayName) {
        entry.displayName = label
        changed = true
      }
      if (campaign !== undefined && campaign !== entry.campaignId) {
        entry.campaignId = campaign
        changed = true
      }
      if (kind !== undefined && entry.kind === undefined) {
        entry.kind = kind
        changed = true
      }
    }
    if (changed) {
      this.slotsDirty = true
      if (this.cachedBootstrap) this.scheduleSlotDeclaration()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.slotRegistry.get(id)
      if (!current) return
      if (current.count <= 1) this.slotRegistry.delete(id)
      else current.count--
    }
  }

  /**
   * The campaign a slot shows now, from the last bootstrap: its assigned and
   * open campaign for the init platform, else the surface's default. With no
   * slot, the default. `null` before the bootstrap. See `resolveSlotCampaign`.
   */
  campaignForSlot(
    slot?: string | null,
    hint?: { campaignId?: CampaignHint; sponsorId?: number | string | null },
  ): BootstrapCampaignEntry | null {
    const config = Configuration.isInitialized ? Configuration.get() : undefined
    return resolveSlotCampaign(
      this.cachedBootstrap,
      slot ?? null,
      Date.now(),
      config?.platform,
      this.pageCampaignCandidates(hint?.campaignId),
      toNumber(hint?.sponsorId),
    )
  }

  /** The page-campaign candidates in precedence order: the element's (own, ancestor), then `Vio.init`'s. */
  private pageCampaignCandidates(hint: CampaignHint): number[] {
    const config = Configuration.isInitialized ? Configuration.get() : undefined
    return campaignCandidates([...(Array.isArray(hint) ? hint : [hint]), config?.campaignId])
  }

  /**
   * The campaign the PAGE belongs to (`Vio.init({ campaignId })`, ADR-0034
   * amendment 3), as the last bootstrap lists it — only when it is there and
   * active; `null` otherwise (no page campaign, paused, unknown, no bootstrap).
   */
  pageCampaign(): BootstrapCampaignEntry | null {
    const config = Configuration.isInitialized ? Configuration.get() : undefined
    return activeCampaignEntry(this.cachedBootstrap, config?.campaignId)
  }

  /**
   * THE attribution helper — the SDK elements, Vev and Replit all use this
   * one. For a place (`slot`): the campaign it shows right now
   * (`campaignForSlot`: its assignment, else the surface's default) as
   * `campaignId` + that campaign's primary sponsor as `sponsorId`, plus the
   * page's content (`content()`). Pure, never throws; `{}` before the
   * bootstrap, except the content.
   *
   * `hint.sponsorId` — when the caller already knows the sponsor (a card with
   * `sponsor-id`) it is kept as `sponsorId`, and the campaign follows the same
   * cascade analytics uses (slot assignment → page campaign → the sponsor's
   * active campaign → default), so what the cart remembers matches what the
   * events say — the page campaign applies there only when that sponsor takes
   * part in it. `hint.campaignId` — the element's own page campaign
   * candidates (`vio-campaign`, an ancestor's `data-vio-campaign`), ahead of
   * `Vio.init`'s; an unusable one falls through to the next; `0` = unset.
   */
  attribution(
    slot?: string | null,
    hint?: { sponsorId?: number | string; campaignId?: CampaignHint },
  ): Attribution {
    const out: Attribution = {}
    try {
      const name = normalizeSlotId(slot)
      if (name) out.slot = name
      const boot = this.cachedBootstrap
      const hinted = toNumber(hint?.sponsorId)
      const pageCampaignId = this.pageCampaignCandidates(hint?.campaignId)
      if (boot) {
        if (hinted !== undefined) {
          const campaignId = resolveCampaignId({ slot: name || undefined, sponsorId: hinted }, boot, {
            pageCampaignId,
          })
          if (campaignId !== undefined) out.campaignId = campaignId
          out.sponsorId = hinted
        } else {
          const campaign = this.campaignForSlot(name || null, { campaignId: pageCampaignId })
          const campaignId = toNumber(campaign?.id)
          if (campaignId !== undefined) out.campaignId = campaignId
          const sponsorId = toNumber(campaign?.primarySponsor?.id)
          if (sponsorId !== undefined) out.sponsorId = sponsorId
        }
      } else if (hinted !== undefined) {
        out.sponsorId = hinted
      }
      const content = this.content()
      if (content.id) out.contentId = content.id
      if (content.title) out.contentTitle = content.title
      if (content.url) out.contentUrl = content.url
    } catch {
      /* attribution never breaks a render or a click */
    }
    return out
  }

  /**
   * What the surface answered and is still believed: `standard` / `minimal`
   * for the configuration; `unknown` for a minute after a timeout or a
   * failure (then it is asked again). `null` = nothing believed.
   */
  private believedSurfaceMode(): PrivacyAnswer | null {
    const answer = this.surfaceMode
    if (!answer) return null
    if (answer.mode !== 'unknown') return answer.mode
    return Date.now() - answer.at < PRIVACY_UNKNOWN_TTL_MS ? 'unknown' : null
  }

  /**
   * Ask the surface its privacy mode (`GET /v2/mobile/surface`), once —
   * started at `init()` and again by `bootstrap()`, never by the payment
   * path, which only reads what is known (`privacyModeNow`). Resolves what
   * was learnt within 1.5 s: the mode; `standard` for a service that predates
   * the endpoint (404) or a surface that names none; `unknown` for a word the
   * SDK does not know, a timeout or any other failure — believed for a
   * minute, then asked again. An answer that arrives after the cap still
   * lands for the next step. Never throws.
   */
  preloadPrivacyMode(): Promise<PrivacyAnswer> {
    try {
      if (this.surfaceRequest) return this.surfaceRequest
      const believed = this.believedSurfaceMode()
      if (believed) return Promise.resolve(believed)
      if (!Configuration.isInitialized) return Promise.resolve('unknown')
      const now = Date.now()
      if (Configuration.get().privacyMode === 'minimal') {
        this.surfaceMode = { mode: 'minimal', at: now }
        return Promise.resolve('minimal')
      }
      const generation = this.generation
      const learnt = (mode: PrivacyAnswer) => {
        // An older key's answer is not this surface's.
        if (generation !== this.generation) return
        // A real answer after a timeout replaces the "unknown"; never the other way round.
        if (mode === 'unknown' && this.surfaceMode && this.surfaceMode.mode !== 'unknown') return
        this.surfaceMode = { mode, at: Date.now() }
      }
      const asked: Promise<PrivacyAnswer> = this.api.surface().then(
        (res) => privacyModeOfSurface(res),
        (err: unknown) => (err instanceof VioApiError && err.status === 404 ? 'standard' : 'unknown'),
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      const capped = new Promise<PrivacyAnswer>((resolve) => {
        timer = setTimeout(() => resolve('unknown'), PRIVACY_MODE_TIMEOUT_MS)
      })
      const request: Promise<PrivacyAnswer> = Promise.race([asked, capped]).then((mode) => {
        clearTimeout(timer)
        learnt(mode)
        if (this.surfaceRequest === request) this.surfaceRequest = null
        return mode
      })
      // The late answer, if the cap won.
      void asked.then((mode) => {
        clearTimeout(timer)
        learnt(mode)
      })
      this.surfaceRequest = request
      return request
    } catch {
      return Promise.resolve('unknown')
    }
  }

  /**
   * How much of the visit the order attribution may carry (ADR-0035): the
   * surface's privacy mode, as known RIGHT NOW, without waiting —
   * `Vio.init({ privacyMode: 'minimal' })` when the host says so, else what
   * the bootstrap says of the surface, else what the surface answered to the
   * ask `init()` started (`preloadPrivacyMode`), else the host's `standard`
   * once the surface could not tell. `unknown` while nothing is known: then
   * the page, the slot and the entry stay off what goes to Commerce, because
   * what can reveal which screen someone was on, and why, is only sent when
   * the surface is known to allow it. The payment path reads this one.
   */
  privacyModeNow(): PrivacyAnswer {
    try {
      const config = Configuration.isInitialized ? Configuration.get() : undefined
      if (config?.privacyMode === 'minimal') return 'minimal'
      const fromBootstrap = privacyModeOf(this.cachedBootstrap?.surface?.privacyMode)
      if (fromBootstrap) return fromBootstrap
      if (!config) return 'unknown'
      const believed = this.believedSurfaceMode()
      if (believed === 'standard' || believed === 'minimal') return believed
      // Nothing believed, nothing asked: ask now for the next time.
      if (!believed) this.preloadPrivacyMode()
      // The host's word stands in only once the surface could not tell.
      return believed === 'unknown' ? (config.privacyMode ?? 'unknown') : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * `privacyModeNow`, but waiting for the ask in flight when there is one
   * (at most its 1.5 s cap) — for the cart's lines, which are not the
   * payment path. Never throws.
   */
  async privacyMode(): Promise<PrivacyAnswer> {
    try {
      const now = this.privacyModeNow()
      if (now !== 'unknown') return now
      if (!this.surfaceRequest) return 'unknown'
      const asked = await this.surfaceRequest
      if (asked !== 'unknown') return asked
      const config = Configuration.isInitialized ? Configuration.get() : undefined
      return config?.privacyMode ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * The attribution of the order a sponsor's cart is about to become
   * (ADR-0035 phase B) — what `CreateCheckout` / `UpdateCheckout` send as
   * `attribution` and shopcart writes on the order: the surface (its SDK
   * key), the page's campaign (`pageCampaign()`; without one, the campaign
   * that explains most units of the cart under the same rule `purchase` is
   * split by — `cartSlices`) and, on a surface KNOWN to be `standard`
   * (`privacyModeNow`), the page (`content()`'s url as origin + path, and
   * title) and where the session came in: the landing the session REMEMBERS
   * (`storedLanding`, else the one analytics resolved on this page) — never
   * the page the shopper pays on taken for a landing. Synchronous: nothing
   * on the way to a payment waits for it. snake_case, capped to Commerce's
   * limits. `undefined` when there is nothing to say; never throws.
   */
  orderAttribution(sponsorId?: number): CheckoutAttributionWire | undefined {
    try {
      const config = Configuration.isInitialized ? Configuration.get() : undefined
      const content = this.content()
      return checkoutAttributionOf({
        surfaceKey: config?.apiKey,
        pageCampaignId: toNumber(this.pageCampaign()?.id),
        slices: this.cartSlices(sponsorId),
        content: { url: content.url, title: content.title },
        landing: this.rememberedLanding(),
        privacyMode: this.privacyModeNow(),
      })
    } catch {
      return undefined
    }
  }

  /** The landing the session remembers: what the first page stored, else what analytics resolved on this page load (consent pending); null otherwise. */
  private rememberedLanding(): Landing | null {
    try {
      return storedLanding() ?? this.analyticsManager?.currentLanding ?? null
    } catch {
      return null
    }
  }

  /**
   * The cart split per campaign — the SAME rule `begin_checkout` / `purchase`
   * use, for hosts with their own analytics sink (Vev). Every unit of every
   * line goes to the campaign of its origin; units without one to the campaign
   * the current rule resolves for the line's sponsor (slot assignment → the
   * sponsor's active campaign → default); `slot` / `contentId` / `sponsorId`
   * only when they are the same for the whole slice; `value` with two
   * decimals; `slice` / `slices` number the parts. Pure over the current cart
   * (or over `opts.items`); `[]` when there is nothing.
   */
  cartSlices(sponsorId?: number, opts: { items?: CartLineItem[] } = {}): CartSlice[] {
    try {
      let lines: CartLineItem[] = []
      if (Array.isArray(opts.items)) {
        lines = opts.items.filter((i) => sponsorId === undefined || Number(i?.sponsorId) === Number(sponsorId))
      } else {
        this.cart.getAllCarts().forEach((state, id) => {
          if (sponsorId === undefined || id === Number(sponsorId)) lines.push(...state.items)
        })
      }
      const boot = this.cachedBootstrap
      return cartSlicesFrom(lines, (slot, lineSponsorId) =>
        resolveCampaignId({ slot, sponsorId: lineSponsorId }, boot),
      )
    } catch {
      return []
    }
  }

  /**
   * What the micro did with the page's campaign per slot (`assignment`):
   * `console.debug` when `Vio.init({ debug: true })`; a warning once per
   * slot when the dashboard's own assignment stands (only for a slot this
   * page actually sent a campaign for) and once per slot when this page moved
   * it from an earlier page assignment (`replaced`).
   */
  private reportAssignments(
    result: ManifestResult | null | undefined,
    sent: ReadonlyArray<ManifestLocation>,
    pageCampaignId: number | undefined,
    debug: boolean,
  ): void {
    const answered = Array.isArray(result?.locations) ? result.locations : []
    const campaignFor = (id: string) =>
      sent.find((l) => l.id === id)?.campaignId ?? pageCampaignId
    for (const l of answered) {
      if (!l || typeof l !== 'object' || !l.assignment) continue
      if (debug && typeof console !== 'undefined') console.debug('[Vio] slot', l.locationId, 'assignment:', l.assignment)
      const sentCampaign = campaignFor(l.locationId)
      if (sentCampaign === undefined) continue
      if (l.assignment === 'dashboard' && !this.warnedDashboardSlots.has(l.locationId)) {
        this.warnedDashboardSlots.add(l.locationId)
        warn(`slot ${l.locationId} is assigned from the dashboard; the page's campaign is ignored there`)
      }
      if (l.assignment === 'replaced' && !this.warnedReplacedSlots.has(l.locationId)) {
        this.warnedReplacedSlots.add(l.locationId)
        warn(`slot ${l.locationId} moved to campaign ${sentCampaign} by this page (it replaced an earlier page assignment)`)
      }
    }
  }

  /**
   * The memory keys of the sent locations whose campaign the micro did not
   * take up: every location when a campaign was sent and no answer carries
   * `assignment` (an older micro), or the ones answered `none` for a campaign
   * the bootstrap lists as active. They are remembered with the 1 h TTL.
   */
  private campaignNotTakenUp(
    result: ManifestResult | null | undefined,
    sent: ReadonlyArray<ManifestLocation>,
    pageCampaignId: number | undefined,
  ): Set<string> {
    const out = new Set<string>()
    const withCampaign = sent.filter((l) => (l.campaignId ?? pageCampaignId) !== undefined)
    if (withCampaign.length === 0) return out
    const answered = Array.isArray(result?.locations) ? result.locations : []
    const anyAssignment = answered.some((l) => l && typeof l === 'object' && !!l.assignment)
    for (const l of withCampaign) {
      const answer = answered.find((a) => a && a.locationId === l.id)
      const campaignId = l.campaignId ?? pageCampaignId
      const notTaken =
        !anyAssignment ||
        (answer?.assignment === 'none' && activeCampaignEntry(this.cachedBootstrap, campaignId) !== null)
      if (notTaken) out.add(slotDeclarationKey(l, pageCampaignId))
    }
    return out
  }

  private scheduleSlotDeclaration(): void {
    if (this.slotDeclareTimer) clearTimeout(this.slotDeclareTimer)
    this.slotDeclareTimer = setTimeout(() => {
      this.slotDeclareTimer = null
      this.slotsDirty = false
      void this.declareSlots(
        [...this.slotRegistry.entries()].map(([id, { displayName, campaignId, kind }]) => ({
          id,
          ...(displayName ? { displayName } : {}),
          ...(campaignId !== undefined ? { campaignId } : {}),
          ...(kind ? { kind } : {}),
        })),
      )
    }, SLOT_DECLARATION_DEBOUNCE_MS)
  }

  private findSponsor(sponsorId: number): Sponsor | undefined {
    const boot = this.cachedBootstrap
    if (!boot) return undefined
    const id = Number(sponsorId)
    if (Number(boot.primarySponsor?.id) === id) return boot.primarySponsor
    const secondary = boot.secondarySponsors?.find((s) => Number(s.id) === id)
    if (secondary) return secondary
    // A sponsor may live only in a non-default campaign (the one a slot shows).
    const campaigns = Array.isArray(boot.campaigns) ? boot.campaigns : []
    for (const c of campaigns) {
      if (!c || typeof c !== 'object') continue
      if (Number(c.primarySponsor?.id) === id) return c.primarySponsor ?? undefined
      const s = Array.isArray(c.secondarySponsors)
        ? c.secondarySponsors.find((x) => Number(x?.id) === id)
        : undefined
      if (s) return s
    }
    return undefined
  }
}

function warn(...args: unknown[]): void {
  if (typeof console !== 'undefined') console.warn('[Vio]', ...args)
}

/** The timestamp a failed attempt is remembered at: it expires after the 1 h failure TTL. */
function failedAt(now: number): number {
  return now - (SLOT_DECLARATION_TTL_MS - SLOT_DECLARATION_FAILURE_TTL_MS)
}


// Cross-bundle singleton. Some hosts (e.g. Vev) bundle each component into its
// own chunk, so a plain module-level instance would give EACH chunk its own
// `Vio` — separate cart + bootstrap cache. That breaks shared state (one chunk
// bootstraps, another reads an empty cache → "Sponsor not found"). Anchoring the
// facade on `globalThis` means every copy resolves to the SAME instance within a
// page. SSR-safe: `globalThis` exists in Node too.
const _vioGlobal = globalThis as unknown as { __VIO_FACADE__?: VioFacade }
export const Vio: VioFacade =
  _vioGlobal.__VIO_FACADE__ ?? (_vioGlobal.__VIO_FACADE__ = new VioFacade())
