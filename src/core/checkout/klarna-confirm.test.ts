/**
 * ConfirmPaymentKlarnaNative with `buyer_ref` (W2): a gateway that refuses
 * the selection (validation, nothing ran) gets the mutation once more without
 * the field; a confirmation that ran and failed is NEVER sent again — with
 * autoCapture that would be a second charge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The commerce options come from the bootstrap in real life; here the
// mutation is the only thing on the wire.
vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({ endpoint: 'https://graph.test', apiKey: 'k' })),
}))

import { resetBuyerRefSupport } from '../api/cart-queries.js'
import { Vio } from '../client.js'

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const UNKNOWN_BUYER_REF = { errors: [{ message: 'Cannot query field "buyer_ref" on type "KlarnaNativeConfirmDTO".' }] }
const CONFIRMED = (extra: Record<string, unknown> = {}) => ({
  data: {
    Payment: {
      ConfirmPaymentKlarnaNative: {
        order_id: 'K-1',
        checkout_id: 'CHK',
        fraud_status: 'ACCEPTED',
        order: { order_id: 'K-1', status: 'AUTHORIZED', order_amount: 19900 },
        ...extra,
      },
    },
  },
})

const manager = Vio.checkout as any
const ctx = { sponsorId: 5, currency: 'NOK', orderAmount: 19900, orderLines: [], checkoutId: 'CHK' }

const sentQuery = (fetchMock: { mock: { calls: unknown[][] } }, i: number) =>
  JSON.parse((fetchMock.mock.calls[i]![1] as { body: string }).body).query as string

/** Runs the confirm and collects what the manager tells the component. */
async function confirm() {
  const complete: any[] = []
  const errors: any[] = []
  const onComplete = (e: Event) => complete.push((e as CustomEvent).detail)
  const onError = (e: Event) => errors.push((e as CustomEvent).detail)
  manager.addEventListener('payment-complete', onComplete)
  manager.addEventListener('payment-error', onError)
  try {
    await manager.completeKlarnaOrder('tok-1', ctx, { authorization_token: 'tok-1' })
  } finally {
    manager.removeEventListener('payment-complete', onComplete)
    manager.removeEventListener('payment-error', onError)
  }
  return { complete, errors }
}

beforeEach(() => {
  resetBuyerRefSupport()
  manager.state = { sponsorId: 5, subtotal: 199, currency: 'NOK', checkoutId: 'CHK' }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  manager.state = null
  vi.restoreAllMocks()
  resetBuyerRefSupport()
})

describe('completeKlarnaOrder and buyer_ref', () => {
  it('selects buyer_ref and hands it over as result.buyerRef', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(CONFIRMED({ buyer_ref: 'brf_k' })))
    const { complete, errors } = await confirm()
    expect(errors).toHaveLength(0)
    expect(complete).toHaveLength(1)
    expect(complete[0].method).toBe('klarna')
    expect(complete[0].result).toMatchObject({ buyerRef: 'brf_k', chargedTotal: 199 })
    expect(sentQuery(fetchMock, 0)).toContain('buyer_ref')
  })

  it('a gateway that refuses the selection (validation, nothing ran): sent once more without the field', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(UNKNOWN_BUYER_REF, 400))
      .mockImplementation(async () => response(CONFIRMED()))
    const { complete, errors } = await confirm()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentQuery(fetchMock, 0)).toContain('buyer_ref')
    expect(sentQuery(fetchMock, 1)).not.toContain('buyer_ref')
    expect(errors).toHaveLength(0)
    expect(complete).toHaveLength(1)
    expect(complete[0].result).not.toHaveProperty('buyerRef')
  })

  it('a confirmation that ran and failed is never repeated: one call, payment-error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        response({ data: { Payment: { ConfirmPaymentKlarnaNative: null } }, errors: [{ message: 'Fraud check rejected' }] }),
      )
    const { complete, errors } = await confirm()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(complete).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toContain('Fraud check rejected')
  })
})
