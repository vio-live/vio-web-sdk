/**
 * Nexi Checkout (formerly Nets Easy) — embedded checkout via Vio Commerce.
 *
 * Fourth embedded provider, same category as Kustom/Qliro/Walley: the widget
 * collects email, phone, addresses AND payment. Two things set it apart and
 * shape this module:
 *
 *   1. There is no html_snippet. `Payment { CreatePaymentNexi }` creates the
 *      payment server-side (the seller's SECRET key never leaves shopcart)
 *      and returns the paymentId plus the PUBLIC checkout key; the browser
 *      loads Nexi's `checkout.js` and mounts `new Dibs.Checkout({…})` in a
 *      LIGHT-DOM container — Nexi refuses a container inside a shadow root
 *      or another iframe.
 *   2. Nexi has no shipping picker. The payment is created with
 *      `merchantHandlesShippingCost`, so Nexi holds its pay button until we
 *      price the address the shopper typed: on `address-changed` the widget
 *      is frozen, `Payment { UpdateNexiShipping }` re-prices for that country
 *      and pushes the SHIPPING line, and the widget is thawed.
 *
 * Completion arrives as the `payment-completed` event — Nexi neither
 * redirects nor renders a receipt of its own, so the component shows Vio's
 * confirmation. Some methods inside Nexi (Vipps, Swish, MobilePay) leave the
 * page and come back to the SAME url with `?paymentId=…` appended; the
 * pending session is remembered in sessionStorage so the widget can be
 * re-mounted on that paymentId and finish.
 *
 * The Commerce order itself is created server-side by Nexi's webhook
 * (shopcart /checkout/payment/nexi/ok) — the browser never confirms money.
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'
import { kustomCleanHref } from './kustom.js'
import type { QliroTheme } from './qliro.js'

/** Normalized Nexi payment (shopcart maps the Payment API). */
export interface NexiOrder {
  /** Nexi paymentId (32 hex). */
  order_id: string
  /** Created | Reserved | Charged | Cancelled | Terminated | Unknown. */
  status: string
  /** Public checkout key for Dibs.Checkout. */
  checkout_key: string
  /** checkout.js of the seller's environment (test or live). */
  checkout_js_url: string
  purchase_country?: string
  purchase_currency?: string
  total_price?: number
}

export interface NexiShippingUpdate {
  ok: boolean
  /** When !ok: NO_SHIPPING — Vio does not ship to that country. */
  reason?: string
  order_id: string
  total_price?: number
  shipping_name?: string
  shipping_price?: number
}

const NEXI_ORDER_FIELDS = `
      order_id
      status
      checkout_key
      checkout_js_url
      purchase_country
      purchase_currency
      total_price`

export const CREATE_PAYMENT_NEXI_MUTATION = `
mutation CreatePaymentNexi($checkoutId: String!, $countryCode: String!, $href: String!, $email: String) {
  Payment {
    CreatePaymentNexi(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email) {${NEXI_ORDER_FIELDS}
    }
  }
}
`

export const GET_NEXI_ORDER_QUERY = `
query GetNexiOrder($checkoutId: String!) {
  Payment {
    GetNexiOrder(checkout_id: $checkoutId) {${NEXI_ORDER_FIELDS}
    }
  }
}
`

export const UPDATE_NEXI_SHIPPING_MUTATION = `
mutation UpdateNexiShipping($checkoutId: String!, $countryCode: String!, $postalCode: String) {
  Payment {
    UpdateNexiShipping(checkout_id: $checkoutId, country_code: $countryCode, postal_code: $postalCode) {
      ok
      reason
      order_id
      total_price
      shipping_name
      shipping_price
    }
  }
}
`

export interface CreatePaymentNexiVariables extends Record<string, unknown> {
  checkoutId: string
  countryCode: string
  href: string
  email?: string
}

export interface UpdateNexiShippingVariables extends Record<string, unknown> {
  checkoutId: string
  countryCode: string
  postalCode?: string
}

export async function createPaymentNexi(
  variables: CreatePaymentNexiVariables | Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<NexiOrder | null> {
  const json = await executeCartGraphQL(CREATE_PAYMENT_NEXI_MUTATION, variables, options)
  return (json?.data?.Payment?.CreatePaymentNexi as NexiOrder) ?? null
}

export async function getNexiOrder(
  checkoutId: string,
  options?: CartQueryOptions,
): Promise<NexiOrder | null> {
  const json = await executeCartGraphQL(GET_NEXI_ORDER_QUERY, { checkoutId }, options)
  return (json?.data?.Payment?.GetNexiOrder as NexiOrder) ?? null
}

export async function updateNexiShipping(
  variables: UpdateNexiShippingVariables | Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<NexiShippingUpdate | null> {
  const json = await executeCartGraphQL(UPDATE_NEXI_SHIPPING_MUTATION, variables, options)
  return (json?.data?.Payment?.UpdateNexiShipping as NexiShippingUpdate) ?? null
}

/**
 * Query-less page URL. Nexi validates `checkout.url` against the page that
 * loads checkout.js (protocol + host + path) — same helper the other
 * embedded methods use for their confirmation redirect.
 */
export const nexiCleanHref = kustomCleanHref

/** Reserved (or already charged, with auto-capture) = the shopper paid. */
export const NEXI_PAID_STATUSES = new Set(['Reserved', 'Charged'])

export function isNexiPaid(status: string | undefined | null): boolean {
  return NEXI_PAID_STATUSES.has(String(status ?? ''))
}

/** Nexi's language tags, by the market the checkout runs in. */
const NEXI_LANGUAGES: Record<string, string> = {
  NO: 'nb-NO',
  SE: 'sv-SE',
  DK: 'da-DK',
  FI: 'fi-FI',
  DE: 'de-DE',
  NL: 'nl-NL',
  PL: 'pl-PL',
  FR: 'fr-FR',
  ES: 'es-ES',
  IT: 'it-IT',
  EE: 'ee-EE',
  LV: 'lv-LV',
  LT: 'lt-LT',
  SK: 'sk-SK',
}

export function nexiLanguageFor(countryCode?: string | null): string {
  return NEXI_LANGUAGES[String(countryCode ?? '').toUpperCase()] ?? 'en-GB'
}

/**
 * Vio theme tokens → Nexi's `theme` object. Nexi accepts colours as hex
 * strings (primaryColor drives the pay button, panelColor the form panels);
 * `buttonRadius` is passed only as a plain px value. No effect when the
 * seller has set a theme in Nexi's portal styler — Nexi says so itself.
 */
export function nexiThemeFrom(theme?: QliroTheme): Record<string, string> | undefined {
  if (!theme) return undefined
  const out: Record<string, string> = {}
  if (theme.accent) out.primaryColor = theme.accent
  if (theme.surface) out.panelColor = theme.surface
  if (theme.radiusMd && /^\d+(\.\d+)?px$/.test(theme.radiusMd)) out.buttonRadius = theme.radiusMd
  return Object.keys(out).length ? out : undefined
}

/** The subset of Dibs.Checkout this SDK relies on. */
export interface NexiCheckoutHandle {
  on(event: string, handler: (payload?: any) => void): void
  send?(event: string, value?: unknown): void
  setLanguage?(language: string): void
  setTheme?(theme: Record<string, string>): void
  freezeCheckout(): void
  thawCheckout(): void
  cleanup(): void
}

const scriptLoads = new Map<string, Promise<void>>()

/**
 * Load Nexi's checkout.js once per URL (test and live are different
 * scripts). Resolves when `Dibs.Checkout` is available.
 */
export function loadNexiCheckoutJs(url: string): Promise<void> {
  const g = globalThis as any
  if (g.Dibs?.Checkout && g.__vioNexiCheckoutJs === url) return Promise.resolve()
  const inFlight = scriptLoads.get(url)
  if (inFlight) return inFlight
  const load = new Promise<void>((resolve, reject) => {
    const doc = g.document
    if (!doc?.head) {
      reject(new Error('[Nexi] no document to load checkout.js into'))
      return
    }
    const script = doc.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => {
      if (g.Dibs?.Checkout) {
        g.__vioNexiCheckoutJs = url
        resolve()
      } else {
        scriptLoads.delete(url)
        reject(new Error('[Nexi] checkout.js loaded but Dibs.Checkout is missing'))
      }
    }
    script.onerror = () => {
      scriptLoads.delete(url)
      reject(new Error(`[Nexi] could not load ${url}`))
    }
    doc.head.appendChild(script)
  })
  scriptLoads.set(url, load)
  return load
}

export interface MountNexiOptions {
  language?: string
  theme?: Record<string, string>
}

/**
 * Mount the widget. The container must be in the LIGHT DOM and have an id
 * (Nexi resolves it from the document); one is assigned when missing.
 */
export async function mountNexi(
  container: HTMLElement,
  order: NexiOrder,
  options: MountNexiOptions = {},
): Promise<NexiCheckoutHandle> {
  if (!order?.order_id || !order.checkout_key || !order.checkout_js_url) {
    throw new Error('[Nexi] order is missing paymentId, checkout_key or checkout_js_url')
  }
  await loadNexiCheckoutJs(order.checkout_js_url)
  if (!container.id) container.id = 'vio-nexi-checkout-container'
  const Dibs = (globalThis as any).Dibs
  const checkout = new Dibs.Checkout({
    checkoutKey: order.checkout_key,
    paymentId: order.order_id,
    containerId: container.id,
    language: options.language ?? 'en-GB',
    ...(options.theme ? { theme: options.theme } : {}),
  })
  return checkout as NexiCheckoutHandle
}

/* ── Pending session (survives a third-party redirect inside Nexi) ─────── */

export const NEXI_PENDING_KEY = 'vio.nexi.pending.v1'

/** Nexi sessions live 48 h; a remembered one older than that is stale. */
const NEXI_PENDING_TTL_MS = 48 * 60 * 60 * 1000

export interface NexiPending {
  checkoutId: string
  sponsorId: number
  paymentId: string
  createdAt: number
}

function storage(): Storage | null {
  try {
    const s = (globalThis as any).sessionStorage as Storage | undefined
    return s ?? null
  } catch {
    return null
  }
}

export function rememberNexiPending(pending: Omit<NexiPending, 'createdAt'>): void {
  try {
    storage()?.setItem(NEXI_PENDING_KEY, JSON.stringify({ ...pending, createdAt: Date.now() }))
  } catch {
    /* storage unavailable — the redirect safety net is simply off */
  }
}

export function readNexiPending(): NexiPending | null {
  try {
    const raw = storage()?.getItem(NEXI_PENDING_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<NexiPending>
    if (!p?.checkoutId || !p?.paymentId) return null
    if (Date.now() - Number(p.createdAt ?? 0) > NEXI_PENDING_TTL_MS) {
      clearNexiPending()
      return null
    }
    return {
      checkoutId: String(p.checkoutId),
      sponsorId: Number(p.sponsorId ?? 0),
      paymentId: String(p.paymentId),
      createdAt: Number(p.createdAt ?? 0),
    }
  } catch {
    return null
  }
}

export function clearNexiPending(): void {
  try {
    storage()?.removeItem(NEXI_PENDING_KEY)
  } catch {
    /* noop */
  }
}

/**
 * The `?paymentId=` Nexi appends when a third-party method (Vipps, Swish,
 * MobilePay) returns the shopper to the checkout page.
 */
export function nexiReturnPaymentId(search?: string): string | null {
  try {
    const s = search ?? ((globalThis as any).location?.search as string | undefined) ?? ''
    const id = new URLSearchParams(s).get('paymentId')
    return id && /^[0-9a-f]{32}$/i.test(id) ? id : null
  } catch {
    return null
  }
}
