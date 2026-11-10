// @vitest-environment jsdom
/**
 * What a line costs once the cart's discount code is counted: Commerce
 * answers every line with what the code takes off it (`price.discount`, the
 * amount off the LINE), the line keeps its list unit price and that amount,
 * and the totals the shopper pays from are the net of the two. A cart
 * without discounts is, to the last key, the cart it always was.
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

import { CartManager, cartStorageKey, type CartUpdatedDetail } from './cart-manager.js'
import { ensureLocalStorage } from './storage.testutil.js'

const SPONSOR = 5

const line = (id: string, productId: number, price: number, quantity = 1, discount?: number | string | null) => ({
  id,
  product_id: productId,
  title: `P${productId}`,
  quantity,
  price: { amount: price * 0.8, amount_incl_taxes: price, currency_code: 'NOK', ...(discount !== undefined ? { discount } : {}) },
})
const serverCart = (lines: Array<ReturnType<typeof line>>) => ({ cart_id: 'cart-1', currency: 'NOK', line_items: lines })

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** A manager whose cart holds a cream (349), synced with the backend. */
async function withCream(quantity = 1): Promise<CartManager> {
  const m = new CartManager()
  gql.addItem.mockResolvedValueOnce(serverCart([line('srv-1', 100, 349, quantity)]))
  m.addManual({ productId: 100, sponsorId: SPONSOR, brand: 'Faves', name: 'P100', unitPrice: 349, currency: 'NOK', imageUrl: '', quantity })
  await m.waitForCartMutations(SPONSOR)
  return m
}
const item = (m: CartManager, id: string) => m.getCart(SPONSOR)?.items.find((i) => i.id === id)

beforeEach(() => {
  ensureLocalStorage().clear()
  gql.getCartGraphQLOptions.mockReset().mockImplementation(async () => ({ sponsorResolved: true }))
  gql.createCart.mockReset().mockImplementation(async () => ({ cart_id: 'cart-1', line_items: [] }))
  for (const fn of [gql.addItem, gql.updateItem, gql.deleteItem, gql.getCart]) fn.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a line keeps its list price and what the code takes off it', () => {
  it('a gift: the list unit price stays, the discount is the line, and the cart costs the rest', async () => {
    const m = await withCream()
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 1, 0), line('srv-2', 421306, 52, 1, 52)]))

    expect(item(m, 'srv-1')).toMatchObject({ unitPrice: 349, quantity: 1 })
    expect(item(m, 'srv-1')).not.toHaveProperty('discount')
    expect(item(m, 'srv-2')).toMatchObject({ unitPrice: 52, quantity: 1, discount: 52 })
    expect(m.subtotalForSponsor(SPONSOR)).toBe(401)
    expect(m.discountForSponsor(SPONSOR)).toBe(52)
    expect(m.totalForSponsor(SPONSOR)).toBe(349)
    expect(m.totalAcrossSponsors).toBe(349)
    expect(m.listTotalAcrossSponsors).toBe(401)
    expect(m.formatTotal()).toMatch(/^349\s?Kr$/i)
  })

  it('a percentage on every line', async () => {
    const m = await withCream(2)
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 2, 69.8), line('srv-2', 101, 52, 1, '5.2')]))
    expect(item(m, 'srv-1')?.discount).toBe(69.8)
    expect(item(m, 'srv-2')?.discount).toBe(5.2)
    expect(m.subtotalForSponsor(SPONSOR)).toBe(750)
    expect(m.discountForSponsor(SPONSOR)).toBe(75)
    expect(m.totalForSponsor(SPONSOR)).toBe(675)
  })

  it('kept with the cart: the next page starts from the same prices', async () => {
    const m = await withCream()
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 1, 0), line('srv-2', 421306, 52, 1, 52)]))
    const again = new CartManager()
    expect(again.getCart(SPONSOR)?.items.map((i) => i.discount)).toEqual([undefined, 52])
    expect(again.totalForSponsor(SPONSOR)).toBe(349)
  })

  it('an answer without a discount takes it off the line again (the code went)', async () => {
    const m = await withCream()
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 1, 34.9)]))
    expect(m.totalForSponsor(SPONSOR)).toBe(314.1)
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 1, null)]))
    expect(item(m, 'srv-1')).not.toHaveProperty('discount')
    expect(m.totalForSponsor(SPONSOR)).toBe(349)
  })

  it('what Commerce says is never more than the line', async () => {
    const m = await withCream()
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 1, 9999)]))
    expect(item(m, 'srv-1')?.discount).toBe(349)
    expect(m.totalForSponsor(SPONSOR)).toBe(0)
  })
})

describe('quantities and the discount', () => {
  it('a tap on + scales the amount at once (a code is a percentage), and the server\'s answer has the last word', async () => {
    const m = await withCream()
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 1, 34.9)]))
    let answer!: (v: unknown) => void
    gql.updateItem.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))

    m.adjustQuantity('srv-1', SPONSOR, +1)
    // Before the server answers: two units, twice the amount off.
    expect(item(m, 'srv-1')).toMatchObject({ quantity: 2, discount: 69.8 })
    expect(m.totalForSponsor(SPONSOR)).toBe(628.2)

    // The server rounds its own way: its word stands.
    await tick()
    answer(serverCart([line('srv-1', 100, 349, 2, 70)]))
    await m.waitForCartMutations(SPONSOR)
    expect(item(m, 'srv-1')).toMatchObject({ quantity: 2, discount: 70 })
  })

  it('an answer for a quantity the line has already left: its amount is scaled to where the line is heading', async () => {
    const m = await withCream()
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 1, 34.9)]))
    let first!: (v: unknown) => void
    gql.updateItem.mockImplementationOnce(() => new Promise((resolve) => (first = resolve)))
    gql.updateItem.mockResolvedValueOnce(serverCart([line('srv-1', 100, 349, 3, 104.7)]))

    m.adjustQuantity('srv-1', SPONSOR, +1)
    m.adjustQuantity('srv-1', SPONSOR, +1)
    await tick()
    // The answer to «2» lands while the line is at 3: three units' worth of discount, not two.
    first(serverCart([line('srv-1', 100, 349, 2, 69.8)]))
    await tick()
    expect(item(m, 'srv-1')).toMatchObject({ quantity: 3, discount: 104.7 })
    await m.waitForCartMutations(SPONSOR)
    expect(item(m, 'srv-1')).toMatchObject({ quantity: 3, discount: 104.7 })
  })
})

describe('a gift is one unit', () => {
  async function withGift(): Promise<CartManager> {
    const m = await withCream()
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 1, 0), line('srv-2', 421306, 52, 1, 52)]))
    return m
  }

  it('it is not raised: «+» (adjustQuantity / updateQuantity) changes nothing and sends nothing', async () => {
    const m = await withGift()
    const changes = vi.fn()
    m.addEventListener('change', changes)
    m.adjustQuantity('srv-2', SPONSOR, +1)
    m.updateQuantity('srv-2', SPONSOR, 5)
    await m.waitForCartMutations(SPONSOR)
    expect(item(m, 'srv-2')).toMatchObject({ quantity: 1, discount: 52 })
    expect(gql.updateItem).not.toHaveBeenCalled()
    expect(changes).not.toHaveBeenCalled()
  })

  it('adding the same product again changes nothing either (Commerce would refuse to be paid for two)', async () => {
    const m = await withGift()
    const added = m.addManual({ productId: 421306, sponsorId: SPONSOR, brand: 'Faves', name: 'P421306', unitPrice: 52, currency: 'NOK', imageUrl: '' })
    await m.waitForCartMutations(SPONSOR)
    expect(added.id).toBe('srv-2')
    expect(item(m, 'srv-2')?.quantity).toBe(1)
    expect(gql.addItem).toHaveBeenCalledTimes(1) // the cream's, long ago
  })

  it('it can be taken out, and every other line is raised as always', async () => {
    const m = await withGift()
    gql.updateItem.mockResolvedValueOnce(serverCart([line('srv-1', 100, 349, 2, 0), line('srv-2', 421306, 52, 1, 52)]))
    m.adjustQuantity('srv-1', SPONSOR, +1)
    await m.waitForCartMutations(SPONSOR)
    expect(item(m, 'srv-1')?.quantity).toBe(2)

    gql.deleteItem.mockResolvedValueOnce(serverCart([line('srv-1', 100, 349, 2, 0)]))
    m.removeItem('srv-2', SPONSOR)
    await m.waitForCartMutations(SPONSOR)
    expect(item(m, 'srv-2')).toBeUndefined()
    expect(gql.deleteItem).toHaveBeenCalledTimes(1)
  })

  it('a gift line that somehow has two units can still come down to one', async () => {
    const m = await withCream()
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 1, 0), line('srv-2', 421306, 52, 2, 104)]))
    gql.updateItem.mockResolvedValueOnce(serverCart([line('srv-1', 100, 349, 1, 0), line('srv-2', 421306, 52, 1, 52)]))
    m.adjustQuantity('srv-2', SPONSOR, -1)
    expect(item(m, 'srv-2')).toMatchObject({ quantity: 1, discount: 52 })
    await m.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(1)
  })
})

describe('vio:cart-updated says the discount', () => {
  function events() {
    const seen: CartUpdatedDetail[] = []
    const on = (e: Event) => seen.push((e as CustomEvent<CartUpdatedDetail>).detail)
    document.addEventListener('vio:cart-updated', on)
    return { seen, off: () => document.removeEventListener('vio:cart-updated', on) }
  }

  it('subtotal stays the list prices; discount and discountCode come with a code', async () => {
    const m = await withCream()
    m.updateFromBackendCart(SPONSOR, { ...serverCart([line('srv-1', 100, 349, 1, 0)]), discount_code: 'gratis_face_mask' } as never)
    gql.getCart.mockResolvedValueOnce({
      ...serverCart([line('srv-1', 100, 349, 1, 0), line('srv-2', 421306, 52, 1, 52)]),
      discount_code: 'gratis_face_mask',
    })
    const e = events()
    await m.refreshFromServer(SPONSOR)
    e.off()
    expect(e.seen).toHaveLength(1)
    expect(e.seen[0]).toMatchObject({ subtotal: 401, discount: 52, discountCode: 'gratis_face_mask', itemCount: 2 })
    expect(e.seen[0]!.items.map((i) => i.discount)).toEqual([undefined, 52])
  })

  it('without a code the detail is the one it always was', async () => {
    const m = await withCream()
    gql.getCart.mockResolvedValueOnce(serverCart([line('srv-1', 100, 349, 1, 0)]))
    const e = events()
    await m.refreshFromServer(SPONSOR)
    e.off()
    expect(Object.keys(e.seen[0]!).sort()).toEqual(['cartId', 'currency', 'itemCount', 'items', 'source', 'sponsorId', 'subtotal'])
    expect(e.seen[0]!.subtotal).toBe(349)
  })
})

describe('a cart without discounts', () => {
  it('is, key for key, the cart it always was — in memory and in storage', async () => {
    const m = await withCream(2)
    m.updateFromBackendCart(SPONSOR, serverCart([line('srv-1', 100, 349, 2, 0), line('srv-2', 101, 52, 1)]))
    for (const i of m.getCart(SPONSOR)!.items) expect(i).not.toHaveProperty('discount')
    expect(m.subtotalForSponsor(SPONSOR)).toBe(750)
    expect(m.totalForSponsor(SPONSOR)).toBe(750)
    expect(m.totalAcrossSponsors).toBe(750)
    expect(m.discountForSponsor(SPONSOR)).toBe(0)
    const stored = JSON.parse(ensureLocalStorage().getItem(cartStorageKey('')) ?? '{}')
    expect(JSON.stringify(stored)).not.toMatch(/discount|gifts/)
  })
})
