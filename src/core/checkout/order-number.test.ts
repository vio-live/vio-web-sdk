import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getCheckoutOrderNumber,
  GET_CHECKOUT_ORDER_NUMBER_QUERY,
  GET_CHECKOUT_QUERY,
} from '../api/cart-queries.js'
import { Vio } from '../client.js'

/**
 * The Vio order number (#4497) for the receipt. `order_id` is new on
 * GetCheckout (2026-10-08): an API that does not have it yet answers the
 * query with an error, so it is asked on its own and a failure is "no number",
 * never a failed payment check.
 */
const OPTS = { endpoint: 'https://graph.test', apiKey: 'k' }

const answer = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )

afterEach(() => vi.restoreAllMocks())

describe('the order number query', () => {
  it('asks for the id and order_id only, and the payment check does not ask for it', () => {
    expect(GET_CHECKOUT_ORDER_NUMBER_QUERY).toContain('GetCheckout(checkout_id: $checkoutId)')
    expect(GET_CHECKOUT_ORDER_NUMBER_QUERY).toContain('order_id')
    expect(GET_CHECKOUT_QUERY).not.toMatch(/\border_id\b/)
  })

  it('answers the number once the order exists', async () => {
    answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: 4497 } } } })
    expect(await getCheckoutOrderNumber('c', OPTS)).toBe(4497)
  })

  it('answers null while it does not', async () => {
    answer({ data: { Checkout: { GetCheckout: { id: 'c', order_id: null } } } })
    expect(await getCheckoutOrderNumber('c', OPTS)).toBeNull()
  })
})

describe('Vio.checkout.getOrderNumber never throws', () => {
  it('an API without the field is "no number"', async () => {
    answer({ errors: [{ message: 'Cannot query field "order_id" on type "GetCheckoutDTO".' }] }, 400)
    const m = Vio.checkout as any
    expect(await m.getOrderNumber('c', 5)).toBeNull()
  })

  it('no checkout, no question', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await (Vio.checkout as any).getOrderNumber('', 5)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})
