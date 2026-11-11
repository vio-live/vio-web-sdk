/**
 * Vio Configuration — singleton holding apiKey, environment, base URLs,
 * and optional payment-vendor publishable keys.
 *
 * Mirrors `VioConfiguration.shared` in the iOS SDK. Initialised once via
 * `Vio.init({ apiKey, ... })`; consumed via `Configuration.get()`.
 *
 * Secrets (apiKey) never come from inside the SDK — the consumer reads
 * them from env vars / their config and passes them to `Vio.init`.
 */

import { toCampaignId } from './slots.js'
import { normalizeDiscountCode } from './cart/discount-code.js'

export type Environment = 'development' | 'testing' | 'production'

/**
 * Platform type of the surface this page belongs to (ADR-0027). It travels
 * with every slot declaration and as `?platform=` on the bootstrap, so the
 * campaigns service only answers with the slot assignments of this platform.
 */
export type VioPlatform = 'web' | 'custom-web' | 'vev'

export interface VioConfig {
  /** Vio API key for this client app (from the Vio dashboard). */
  apiKey: string
  /** Target environment. Defaults to 'development'. */
  environment?: Environment
  /**
   * Platform type of this surface: `web` (the no-code snippet), `custom-web`
   * (the SDK integrated by code) or `vev`. Defaults to `web`.
   */
  platform?: VioPlatform
  /**
   * The host's own id for the content (article, page) this SDK instance is
   * rendered in — the first choice of `Vio.content()`, ahead of the URL query,
   * the `vio:content-id` meta, the canonical URL and the pathname. Goes on
   * every analytics event as `content_id`.
   */
  contentId?: string | number
  /** Human-readable title of that content (`content_title`); see `contentId`. */
  contentTitle?: string
  /**
   * The campaign this PAGE belongs to (ADR-0034, amendment 3) — an editorial
   * page (a Vev article, a Replit article) that is part of one campaign. Its
   * slots are declared with it (the micro assigns them unless the dashboard
   * already did) and, until that round-trips, the elements already resolve to
   * it: assignment → page campaign → default. DOM alternative, inheritable:
   * `data-vio-campaign` on any ancestor, or `vio-campaign` on the element.
   */
  campaignId?: number
  /**
   * A discount code for this page's carts — an OVERRIDE: the recommended
   * place for a campaign's code is the campaign itself, in Vio's dashboard,
   * per sponsor (the SDK puts it on that sponsor's cart by itself on the
   * campaign's pages, by reference — the code never reaches the page). This
   * one goes on every
   * sponsor's cart instead, the same way — the shopper types nothing — once
   * the cart has lines, on every new cart, and before a checkout or a
   * payment is built on it. Commerce takes one code per cart; when it does
   * not take this one, nothing is said (nobody typed it) and the purchase
   * goes on without it. Wins over a `?vio_discount=` in the URL, which wins
   * over the campaign's. Naming a code turns discount codes on for the page:
   * the «Rabattkode» field shows too (see `discountField`). Only on the carts
   * of brands one of whose ways to pay takes discount codes (Vipps, for now):
   * it waits for the bootstrap to know (README → Discount codes).
   */
  discountCode?: string
  /**
   * The «Rabattkode» field of the cart and of the checkout's summary, where
   * the shopper types the brand's code, sees what came of it before paying
   * (taken: the discount or the gift, and the new total; not taken: why, and
   * the total as it was) and takes the code off again.
   *
   * Shown by default wherever discount codes are on for the page — it names
   * a `discountCode`, or its link carried `?vio_discount=`. A code the
   * page's CAMPAIGN gives does not turn it on. `true` shows it on a page with
   * no code of its own (the shopper types the brand's; with the campaign's
   * on the cart it says a discount is on — never its code — and «Fjern»);
   * `false` hides it (the page's own code still goes on the cart). A page
   * that says nothing about discount codes has no field. Only for brands
   * that are paid with Vipps.
   */
  discountField?: boolean
  /** Log the SDK's slot/attribution decisions at `console.debug` (manifest assignments per slot). */
  debug?: boolean
  /**
   * The surface's privacy mode, when the host knows it (ADR-0035): `minimal`
   * keeps the entry context (referrer, utm, landing page) off the order
   * attribution. Without it the SDK asks the surface itself
   * (`GET /v2/mobile/surface`), once per page load; a host-set `minimal`
   * always wins.
   */
  privacyMode?: 'standard' | 'minimal'
  /** Override REST API base. Defaults are env-aware. */
  apiBase?: string
  /** Override GraphQL base. Defaults are env-aware. */
  graphQLBase?: string
  /**
   * Override the analytics collector base (vio-analytics service).
   * Defaults are env-aware (`events-dev`/`events-staging`/`events.vio.live`).
   */
  eventsBase?: string
  /**
   * Stripe **publishable** key (`pk_test_xxx` or `pk_live_xxx`). Used for
   * Apple Pay (via Payment Request) and Card flows. Public-safe — fine
   * to expose in client bundles.
   */
  stripePublishableKey?: string
  /**
   * Klarna **Client Identifier** for Express Checkout (KEC). Public-safe.
   * From Merchant Portal → Payment settings → Client Identifiers. When set,
   * the checkout shows the Klarna Express button; when absent it degrades
   * to the plain method selector. Must match `klarnaEnvironment`.
   */
  klarnaClientId?: string
  /**
   * Klarna environment for the Express button. `playground` = sandbox
   * (test orders, no real money), `production` = live. Defaults to
   * `playground` so dev/test never hits live Klarna by accident.
   */
  klarnaEnvironment?: 'playground' | 'production'
}

export interface ResolvedConfig {
  apiKey: string
  environment: Environment
  platform: VioPlatform
  contentId?: string | number
  contentTitle?: string
  campaignId?: number
  /** The page's discount code as it is sent (trimmed); absent when none was given or it was not a code. */
  discountCode?: string
  /** What the page said about the «Rabattkode» field (`true` / `false`); absent when it said nothing (`discountFieldEnabled` decides). */
  discountField?: boolean
  debug: boolean
  privacyMode?: 'standard' | 'minimal'
  apiBase: string
  graphQLBase: string
  eventsBase: string
  stripePublishableKey?: string
  klarnaClientId?: string
  klarnaEnvironment: 'playground' | 'production'
}

const DEFAULT_URLS: Record<
  Environment,
  { apiBase: string; graphQLBase: string; eventsBase: string }
> = {
  // The Vio Backend development environment was removed on 2026-09-16; its REST
  // and events hosts now point at staging (Commerce GraphQL dev is unaffected).
  development: {
    apiBase: 'https://api-staging.vio.live',
    graphQLBase: 'https://graph-ql-dev.vio.live',
    eventsBase: 'https://events-staging.vio.live',
  },
  // No separate staging GraphQL deployment yet — shares dev's.
  testing: {
    apiBase: 'https://api-staging.vio.live',
    graphQLBase: 'https://graph-ql-dev.vio.live',
    eventsBase: 'https://events-staging.vio.live',
  },
  production: {
    apiBase: 'https://api.vio.live',
    graphQLBase: 'https://graph-ql.vio.live',
    eventsBase: 'https://events.vio.live',
  },
}

class ConfigurationSingleton {
  private resolved: ResolvedConfig | null = null
  private readyWaiters: Array<() => void> = []

  init(input: VioConfig): void {
    if (!input.apiKey || typeof input.apiKey !== 'string') {
      throw new Error('[Vio] apiKey is required in Vio.init({ apiKey })')
    }
    const env: Environment = input.environment ?? 'development'
    const defaults = DEFAULT_URLS[env]
    this.resolved = {
      apiKey: input.apiKey,
      environment: env,
      platform: input.platform ?? 'web',
      contentId: input.contentId,
      contentTitle: input.contentTitle,
      campaignId: toCampaignId(input.campaignId),
      ...(normalizeDiscountCode(input.discountCode) ? { discountCode: normalizeDiscountCode(input.discountCode) } : {}),
      ...(typeof input.discountField === 'boolean' ? { discountField: input.discountField } : {}),
      debug: input.debug === true,
      // Only the two words the backend knows; anything else is "not said".
      privacyMode:
        input.privacyMode === 'minimal' || input.privacyMode === 'standard' ? input.privacyMode : undefined,
      apiBase: input.apiBase ?? defaults.apiBase,
      graphQLBase: input.graphQLBase ?? defaults.graphQLBase,
      eventsBase: input.eventsBase ?? defaults.eventsBase,
      stripePublishableKey: input.stripePublishableKey,
      klarnaClientId: input.klarnaClientId,
      // Sandbox by default — live Klarna must be opted into explicitly.
      klarnaEnvironment: input.klarnaEnvironment ?? 'playground',
    }
    if (typeof console !== 'undefined') {
      const masked =
        input.apiKey.length > 4
          ? '*'.repeat(Math.max(0, input.apiKey.length - 4)) + input.apiKey.slice(-4)
          : '****'
      console.info('[Vio] Initialized', {
        environment: env,
        platform: this.resolved.platform,
        apiBase: this.resolved.apiBase,
        apiKey: masked,
        stripeConfigured: !!input.stripePublishableKey,
        klarnaConfigured: !!input.klarnaClientId,
        klarnaEnvironment: this.resolved.klarnaEnvironment,
      })
    }
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const waiter of waiters) waiter()
  }

  get(): ResolvedConfig {
    if (!this.resolved) {
      throw new Error(
        '[Vio] Not initialized. Call Vio.init({ apiKey }) before using the SDK.',
      )
    }
    return this.resolved
  }

  get isInitialized(): boolean {
    return this.resolved !== null
  }

  /**
   * Resolves once `Vio.init()` has run, or after `timeoutMs` — whichever
   * comes first. Hosts that mount several independent components (e.g. Vev
   * blocks, which mount in no guaranteed order) may have one fire a GraphQL
   * call before another has called `Vio.init()`. Awaiting this briefly lets
   * that race resolve instead of silently sending an unauthenticated
   * request. Resolves `true` if init happened in time, `false` on timeout —
   * callers should still degrade gracefully either way.
   */
  whenReady(timeoutMs = 2000): Promise<boolean> {
    if (this.resolved) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      this.readyWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  /** For tests only. */
  reset(): void {
    this.resolved = null
    this.readyWaiters = []
  }
}

export const Configuration = /* @__PURE__ */ new ConfigurationSingleton()
