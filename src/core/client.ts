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
import { AnalyticsManager } from './analytics/analytics-manager.js'
import type { BootstrapResponse, Sponsor } from './types.js'

class VioFacade {
  private apiInstance: VioApi | null = null
  private commerceClients = new Map<number, CommerceClient>()
  private bootstrapPromise: Promise<BootstrapResponse> | null = null
  private cachedBootstrap: BootstrapResponse | null = null
  /** Last bootstrap failure — short backoff so cart mutations don't hammer a
   * dead endpoint on every call. */
  private bootstrapFailedAt = 0

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
    // A new key/environment invalidates the per-sponsor payment methods too.
    this.checkoutManager?.clearPaymentMethodsCache()
    // NOTE: cart / checkout managers are NOT reset — user cart state is
    // independent of SDK re-config.
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

  /** Lazy VioApi for REST endpoints on `api-dev.vio.live`. */
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
    this.bootstrapPromise = this.api
      .bootstrap()
      .then((res) => {
        this.cachedBootstrap = res
        this.bootstrapFailedAt = 0
        return res
      })
      .catch((err) => {
        this.bootstrapFailedAt = Date.now()
        throw err
      })
      .finally(() => {
        this.bootstrapPromise = null
      })
    return this.bootstrapPromise
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

  private findSponsor(sponsorId: number): Sponsor | undefined {
    const boot = this.cachedBootstrap
    if (!boot) return undefined
    const id = Number(sponsorId)
    if (Number(boot.primarySponsor?.id) === id) return boot.primarySponsor
    return boot.secondarySponsors?.find((s) => Number(s.id) === id)
  }
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
