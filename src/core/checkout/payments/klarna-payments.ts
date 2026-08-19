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
  /** Debug/lifecycle events — e.g. 'fullscreenOverlayShown'/'fullscreenOverlayHidden'. */
  on?(event: string, cb: () => void): void
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
   * Authorize a category. Resolves with the authorization token, rejects on
   * decline/cancel/error. `category` overrides `selected` for this call (and
   * reloads the widget first if it differs) — pass it explicitly rather than
   * relying on `selected` alone, since a caller UI's own state and the
   * widget's internal `selected` can drift. `data` is an optional order-data
   * update (the session already carries the lines; pass billing/extra if
   * available).
   */
  authorize(category?: string, data?: Record<string, unknown>): Promise<string>
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
/** Pick the direct-payment category ("Betal nå") when the session offers one —
 * the demo sells physical goods paid up front, not financing. Ported from
 * Alan's round-5 improvement. */
export function findPayNowCategory(categories: KlarnaPaymentsCategory[]): string | null {
  if (!Array.isArray(categories) || categories.length === 0) return null
  const byId = (re: RegExp) => categories.find((c) => c?.identifier && re.test(c.identifier))
  const byName = (re: RegExp) => categories.find((c) => c?.name && re.test(c.name))
  const cat =
    categories.find((c) => c?.identifier === 'pay_now') ??
    byName(/betal\s*n[åa]|pay\s*now/i) ??
    byId(/pay_now|direct_debit|direct_bank_transfer|pay_in_full|klarna_pay_now/i) ??
    byName(/direkte|bank|kort|straks|sofort/i) ??
    categories.find((c) => c?.identifier && !/pay_later|pay_over_time|slice_it/.test(c.identifier))
  console.log('findPayNowCategory - Selected: ', cat)
  return cat?.identifier ?? null
}

export async function createKlarnaPaymentsWidget(
  input: KlarnaPaymentsWidgetInput,
): Promise<KlarnaPaymentsWidget> {
  const Klarna = await loadKpLib()
  console.log('[DEBUG Klarna] Initializing Klarna Payments')
  Klarna.Payments.init({ client_token: input.clientToken })
  console.log('[DEBUG Klarna] Klarna Payments initialized')
  Klarna.Payments.on?.('fullscreenOverlayShown', () => {
    console.log('[DEBUG Klarna] FULLSCREEN OVERLAY SHOWN')
  })
  Klarna.Payments.on?.('fullscreenOverlayHidden', () => {
    console.log('[DEBUG Klarna] FULLSCREEN OVERLAY HIDDEN')
  })

  let selected =
    input.category ??
    findPayNowCategory(input.categories) ??
    input.categories[0]?.identifier ??
    'pay_now'
  if (typeof console !== 'undefined') {
    console.log('[VioKlarna] Received payment_method_categories from backend:', input.categories)
    console.log('[VioKlarna] Selected initial payment_method_category:', selected)
  }

  const load = (category?: string): Promise<{ showForm: boolean }> => {
    if (category) selected = category
    if (typeof console !== 'undefined') {
      console.log(
        '[VioKlarna] Klarna.Payments.load calling with payment_method_category:',
        selected,
        'container:',
        input.container,
      )
    }
    // Clear any previously-rendered iframe before reloading a different
    // category — Klarna's widget doesn't always replace its own markup
    // cleanly on a second load() into the same container.
    if (input.container && 'innerHTML' in input.container) {
      input.container.innerHTML = ''
    }
    return new Promise((resolve, reject) => {
      try {
        // 3-arg form per Klarna docs: (options, data, callback). The empty
        // data object is required — a 2-arg call risks the SDK treating the
        // callback as `data` and never invoking it.
        Klarna.Payments.load(
          { container: input.container, payment_method_category: selected },
          {},
          (res) => {
            if (typeof console !== 'undefined') {
              console.log(
                '[VioKlarna] Klarna.Payments.load response for payment_method_category:',
                selected,
                res,
              )
            }
            if (res?.error) reject(res.error)
            else resolve({ showForm: res?.show_form !== false })
          },
        )
      } catch (err) {
        reject(err)
      }
    })
  }

  return {
    categories: input.categories,
    get selected() {
      return selected
    },
    load,
    async authorize(category?: string, data?: Record<string, unknown>): Promise<string> {
      const cat = category || selected
      if (typeof console !== 'undefined') {
        console.log('[DEBUG Klarna] BEFORE AUTHORIZE', {
          argumentCategory: category,
          argumentData: data,
          selected,
          resolvedCategory: cat,
        })
      }
      // If the caller asked for a category different from what's currently
      // loaded, reload the widget first — authorizing against a stale
      // `selected` would charge/confirm the wrong payment method category.
      if (cat && cat !== selected) {
        await load(cat)
      }
      const finalData = { payment_method_category: cat, ...(data ?? {}) }
      if (typeof console !== 'undefined') {
        console.log('[DEBUG Klarna] FINAL AUTHORIZE', { cat, selected, finalData })
      }
      return new Promise<string>((resolve, reject) => {
        try {
          if (typeof console !== 'undefined') {
            console.log('[DEBUG Klarna] ABOUT TO CALL AUTHORIZE')
          }
          Klarna.Payments.authorize(
            { payment_method_category: cat, auto_finalize: true },
            finalData,
            (res) => {
              if (typeof console !== 'undefined') {
                console.log('[DEBUG Klarna] RAW AUTHORIZE RESPONSE:', JSON.stringify(res, null, 2))
              }
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
          if (typeof console !== 'undefined') {
            console.log('[DEBUG Klarna] AUTHORIZE CALL RETURNED')
          }
        } catch (err) {
          reject(err)
        }
      })
    },
  }
}
