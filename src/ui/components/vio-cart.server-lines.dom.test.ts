// @vitest-environment jsdom
/**
 * Mote & Livsstil, 2026-10-23, order 4127: the drawer showed one product, the
 * Vipps page two. The checkout is built on the BACKEND cart — every line in
 * it, whoever put it there — while the drawer drew this tab's memory. Now the
 * manager asks the server right before the checkout and the drawer draws that
 * answer, and a tab that paid empties the drawer of the others. The drawer is
 * mounted for real: its lines are what is pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  getCart: vi.fn(),
  createCheckout: vi.fn(),
  updateCheckout: vi.fn(),
}))

vi.mock('../../core/api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { Vio } from '../../core/client.js'
import type { CartUpdatedDetail } from '../../core/cart/cart-manager.js'
import { ensureLocalStorage } from '../../core/cart/storage.testutil.js'
import { mount, unmountAll, settle } from '../test-harness.js'

const SPONSOR = 1327
const storage = ensureLocalStorage()

const line = (id: string, productId: number, title: string) => ({
  id,
  product_id: productId,
  title,
  quantity: 1,
  price: { amount: 100, amount_incl_taxes: 100, currency_code: 'NOK' },
})
const serverCart = (cartId: string, lines: Array<ReturnType<typeof line>>) => ({
  cart_id: cartId,
  currency: 'NOK',
  line_items: lines,
})
const JUMPER = line('srv-1', 146, 'Sofie genser XL')
const TOP = line('srv-2', 147, 'Vilde XS')

function addLocally(productId: number, name: string): void {
  Vio.cart.addManual({ productId, sponsorId: SPONSOR, sponsorName: 'Careless', brand: 'Careless', name, unitPrice: 100, currency: 'NOK', imageUrl: '' })
}

const lineNames = (el: HTMLElement) =>
  [...el.shadowRoot!.querySelectorAll('.item-name')].map((n) => (n.textContent ?? '').trim())

function cartUpdatedEvents() {
  const seen: CartUpdatedDetail[] = []
  const on = (e: Event) => seen.push((e as CustomEvent<CartUpdatedDetail>).detail)
  document.addEventListener('vio:cart-updated', on)
  return { seen, off: () => document.removeEventListener('vio:cart-updated', on) }
}

/** The jumper in this tab's cart (`cart-1`), the drawer open on it. */
async function drawerWithJumper() {
  gql.createCart.mockResolvedValueOnce({ cart_id: 'cart-1', line_items: [] })
  gql.addItem.mockResolvedValueOnce(serverCart('cart-1', [JUMPER]))
  addLocally(146, 'Sofie genser XL')
  await Vio.cart.waitForCartMutations(SPONSOR)
  const el = await mount<HTMLElement & { open: boolean }>('vio-cart')
  el.open = true
  await settle(el)
  expect(lineNames(el)).toEqual(['Sofie genser XL'])
  return el
}

describe('vio-cart — the lines a checkout is built on are the lines the drawer shows', () => {
  beforeEach(() => {
    storage.clear()
    Vio.cart.clearAllCarts()
    for (const fn of Object.values(gql)) fn.mockReset()
    gql.getCartGraphQLOptions.mockImplementation(async () => ({ sponsorResolved: true }))
    gql.createCheckout.mockImplementation(async () => ({ id: 'CHK-1' }))
    gql.updateCheckout.mockImplementation(async (vars: { checkoutId: string }) => ({ id: vars.checkoutId }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // No network from the drawer itself.
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([] as never)
  })
  afterEach(() => {
    unmountAll()
    Vio.cart.clearAllCarts()
    vi.restoreAllMocks()
  })

  it('a line another tab put in the backend cart is drawn before the checkout is created — and the host hears it', async () => {
    const el = await drawerWithJumper()
    // The backend cart meanwhile (another tab, a page loaded earlier): the
    // jumper AND the top. Before, the checkout took both and the drawer said one.
    const order: string[] = []
    gql.getCart.mockImplementationOnce(async () => {
      order.push('GetCart')
      return serverCart('cart-1', [JUMPER, TOP])
    })
    gql.createCheckout.mockImplementationOnce(async () => {
      order.push('CreateCheckout')
      return { id: 'CHK-1' }
    })
    const events = cartUpdatedEvents()

    await Vio.checkout.createCheckout(SPONSOR)
    await settle(el)
    events.off()

    expect(order).toEqual(['GetCart', 'CreateCheckout'])
    expect(gql.getCart).toHaveBeenCalledWith('cart-1', expect.anything())
    expect(gql.createCheckout).toHaveBeenCalledWith('cart-1', expect.anything())
    expect(lineNames(el)).toEqual(['Sofie genser XL', 'Vilde XS'])
    expect(events.seen.map((e) => [e.source, e.itemCount, e.items.map((i) => i.name)])).toEqual([
      ['server', 2, ['Sofie genser XL', 'Vilde XS']],
    ])
  })

  it('opening the drawer asks the server and draws its lines', async () => {
    gql.createCart.mockResolvedValueOnce({ cart_id: 'cart-1', line_items: [] })
    gql.addItem.mockResolvedValueOnce(serverCart('cart-1', [JUMPER]))
    addLocally(146, 'Sofie genser XL')
    await Vio.cart.waitForCartMutations(SPONSOR)
    const el = await mount<HTMLElement & { open: boolean }>('vio-cart')
    expect(gql.getCart).not.toHaveBeenCalled()
    // The backend cart grew while the drawer was closed.
    gql.getCart.mockResolvedValueOnce(serverCart('cart-1', [JUMPER, TOP]))

    el.open = true
    await settle(el)
    await settle(el)

    expect(gql.getCart).toHaveBeenCalledTimes(1)
    expect(lineNames(el)).toEqual(['Sofie genser XL', 'Vilde XS'])
  })

  it('a tab that paid empties this drawer too, and the next add opens a new backend cart', async () => {
    const el = await drawerWithJumper()
    // The other tab paid: the SDK cleared the sponsor's cart there — this is
    // what it left in storage, and what the browser tells this tab.
    storage.setItem('vio.cart.v1', '{}')
    window.dispatchEvent(new StorageEvent('storage', { key: 'vio.cart.v1', newValue: '{}' }))
    await settle(el)
    expect(lineNames(el)).toEqual([])
    expect(el.shadowRoot!.querySelector('.empty')).toBeTruthy()

    gql.createCart.mockResolvedValueOnce({ cart_id: 'cart-2', line_items: [] })
    gql.addItem.mockResolvedValueOnce(serverCart('cart-2', [line('srv-9', 147, 'Vilde XS')]))
    addLocally(147, 'Vilde XS')
    await Vio.cart.waitForCartMutations(SPONSOR)
    await settle(el)
    expect(gql.addItem).toHaveBeenLastCalledWith('cart-2', expect.anything(), expect.anything())
    expect(lineNames(el)).toEqual(['Vilde XS'])
  })
})
