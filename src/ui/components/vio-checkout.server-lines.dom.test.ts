// @vitest-environment jsdom
/**
 * The checkout opens on the SERVER's cart. Its summary and its total used to
 * be this tab's memory at `open()`, while the checkout — and the Vipps page —
 * were built on the backend cart, every line of it (Mote & Livsstil,
 * 2026-10-23: one line on the page, two on Vipps' page). Now opening the
 * overlay asks the server; the manager follows the cart and the overlay
 * re-reads its lines and its total before the shopper pays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  getCart: vi.fn(),
}))

vi.mock('../../core/api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { Vio } from '../../core/client.js'
import { formatPrice } from '../../core/types.js'
import { ensureLocalStorage } from '../../core/cart/storage.testutil.js'
import { VioCheckout } from './vio-checkout.js'
import { mount, unmountAll, settle } from '../test-harness.js'

const SPONSOR = 1327
const storage = ensureLocalStorage()
const manager = Vio.checkout as unknown as Record<string, (...args: never[]) => unknown>

const line = (id: string, productId: number, title: string) => ({
  id,
  product_id: productId,
  title,
  quantity: 1,
  price: { amount: 100, amount_incl_taxes: 100, currency_code: 'NOK' },
})
const serverCart = (lines: Array<ReturnType<typeof line>>) => ({ cart_id: 'cart-1', currency: 'NOK', line_items: lines })
const JUMPER = line('srv-1', 146, 'Sofie genser XL')
const TOP = line('srv-2', 147, 'Vilde XS')

/** A Storage that lives in a Map — the test's own (`sessionStorage` is read on connect). */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
}

const lineNames = (el: HTMLElement) =>
  [...el.shadowRoot!.querySelectorAll('.order-summary .order-line b')].map((n) => (n.textContent ?? '').trim())
const summaryText = (el: HTMLElement) =>
  (el.shadowRoot!.querySelector('.order-summary')?.textContent ?? '').replace(/\s+/g, ' ').trim()

describe('vio-checkout — it opens on the lines the server has', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('sessionStorage', memoryStorage())
    Vio.cart.clearAllCarts()
    Vio.checkout.close()
    for (const fn of Object.values(gql)) fn.mockReset()
    gql.getCartGraphQLOptions.mockImplementation(async () => ({ sponsorResolved: true }))
    const proto = VioCheckout.prototype as unknown as Record<string, unknown>
    for (const m of ['loadAvailablePaymentMethods', 'loadAvailableShippings', 'refreshApplePay', 'refreshKlarna', 'loadVippsButton']) {
      vi.spyOn(proto as never, m as never).mockResolvedValue(undefined as never)
    }
    vi.spyOn(manager as never, 'resumeKlarnaReturn' as never).mockResolvedValue(undefined as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    unmountAll()
    Vio.checkout.close()
    Vio.cart.clearAllCarts()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('a line another tab added is in the summary, and in the total, before the shopper pays', async () => {
    // This tab: the jumper (cart-1), as the drawer showed it.
    gql.createCart.mockResolvedValueOnce({ cart_id: 'cart-1', line_items: [] })
    gql.addItem.mockResolvedValueOnce(serverCart([JUMPER]))
    Vio.cart.addManual({ productId: 146, sponsorId: SPONSOR, sponsorName: 'Careless', brand: 'Careless', name: 'Sofie genser XL', unitPrice: 100, currency: 'NOK', imageUrl: '' })
    await Vio.cart.waitForCartMutations(SPONSOR)
    // The backend cart: the jumper AND the top.
    gql.getCart.mockResolvedValueOnce(serverCart([JUMPER, TOP]))

    const el = await mount<HTMLElement & { open: boolean }>('vio-checkout')
    Vio.checkout.open(SPONSOR)
    expect(Vio.checkout.currentState?.subtotal).toBe(100)
    el.open = true
    for (let i = 0; i < 6; i++) await settle(el)

    expect(gql.getCart).toHaveBeenCalledWith('cart-1', expect.anything())
    expect(lineNames(el)).toEqual(['Sofie genser XL', 'Vilde XS'])
    expect(Vio.checkout.currentState?.subtotal).toBe(200)
    expect(summaryText(el)).toContain(formatPrice(200, 'NOK'))
    // Still the session open() started: nothing was torn down to show it.
    expect(Vio.checkout.currentState?.session).toBeDefined()
  })
})
