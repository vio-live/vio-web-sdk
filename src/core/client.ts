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
import type { BootstrapResponse, Sponsor } from './types.js'

class VioFacade {
  private apiInstance: VioApi | null = null
  private commerceClients = new Map<number, CommerceClient>()
  private bootstrapPromise: Promise<BootstrapResponse> | null = null
  private cachedBootstrap: BootstrapResponse | null = null

  // Client-side managers — created lazily on first access. They don't
  // need Vio.init() to work (state is purely local).
  private cartManager: CartManager | null = null
  private checkoutManager: CheckoutManager | null = null

  init(config: VioConfig): void {
    Configuration.init(config)
    // Reset cached backend instances so a re-init picks up the new config.
    this.apiInstance = null
    this.commerceClients.clear()
    this.bootstrapPromise = null
    this.cachedBootstrap = null
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
    this.bootstrapPromise = this.api
      .bootstrap()
      .then((res) => {
        this.cachedBootstrap = res
        return res
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
