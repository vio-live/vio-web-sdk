/**
 * Vipps MobilePay Payment Adapter — GraphQL Integration & Types.
 *
 * Vipps payment integration uses 2 GraphQL operations:
 *
 * 1. `CreatePaymentVipps` mutation:
 *    Initiates a Vipps payment session for a checkout and returns `payment_url`.
 *
 * 2. `GetVippsStatus` query:
 *    Queries Vipps payment state directly for a checkout (`state`).
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'

/**
 * GraphQL mutation to create a Vipps payment session.
 */
export const CREATE_PAYMENT_VIPPS_MUTATION = `
mutation CreatePaymentVipps($checkoutId: String!, $email: String!, $returnUrl: String!) {
  Payment {
    CreatePaymentVipps(checkout_id: $checkoutId, email: $email, return_url: $returnUrl) {
      payment_url
    }
  }
}
`

/**
 * GraphQL query to fetch current Vipps payment status.
 */
export const GET_VIPPS_STATUS_QUERY = `
query GetVippsStatus($checkoutId: String!) {
  Payment {
    GetVippsStatus(checkout_id: $checkoutId) {
      state
    }
  }
}
`

export interface CreatePaymentVippsVariables extends Record<string, unknown> {
  checkoutId: string
  email: string
  returnUrl: string
}

export interface CreatePaymentVippsResponse {
  payment_url: string
}

export interface GetVippsStatusVariables extends Record<string, unknown> {
  checkoutId: string
}

export interface VippsStatusResult {
  state: string
}

export type VippsPaymentState =
  | 'CREATED'
  | 'INITIATED'
  | 'AUTHORIZED'
  | 'TERMINATED'
  | 'EXPIRED'
  | string

/**
 * Executes the `CreatePaymentVipps` GraphQL mutation.
 */
export async function createPaymentVipps(
  variables: CreatePaymentVippsVariables | Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<CreatePaymentVippsResponse | null> {
  const json = await executeCartGraphQL(CREATE_PAYMENT_VIPPS_MUTATION, variables, options)
  return (json?.data?.Payment?.CreatePaymentVipps as CreatePaymentVippsResponse) ?? null
}

/**
 * Executes the `GetVippsStatus` GraphQL query.
 */
export async function getVippsStatus(
  variables: GetVippsStatusVariables | Record<string, unknown>,
  options?: CartQueryOptions,
): Promise<VippsStatusResult | null> {
  const json = await executeCartGraphQL(GET_VIPPS_STATUS_QUERY, variables, options)
  return (json?.data?.Payment?.GetVippsStatus as VippsStatusResult) ?? null
}
