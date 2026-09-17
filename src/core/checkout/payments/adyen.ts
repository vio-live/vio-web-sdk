/**
 * Adyen — payment via Vio Commerce, rendered with Adyen's own Drop-in.
 *
 * Adyen is NOT an embedded checkout like Kustom/Qliro/Walley/Nexi: Drop-in
 * lists payment methods (cards, Vipps, Klarna, Swish…) and charges, and that
 * is all. It collects no email, address or shipping, so it belongs with the
 * FORM-FIRST methods (Stripe, Klarna Payments): the shopper fills Vio's form
 * and picks Vio's shipping first, and only then is there a session. Three
 * things shape this module:
 *
 *   1. A session is an immutable PHOTO of the purchase. `Payment {
 *      CreatePaymentAdyen }` creates it server-side (the seller's API key
 *      never leaves shopcart) from the saved checkout, with the final amount,
 *      and returns the session plus the PUBLIC client key. It is never
 *      updated: after any change the caller discards it and creates another.
 *      At "Pay", `ConfirmAdyenPayment` only VERIFIES (lesson 2026-09-17: the
 *      amount does not change while the PSP charges).
 *   2. Adyen Web is loaded from Adyen's CDN, version-pinned and with
 *      Subresource Integrity — never bundled: it weighs more than this whole
 *      SDK, and publisher pages must only pay for it when Adyen is used.
 *      Drop-in is real DOM styled by a real stylesheet (not an iframe), so it
 *      mounts in the LIGHT DOM and its stylesheet goes in `document.head`.
 *   3. Vipps, Klarna, Trustly and redirect-3DS leave the page and come back
 *      to `return_url` with `redirectResult` appended. The return is
 *      finalised on the SERVER (`GetAdyenPayment(redirect_result)`), and the
 *      return URL names the checkout, so nothing depends on this tab's
 *      storage — a shopper sent from an in-app browser to Safari still lands
 *      on a confirmation. Nothing is resumed from storage on a plain open,
 *      which is how Nexi once opened one cart's payment on another (0.12.2).
 *
 * The page's origin must be in the "Allowed origins" of the credential whose
 * client key is used, or Adyen refuses to render — see `AdyenOriginError`.
 *
 * The Commerce order itself is created server-side by Adyen's webhook —
 * the browser never confirms money.
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'

/** What `CreatePaymentAdyen` answers: everything Drop-in is created with. */
export interface AdyenSession {
  order_id: string
  session_id: string
  session_data: string
  client_key: string
  environment: 'test' | 'live' | string
  country_code: string
  /** As ADYEN names it: Norwegian is `no-NO` (`nb-NO` renders in English). */
  shopper_locale: string
  purchase_currency: string
  /** Minor units — Drop-in's Pay button. */
  amount: number
  /** Major units, shipping included. */
  total_price: number
  shipping_name?: string | null
  shipping_price?: number | null
  expires_at?: string | null
}

export type AdyenOutcome = 'authorised' | 'pending' | 'refused' | 'cancelled' | 'error' | 'unknown'

/** Outcome of the session a checkout owns, as Adyen reported it. */
export interface AdyenPayment {
  order_id: string
  status: AdyenOutcome | string
  result_code?: string | null
  psp_reference?: string | null
  payment_method?: string | null
  purchase_country?: string | null
  purchase_currency?: string | null
  total_price?: number | null
  shipping_name?: string | null
  shipping_price?: number | null
  email?: string | null
  order_created: boolean
}

export interface AdyenConfirm {
  ok: boolean
  /** SESSION_REPLACED | AMOUNT_CHANGED | CART_CHANGED | ALREADY_PAID | NO_SESSION */
  reason?: string | null
}

const ADYEN_SESSION_FIELDS = `
      order_id
      session_id
      session_data
      client_key
      environment
      country_code
      shopper_locale
      purchase_currency
      amount
      total_price
      shipping_name
      shipping_price
      expires_at`

const ADYEN_PAYMENT_FIELDS = `
      order_id
      status
      result_code
      psp_reference
      payment_method
      purchase_country
      purchase_currency
      total_price
      shipping_name
      shipping_price
      email
      order_created`

export const CREATE_PAYMENT_ADYEN_MUTATION = `
mutation CreatePaymentAdyen($checkoutId: String!, $returnUrl: String!, $countryCode: String, $channel: String, $email: String, $client: String) {
  Payment {
    CreatePaymentAdyen(checkout_id: $checkoutId, return_url: $returnUrl, country_code: $countryCode, channel: $channel, email: $email, client: $client) {${ADYEN_SESSION_FIELDS}
    }
  }
}
`

export const GET_ADYEN_PAYMENT_QUERY = `
query GetAdyenPayment($checkoutId: String!, $sessionResult: String, $redirectResult: String) {
  Payment {
    GetAdyenPayment(checkout_id: $checkoutId, session_result: $sessionResult, redirect_result: $redirectResult) {${ADYEN_PAYMENT_FIELDS}
    }
  }
}
`

export const CONFIRM_ADYEN_PAYMENT_MUTATION = `
mutation ConfirmAdyenPayment($checkoutId: String!, $sessionId: String!) {
  Payment {
    ConfirmAdyenPayment(checkout_id: $checkoutId, session_id: $sessionId) {
      ok
      reason
    }
  }
}
`

export interface CreatePaymentAdyenVariables extends Record<string, unknown> {
  checkoutId: string
  returnUrl: string
  countryCode?: string
  channel?: 'Web' | 'iOS' | 'Android'
  email?: string
  client?: string
}

export async function createPaymentAdyen(
  variables: CreatePaymentAdyenVariables | Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<AdyenSession | null> {
  const json = await executeCartGraphQL(CREATE_PAYMENT_ADYEN_MUTATION, variables, options)
  return (json?.data?.Payment?.CreatePaymentAdyen as AdyenSession) ?? null
}

export async function getAdyenPayment(
  variables: { checkoutId: string; sessionResult?: string; redirectResult?: string },
  options?: CartQueryOptions,
): Promise<AdyenPayment | null> {
  const json = await executeCartGraphQL(GET_ADYEN_PAYMENT_QUERY, variables, options)
  return (json?.data?.Payment?.GetAdyenPayment as AdyenPayment) ?? null
}

export async function confirmAdyenPayment(
  variables: { checkoutId: string; sessionId: string },
  options?: CartQueryOptions,
): Promise<AdyenConfirm | null> {
  const json = await executeCartGraphQL(CONFIRM_ADYEN_PAYMENT_MUTATION, variables, options)
  return (json?.data?.Payment?.ConfirmAdyenPayment as AdyenConfirm) ?? null
}

/* ── Adyen Web from Adyen's CDN, pinned + Subresource Integrity ────────── */

/**
 * The Adyen Web release this SDK was tested against. Bumping it is a
 * deliberate change: the two hashes below are the SRI values Adyen publishes
 * in the release notes of THAT version ("Updating to this version"), and the
 * browser refuses a file that does not match them.
 */
export const ADYEN_WEB_VERSION = '6.45.0'
const ADYEN_WEB_JS_SRI = 'sha384-7KW64UN6T0xZoacpNpRg2KVxMMVwfqwUNTDmalkE1roPBtjOpWe8JuJoUU7OCMvF'
const ADYEN_WEB_CSS_SRI = 'sha384-A4V58Hp1NTZmMvKn29pBh7249tw4TmfdL2szCtpKvaYfR/ARbXlXRYU20SLp/1VW'

/** Adyen serves the library per environment/region; only these are known. */
const ADYEN_ENVIRONMENTS = ['test', 'live', 'live-us', 'live-au', 'live-apse', 'live-in']

export function adyenAssetUrls(environment: string): { js: string; css: string } {
  const env = ADYEN_ENVIRONMENTS.includes(environment) ? environment : 'test'
  const base = `https://checkoutshopper-${env}.cdn.adyen.com/checkoutshopper/sdk/${ADYEN_WEB_VERSION}`
  return { js: `${base}/adyen.js`, css: `${base}/adyen.css` }
}

const assetLoads = new Map<string, Promise<void>>()

/**
 * Load Adyen Web (script + stylesheet) once per environment. Resolves when
 * `window.AdyenWeb` exposes AdyenCheckout and Dropin.
 */
export function loadAdyenWeb(environment: string): Promise<void> {
  const g = globalThis as any
  const { js, css } = adyenAssetUrls(environment)
  if (g.AdyenWeb?.AdyenCheckout && g.__vioAdyenWeb === js) return Promise.resolve()
  const inFlight = assetLoads.get(js)
  if (inFlight) return inFlight
  const load = new Promise<void>((resolve, reject) => {
    const doc = g.document
    if (!doc?.head) {
      reject(new Error('[Adyen] no document to load Adyen Web into'))
      return
    }
    if (!doc.head.querySelector(`link[data-vio-adyen="${ADYEN_WEB_VERSION}"]`)) {
      const link = doc.createElement('link')
      link.rel = 'stylesheet'
      link.href = css
      link.integrity = ADYEN_WEB_CSS_SRI
      link.crossOrigin = 'anonymous'
      link.setAttribute('data-vio-adyen', ADYEN_WEB_VERSION)
      doc.head.appendChild(link)
    }
    const script = doc.createElement('script')
    script.src = js
    script.async = true
    script.integrity = ADYEN_WEB_JS_SRI
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      if (g.AdyenWeb?.AdyenCheckout && g.AdyenWeb?.Dropin) {
        g.__vioAdyenWeb = js
        resolve()
      } else {
        reject(new Error('[Adyen] adyen.js loaded but AdyenWeb.AdyenCheckout is missing'))
      }
    }
    script.onerror = () => {
      reject(new Error(`[Adyen] could not load ${js}`))
    }
    doc.head.appendChild(script)
  }).finally(() => {
    // Only IN-FLIGHT loads are remembered: once settled, the check at the top
    // (AdyenWeb present for this URL) answers, and a failure can be retried.
    assetLoads.delete(js)
  })
  assetLoads.set(js, load)
  return load
}

/* ── Mount ─────────────────────────────────────────────────────────────── */

/**
 * The page is not an allowed origin of the client key. Adyen's own message
 * ("Invalid client key or unknown origin") reads like a bad key; the cause
 * is a missing entry under Allowed origins, and this says which.
 */
export class AdyenOriginError extends Error {
  constructor(public readonly origin: string) {
    super(
      `[Adyen] ${origin} is not an allowed origin of this Adyen client key — add it under Developers > API credentials > Client settings > Allowed origins.`,
    )
    this.name = 'AdyenOriginError'
  }
}

const looksLikeOriginProblem = (err: unknown): boolean =>
  /origin|client\s?key|14_0381|401|403/i.test(String((err as any)?.message ?? err ?? ''))

export interface AdyenResult {
  resultCode?: string
  sessionResult?: string
}

export interface MountAdyenHandlers {
  /**
   * "Pay" was pressed. Resolve `true` to let Adyen charge, `false` to stop:
   * the session no longer pays for the checkout and must be replaced.
   */
  onBeforePay(): Promise<boolean>
  onCompleted(result: AdyenResult): void
  /** Refused, cancelled or errored — the shopper may try again. */
  onFailed(result: AdyenResult): void
  onError?(error: unknown): void
}

export interface AdyenDropinHandle {
  sessionId: string
  unmount(): void
}

export interface MountAdyenOptions {
  /** Vio tokens for the Pay button and the corners — scoped to the container. */
  theme?: { accent?: string; radiusMd?: string }
}

/**
 * Mount Drop-in on a session. The container must be in the LIGHT DOM:
 * Drop-in is styled by the stylesheet in `document.head`, which does not
 * reach into a shadow root.
 */
export async function mountAdyen(
  container: HTMLElement,
  session: AdyenSession,
  handlers: MountAdyenHandlers,
  options: MountAdyenOptions = {},
): Promise<AdyenDropinHandle> {
  if (!session?.session_id || !session.session_data || !session.client_key) {
    throw new Error('[Adyen] session is missing session_id, session_data or client_key')
  }
  await loadAdyenWeb(session.environment)
  const { AdyenCheckout, Dropin } = (globalThis as any).AdyenWeb

  if (options.theme?.accent) {
    container.style.setProperty('--adyen-sdk-color-background-always-dark', options.theme.accent)
  }
  if (options.theme?.radiusMd && /^\d+(\.\d+)?px$/.test(options.theme.radiusMd)) {
    container.style.setProperty('--adyen-sdk-border-radius-m', options.theme.radiusMd)
  }

  // A shopper can submit twice (Enter + click): the second one is refused
  // while the first is in flight — Adyen's own best practice.
  let paying = false
  let checkout: any
  try {
    checkout = await AdyenCheckout({
      session: { id: session.session_id, sessionData: session.session_data },
      clientKey: session.client_key,
      environment: session.environment,
      locale: session.shopper_locale,
      countryCode: session.country_code,
      amount: { value: session.amount, currency: session.purchase_currency },
      beforeSubmit: async (data: unknown, _component: unknown, actions: any) => {
        if (paying) {
          actions.reject()
          return
        }
        paying = true
        let proceed = false
        try {
          proceed = await handlers.onBeforePay()
        } catch {
          proceed = false
        }
        if (proceed) {
          actions.resolve(data)
        } else {
          paying = false
          actions.reject()
        }
      },
      onPaymentCompleted: (result: AdyenResult) => {
        paying = false
        handlers.onCompleted(result ?? {})
      },
      onPaymentFailed: (result: AdyenResult) => {
        paying = false
        handlers.onFailed(result ?? {})
      },
      onError: (error: unknown) => {
        paying = false
        handlers.onError?.(error)
      },
    })
  } catch (err) {
    // Creating the checkout is when Adyen checks client key + origin.
    if (looksLikeOriginProblem(err)) {
      throw new AdyenOriginError((globalThis as any).location?.origin ?? 'this page')
    }
    throw err
  }

  const dropin = new Dropin(checkout, {
    // Vio's own confirmation follows; Adyen's success animation would sit
    // between the payment and it.
    disableFinalAnimation: true,
    instantPaymentTypes: ['applepay', 'googlepay'],
  }).mount(container)

  return {
    sessionId: session.session_id,
    unmount: () => {
      try {
        dropin.unmount()
      } catch {
        /* already gone */
      }
    },
  }
}

/* ── Return from a redirect (Vipps, Klarna, Trustly, redirect-3DS) ─────── */

/** `vio_method` value that marks OUR return URL as an Adyen one. */
export const ADYEN_RETURN_METHOD = 'adyen'

/**
 * What Adyen appended to the return URL. Only a real return carries
 * `redirectResult`; without it there is nothing to finalise.
 */
export function adyenReturnParams(
  search: string = (globalThis as any)?.location?.search ?? '',
): { redirectResult: string; sessionId: string | null } | null {
  try {
    const params = new URLSearchParams(search)
    const redirectResult = params.get('redirectResult')
    if (!redirectResult) return null
    return { redirectResult, sessionId: params.get('sessionId') }
  } catch {
    return null
  }
}

/** Every query parameter of an Adyen return — ours and Adyen's. */
export const ADYEN_RETURN_QUERY_KEYS = [
  'vio_payment',
  'vio_method',
  'vio_sponsor',
  'checkout_id',
  'sessionId',
  'redirectResult',
]

/** Adyen's outcome → the three answers the checkout's return flow knows. */
export function adyenReturnOutcome(payment: AdyenPayment | null): 'paid' | 'failed' | 'pending' {
  switch (payment?.status) {
    case 'authorised':
      return 'paid'
    case 'refused':
    case 'cancelled':
    case 'error':
      return 'failed'
    // pending (Swish, Trustly…) and anything unrecognised: the webhook
    // decides, and offering to pay again is the one thing not to do.
    default:
      return 'pending'
  }
}
