import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckoutManager } from './checkout-manager.js'
import * as cartQueries from '../api/cart-queries.js'

/**
 * No checkout is opened and no payment is started for an empty cart or one
 * that totals 0 kr — whatever button asked (Mote & Livsstil, 2026-10-28).
 * The cart is read from the server first, so a cart another tab paid counts
 * as empty here.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

type Line = { id: string; unitPrice: number; quantity: number; discount?: number }

function manager(lines: Line[]) {
  const cart = {
    items: lines,
    cartId: 'cart-1',
  }
  const cm = {
    waitForCartMutations: vi.fn(async () => {}),
    refreshFromServer: vi.fn(async () => undefined),
    getCart: () => cart,
    ensureCartId: async () => 'cart-1',
    subtotalForSponsor: () => lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
  }
  const m = new CheckoutManager(cm as never) as any
  return { m, cart }
}

const line = (unitPrice: number, quantity = 1): Line => ({ id: 'l1', unitPrice, quantity })
/** A line a discount code gives away: its discount is its whole price. */
const gift = (unitPrice = 52): Line => ({ id: 'gift', unitPrice, quantity: 1, discount: unitPrice })

describe('CheckoutManager.open', () => {
  it('refuses an empty cart', () => {
    const { m } = manager([])
    expect(() => m.open(5)).toThrow(/no cart items/)
  })

  it('refuses a cart that totals 0', () => {
    const { m } = manager([line(0, 2)])
    expect(() => m.open(5)).toThrow(/totals 0/)
    expect(m.currentState).toBeNull()
  })

  it('opens a cart with something to pay', () => {
    const { m } = manager([line(599)])
    expect(m.open(5)).toMatchObject({ sponsorId: 5, subtotal: 599 })
    // No discount code on the cart: the state does not even name one.
    expect(m.currentState).not.toHaveProperty('discount')
  })

  it('refuses a cart of a gift alone: its lines cost nothing once the discount code is counted', () => {
    const { m } = manager([gift()])
    expect(() => m.open(5)).toThrow(/totals 0/)
    expect(m.currentState).toBeNull()
  })

  it('a cart with a gift and something to pay: the subtotal is the list prices, the discount beside it', () => {
    const { m } = manager([line(599), gift(52)])
    expect(m.open(5)).toMatchObject({ sponsorId: 5, subtotal: 651, discount: 52 })
  })
})

describe('Vipps never starts for nothing', () => {
  for (const [name, start] of [
    ['startVippsPayment', (m: any) => m.startVippsPayment(5, { email: 'kari@example.no' })],
    ['startVippsExpress', (m: any) => m.startVippsExpress(5)],
  ] as const) {
    it(`${name}: an empty cart (as the server has it) creates no checkout and no payment`, async () => {
      const { m } = manager([])
      const gql = vi.spyOn(cartQueries, 'executeCartGraphQL')
      const create = vi.spyOn(cartQueries, 'createCheckout')
      await expect(start(m)).rejects.toThrow(/empty — nothing to pay/)
      expect(create).not.toHaveBeenCalled()
      expect(gql).not.toHaveBeenCalled()
    })

    it(`${name}: a cart that totals 0 kr creates no checkout and no payment`, async () => {
      const { m } = manager([line(0)])
      const gql = vi.spyOn(cartQueries, 'executeCartGraphQL')
      const create = vi.spyOn(cartQueries, 'createCheckout')
      await expect(start(m)).rejects.toThrow(/totals 0/)
      expect(create).not.toHaveBeenCalled()
      expect(gql).not.toHaveBeenCalled()
    })
  }

  it('a cart of a gift alone creates no checkout and no payment either', async () => {
    const { m } = manager([gift()])
    const create = vi.spyOn(cartQueries, 'createCheckout')
    await expect(m.startVippsExpress(5)).rejects.toThrow(/totals 0/)
    await expect(m.startVippsPayment(5, { email: 'kari@example.no' })).rejects.toThrow(/totals 0/)
    expect(create).not.toHaveBeenCalled()
  })

  it('the check runs on the cart the server answered, after the in-flight changes', async () => {
    const { m, cart } = manager([line(599)])
    const cm = m.cartManager
    cm.refreshFromServer.mockImplementation(async () => {
      cart.items = [] // another tab paid it
    })
    await expect(m.startVippsExpress(5)).rejects.toThrow(/empty/)
    expect(cm.waitForCartMutations).toHaveBeenCalled()
    expect(cm.refreshFromServer).toHaveBeenCalled()
  })

  it('Stripe’s payment link is refused the same way', async () => {
    const { m } = manager([])
    await expect(m.startStripePayment(5, { email: 'kari@example.no' })).rejects.toThrow(/empty/)
  })
})
