// @vitest-environment jsdom
/**
 * The «før-pris» of a cart line (`compareAtPrice`): what one unit cost before
 * the shop's own price cut. The page knows it when the product is added;
 * Commerce says it again with every answer about the cart, and that is the
 * word that stays — a cut that ended goes with it. It never changes what the
 * line costs.
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

import { CartManager } from './cart-manager.js'
import { ensureLocalStorage } from './storage.testutil.js'
import type { Product } from '../types.js'

const SPONSOR = 5

const price = (extra: Record<string, unknown> = {}) => ({
  amount: 115.15,
  amount_incl_taxes: 143.94,
  currency_code: 'NOK',
  ...extra,
})
const CUT = { compare_at: 191.92, compare_at_incl_taxes: 239.9 }
const serverLine = (p: Record<string, unknown> | null, quantity = 1) => ({
  id: 'srv-1',
  product_id: 416094,
  title: 'Sun Face Cream',
  quantity,
  ...(p ? { price: p } : {}),
})
const serverCart = (...lines: Array<ReturnType<typeof serverLine>>) => ({ cart_id: 'cart-1', currency: 'NOK', line_items: lines })

const PRODUCT = (p: Record<string, unknown>, variants: unknown[] = []) =>
  ({ id: 416094, title: 'Sun Face Cream', brand: 'Cosmica', price: p, images: [], variants, options: [] }) as unknown as Product

const only = (m: CartManager) => m.getCart(SPONSOR)!.items[0]!

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

describe('adding a product', () => {
  it('a product with a «før-pris» above its price: the line keeps it', async () => {
    const m = new CartManager()
    gql.addItem.mockResolvedValueOnce(serverCart(serverLine(price(CUT))))
    const line = m.addProduct({ product: PRODUCT(price(CUT)), sponsorId: SPONSOR })
    expect(line.unitPrice).toBe(143.94)
    expect(line.compareAtPrice).toBe(239.9)
    await m.waitForCartMutations(SPONSOR)
    expect(only(m).compareAtPrice).toBe(239.9)
    expect(only(m).unitPrice).toBe(143.94)
  })

  it('the variant’s own «før-pris», not the product’s', async () => {
    const m = new CartManager()
    gql.addItem.mockResolvedValueOnce(serverCart(serverLine(null)))
    const variant = { id: 9, title: '100 ml', price: price({ amount_incl_taxes: 199, compare_at_incl_taxes: 299 }), images: [] }
    const line = m.addProduct({ product: PRODUCT(price(CUT), [variant]), sponsorId: SPONSOR, variantId: 9 })
    expect(line.unitPrice).toBe(199)
    expect(line.compareAtPrice).toBe(299)
    await m.waitForCartMutations(SPONSOR)
  })

  it('a product without one, or with one that is not above the price: none on the line', async () => {
    for (const p of [price(), price({ compare_at: 0, compare_at_incl_taxes: 0 }), price({ compare_at_incl_taxes: 143.94 })]) {
      ensureLocalStorage().clear()
      const m = new CartManager()
      gql.addItem.mockResolvedValueOnce(serverCart(serverLine(p)))
      const line = m.addProduct({ product: PRODUCT(p), sponsorId: SPONSOR })
      expect('compareAtPrice' in line).toBe(false)
      await m.waitForCartMutations(SPONSOR)
      expect('compareAtPrice' in only(m)).toBe(false)
    }
  })

  it('a host’s own line (`addManual`) may say it too', async () => {
    const m = new CartManager()
    gql.addItem.mockResolvedValueOnce(serverCart(serverLine(null)))
    const line = m.addManual({
      productId: 416094,
      sponsorId: SPONSOR,
      brand: 'Cosmica',
      name: 'Sun Face Cream',
      unitPrice: 143.94,
      compareAtPrice: 239.9,
      currency: 'NOK',
      imageUrl: '',
    })
    expect(line.compareAtPrice).toBe(239.9)
    await m.waitForCartMutations(SPONSOR)
  })
})

describe('what Commerce says of the cart', () => {
  it('a line added without one gets the «før-pris» Commerce answers', async () => {
    const m = new CartManager()
    gql.addItem.mockResolvedValueOnce(serverCart(serverLine(price(CUT))))
    const line = m.addProduct({ product: PRODUCT(price()), sponsorId: SPONSOR })
    expect('compareAtPrice' in line).toBe(false)
    await m.waitForCartMutations(SPONSOR)
    expect(only(m).compareAtPrice).toBe(239.9)
  })

  it('a cut that ended: the «før-pris» goes when Commerce no longer says it', async () => {
    const m = new CartManager()
    gql.addItem.mockResolvedValueOnce(serverCart(serverLine(price(CUT))))
    m.addProduct({ product: PRODUCT(price(CUT)), sponsorId: SPONSOR })
    await m.waitForCartMutations(SPONSOR)
    expect(only(m).compareAtPrice).toBe(239.9)

    m.updateFromBackendCart(SPONSOR, serverCart(serverLine(price({ amount_incl_taxes: 239.9, compare_at: 0, compare_at_incl_taxes: 0 }))))
    expect(only(m).unitPrice).toBe(239.9)
    expect('compareAtPrice' in only(m)).toBe(false)
  })

  it('an answer without a price keeps the line’s own', async () => {
    const m = new CartManager()
    gql.addItem.mockResolvedValueOnce(serverCart(serverLine(null)))
    m.addProduct({ product: PRODUCT(price(CUT)), sponsorId: SPONSOR })
    await m.waitForCartMutations(SPONSOR)
    expect(only(m).unitPrice).toBe(143.94)
    expect(only(m).compareAtPrice).toBe(239.9)
  })

  it('it is kept with the cart across a reload', async () => {
    const m = new CartManager()
    gql.addItem.mockResolvedValueOnce(serverCart(serverLine(price(CUT))))
    m.addProduct({ product: PRODUCT(price(CUT)), sponsorId: SPONSOR })
    await m.waitForCartMutations(SPONSOR)

    const reloaded = new CartManager()
    expect(only(reloaded).compareAtPrice).toBe(239.9)
  })

  it('it never changes what the cart costs', async () => {
    const m = new CartManager()
    gql.addItem.mockResolvedValueOnce(serverCart(serverLine(price(CUT), 2)))
    m.addProduct({ product: PRODUCT(price(CUT)), sponsorId: SPONSOR, quantity: 2 })
    await m.waitForCartMutations(SPONSOR)
    expect(m.subtotalForSponsor(SPONSOR)).toBeCloseTo(287.88, 2)
    expect(m.totalForSponsor(SPONSOR)).toBeCloseTo(287.88, 2)
  })
})
