/**
 * Qliro Checkout — embedded checkout via Vio Commerce.
 *
 * Same embed philosophy as Kustom (the widget collects address, shipping
 * AND payment), different provider API underneath — shopcart normalizes
 * Qliro's Merchant API (OrderId / CustomerCheckoutStatus / OrderHtmlSnippet)
 * to the { order_id, status, html_snippet } shape both flows share:
 *
 *   1. `Payment { CreatePaymentQliro }` creates the order and returns the
 *      snippet (sponsor-key authed; the seller's MerchantApiKey/Secret live
 *      server-side, per seller, never here).
 *   2. The snippet is injected (script-executing embed, shared with Kustom).
 *   3. On completion Qliro redirects to the confirmation URL
 *      (`?checkout_id=…&payment_processor=QLIRO`); the SDK re-reads the
 *      order via `Payment { GetQliroOrder(checkout_id) }` — Qliro
 *      correlates by the OWNING CHECKOUT, not the order id — and renders
 *      the snippet again, which shows Qliro's own receipt.
 *
 * The Commerce order is created server-side by Qliro's push webhook
 * (shopcart /checkout/payment/qliro/ok) — the browser never confirms money.
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'
import { kustomCleanHref, renderKustomSnippet } from './kustom.js'

/** Normalized Qliro order (shopcart maps the PascalCase Merchant API). */
export interface QliroOrder {
  order_id: string
  /** Qliro CustomerCheckoutStatus: InProcess | Completed | OnHold | Refused. */
  status: string
  html_snippet: string
  purchase_country?: string
  purchase_currency?: string
  total_price?: number
}

export const CREATE_PAYMENT_QLIRO_MUTATION = `
mutation CreatePaymentQliro($checkoutId: String!, $countryCode: String!, $href: String!, $email: String) {
  Payment {
    CreatePaymentQliro(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email) {
      order_id
      status
      html_snippet
      purchase_country
      purchase_currency
      total_price
    }
  }
}
`

export const GET_QLIRO_ORDER_QUERY = `
query GetQliroOrder($checkoutId: String!) {
  Payment {
    GetQliroOrder(checkout_id: $checkoutId) {
      order_id
      status
      html_snippet
      purchase_country
      purchase_currency
      total_price
    }
  }
}
`

export interface CreatePaymentQliroVariables extends Record<string, unknown> {
  checkoutId: string
  countryCode: string
  href: string
  email?: string
}

export async function createPaymentQliro(
  variables: CreatePaymentQliroVariables | Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<QliroOrder | null> {
  const json = await executeCartGraphQL(CREATE_PAYMENT_QLIRO_MUTATION, variables, options)
  return (json?.data?.Payment?.CreatePaymentQliro as QliroOrder) ?? null
}

export async function getQliroOrder(
  checkoutId: string,
  options?: CartQueryOptions,
): Promise<QliroOrder | null> {
  const json = await executeCartGraphQL(GET_QLIRO_ORDER_QUERY, { checkoutId }, options)
  return (json?.data?.Payment?.GetQliroOrder as QliroOrder) ?? null
}

/** Query-less page URL — shopcart appends ?checkout_id=…&payment_processor=QLIRO. */
export const qliroCleanHref = kustomCleanHref

/** Script-executing snippet injection — identical technique to Kustom/KCO. */
export const renderQliroSnippet = renderKustomSnippet
