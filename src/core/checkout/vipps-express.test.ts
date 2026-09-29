import { afterEach, describe, expect, it, vi } from 'vitest'
import { Vio } from '../client.js'
import * as cartQueries from '../api/cart-queries.js'
import { CREATE_PAYMENT_VIPPS_MUTATION } from './payments/vipps.js'

/**
 * Vipps Express from the product and the cart (2026-09-29): one call asks
 * for it, and the answer decides between the app and our checkout.
 */
const manager = Vio.checkout as any
const CheckoutManager = manager.constructor as any

afterEach(() => {
  vi.restoreAllMocks()
})

function prepared() {
  vi.spyOn(manager, 'prepareRedirectPayment').mockResolvedValue({
    spId: 5,
    checkoutId: 'chk-1',
    emailVal: '',
    opts: {},
  })
  return vi.spyOn(CheckoutManager, 'redirectTo').mockImplementation(() => undefined)
}

describe('startVippsExpress', () => {
  it('asks for Express without an email and follows the landing page Vipps answers', async () => {
    const redirect = prepared()
    const gql = vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValueOnce({
      data: { Payment: { CreatePaymentVipps: { payment_url: 'https://apitest.vipps.no/landing', reference: 'VIO-chk-1', express: true } } },
    })
    const res = await manager.startVippsExpress(5)
    expect(gql).toHaveBeenCalledWith(
      CREATE_PAYMENT_VIPPS_MUTATION,
      expect.objectContaining({ checkoutId: 'chk-1', express: true }),
      {},
    )
    expect(gql.mock.calls[0]![1]).not.toHaveProperty('email')
    expect(redirect).toHaveBeenCalledWith('https://apitest.vipps.no/landing')
    expect(res).toMatchObject({ reference: 'VIO-chk-1', express: true })
  })

  it('when the cart cannot have Express, resolves with the reason and redirects nowhere', async () => {
    const redirect = prepared()
    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValueOnce({
      data: { Payment: { CreatePaymentVipps: { express: false, reason: 'several suppliers' } } },
    })
    const res = await manager.startVippsExpress(5)
    expect(res).toEqual({ express: false, reason: 'several suppliers' })
    expect(redirect).not.toHaveBeenCalled()
  })

  it('the plain flow still refuses an answer without a landing page', async () => {
    prepared()
    vi.spyOn(cartQueries, 'executeCartGraphQL').mockResolvedValueOnce({
      data: { Payment: { CreatePaymentVipps: { express: false, reason: 'nope' } } },
    })
    await expect(manager.startVippsPayment(5, { email: 'kari@example.no' })).rejects.toThrow(/missing payment_url/)
  })
})
