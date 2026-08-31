/**
 * Walley (former Collector) Checkout — embedded checkout via Vio Commerce.
 *
 * Third member of the embedded family (Kustom, Qliro, Walley): the widget
 * collects address, shipping and payment itself; shopcart normalizes the
 * provider API to { order_id, status, html_snippet }. Walley's embed is a
 * <script data-token> loader — shopcart SYNTHESIZES the snippet, so the
 * shared script-executing injection renders it unchanged.
 *
 * The big UX difference: Walley fires a DOM event on completion —
 * `walleyCheckoutPurchaseCompleted` on `document` — so the success signal
 * needs NO redirect round-trip. The SDK listens while the panel is mounted
 * and also re-checks the session status on mount (covers reloads; Walley
 * renders its own receipt for completed sessions).
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'
import { kustomCleanHref, renderKustomSnippet } from './kustom.js'

/** Normalized Walley session (shopcart maps privateId/publicToken/status). */
export interface WalleyOrder {
  order_id: string
  /** Initialized | CustomerIdentified | CommittedToPurchase | PurchaseCompleted | Aborted. */
  status: string
  html_snippet: string
  public_token?: string
  purchase_country?: string
  purchase_currency?: string
  total_price?: number
}

/** DOM event Walley's iframe fires on document when the purchase completes. */
export const WALLEY_PURCHASE_COMPLETED_EVENT = 'walleyCheckoutPurchaseCompleted'

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

/** Shared embed + href helpers — one implementation, three providers. */
export const walleyCleanHref = kustomCleanHref
export const renderWalleySnippet = renderKustomSnippet
