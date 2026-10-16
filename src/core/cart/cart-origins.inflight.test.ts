/**
 * W1: a backend answer that arrives while other Add/Update mutations are still
 * in flight carries a quantity that is already old. It must not rewrite the
 * origins (an add from `hero` then one from `carousel-1`, answered one at a
 * time, used to end with both units credited to `hero`), and a rejected add
 * is reverted from the origin that failed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(async () => ({ cart_id: 'cart-1', line_items: [] })),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
}))

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { CartManager, lineOrigins } from './cart-manager.js'

const SPONSOR = 5
const HERO = { campaignId: 12, slot: 'hero', contentId: 'art-1' }
const CAROUSEL = { campaignId: 10, slot: 'carousel-1', contentId: 'art-1' }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const serverCart = (quantity: number) => ({
  cart_id: 'cart-1',
  currency: 'NOK',
  line_items: [{ id: 'srv-1', product_id: 9, title: 'Morris', quantity, price: { amount: 100, currency_code: 'NOK' } }],
})

const lamp = (cart: CartManager, origin: Record<string, unknown>) =>
  cart.addManual({ productId: 9, sponsorId: SPONSOR, brand: 'S', name: 'Morris', unitPrice: 100, currency: 'NOK', imageUrl: '', origin })

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.stubGlobal('localStorage', undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  gql.addItem.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('origins while mutations are in flight', () => {
  it('two adds answered one at a time keep one unit per origin', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    gql.addItem.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const cart = new CartManager()
    lamp(cart, HERO)
    lamp(cart, CAROUSEL)
    const line = () => cart.getCart(SPONSOR)!.items[0]!
    expect(line().quantity).toBe(2)

    first.resolve(serverCart(1)) // the server only knows about the first unit yet
    await flush()
    await flush()
    expect(line().origins).toEqual([
      { ...HERO, quantity: 1 },
      { ...CAROUSEL, quantity: 1 },
    ])
    // Reporting never over-counts while the quantity is transiently behind.
    expect(lineOrigins(line()).reduce((n, o) => n + o.quantity, 0)).toBe(line().quantity)

    second.resolve(serverCart(2))
    await cart.waitForCartMutations(SPONSOR)
    expect(line().quantity).toBe(2)
    expect(line().origins).toEqual([
      { ...HERO, quantity: 1 },
      { ...CAROUSEL, quantity: 1 },
    ])
  })

  it('a rejected add is reverted from the origin that failed, not from the most recent', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    gql.addItem.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const cart = new CartManager()
    lamp(cart, HERO)
    lamp(cart, CAROUSEL)
    first.reject(new Error('out of stock'))
    await flush()
    await flush()
    const line = cart.getCart(SPONSOR)!.items[0]!
    expect(line.quantity).toBe(1)
    expect(line.origins).toEqual([{ ...CAROUSEL, quantity: 1 }])
    second.resolve(serverCart(1))
    await cart.waitForCartMutations(SPONSOR)
    expect(cart.getCart(SPONSOR)!.items[0]!.origins).toEqual([{ ...CAROUSEL, quantity: 1 }])
  })

  it('once nothing is in flight, a quiet refresh squares the origins with the server', async () => {
    gql.addItem.mockResolvedValue(serverCart(1))
    const cart = new CartManager()
    lamp(cart, HERO)
    await cart.waitForCartMutations(SPONSOR)
    cart.adjustQuantity(cart.getCart(SPONSOR)!.items[0]!.id, SPONSOR, +1, { origin: CAROUSEL })
    await cart.waitForCartMutations(SPONSOR)
    // Stock clamp answered later, with nothing pending.
    cart.updateFromBackendCart(SPONSOR, serverCart(1))
    expect(cart.getCart(SPONSOR)!.items[0]!.origins).toEqual([{ ...HERO, quantity: 1 }])
  })
})
