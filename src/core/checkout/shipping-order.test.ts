/**
 * Shipping rates come back from Commerce in database order. The checkout
 * preselects (and saves on the cart) the first one, and with Qliro that is
 * the rate the widget opens with — on 2026-09-14 the dearest, by accident of
 * row order. They are listed cheapest first instead.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({})),
  getLineItemsBySupplier: vi.fn(async () => [
    {
      supplier: { id: 7 },
      available_shippings: [
        { id: 'sc-dear', name: 'other to NO', price: { amount_incl_taxes: 200, currency_code: 'NOK' } },
        { id: 'sc-cheap', name: 'from seller in not', price: { amount_incl_taxes: 100, currency_code: 'NOK' } },
        { id: 'sc-mid', name: 'Pickup', price: { amount_incl_taxes: 149, currency_code: 'NOK' } },
      ],
    },
  ]),
}))

import { CheckoutManager } from './checkout-manager.js'

const fakeCart = {
  waitForCartMutations: async () => {},
  getCart: () => ({ cartId: 'cart-1' }),
  ensureCartId: async () => 'cart-1',
} as never

describe('fetchAvailableShippings', () => {
  it('lists the rates cheapest first and preselects the cheapest', async () => {
    const m = new CheckoutManager(fakeCart)
    const list = await m.fetchAvailableShippings(5)
    expect(list.map((s) => s.id)).toEqual(['sc-cheap', 'sc-mid', 'sc-dear'])
    expect(list.map((s) => s.preselected)).toEqual([true, false, false])
  })
})

describe('checkout sessions', () => {
  it('every open() is a new session, and later updates keep it', async () => {
    const cart = {
      waitForCartMutations: async () => {},
      getCart: () => ({ cartId: 'cart-1', items: [{ id: 'a', quantity: 1, unitPrice: 100 }] }),
      ensureCartId: async () => 'cart-1',
      subtotalForSponsor: () => 100,
    } as never
    const m = new CheckoutManager(cart)
    const first = m.open(5).session
    m.selectPaymentMethod('qliro')
    expect(m.currentState?.session).toBe(first)
    const second = m.open(5).session
    expect(second).toBeGreaterThan(first ?? 0)
  })
})
