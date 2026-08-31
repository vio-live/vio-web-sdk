/**
 * Kustom (former Klarna Checkout) — embedded KCO v3 checkout.
 *
 * Kustom kept the Klarna Checkout dialect on its own hosts, so the flow is
 * the classic KCO embed:
 *
 *   1. Vio Commerce creates the order (`Payment { CreatePaymentKustom }`,
 *      authed with the sponsor's commerce API key; the seller's own
 *      kco_*_api_* key lives server-side, per seller, never here).
 *   2. The response's `html_snippet` is injected into a container — it
 *      renders Kustom's iframe, which collects address, shipping AND payment
 *      by itself (the widget does everything; no Vio address form).
 *   3. On completion Kustom redirects to the confirmation URL
 *      (`?order_id=…&payment_processor=KUSTOM`), where the SDK re-reads the
 *      order (`Payment { GetKustomOrder }`) and renders its confirmation
 *      snippet — KCO's own receipt.
 *
 * The Commerce order itself is created server-side by Kustom's push webhook
 * (shopcart /checkout/payment/kustom/ok) — the browser never confirms money.
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'

/** KCO order fields the SDK consumes (the full order is much larger). */
export interface KustomOrder {
  order_id: string
  status: string
  html_snippet: string
  purchase_country?: string
  purchase_currency?: string
}

export const CREATE_PAYMENT_KUSTOM_MUTATION = `
mutation CreatePaymentKustom($checkoutId: String!, $countryCode: String!, $href: String!, $email: String) {
  Payment {
    CreatePaymentKustom(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email) {
      order_id
      status
      html_snippet
      purchase_country
      purchase_currency
    }
  }
}
`

export const GET_KUSTOM_ORDER_QUERY = `
query GetKustomOrder($orderId: String!) {
  Payment {
    GetKustomOrder(order_id: $orderId) {
      order_id
      status
      html_snippet
      purchase_country
      purchase_currency
    }
  }
}
`

export interface CreatePaymentKustomVariables extends Record<string, unknown> {
  checkoutId: string
  countryCode: string
  href: string
  email?: string
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
