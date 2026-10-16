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
import { createVioApi, type VioApi } from './api/vio.js'
import { createCommerceClient, type CommerceClient } from './api/commerce.js'
import { CartManager } from './cart/cart-manager.js'
import { CheckoutManager } from './checkout/checkout-manager.js'
import { AnalyticsManager, resolveCampaignId } from './analytics/analytics-manager.js'
import { resolveContent, type ContentRef } from './content.js'
import {
  isSlotDeclarationFresh,
  normalizeSlotId,
  normalizeSlotLocations,
  readSlotDeclaration,
  resolveSlotCampaign,
  slotDeclarationKeys,
  slotDeclarationStorageKey,
  writeSlotDeclaration,
  type SlotInput,
} from './slots.js'
import type {
  Attribution,
  BootstrapCampaignEntry,
  BootstrapResponse,
  ManifestResult,
  Sponsor,
} from './types.js'

/** Mount storms (a carousel of cards, Vev blocks) collapse into ONE manifest. */
const SLOT_DECLARATION_DEBOUNCE_MS = 1_000

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

  /** Slot ids present on the page (`Vio.registerSlot`): how many elements hold each + its display name. */
  private slotRegistry = new Map<string, { count: number; displayName?: string }>()
  /** Pending debounced declaration of the registry. */
  private slotDeclareTimer: ReturnType<typeof setTimeout> | null = null
  /** A name appeared (or the key changed) since the registry was last declared. */
  private slotsDirty = false
  /** `Vio.content()` resolved once per page; forgotten on every init(). */
  private contentCache: ContentRef | null = null

  // Client-side managers — created lazily on first access. They don't
  // need Vio.init() to work (state is purely local).
  private cartManager: CartManager | null = null
  private checkoutManager: CheckoutManager | null = null
  private analyticsManager: AnalyticsManager | null = null

  init(config: VioConfig): void {
    Configuration.init(config)
    // Reset cached backend instances so a re-init picks up the new config.
    this.apiInstance = null
    this.commerceClients.clear()
    this.bootstrapPromise = null
    this.cachedBootstrap = null
    this.bootstrapFailedAt = 0
    this.generation++
    // A new key/environment invalidates the per-sponsor payment methods too.
    this.checkoutManager?.clearPaymentMethodsCache()
    // The page's slots stay; they are declared again once the NEW key has
    // bootstrapped (a declaration pending for the old key is dropped).
    if (this.slotDeclareTimer) {
      clearTimeout(this.slotDeclareTimer)
      this.slotDeclareTimer = null
    }
    this.slotsDirty = this.slotRegistry.size > 0
    // A re-init may carry another contentId/contentTitle.
    this.contentCache = null
    // NOTE: cart / checkout managers are NOT reset — user cart state is
    // independent of SDK re-config.
  }

  /**
   * The content (article, page) this SDK instance is rendered in — what every
   * analytics event carries as `content_id` / `content_title` when the event
   * has no explicit one. Resolved once per page (init option → URL query →
   * `vio:content-*` metas → canonical/og:url → pathname; see
   * `resolveContent`), forgotten on every `init()`. Never throws; `{}` without
   * a document.
   */
  content(): ContentRef {
    if (this.contentCache) return this.contentCache
    let init: { contentId?: string | number; contentTitle?: string } | undefined
    if (Configuration.isInitialized) {
      const cfg = Configuration.get()
      init = { contentId: cfg.contentId, contentTitle: cfg.contentTitle }
    }
    const resolved = resolveContent(init)
    // Cache only once a document could be asked — SSR answers `{}` and must
    // not freeze an empty answer for a later hydration on the same facade.
    if (typeof document !== 'undefined') this.contentCache = resolved
    return resolved
  }

  get isInitialized(): boolean { return Configuration.isInitialized }
  get config() { return Configuration.get() }

  // MARK: - Client-side managers (no init required)

  /** Multi-sponsor cart manager. Reactive — listen via addEventListener('change', ...). */
  get cart(): CartManager {
    if (!this.cartManager) this.cartManager = new CartManager()
    return this.cartManager
  }

  /** Checkout flow manager. Subscribes to cart state via the CartManager. */
  get checkout(): CheckoutManager {
    if (!this.checkoutManager) this.checkoutManager = new CheckoutManager(this.cart)
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
    try {
      const locations = normalizeSlotLocations(slots)
      if (locations.length === 0) return null
      if (!Configuration.isInitialized) {
        warn('declareSlots() before Vio.init() — nothing declared')
        return null
      }
      const cfg = Configuration.get()
      const storageKey = slotDeclarationStorageKey(cfg.platform, cfg.apiKey)
      // Display names are part of the key: a renamed block declares again.
      const keys = slotDeclarationKeys(locations)
      const now = Date.now()
      if (!opts.force && isSlotDeclarationFresh(readSlotDeclaration(storageKey), keys, now)) {
        return null
      }
      const result = await this.api.declareManifest({
        platform: cfg.platform,
        mode: 'merge',
        locations,
      })
      // A server that predates `mode` drops the field, answers 200 without it
      // and REPLACES (it deprecates the other pages' slots). Only a declaration
      // the server confirms as merged is remembered — otherwise the next page
      // load tries again, and succeeds once the server is updated.
      if (result?.mode === 'merge') {
        writeSlotDeclaration(storageKey, { keys, at: now })
      } else {
        warn(
          'slots declared but the server ignored mode=merge (old server); not caching, will retry next load',
        )
      }
      return result
    } catch (err) {
      warn('declareSlots() failed —', err)
      return null
    }
  }

  /**
   * Register a slot present on the page (the `<vio-*>` elements call it with
   * their effective id — the host's `vio-slot` or the auto-generated one —
   * and the optional display name). The registry is declared ONCE, debounced,
   * after the first successful bootstrap — and again whenever a new id or a
   * new display name appears. A `displayName` given later for an id already
   * registered replaces the one kept; `undefined` leaves it alone. The
   * returned function unregisters; removal never re-declares.
   */
  registerSlot(name: string, displayName?: string): () => void {
    const id = normalizeSlotId(name)
    if (!id) return () => {}
    const label = typeof displayName === 'string' && displayName.trim() ? displayName.trim() : undefined
    const entry = this.slotRegistry.get(id)
    let changed = false
    if (!entry) {
      this.slotRegistry.set(id, { count: 1, displayName: label })
      changed = true
    } else {
      entry.count++
      if (label !== undefined && label !== entry.displayName) {
        entry.displayName = label
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
  campaignForSlot(slot?: string | null): BootstrapCampaignEntry | null {
    const platform = Configuration.isInitialized ? Configuration.get().platform : undefined
    return resolveSlotCampaign(this.cachedBootstrap, slot ?? null, Date.now(), platform)
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
   * cascade analytics uses (slot assignment → the sponsor's active campaign →
   * default), so what the cart remembers matches what the events say.
   */
  attribution(slot?: string | null, hint?: { sponsorId?: number | string }): Attribution {
    const out: Attribution = {}
    try {
      const name = typeof slot === 'string' ? slot.trim() : ''
      if (name) out.slot = name
      const boot = this.cachedBootstrap
      const hinted = toNumber(hint?.sponsorId)
      if (boot) {
        if (hinted !== undefined) {
          const campaignId = resolveCampaignId({ slot: name || undefined, sponsorId: hinted }, boot)
          if (campaignId !== undefined) out.campaignId = campaignId
          out.sponsorId = hinted
        } else {
          const campaign = this.campaignForSlot(name || null)
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
    } catch {
      /* attribution never breaks a render or a click */
    }
    return out
  }

  private scheduleSlotDeclaration(): void {
    if (this.slotDeclareTimer) clearTimeout(this.slotDeclareTimer)
    this.slotDeclareTimer = setTimeout(() => {
      this.slotDeclareTimer = null
      this.slotsDirty = false
      void this.declareSlots(
        [...this.slotRegistry.entries()].map(([id, { displayName }]) =>
          displayName ? { id, displayName } : id,
        ),
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

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
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
