/**
 * Walley (former Collector) — embedded checkout via Vio Commerce.
 *
 * Third embedded provider, same category as Kustom/Qliro: the widget
 * collects address, shipping AND payment by itself.
 *
 *   1. `Payment { CreatePaymentWalley }` initializes the session (sponsor-key
 *      authed; the seller's own Walley credentials live server-side, per
 *      seller, never here) and returns a SYNTHESIZED html_snippet — Walley's
 *      real embed is a `<script data-token>` loader, so shopcart wraps it
 *      in the same shape Kustom/Qliro use, and this module reuses their
 *      exact script-executing injection.
 *   2. Walley's own script renders the iframe. On completion it dispatches
 *      the DOM event `walleyCheckoutPurchaseCompleted` — the PRIMARY success
 *      signal, no page reload needed. `redirectPageUri` is registered too
 *      (`?checkout_id=…&payment_processor=WALLEY`, same contract as
 *      Kustom/Qliro) as a safety net in case the event is missed (tab
 *      backgrounded, page reload).
 *   3. Either path re-reads the session (`Payment { GetWalleyOrder }`) BY
 *      OWNING CHECKOUT — same as Qliro — and re-renders Walley's own
 *      receipt.
 *
 * The Commerce order itself is created server-side by Walley's notification
 * webhook (shopcart /checkout/payment/walley/ok) — the browser never
 * confirms money.
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'
import { kustomCleanHref, renderKustomSnippet } from './kustom.js'

/** Normalized Walley session (shopcart maps privateId/publicToken/status). */
export interface WalleyOrder {
  order_id: string
  /** Walley status: Initialized | CustomerIdentified | CommittedToPurchase | PurchaseCompleted | Aborted. */
  status: string
  html_snippet: string
  public_token?: string
  purchase_country?: string
  purchase_currency?: string
  total_price?: number
}

export const CREATE_PAYMENT_WALLEY_MUTATION = `
mutation CreatePaymentWalley($checkoutId: String!, $countryCode: String!, $href: String!, $email: String) {
  Payment {
    CreatePaymentWalley(checkout_id: $checkoutId, country_code: $countryCode, href: $href, email: $email) {
      order_id
      status
      html_snippet
      public_token
      purchase_country
      purchase_currency
      total_price
    }
  }
}
`

export const GET_WALLEY_ORDER_QUERY = `
query GetWalleyOrder($checkoutId: String!) {
  Payment {
    GetWalleyOrder(checkout_id: $checkoutId) {
      order_id
      status
      html_snippet
      public_token
      purchase_country
      purchase_currency
      total_price
    }
  }
}
`

export interface CreatePaymentWalleyVariables extends Record<string, unknown> {
  checkoutId: string
  countryCode: string
  href: string
  email?: string
}

export async function createPaymentWalley(
  variables: CreatePaymentWalleyVariables | Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<WalleyOrder | null> {
  const json = await executeCartGraphQL(CREATE_PAYMENT_WALLEY_MUTATION, variables, options)
  return (json?.data?.Payment?.CreatePaymentWalley as WalleyOrder) ?? null
}

export async function getWalleyOrder(
  checkoutId: string,
  options?: CartQueryOptions,
): Promise<WalleyOrder | null> {
  const json = await executeCartGraphQL(GET_WALLEY_ORDER_QUERY, { checkoutId }, options)
  return (json?.data?.Payment?.GetWalleyOrder as WalleyOrder) ?? null
}

/** Query-less page URL — shopcart appends ?checkout_id=…&payment_processor=WALLEY. */
export const walleyCleanHref = kustomCleanHref

/** Script-executing snippet injection — identical technique to Kustom/Qliro. */
export const renderWalleySnippet = renderKustomSnippet

/** Name of the DOM event Walley's own embed script dispatches on success. */
export const WALLEY_PURCHASE_COMPLETED_EVENT = 'walleyCheckoutPurchaseCompleted'
