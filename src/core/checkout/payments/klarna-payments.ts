/**
 * Klarna Payments — classic widget flow (`kp/lib/v1/api.js`).
 *
 * This is the alternative to KEC (Web SDK v2 button + `initiate` redirect).
 * Instead of a public `clientId` + origin handshake (which 403'd on the
 * `klarnaevt` bridge from localhost), it uses a **server-minted client_token**:
 *
 *   1. Backend creates a Payments session → `client_token` + categories
 *      (POST /v2/commerce/klarna/sessions, server-side Basic-auth API key).
 *   2. We load Klarna's widget **inline** (an iframe) into a container via
 *      `Klarna.Payments.init({ client_token })` + `Klarna.Payments.load(...)`.
 *   3. The customer picks/fills a method; `Klarna.Payments.authorize(...)`
 *      yields an `authorization_token`.
 *   4. Backend exchanges the token for a real order (existing /orders route).
 *
 * No redirect, no popup, no public clientId — so the origin/handshake failure
 * mode simply doesn't apply here.
 */

/** Klarna Payments JS library (classic). Loaded via <script>, sets window.Klarna. */
export const KLARNA_KP_LIB_URL = 'https://x.klarnacdn.net/kp/lib/v1/api.js'

export interface KlarnaPaymentsCategory {
  identifier: string
  name: string
  asset_urls?: { descriptive?: string; standard?: string }
}

// ── Minimal runtime typings for the <script>-loaded global ────────────────
interface KpLoadResult {
  show_form?: boolean
  error?: unknown
}
interface KpAuthorizeResult {
  approved?: boolean
  show_form?: boolean
  authorization_token?: string
  finalize_required?: boolean
  error?: unknown
}
interface KlarnaPaymentsApi {
  init(opts: { client_token: string }): void
  load(
    opts: { container: string | HTMLElement; payment_method_category?: string },
    data: Record<string, unknown>,
    cb?: (res: KpLoadResult) => void,
  ): void
  authorize(
    opts: { payment_method_category?: string; auto_finalize?: boolean },
    data: Record<string, unknown>,
    cb?: (res: KpAuthorizeResult) => void,
  ): void
}
interface KlarnaGlobal {
  Payments: KlarnaPaymentsApi
}

declare global {
  interface Window {
    Klarna?: KlarnaGlobal
    klarnaAsyncCallback?: () => void
  }
}

let kpLoad: Promise<KlarnaGlobal> | null = null

/** Load kp/lib/v1/api.js once; resolves when window.Klarna.Payments is ready. */
function loadKpLib(): Promise<KlarnaGlobal> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('[VioKlarnaKP] requires a browser environment'))
  }
  if (window.Klarna?.Payments) return Promise.resolve(window.Klarna)
  if (kpLoad) return kpLoad

  kpLoad = new Promise<KlarnaGlobal>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('[VioKlarnaKP] kp/lib/v1/api.js load timed out')),
      12000,
    )
    const ready = () => {
      clearTimeout(timer)
      if (window.Klarna?.Payments) resolve(window.Klarna)
      else reject(new Error('[VioKlarnaKP] Klarna global missing after ready'))
    }
    // Klarna invokes window.klarnaAsyncCallback once the lib is initialised.
    const prev = window.klarnaAsyncCallback
    window.klarnaAsyncCallback = () => {
      if (typeof prev === 'function') {
        try {
          prev()
        } catch {
          /* host callback threw — ignore */
        }
      }
      ready()
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${KLARNA_KP_LIB_URL}"]`,
    )
    if (existing) {
      // Script already in the DOM (e.g. re-open). If Klarna is up, resolve now;
      // otherwise our klarnaAsyncCallback above will fire.
      if (window.Klarna?.Payments) ready()
    } else {
      const s = document.createElement('script')
      s.src = KLARNA_KP_LIB_URL
      s.async = true
      s.onerror = () => {
        clearTimeout(timer)
        kpLoad = null
        reject(new Error('[VioKlarnaKP] failed to load kp/lib/v1/api.js'))
      }
      document.head.appendChild(s)
    }
  }).catch((err) => {
    kpLoad = null // allow retry
    throw err
  })

  return kpLoad
}

export interface KlarnaPaymentsWidgetInput {
  clientToken: string
  /** Klarna session id (native GraphQL flow) — informational, for callers/logs. */
  sessionId?: string
  categories: KlarnaPaymentsCategory[]
  container: HTMLElement
  /** Category to load first. Defaults to the first available. */
  category?: string
}

export interface KlarnaPaymentsWidget {
  /** Categories offered by the session (pay_now / pay_later / pay_over_time). */
  categories: KlarnaPaymentsCategory[]
  /** Currently selected payment_method_category. */
  selected: string
  /** (Re)load the widget for a category into the container. */
  load(category?: string): Promise<{ showForm: boolean }>
  /**
   * Authorize the selected category. Resolves with the authorization token,
   * rejects on decline/cancel/error. `data` is an optional order-data update
   * (the session already carries the lines; pass billing/extra if available).
   */
  authorize(data?: Record<string, unknown>): Promise<string>
}

/** True if the Klarna Payments lib can load in this environment. */
export async function isKlarnaPaymentsAvailable(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  try {
    await loadKpLib()
    return true
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[VioKlarnaKP] availability check failed:', err)
    }
    return false
  }
}

/**
 * Init Klarna Payments with a server-minted client_token and mount the widget.
 * Returns a handle to (re)load categories and to authorize.
 */
export async function createKlarnaPaymentsWidget(
  input: KlarnaPaymentsWidgetInput,
): Promise<KlarnaPaymentsWidget> {
  const Klarna = await loadKpLib()
  Klarna.Payments.init({ client_token: input.clientToken })

  let selected =
    input.category ?? input.categories[0]?.identifier ?? 'pay_later'

  return {
    categories: input.categories,
    get selected() {
      return selected
    },
    load(category?: string): Promise<{ showForm: boolean }> {
      if (category) selected = category
      return new Promise((resolve, reject) => {
        try {
          // 3-arg form per Klarna docs: (options, data, callback). The empty
          // data object is required — a 2-arg call risks the SDK treating the
          // callback as `data` and never invoking it.
          Klarna.Payments.load(
            { container: input.container, payment_method_category: selected },
            {},
            (res) => {
              if (res?.error) reject(res.error)
              else resolve({ showForm: res?.show_form !== false })
            },
          )
        } catch (err) {
          reject(err)
        }
      })
    },
    authorize(data?: Record<string, unknown>): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        try {
          Klarna.Payments.authorize(
            { payment_method_category: selected, auto_finalize: true },
            data ?? {},
            (res) => {
              if (res?.approved && res.authorization_token) {
                resolve(res.authorization_token)
              } else if (res?.error) {
                reject(res.error)
              } else if (res?.finalize_required) {
                reject(new Error('Klarna requires a finalize step (multistep)'))
              } else {
                // approved:false without an error == user cancelled / declined.
                reject(new Error('Klarna authorization was not approved'))
              }
            },
          )
        } catch (err) {
          reject(err)
        }
      })
    },
  }
}
