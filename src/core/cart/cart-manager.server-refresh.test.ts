// @vitest-environment jsdom
/**
 * The cart a checkout is built on is the SERVER's cart — every line in it,
 * whoever put it there — so right before a checkout the manager asks for it
 * and shows it (Mote & Livsstil, 2026-10-23: the Vipps page listed a line the
 * page had not drawn). jsdom because `vio:cart-updated` goes out on `document`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(async () => ({ cart_id: 'cart-1', line_items: [] })),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  getCart: vi.fn(),
}))

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { CartManager, type CartUpdatedDetail } from './cart-manager.js'
import { ensureLocalStorage } from './storage.testutil.js'

const SPONSOR = 5

/** Let awaited mocks and their continuations run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const line = (id: string, productId: number, title: string, quantity = 1) => ({
  id,
  product_id: productId,
  title,
  quantity,
  price: { amount: 100, amount_incl_taxes: 100, currency_code: 'NOK' },
})
/** A backend cart as Commerce answers it: the WHOLE cart. */
const serverCart = (lines: Array<ReturnType<typeof line>>) => ({
  cart_id: 'cart-1',
  currency: 'NOK',
  line_items: lines,
})
const JUMPER = line('srv-1', 146, 'Sofie genser XL')
const TOP = line('srv-2', 147, 'Vilde XS')

/** A manager whose cart holds the jumper, synced with the backend. */
async function withJumper(): Promise<CartManager> {
  const m = new CartManager()
  gql.addItem.mockResolvedValueOnce(serverCart([JUMPER]))
  m.addManual({
    productId: 146,
    sponsorId: SPONSOR,
    brand: 'Careless',
    name: 'Sofie genser XL',
    unitPrice: 100,
    currency: 'NOK',
    imageUrl: '',
  })
  await m.waitForCartMutations(SPONSOR)
  return m
}

const names = (m: CartManager) => m.getCart(SPONSOR)?.items.map((i) => i.name) ?? []

function cartUpdatedEvents() {
  const seen: CartUpdatedDetail[] = []
  const on = (e: Event) => seen.push((e as CustomEvent<CartUpdatedDetail>).detail)
  document.addEventListener('vio:cart-updated', on)
  return { seen, off: () => document.removeEventListener('vio:cart-updated', on) }
}

describe('CartManager.refreshFromServer — the cart as the server has it', () => {
  beforeEach(() => {
    ensureLocalStorage().clear()
    gql.getCartGraphQLOptions.mockReset().mockImplementation(async () => ({ sponsorResolved: true }))
    gql.createCart.mockReset().mockImplementation(async () => ({ cart_id: 'cart-1', line_items: [] }))
    gql.addItem.mockReset()
    gql.updateItem.mockReset()
    gql.deleteItem.mockReset()
    gql.getCart.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a line another tab put in the cart is here before the checkout — and the page is told', async () => {
    const m = await withJumper()
    expect(names(m)).toEqual(['Sofie genser XL'])
    gql.getCart.mockResolvedValueOnce(serverCart([JUMPER, TOP]))
    const changes = vi.fn()
    m.addEventListener('change', changes)
    const events = cartUpdatedEvents()

    const cart = await m.refreshFromServer(SPONSOR)
    events.off()

    expect(gql.getCart).toHaveBeenCalledWith('cart-1', expect.anything())
    expect(names(m)).toEqual(['Sofie genser XL', 'Vilde XS'])
    expect(cart?.items.map((i) => i.cartItemId)).toEqual(['srv-1', 'srv-2'])
    expect(changes).toHaveBeenCalled()
    expect(events.seen).toHaveLength(1)
    expect(events.seen[0]).toMatchObject({
      sponsorId: SPONSOR,
      cartId: 'cart-1',
      itemCount: 2,
      subtotal: 200,
      currency: 'NOK',
      source: 'server',
    })
    expect(events.seen[0]!.items.map((i) => i.name)).toEqual(['Sofie genser XL', 'Vilde XS'])
    // Copies: a host that mutates them does not touch the cart.
    events.seen[0]!.items[0]!.quantity = 99
    expect(m.getCart(SPONSOR)?.items[0]?.quantity).toBe(1)
  })

  it('a cart the server says is empty is empty here too — nothing of ours is in flight', async () => {
    const m = await withJumper()
    gql.getCart.mockResolvedValueOnce(serverCart([]))
    await m.refreshFromServer(SPONSOR)
    expect(names(m)).toEqual([])
    expect(m.itemCount).toBe(0)
    // The backend cart stays the one to add to.
    expect(m.getCart(SPONSOR)?.cartId).toBe('cart-1')
  })

  it('a GetCart that fails leaves the cart as it was, warns, and resolves', async () => {
    const m = await withJumper()
    gql.getCart.mockRejectedValueOnce(new Error('503'))
    const events = cartUpdatedEvents()
    await expect(m.refreshFromServer(SPONSOR)).resolves.toMatchObject({ cartId: 'cart-1' })
    events.off()
    expect(names(m)).toEqual(['Sofie genser XL'])
    expect(events.seen).toHaveLength(0)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('GetCart before the checkout failed'),
      expect.anything(),
    )
  })

  it('without a backend cart there is nothing to ask', async () => {
    const m = new CartManager()
    // A sponsor whose commerce key never resolved: the cart stays local-only.
    gql.getCartGraphQLOptions.mockImplementation(async () => ({ sponsorResolved: false }))
    m.addManual({ productId: 1, sponsorId: SPONSOR, brand: 'B', name: 'P1', unitPrice: 100, currency: 'NOK', imageUrl: '' })
    await m.waitForCartMutations(SPONSOR)
    const events = cartUpdatedEvents()
    const cart = await m.refreshFromServer(SPONSOR)
    events.off()
    expect(cart?.cartId).toBeUndefined()
    expect(gql.getCart).not.toHaveBeenCalled()
    expect(events.seen).toHaveLength(0)
    expect(names(m)).toEqual(['P1'])
  })

  it("waits for this tab's own mutation first, and asks again when a tap lands while the server answers", async () => {
    const m = await withJumper()
    // A + tapped a moment ago, still on its way.
    const update1 = deferred()
    gql.updateItem.mockImplementationOnce(() => update1.promise)
    m.adjustQuantity('srv-1', SPONSOR, +1)
    const get1 = deferred()
    gql.getCart.mockImplementationOnce(() => get1.promise)

    const refreshing = m.refreshFromServer(SPONSOR)
    await tick()
    expect(gql.getCart).not.toHaveBeenCalled()

    update1.resolve(serverCart([line('srv-1', 146, 'Sofie genser XL', 2)]))
    await tick()
    expect(gql.getCart).toHaveBeenCalledTimes(1)

    // While the server answers, another +.
    const update2 = deferred()
    gql.updateItem.mockImplementationOnce(() => update2.promise)
    m.adjustQuantity('srv-1', SPONSOR, +1)
    const get2 = deferred()
    gql.getCart.mockImplementationOnce(() => get2.promise)
    get1.resolve(serverCart([line('srv-1', 146, 'Sofie genser XL', 2)]))
    await tick()
    // That answer is old: not applied over the 3 on screen; asked again once the + settles.
    expect(m.getCart(SPONSOR)?.items[0]?.quantity).toBe(3)
    expect(gql.getCart).toHaveBeenCalledTimes(1)

    update2.resolve(serverCart([line('srv-1', 146, 'Sofie genser XL', 3)]))
    await tick()
    expect(gql.getCart).toHaveBeenCalledTimes(2)
    get2.resolve(serverCart([line('srv-1', 146, 'Sofie genser XL', 3)]))
    await refreshing
    expect(m.getCart(SPONSOR)?.items[0]?.quantity).toBe(3)
  })
})
