/**
 * Right before a checkout is created, or a payment link minted, the manager
 * asks the cart for the SERVER's lines (`CartManager.refreshFromServer`) —
 * after this tab's own mutations have settled, before CreateCheckout — so the
 * lines the shopper is about to pay for are on the page first (Mote &
 * Livsstil, 2026-10-23).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as string[])

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({})),
  createCheckout: vi.fn(async () => {
    calls.push('CreateCheckout')
    return { id: 'CHK-1' }
  }),
  updateCheckout: vi.fn(async (vars: { checkoutId: string }) => {
    calls.push('UpdateCheckout')
    return { id: vars.checkoutId }
  }),
}))

import * as cartQueries from '../api/cart-queries.js'
import { CheckoutManager } from './checkout-manager.js'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** A cart whose server refresh answers when the test says so. */
function cartWithRefresh() {
  let release!: () => void
  const refreshed = new Promise<void>((r) => (release = r))
  const cart = {
    waitForCartMutations: vi.fn(async () => {
      calls.push('waitForCartMutations')
    }),
    refreshFromServer: vi.fn(async () => {
      calls.push('refreshFromServer')
      await refreshed
      return undefined
    }),
    getCart: () => ({ cartId: 'cart-1', currency: 'NOK', items: [{ id: 'a', quantity: 2, unitPrice: 100 }] }),
    ensureCartId: async () => 'cart-1',
    subtotalForSponsor: () => 200,
  }
  return { cart, release }
}

describe("the checkout is built on the server's cart", () => {
  beforeEach(() => {
    calls.length = 0
    vi.mocked(cartQueries.createCheckout).mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('createCheckout: own mutations, then the server, then CreateCheckout', async () => {
    const { cart, release } = cartWithRefresh()
    const m = new CheckoutManager(cart as never)
    const creating = m.createCheckout(5)
    await tick()
    expect(cart.refreshFromServer).toHaveBeenCalledWith(5)
    expect(cartQueries.createCheckout).not.toHaveBeenCalled()
    release()
    await creating
    expect(calls).toEqual(['waitForCartMutations', 'refreshFromServer', 'CreateCheckout', 'UpdateCheckout'])
  })

  it('prepareRedirectPayment (the Vipps / Stripe links): the same, before the checkout is created or updated', async () => {
    const { cart, release } = cartWithRefresh()
    const m = new CheckoutManager(cart as never) as unknown as {
      prepareRedirectPayment: (s: number, f: unknown, x?: Record<string, unknown>) => Promise<{ checkoutId: string }>
    }
    const preparing = m.prepareRedirectPayment(5, undefined, { paymentMethod: 'Vipps' })
    await tick()
    expect(cart.refreshFromServer).toHaveBeenCalledWith(5)
    expect(cartQueries.createCheckout).not.toHaveBeenCalled()
    release()
    const res = await preparing
    expect(res.checkoutId).toBe('CHK-1')
    expect(calls).toEqual(['waitForCartMutations', 'refreshFromServer', 'CreateCheckout', 'UpdateCheckout'])
  })
})

/** A cart that can say `change`, as the real manager does. */
class FakeCart extends EventTarget {
  items: Array<{ id: string; productId: number; quantity: number; unitPrice: number }> = [
    { id: 'a', productId: 146, quantity: 1, unitPrice: 100 },
  ]
  waitForCartMutations = async () => {}
  refreshFromServer = async () => undefined
  getCart() {
    return { cartId: 'cart-1', currency: 'NOK', items: this.items }
  }
  ensureCartId = async () => 'cart-1'
  subtotalForSponsor() {
    return this.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)
  }
  changed() {
    this.dispatchEvent(new Event('change'))
  }
}

describe('the open checkout follows its cart', () => {
  it('a line that arrives under the open checkout: subtotal recomputed, change said once', () => {
    const cart = new FakeCart()
    const m = new CheckoutManager(cart as never)
    m.open(5)
    const changes = vi.fn()
    m.addEventListener('change', changes)

    // The server's cart had a second line (another tab): applied, the cart says change.
    cart.items = [...cart.items, { id: 'b', productId: 147, quantity: 1, unitPrice: 100 }]
    cart.changed()
    expect(m.currentState?.subtotal).toBe(200)
    expect(m.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(changes).toHaveBeenCalledTimes(1)
    // The same cart again: nothing to say.
    cart.changed()
    expect(changes).toHaveBeenCalledTimes(1)
    // The session is the one open() started: no widget is torn down for this.
    expect(m.currentState?.session).toBe(1)
  })

  it('a closed checkout does not care', () => {
    const cart = new FakeCart()
    const m = new CheckoutManager(cart as never)
    const changes = vi.fn()
    m.addEventListener('change', changes)
    cart.items = []
    cart.changed()
    expect(changes).not.toHaveBeenCalled()
    expect(m.currentState).toBeNull()
  })
})
