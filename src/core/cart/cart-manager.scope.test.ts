// @vitest-environment jsdom
/**
 * One cart per connection (2026-10-28). Every connection of a site used to share
 * `vio.cart.v1`, and every tab adopted what the others wrote: with two tabs on
 * two connections (Replit's admin with Staging and Prod side by side) one tab
 * took the other's cart for a moment. Now each connection — environment + key —
 * keeps its own entry, a tab only listens to its own, and `Vio.init` with
 * another key switches `Vio.cart` to that connection's carts.
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

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { CART_STORAGE_PREFIX, CartManager, cartScopeOf, cartStorageKey } from './cart-manager.js'
import { ensureLocalStorage } from './storage.testutil.js'
import { Vio } from '../client.js'

const SPONSOR = 5
const storage = ensureLocalStorage()
const STAGING = cartScopeOf('testing', 'key-staging')
const PROD = cartScopeOf('production', 'key-prod')

function add(m: CartManager, productId: number, name: string): void {
  m.addManual({ productId, sponsorId: SPONSOR, brand: 'Careless', name, unitPrice: 100, currency: 'NOK', imageUrl: '' })
}
const names = (m: CartManager) => m.getCart(SPONSOR)?.items.map((i) => i.name) ?? []
const stored = (scope: string) => JSON.parse(storage.getItem(cartStorageKey(scope)) ?? '{}')

beforeEach(() => {
  storage.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('the scope of a connection', () => {
  it('is the environment and a hash of the key — never the key', () => {
    expect(STAGING).toMatch(/^testing:[0-9a-f]{8}$/)
    expect(STAGING).not.toContain('key-staging')
    expect(cartScopeOf('testing', 'key-staging')).toBe(STAGING)
    expect(cartScopeOf('production', 'key-staging')).not.toBe(STAGING)
    expect(cartStorageKey('')).toBe(CART_STORAGE_PREFIX)
    expect(cartStorageKey(PROD)).toBe(`${CART_STORAGE_PREFIX}:${PROD}`)
  })
})

describe('two connections in two tabs', () => {
  it('keep their carts apart, and a tab ignores the other connection’s writes', () => {
    const staging = new CartManager(STAGING)
    const prod = new CartManager(PROD)
    add(staging, 1, 'Sofie genser (QA)')
    add(prod, 2, 'Vilde genser')
    // The browser tells every other tab about each write.
    window.dispatchEvent(new StorageEvent('storage', { key: cartStorageKey(STAGING) }))
    window.dispatchEvent(new StorageEvent('storage', { key: cartStorageKey(PROD) }))
    expect(names(staging)).toEqual(['Sofie genser (QA)'])
    expect(names(prod)).toEqual(['Vilde genser'])
    expect(Object.keys(stored(STAGING))).toEqual([String(SPONSOR)])
    expect(stored(PROD)[SPONSOR].items.map((i: { name: string }) => i.name)).toEqual(['Vilde genser'])
    expect(storage.getItem(CART_STORAGE_PREFIX)).toBeNull()
  })
})

describe('the carts kept before (shared entry)', () => {
  it('move once to the first connection that opens with none, and only to it', () => {
    const before = new CartManager() // an SDK before this change: the shared entry
    add(before, 3, 'Hennie cardigan')
    expect(storage.getItem(CART_STORAGE_PREFIX)).not.toBeNull()

    const prod = new CartManager(PROD)
    expect(names(prod)).toEqual(['Hennie cardigan'])
    expect(storage.getItem(CART_STORAGE_PREFIX)).toBeNull()
    expect(names(new CartManager(STAGING))).toEqual([])
  })

  it('never over a connection that already has carts of its own', () => {
    const prod = new CartManager(PROD)
    add(prod, 2, 'Vilde genser')
    add(new CartManager(), 3, 'From the shared entry')
    expect(names(new CartManager(PROD))).toEqual(['Vilde genser'])
  })
})

describe('Vio.cart across Vio.init', () => {
  it('switches to the new connection’s carts, tells its listeners, and comes back to the first', () => {
    storage.setItem(cartStorageKey(cartScopeOf('testing', 'key-a')), JSON.stringify({
      [SPONSOR]: { sponsorId: SPONSOR, currency: 'NOK', items: [{ productId: 1, sponsorId: SPONSOR, name: 'A', brand: 'x', unitPrice: 1, quantity: 1, currency: 'NOK', imageUrl: '' }] },
    }))
    storage.setItem(cartStorageKey(cartScopeOf('testing', 'key-b')), JSON.stringify({
      [SPONSOR]: { sponsorId: SPONSOR, currency: 'NOK', items: [{ productId: 2, sponsorId: SPONSOR, name: 'B', brand: 'x', unitPrice: 1, quantity: 2, currency: 'NOK', imageUrl: '' }] },
    }))
    Vio.init({ apiKey: 'key-a', environment: 'testing' })
    expect(Vio.cart.getCart(SPONSOR)?.items.map((i) => i.name)).toEqual(['A'])

    const change = vi.fn()
    Vio.cart.addEventListener('change', change)
    Vio.init({ apiKey: 'key-b', environment: 'testing' })
    expect(Vio.cart.getCart(SPONSOR)?.items.map((i) => i.name)).toEqual(['B'])
    expect(Vio.cart.itemCount).toBe(2)
    expect(change).toHaveBeenCalledTimes(1)

    Vio.init({ apiKey: 'key-a', environment: 'testing' })
    expect(Vio.cart.getCart(SPONSOR)?.items.map((i) => i.name)).toEqual(['A'])
    Vio.cart.removeEventListener('change', change)
  })

  it('an answer for the connection left behind lands in ITS cart, silently — never in the new one', async () => {
    Vio.init({ apiKey: 'key-old', environment: 'testing' })
    let answer!: (v: unknown) => void
    gql.createCart.mockImplementationOnce(() => new Promise((r) => (answer = r)))
    gql.addItem.mockResolvedValue({
      cart_id: 'cart-old', currency: 'NOK',
      line_items: [{ id: 'l1', product_id: 9, title: 'Old', quantity: 1, price: { amount: 100, amount_incl_taxes: 100, currency_code: 'NOK' } }],
    })
    const pending = Vio.cart.ensureCartId(SPONSOR)
    for (let i = 0; i < 20 && !answer; i++) await new Promise((r) => setTimeout(r, 0))
    expect(typeof answer).toBe('function') // the request is out, for the old connection
    Vio.init({ apiKey: 'key-new', environment: 'testing' })
    const updated = vi.fn()
    document.addEventListener('vio:cart-updated', updated)
    answer({ cart_id: 'cart-old', line_items: [] })
    await pending.catch(() => undefined)
    await new Promise((r) => setTimeout(r, 0))
    document.removeEventListener('vio:cart-updated', updated)
    expect(Vio.cart.getCart(SPONSOR)?.cartId).toBeUndefined()
    expect(stored(cartScopeOf('testing', 'key-new'))[SPONSOR]?.cartId).toBeUndefined()
    expect(updated).not.toHaveBeenCalled()
  })
})
