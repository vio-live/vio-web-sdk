/**
 * Klarna Express Checkout (KEC) — via the Klarna Web SDK v2.
 *
 * Frontend half of the flow (the only half that runs client-side):
 *   1. Load the Klarna Web SDK ESM module from Klarna's CDN.
 *   2. `KlarnaSDK({ clientId, products: ['PAYMENT'] })` → SDK instance.
 *   3. `Klarna.Payment.button({ paymentRequest, initiationMode })` → button.
 *   4. `button.mount(container)` renders the express button.
 *   5. User taps it → Klarna popup → on success the SDK yields an
 *      **authorization token**.
 *
 * The authorization token is NOT an order. The merchant **backend** must
 * exchange it for an order against the Klarna Payments API
 * (`POST /payments/v1/authorizations/{token}/order`, Basic auth with the
 * server-side Klarna API key). That step needs secret credentials and is
 * intentionally out of this client module — we surface the token via
 * `onAuthorize` and let the host (or, later, vio-backend) create the order.
 *
 * Verified against Klarna Web SDK v2 docs (module URL, KlarnaSDK init,
 * Payment.button().mount(), authorization-token result). The exact
 * authorize *event name* varies by SDK minor version, so the subscription
 * below is defensive — it normalises across the documented shapes.
 *
 * Prerequisites (merchant-configured, like Stripe domain reg for Apple Pay):
 *   - Klarna merchant account + a **Client Identifier** (Merchant Portal →
 *     Payment settings → Client Identifiers).
 *   - The integration domain registered under "Allowed Origins".
 *   - A server-side Klarna API key for the order-creation step (backend).
 */

/** Klarna Web SDK v2 ESM module (loaded from Klarna's CDN at runtime). */
export const KLARNA_SDK_URL = 'https://js.klarna.com/web-sdk/v2/klarna.mjs'

/** One line in the express button's purchase data. Amounts in MINOR units. */
export interface KlarnaLineItem {
  name: string
  quantity: number
  /** Line total (unitPrice × quantity), minor units (e.g. øre for NOK). */
  totalAmount: number
  /** Per-unit price, minor units. Optional. */
  unitPrice?: number
  /** Merchant SKU / product reference. Optional. */
  reference?: string
  /** Absolute image URL. Optional. */
  imageUrl?: string
}

/** Payment request handed to the KEC button. Amounts in MINOR units. */
export interface KlarnaPaymentRequestData {
  /** ISO currency code (e.g. "NOK"). */
  currency: string
  /** Order total in minor units. */
  amount: number
  /** Line items — shown in the Klarna sheet. */
  supplementaryPurchaseData?: { lineItems: KlarnaLineItem[] }
}

export interface KlarnaConfig {
  /** Klarna Client Identifier (public-safe — fine in client bundles). */
  clientId: string
  /** Optional BCP-47 locale, e.g. "nb-NO". */
  locale?: string
  /**
   * Klarna environment. `playground` = sandbox (test orders, "TEST DRIVE"
   * badge, no real money). `production` = live. Defaults to the SDK's own
   * default when omitted. The clientId must be generated for the matching
   * environment in the Klarna Merchant Portal.
   */
  environment?: 'playground' | 'production'
}

export interface KlarnaAuthorizeResult {
  /** Authorization token — backend exchanges it for an order. */
  authorizationToken: string
  /** Klarna may require a finalize step (multistep flows). */
  finalizeRequired?: boolean
  /** Raw payload from the SDK, for debugging / forward-compat. */
  raw?: unknown
}

export interface KlarnaButtonHandle {
  unmount(): void
}

// ── Minimal structural typings for the runtime-loaded SDK ────────────────
// We don't ship Klarna's .d.ts; the SDK is fetched at runtime, so these are
// just enough to call it type-safely.

interface KlarnaButtonInstance {
  mount(container: string | HTMLElement): KlarnaButtonInstance
  unmount(): KlarnaButtonInstance
  on(event: string, cb: (...args: unknown[]) => unknown): KlarnaButtonInstance
}

interface KlarnaPaymentNamespace {
  button(config: Record<string, unknown>): KlarnaButtonInstance
  /**
   * Opens the Klarna flow. Takes a callback that returns the payment-request
   * data (or a Promise of it). Must be invoked synchronously from the
   * button's `click` handler so the popup keeps the user gesture. Resolves
   * with the authorization result once the user completes the popup.
   */
  initiate(resolvePaymentRequest: () => unknown): Promise<unknown>
  on?(event: string, cb: (...args: unknown[]) => unknown): unknown
}

interface KlarnaSdkInstance {
  Payment: KlarnaPaymentNamespace
}

type KlarnaSdkFactory = (config: Record<string, unknown>) => Promise<KlarnaSdkInstance>

// Memoise the SDK instance per clientId so re-opening checkout reuses it.
const sdkCache = new Map<string, Promise<KlarnaSdkInstance>>()

function loadKlarnaSdk(config: KlarnaConfig): Promise<KlarnaSdkInstance> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('[VioKlarna] requires a browser environment'))
  }
  if (!config.clientId) {
    return Promise.reject(new Error('[VioKlarna] clientId is required'))
  }
  // Key the cache by clientId + environment so switching env re-inits.
  const cacheKey = `${config.clientId}:${config.environment ?? 'default'}`
  const cached = sdkCache.get(cacheKey)
  if (cached) return cached

  // Dynamic import of an absolute CDN URL. `@vite-ignore` stops the bundler
  // from trying to resolve/inline it — it stays a runtime fetch.
  const url = KLARNA_SDK_URL
  const promise = import(/* @vite-ignore */ url)
    .then((mod: { KlarnaSDK?: KlarnaSdkFactory; default?: KlarnaSdkFactory }) => {
      const factory = mod.KlarnaSDK ?? mod.default
      if (typeof factory !== 'function') {
        throw new Error('[VioKlarna] KlarnaSDK factory not found in module')
      }
      return factory({
        clientId: config.clientId,
        products: ['PAYMENT'],
        ...(config.locale ? { locale: config.locale } : {}),
        ...(config.environment ? { environment: config.environment } : {}),
      })
    })
    .catch((err) => {
      // Don't poison the cache on failure — allow a later retry.
      sdkCache.delete(cacheKey)
      throw err
    })
  sdkCache.set(cacheKey, promise)
  return promise
}

/**
 * True if Klarna Express can be offered right now (clientId set + SDK loads).
 * Never throws — returns false on any failure path (mirrors Apple Pay).
 */
export async function isKlarnaAvailable(config: KlarnaConfig): Promise<boolean> {
  if (typeof window === 'undefined' || !config.clientId) return false
  try {
    await loadKlarnaSdk(config)
    return true
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[VioKlarna] availability check failed:', err)
    }
    return false
  }
}

/** Recursively search a result object for an authorization token. */
function findAuthToken(value: unknown, depth = 0): string | undefined {
  if (!value || depth > 4 || typeof value !== 'object') return undefined
  const o = value as Record<string, unknown>
  for (const key of ['authorizationToken', 'authorization_token', 'authToken']) {
    if (typeof o[key] === 'string' && (o[key] as string).length > 0) return o[key] as string
  }
  for (const k of Object.keys(o)) {
    const found = findAuthToken(o[k], depth + 1)
    if (found) return found
  }
  return undefined
}

/**
 * Build + mount the Klarna Express button into `container`.
 *
 * Flow (Klarna Web SDK v2): the button's `click` handler **synchronously**
 * calls `Klarna.Payment.initiate(cb)` — `cb` returns the payment-request
 * data. That call opens the Klarna popup (the synchronous call preserves the
 * user gesture). The returned Promise resolves with the authorization result
 * once the user completes the popup; we pull the authorization token out and
 * hand it to `onAuthorize`. The token is NOT an order — the backend creates
 * the order from it.
 */
export async function mountKlarnaExpressButton(opts: {
  config: KlarnaConfig
  container: HTMLElement
  paymentRequest: KlarnaPaymentRequestData
  /** URL Klarna returns to after a redirect-based completion. Required by KEC. */
  returnUrl?: string
  /**
   * sessionStorage key + payload to persist BEFORE launching. On a redirect
   * completion the page reloads (the initiate() promise is lost), so the
   * resume handler reads this back to recreate the order. Survives the
   * cross-origin redirect because sessionStorage is per-tab.
   */
  pendingKey?: string
  pendingContext?: unknown
  onAuthorize: (result: KlarnaAuthorizeResult) => void
  onError?: (err: unknown) => void
}): Promise<KlarnaButtonHandle> {
  const sdk = await loadKlarnaSdk(opts.config)

  const button = sdk.Payment.button({
    id: 'vio-klarna-express',
    // `PAY` = one-time purchase (vs BUY/SUBSCRIBE). Must be an array.
    intents: ['PAY'],
    // initiationMode belongs on the BUTTON config (per Klarna Web SDK docs),
    // NOT inside the initiate() data — when set only in initiate() the SDK
    // falls back to its default (DEVICE_BEST → desktop popup), which opened
    // and closed without completing. Forcing REDIRECT here makes the click do
    // a full-page navigation to Klarna's hosted journey, returning via
    // `returnUrl` (recovered by resumeKlarnaReturn()).
    initiationMode: 'REDIRECT',
  })

  // Clean origin+path (no existing query/hash) so Klarna's appended result
  // params land on a predictable URL the resume handler can parse.
  const returnUrl =
    opts.returnUrl ??
    (typeof window !== 'undefined'
      ? window.location.origin + window.location.pathname
      : '')

  let settled = false
  button.on('click', () => {
    // Persist the pending order so a REDIRECT completion (page reloads, this
    // promise never resolves) can be recovered on the return page.
    if (opts.pendingKey && opts.pendingContext && typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem(opts.pendingKey, JSON.stringify(opts.pendingContext))
      } catch {
        /* storage unavailable — popup mode still works via the promise */
      }
    }
    // initiate() MUST be called synchronously here — going async first would
    // drop the user-gesture and the browser would block the popup.
    const promise = sdk.Payment.initiate(() => ({
      currency: opts.paymentRequest.currency,
      paymentAmount: opts.paymentRequest.amount,
      intents: ['PAY'],
      locale: 'nb-NO',
      // REDIRECT = full-page navigation to Klarna's hosted journey, then back
      // to `returnUrl` with the result. We force this (vs DEVICE_BEST's desktop
      // popup) because the popup proved unreliable here — it opened and closed
      // without completing. The redirect flow has no popup-blocker / window-
      // messaging failure modes; the return is recovered via resumeKlarnaReturn().
      initiationMode: 'REDIRECT',
      returnUrl,
      ...(opts.paymentRequest.supplementaryPurchaseData
        ? { supplementaryPurchaseData: opts.paymentRequest.supplementaryPurchaseData }
        : {}),
    }))

    Promise.resolve(promise)
      .then((result) => {
        if (settled) return
        const token = findAuthToken(result)
        if (token) {
          settled = true
          opts.onAuthorize({ authorizationToken: token, raw: result })
        } else if (typeof console !== 'undefined') {
          // Resolved without a recognisable token — log so we can map the
          // shape. Don't confirm the order on an ambiguous resolve.
          console.warn('[VioKlarna] authorize resolved without a token:', result)
        }
      })
      .catch((err) => {
        // Reject = user cancelled or a validation/auth error. Not a success.
        opts.onError?.(err)
      })

    // Hand the same promise back to the SDK (its contract for the handler).
    return promise
  })

  button.mount(opts.container)

  return {
    unmount: () => {
      try {
        button.unmount()
      } catch {
        /* already gone */
      }
    },
  }
}

/**
 * Read a Klarna authorization token from the current URL's query string.
 * Klarna's redirect completion appends it; param name varies, so check the
 * known variants. Returns the token + the param name found (to clean later).
 */
export function readKlarnaTokenFromUrl(): { token: string; param: string } | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  for (const name of [
    'authorization_token',
    'authorizationToken',
    'klarna_authorization_token',
    'vio_klarna_token',
  ]) {
    const v = params.get(name)
    if (v && v.length > 0 && v !== '{klarna.authorization_token}') {
      return { token: v, param: name }
    }
  }
  return null
}

/** Strip the given query params from the URL without reloading. */
export function cleanUrlParams(params: string[]): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return
  const url = new URL(window.location.href)
  let changed = false
  for (const p of params) {
    if (url.searchParams.has(p)) {
      url.searchParams.delete(p)
      changed = true
    }
  }
  if (changed) window.history.replaceState({}, '', url.toString())
}

/**
 * Subscribe to the SDK's namespace-level `complete`/`error` events. On a
 * REDIRECT return the SDK resumes its persisted session and fires `complete`
 * with the authorization token — this is how we recover the token when the
 * page reloaded and the initiate() promise was lost.
 *
 * Never throws; logs and resolves even if the SDK can't load.
 */
export async function listenForKlarnaCompletion(opts: {
  config: KlarnaConfig
  onComplete: (result: KlarnaAuthorizeResult) => void
  onError?: (err: unknown) => void
}): Promise<void> {
  let sdk: KlarnaSdkInstance
  try {
    sdk = await loadKlarnaSdk(opts.config)
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[VioKlarna] resume: SDK load failed:', err)
    }
    return
  }
  let settled = false
  const onComplete = (...args: unknown[]) => {
    if (settled) return
    for (const a of args) {
      const token = findAuthToken(a)
      if (token) {
        settled = true
        opts.onComplete({ authorizationToken: token, raw: a })
        return
      }
    }
  }
  try {
    sdk.Payment.on?.('complete', onComplete)
  } catch {
    /* unsupported */
  }
  try {
    sdk.Payment.on?.('error', (...a: unknown[]) => opts.onError?.(a[0]))
  } catch {
    /* unsupported */
  }
}
