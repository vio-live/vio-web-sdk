/**
 * ADR-0035 phase B: the checkout is born attributed and attributed again
 * right before paying. The manager asks the facade (`deps.orderAttribution`)
 * and passes the answer to `CreateCheckout` and `UpdateCheckout`; without a
 * facade, or when it fails, nothing changes and nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({})),
  createCheckout: vi.fn(async () => ({ id: 'CHK-1' })),
  updateCheckout: vi.fn(async (vars: { checkoutId: string }) => ({ id: vars.checkoutId })),
}))

import * as cartQueries from '../api/cart-queries.js'
import { CheckoutManager } from './checkout-manager.js'

const ATTRIBUTION = { surface_key: 'surface-key', campaign_id: 7, content_url: 'https://host.example/a' }

const cart = () =>
  ({
    waitForCartMutations: vi.fn(async () => {}),
    getCart: () => ({ cartId: 'cart-1', currency: 'NOK', items: [{ id: 'a', quantity: 2, unitPrice: 100 }] }),
    ensureCartId: async () => 'cart-1',
    subtotalForSponsor: () => 200,
  }) as never

type Prepare = {
  prepareRedirectPayment: (s: number, f: unknown, x?: Record<string, unknown>) => Promise<{ checkoutId: string }>
}

beforeEach(() => {
  vi.mocked(cartQueries.createCheckout).mockClear()
  vi.mocked(cartQueries.updateCheckout).mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('the checkout is born attributed', () => {
  it('createCheckout passes the facade\'s attribution to CreateCheckout', async () => {
    const orderAttribution = vi.fn(async () => ATTRIBUTION)
    const m = new CheckoutManager(cart(), { orderAttribution })
    await m.createCheckout(5)
    expect(orderAttribution).toHaveBeenCalledWith(5)
    expect(cartQueries.createCheckout).toHaveBeenCalledWith('cart-1', expect.anything(), { attribution: ATTRIBUTION })
  })

  it('without a facade (or an attribution) CreateCheckout is called as before', async () => {
    const m = new CheckoutManager(cart())
    await m.createCheckout(5)
    expect(cartQueries.createCheckout).toHaveBeenCalledWith('cart-1', expect.anything())
    expect(vi.mocked(cartQueries.createCheckout).mock.calls[0]).toHaveLength(2)
    const none = new CheckoutManager(cart(), { orderAttribution: async () => undefined })
    await none.createCheckout(5)
    expect(vi.mocked(cartQueries.createCheckout).mock.calls[1]).toHaveLength(2)
  })

  it('a facade that throws costs nothing: the checkout is created without attribution', async () => {
    const m = new CheckoutManager(cart(), {
      orderAttribution: async () => {
        throw new Error('no')
      },
    })
    await expect(m.createCheckout(5)).resolves.toMatchObject({ id: 'CHK-1' })
    expect(vi.mocked(cartQueries.createCheckout).mock.calls[0]).toHaveLength(2)
  })
})

describe('and attributed again right before paying', () => {
  it('prepareRedirectPayment (Stripe / Vipps links): on the CreateCheckout and on the UpdateCheckout with the address', async () => {
    const m = new CheckoutManager(cart(), { orderAttribution: async () => ATTRIBUTION }) as unknown as Prepare
    const res = await m.prepareRedirectPayment(5, { email: 'kari@example.no' }, { paymentMethod: 'Vipps' })
    expect(res.checkoutId).toBe('CHK-1')
    expect(cartQueries.createCheckout).toHaveBeenCalledWith('cart-1', expect.anything(), { attribution: ATTRIBUTION })
    expect(cartQueries.updateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ checkoutId: 'CHK-1', email: 'kari@example.no', paymentMethod: 'Vipps', attribution: ATTRIBUTION }),
      expect.anything(),
    )
  })

  it('updateCheckout (Apple Pay, the method on the checkout) carries it unless the caller gives its own', async () => {
    const m = new CheckoutManager(cart(), { orderAttribution: async () => ATTRIBUTION })
    await m.updateCheckout({ checkoutId: 'CHK-1', paymentMethod: 'Apple Pay' }, 5)
    expect(cartQueries.updateCheckout).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkoutId: 'CHK-1', paymentMethod: 'Apple Pay', attribution: ATTRIBUTION }),
      expect.anything(),
    )
    const own = { surface_key: 'other' }
    await m.updateCheckout({ checkoutId: 'CHK-1', attribution: own }, 5)
    expect(cartQueries.updateCheckout).toHaveBeenLastCalledWith(expect.objectContaining({ attribution: own }), expect.anything())
  })

  it('without a facade the variables are exactly what they were', async () => {
    const m = new CheckoutManager(cart())
    await m.updateCheckout({ checkoutId: 'CHK-1', paymentMethod: 'Apple Pay' }, 5)
    expect(cartQueries.updateCheckout).toHaveBeenLastCalledWith(
      { buyerAcceptsPurchaseConditions: true, buyerAcceptsTermsConditions: true, checkoutId: 'CHK-1', paymentMethod: 'Apple Pay' },
      expect.anything(),
    )
  })
})
