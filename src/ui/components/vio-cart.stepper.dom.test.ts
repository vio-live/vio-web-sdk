// @vitest-environment jsdom
/**
 * The stepper of the cart drawer under quick taps (Alan, 2026-10-15). Five
 * taps on "+" before Lit re-renders: the handler sees the same rendered
 * snapshot each time, so the target has to come from the manager's live
 * state — and only one request may be in flight per line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(async () => ({ cart_id: 'cart-1', line_items: [] })),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  // Opening the drawer asks the server for the cart; nothing to answer here.
  getCart: vi.fn(),
}))

vi.mock('../../core/api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { Vio } from '../../core/client.js'
import { mount, unmountAll, settle } from '../test-harness.js'

const SPONSOR = 5

const serverCart = (quantity: number) => ({
  cart_id: 'cart-1',
  currency: 'NOK',
  line_items: [
    {
      id: 'srv-1',
      product_id: 1,
      title: 'Aole spisestol',
      quantity,
      price: { amount: 4999, amount_incl_taxes: 4999, currency_code: 'NOK' },
    },
  ],
})

describe('vio-cart — quick taps on the stepper', () => {
  beforeEach(() => {
    localStorage.clear()
    Vio.cart.clearAllCarts()
    gql.updateItem.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // No network from the drawer itself.
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([] as never)
  })
  afterEach(() => {
    unmountAll()
    Vio.cart.clearAllCarts()
    vi.restoreAllMocks()
  })

  it('five quick + taps show 6, with one request in flight at a time and the last one asking for 6', async () => {
    gql.addItem.mockImplementation(async () => serverCart(1))
    Vio.cart.addManual({
      productId: 1,
      sponsorId: SPONSOR,
      sponsorName: 'Bohus',
      brand: 'Bohus',
      name: 'Aole spisestol',
      unitPrice: 4999,
      currency: 'NOK',
      imageUrl: '',
    })
    await Vio.cart.waitForCartMutations(SPONSOR)

    const sent: Array<{ qty: number; resolve: (v: unknown) => void }> = []
    gql.updateItem.mockImplementation(
      (_cart: string, _id: string, _ship: unknown, qty: number) =>
        new Promise((resolve) => sent.push({ qty, resolve })),
    )

    const el = await mount<HTMLElement & { open: boolean }>('vio-cart')
    el.open = true
    await settle(el)
    const shown = () =>
      Number((el.shadowRoot!.querySelector('.item-qty')!.textContent ?? '').replace(/\D/g, ''))
    expect(shown()).toBe(1)

    // Five taps in the same task: Lit has not re-rendered between them.
    const plus = el.shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Øk"]')!
    for (let i = 0; i < 5; i++) plus.click()
    await settle(el)
    expect(shown()).toBe(6)
    expect(sent.map((s) => s.qty)).toEqual([2])

    sent[0]!.resolve(serverCart(2)) // the stale answer
    await settle(el)
    expect(shown()).toBe(6)
    expect(sent.map((s) => s.qty)).toEqual([2, 6])

    sent[1]!.resolve(serverCart(6))
    await Vio.cart.waitForCartMutations(SPONSOR)
    await settle(el)
    expect(shown()).toBe(6)
  })
})
