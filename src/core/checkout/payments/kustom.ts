/**
 * Kustom (former Klarna Checkout) — embedded KCO v3 checkout.
 *
 * Kustom kept the Klarna Checkout dialect on its own hosts, so the flow is
 * the classic KCO embed:
 *
 *   1. Vio Commerce creates the order (`Payment { CreatePaymentKustom }`,
 *      authed with the sponsor's commerce API key; the seller's own
 *      kco_*_api_* key lives server-side, per seller, never here). One order
 *      per checkout: asking again while it is open UPDATES it.
 *   2. The response's `html_snippet` is injected into a LIGHT-DOM container
 *      — it renders Kustom's iframe, which collects address, shipping AND
 *      payment by itself (the widget does everything; no Vio address form).
 *   3. While it is open, the widget talks through `window._klarnaCheckout`:
 *      we suspend it around a cart change (`Payment { SyncPaymentKustom }`),
 *      and listen to its totals so our summary never disagrees with it.
 *   4. On completion Kustom redirects to the confirmation URL
 *      (`?order_id=…&payment_processor=KUSTOM&checkout_id=…`), where the SDK
 *      re-reads the order (`Payment { GetKustomOrder }`) — the backend
 *      completes it right there — and renders Kustom's own receipt.
 *
 * The Commerce order is created server-side, from what Kustom says it
 * charged (Order Management), whether the shopper comes back or not (the
 * push) — the browser never confirms money.
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'

/** A Kustom order as shopcart normalizes it (never Kustom's raw order). */
export interface KustomOrder {
  order_id: string
  /** `checkout_incomplete` | `checkout_complete`, lower-cased by the backend. */
  status: string
  html_snippet: string
  purchase_country?: string
  purchase_currency?: string
  checkout_id?: string
  environment?: string
  /** Goods + the shipping shown or charged, decimal. */
  total_price?: number
  shipping_name?: string
  shipping_price?: number
  /** Whether the Vio Commerce order exists (after completion). */
  order_created?: boolean
  /** Kustom's short shopper-facing reference (after completion). */
  reference?: string
}

const KUSTOM_ORDER_FIELDS = `
      order_id
      status
      html_snippet
      purchase_country
      purchase_currency
      checkout_id
      environment
      total_price
      shipping_name
      shipping_price
      order_created
      reference`

export const CREATE_PAYMENT_KUSTOM_MUTATION = `
mutation CreatePaymentKustom($checkoutId: String!, $countryCode: String!, $href: String!, $email: String, $client: String) {
  Payment {
    CreatePaymentKustom(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email, client: $client) {${KUSTOM_ORDER_FIELDS}
    }
  }
}
`

export const GET_KUSTOM_ORDER_QUERY = `
query GetKustomOrder($orderId: String!) {
  Payment {
    GetKustomOrder(order_id: $orderId) {${KUSTOM_ORDER_FIELDS}
    }
  }
}
`

export const SYNC_PAYMENT_KUSTOM_MUTATION = `
mutation SyncPaymentKustom($checkoutId: String!) {
  Payment {
    SyncPaymentKustom(checkout_id: $checkoutId) {${KUSTOM_ORDER_FIELDS}
    }
  }
}
`

export interface CreatePaymentKustomVariables extends Record<string, unknown> {
  checkoutId: string
  countryCode: string
  href: string
  email?: string
  client?: string
}

export async function createPaymentKustom(
  variables: CreatePaymentKustomVariables | Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<KustomOrder | null> {
  const json = await executeCartGraphQL(CREATE_PAYMENT_KUSTOM_MUTATION, variables, options)
  return (json?.data?.Payment?.CreatePaymentKustom as KustomOrder) ?? null
}

export async function getKustomOrder(
  orderId: string,
  options?: CartQueryOptions,
): Promise<KustomOrder | null> {
  const json = await executeCartGraphQL(GET_KUSTOM_ORDER_QUERY, { orderId }, options)
  return (json?.data?.Payment?.GetKustomOrder as KustomOrder) ?? null
}

/** Push the current cart into the checkout's open Kustom order. */
export async function syncPaymentKustom(
  checkoutId: string,
  options?: CartQueryOptions,
): Promise<KustomOrder | null> {
  const json = await executeCartGraphQL(SYNC_PAYMENT_KUSTOM_MUTATION, { checkoutId }, options)
  return (json?.data?.Payment?.SyncPaymentKustom as KustomOrder) ?? null
}

/**
 * The page URL Kustom appends its redirect params to. shopcart builds the
 * confirmation URL as `${href}?order_id={checkout.order.id}&…`, so the href
 * MUST NOT already carry a query string — origin + pathname only.
 */
export function kustomCleanHref(): string {
  if (typeof window === 'undefined' || !window.location) return ''
  return `${window.location.origin}${window.location.pathname}`
}

/**
 * Inject a KCO html_snippet and EXECUTE its inline scripts — innerHTML alone
 * leaves <script> tags inert, so each one is recreated node-by-node. This is
 * the standard Klarna Checkout embed technique, unchanged under Kustom.
 */
export function renderKustomSnippet(container: HTMLElement, htmlSnippet: string): void {
  container.innerHTML = htmlSnippet
  const scripts = Array.from(container.querySelectorAll('script'))
  for (const oldScript of scripts) {
    const newScript = document.createElement('script')
    for (const attr of Array.from(oldScript.attributes)) {
      newScript.setAttribute(attr.name, attr.value)
    }
    newScript.text = oldScript.text
    oldScript.parentNode?.replaceChild(newScript, oldScript)
  }
}

/* ── The widget's JavaScript API (`window._klarnaCheckout`) ─────────────── */

/**
 * The slice of Kustom's client-side API this SDK uses. Kustom kept the
 * `_klarnaCheckout` name: the snippet defines it, and it queues callbacks
 * until the iframe has rendered.
 */
export interface KustomApi {
  suspend(options?: { autoResume?: { enabled: boolean } }): void
  resume(): void
  on(listeners: Record<string, (data: any, callback?: (r: any) => void) => void>): void
}

type KustomApiFn = (cb: (api: KustomApi) => void) => void

/** The widget's API, or null when no snippet has defined it yet. */
export function kustomApi(): KustomApiFn | null {
  if (typeof window === 'undefined') return null
  const fn = (window as any)._klarnaCheckout
  return typeof fn === 'function' ? (fn as KustomApiFn) : null
}

/**
 * Lock the widget while the order is being changed server-side. Kustom
 * auto-resumes after 10 s unless told otherwise; the sync is one call, so
 * the automatic resume stays as the safety net.
 */
export function suspendKustom(): boolean {
  const api = kustomApi()
  if (!api) return false
  api((a) => a.suspend())
  return true
}

/** Refresh the widget with the order as it now is at Kustom. */
export function resumeKustom(): boolean {
  const api = kustomApi()
  if (!api) return false
  api((a) => a.resume())
  return true
}

export interface KustomShippingChange {
  id?: string
  name?: string
  description?: string
  /** Minor units, as the widget reports them. */
  price?: number
  tax_amount?: number
  tax_rate?: number
}

export interface KustomListenerHandlers {
  /** The iframe rendered. */
  onLoad?: (data: any) => void
  /** The order total the widget shows, in MINOR units. */
  onOrderTotalChange?: (orderTotalMinor: number) => void
  /** The shopper picked a rate inside the widget. */
  onShippingOptionChange?: (option: KustomShippingChange) => void
  /** The shopper could not pay (declined credit…): show another way. */
  onCannotComplete?: () => void
  onNetworkError?: () => void
  /** The shopper is about to leave for the confirmation page. */
  onRedirectInitiated?: () => void
}

/**
 * Subscribe to the widget's events. Kustom has no `off`, so the returned
 * `destroy` disarms the handlers: a widget torn down and re-rendered must not
 * keep driving a summary that no longer exists.
 */
export function installKustomListeners(handlers: KustomListenerHandlers): { destroy(): void } {
  let alive = true
  const api = kustomApi()
  if (api) {
    api((a) => {
      a.on({
        load: (data) => alive && handlers.onLoad?.(data),
        order_total_change: (data) => {
          const total = Number(data?.order_total)
          if (alive && Number.isFinite(total)) handlers.onOrderTotalChange?.(total)
        },
        shipping_option_change: (data) => alive && handlers.onShippingOptionChange?.(data ?? {}),
        can_not_complete_order: () => alive && handlers.onCannotComplete?.(),
        network_error: () => alive && handlers.onNetworkError?.(),
        redirect_initiated: () => alive && handlers.onRedirectInitiated?.(),
      })
    })
  }
  return {
    destroy() {
      alive = false
    },
  }
}

/* ── The return trip ────────────────────────────────────────────────────── */

/** Query keys Kustom's redirects and our own rejection page add to the URL. */
export const KUSTOM_RETURN_QUERY_KEYS = [
  'order_id',
  'payment_processor',
  'checkout_id',
  'vio_payment',
  'vio_method',
] as const

/**
 * What a URL says about a Kustom round trip:
 * - `confirmation`: Kustom sent the shopper back paid (`payment_processor=KUSTOM`);
 * - `rejected`: our validation callback refused the purchase and Kustom
 *   showed the shopper the reason inside the widget — nothing to read;
 * - null: not a Kustom return.
 */
export function kustomReturnOutcome(
  params: URLSearchParams,
): { kind: 'confirmation'; orderId: string; checkoutId?: string } | { kind: 'rejected'; checkoutId?: string } | null {
  const orderId = params.get('order_id') || ''
  if (params.get('payment_processor') === 'KUSTOM' && orderId) {
    return { kind: 'confirmation', orderId, checkoutId: params.get('checkout_id') || undefined }
  }
  if (params.get('vio_payment') === 'rejected' && params.get('vio_method') === 'kustom') {
    return { kind: 'rejected', checkoutId: params.get('checkout_id') || undefined }
  }
  return null
}
