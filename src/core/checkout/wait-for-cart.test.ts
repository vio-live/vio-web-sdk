/**
 * The checkout is built on the cart AFTER any in-flight quantity change
 * (review of 2026-10-16, W4): a + tapped a moment before "Pay" must be in the
 * backend cart the checkout / payment link is created from.
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

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** A cart whose last mutation has not settled until the test says so. */
function cartStillSyncing() {
  let release!: () => void
  const settled = new Promise<void>((r) => (release = r))
  const cart = {
    waitForCartMutations: vi.fn(() => settled),
    getCart: () => ({ cartId: 'cart-1', currency: 'NOK', items: [{ id: 'a', quantity: 2, unitPrice: 100 }] }),
    ensureCartId: async () => 'cart-1',
    subtotalForSponsor: () => 200,
  }
  return { cart, release }
}

describe('the checkout waits for in-flight cart mutations', () => {
  beforeEach(() => {
    vi.mocked(cartQueries.createCheckout).mockClear()
    vi.mocked(cartQueries.updateCheckout).mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('createCheckout does not create the backend checkout until the cart has settled', async () => {
    const { cart, release } = cartStillSyncing()
    const m = new CheckoutManager(cart as never)
    const creating = m.createCheckout(5)
    await tick()
    expect(cart.waitForCartMutations).toHaveBeenCalledWith(5)
    expect(cartQueries.createCheckout).not.toHaveBeenCalled()
    release()
    await creating
    expect(cartQueries.createCheckout).toHaveBeenCalledTimes(1)
    expect(cartQueries.createCheckout).toHaveBeenCalledWith('cart-1', expect.anything())
  })

  it('prepareRedirectPayment (Stripe / Vipps links) waits too', async () => {
    const { cart, release } = cartStillSyncing()
    const m = new CheckoutManager(cart as never) as unknown as {
      prepareRedirectPayment: (s: number, f: unknown, x?: Record<string, unknown>) => Promise<{ checkoutId: string }>
    }
    const preparing = m.prepareRedirectPayment(5, { email: 'kari@example.no' }, { paymentMethod: 'Vipps' })
    await tick()
    expect(cart.waitForCartMutations).toHaveBeenCalledWith(5)
    expect(cartQueries.createCheckout).not.toHaveBeenCalled()
    release()
    const res = await preparing
    expect(res.checkoutId).toBe('CHK-1')
    expect(cartQueries.createCheckout).toHaveBeenCalledTimes(1)
  })
})
