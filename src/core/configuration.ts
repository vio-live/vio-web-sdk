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

export type Environment = 'development' | 'testing' | 'production'

export interface VioConfig {
  /** Vio API key for this client app (from the Vio dashboard). */
  apiKey: string
  /** Target environment. Defaults to 'development'. */
  environment?: Environment
  /** Override REST API base. Defaults are env-aware. */
  apiBase?: string
  /** Override GraphQL base. Defaults are env-aware. */
  graphQLBase?: string
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
  apiBase: string
  graphQLBase: string
  stripePublishableKey?: string
  klarnaClientId?: string
  klarnaEnvironment: 'playground' | 'production'
}

const DEFAULT_URLS: Record<Environment, { apiBase: string; graphQLBase: string }> = {
  development: {
    apiBase: 'https://api-dev.vio.live',
    graphQLBase: 'https://graph-ql-dev.vio.live',
  },
  testing: {
    apiBase: 'https://api-dev.vio.live',
    graphQLBase: 'https://graph-ql-dev.vio.live',
  },
  production: {
    apiBase: 'https://api.vio.live',
    graphQLBase: 'https://graph-ql.vio.live',
  },
}

class ConfigurationSingleton {
  private resolved: ResolvedConfig | null = null

  init(input: VioConfig): void {
    if (!input.apiKey || typeof input.apiKey !== 'string') {
      throw new Error('[Vio] apiKey is required in Vio.init({ apiKey })')
    }
    const env: Environment = input.environment ?? 'development'
    const defaults = DEFAULT_URLS[env]
    this.resolved = {
      apiKey: input.apiKey,
      environment: env,
      apiBase: input.apiBase ?? defaults.apiBase,
      graphQLBase: input.graphQLBase ?? defaults.graphQLBase,
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
        apiBase: this.resolved.apiBase,
        apiKey: masked,
        stripeConfigured: !!input.stripePublishableKey,
        klarnaConfigured: !!input.klarnaClientId,
        klarnaEnvironment: this.resolved.klarnaEnvironment,
      })
    }
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

  /** For tests only. */
  reset(): void {
    this.resolved = null
  }
}

export const Configuration = new ConfigurationSingleton()
