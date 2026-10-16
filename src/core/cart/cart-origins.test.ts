/**
 * Cart origins (ADR-0034): every unit in the cart remembers where it came
 * from — campaign, slot, content — so the purchase can be split per campaign.
 * Runs the real CartManager with the backend sync switched off (no commerce
 * key resolved → the cart stays local, as on a page without bootstrap).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: false })),
}))

import {
  CartManager,
  addOriginQuantity,
  lineOrigins,
  normalizeOrigin,
  reconciledOrigins,
  removeOriginQuantity,
  sameOrigin,
} from './cart-manager.js'
import type { CartLineItem } from './types.js'

const SPONSOR = 5
const HERO = { campaignId: 12, slot: 'hero', contentId: 'article-1' }
const SIDEBAR = { campaignId: 10, slot: 'sidebar', contentId: 'article-1' }

let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const lamp = (cart: CartManager, quantity: number, origin?: Record<string, unknown>) =>
  cart.addManual({
    productId: 9,
    sponsorId: SPONSOR,
    brand: 'SINDIG',
    name: 'Morris',
    unitPrice: 100,
    currency: 'NOK',
    imageUrl: '',
    quantity,
    origin,
  })

const originsOf = (cart: CartManager) => cart.getCart(SPONSOR)!.items[0]!.origins

describe('origins accumulate per add', () => {
  it('a new line starts with the add origin and its quantity', () => {
    const cart = new CartManager()
    lamp(cart, 2, HERO)
    expect(originsOf(cart)).toEqual([{ ...HERO, quantity: 2 }])
  })

  it('the same origin again bumps its quantity; another origin is a new entry, most recent last', () => {
    const cart = new CartManager()
    lamp(cart, 1, HERO)
    lamp(cart, 2, SIDEBAR)
    lamp(cart, 1, HERO)
    expect(cart.getCart(SPONSOR)!.items[0]!.quantity).toBe(4)
    // HERO moved to the end: it is the most recent origin now.
    expect(originsOf(cart)).toEqual([
      { ...SIDEBAR, quantity: 2 },
      { ...HERO, quantity: 2 },
    ])
  })

  it('an add without origin goes to the most recent origin, or to an empty one', () => {
    const cart = new CartManager()
    lamp(cart, 1, HERO)
    lamp(cart, 1)
    expect(originsOf(cart)).toEqual([{ ...HERO, quantity: 2 }])

    store.clear() // a fresh browser, not the cart persisted just above
    const plain = new CartManager()
    lamp(plain, 2)
    expect(originsOf(plain)).toEqual([{ quantity: 2 }])
  })

  it('+1 through adjustQuantity with an origin lands on that origin; without, on the most recent', () => {
    const cart = new CartManager()
    const line = lamp(cart, 1, HERO)
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: SIDEBAR })
    cart.adjustQuantity(line.id, SPONSOR, +1)
    expect(originsOf(cart)).toEqual([
      { ...HERO, quantity: 1 },
      { ...SIDEBAR, quantity: 2 },
    ])
  })

  it('keeps only campaignId / slot / contentId of whatever attribution it is handed', () => {
    const cart = new CartManager()
    lamp(cart, 1, { ...HERO, sponsorId: 5, contentTitle: 'x', campaignId: '12' })
    expect(originsOf(cart)).toEqual([{ ...HERO, quantity: 1 }])
    expect(normalizeOrigin({ campaignId: 'nope' as never, slot: '  ', contentId: 7 as never })).toEqual({ contentId: '7' })
    expect(sameOrigin({}, {})).toBe(true)
    expect(sameOrigin(HERO, { ...HERO, contentId: 'other' })).toBe(false)
  })
})

describe('decrements come off the most recent origin first', () => {
  it('-1 and removal', () => {
    const cart = new CartManager()
    const line = lamp(cart, 2, HERO)
    lamp(cart, 2, SIDEBAR)
    cart.adjustQuantity(line.id, SPONSOR, -1)
    expect(originsOf(cart)).toEqual([
      { ...HERO, quantity: 2 },
      { ...SIDEBAR, quantity: 1 },
    ])
    cart.adjustQuantity(line.id, SPONSOR, -2)
    expect(originsOf(cart)).toEqual([{ ...HERO, quantity: 1 }])
    cart.updateQuantity(line.id, SPONSOR, 0)
    expect(cart.getCart(SPONSOR)).toBeUndefined()
  })

  it('the pure helpers agree', () => {
    const line: Pick<CartLineItem, 'origins'> = { origins: [] }
    addOriginQuantity(line, HERO, 2)
    addOriginQuantity(line, SIDEBAR, 1)
    addOriginQuantity(line, undefined, 1)
    expect(line.origins).toEqual([
      { ...HERO, quantity: 2 },
      { ...SIDEBAR, quantity: 2 },
    ])
    removeOriginQuantity(line, 3)
    expect(line.origins).toEqual([{ ...HERO, quantity: 1 }])
    removeOriginQuantity(line, 5)
    expect(line.origins).toEqual([])
  })
})

describe('persistence', () => {
  it('round-trips the origins with the cart state', () => {
    const cart = new CartManager()
    lamp(cart, 1, HERO)
    lamp(cart, 2, SIDEBAR)
    const again = new CartManager()
    expect(again.getCart(SPONSOR)!.items[0]!.origins).toEqual([
      { ...HERO, quantity: 1 },
      { ...SIDEBAR, quantity: 2 },
    ])
  })

  it('tolerates a cart persisted before origins existed', () => {
    store.set(
      'vio.cart.v1',
      JSON.stringify({
        [SPONSOR]: {
          sponsorId: SPONSOR,
          currency: 'NOK',
          items: [{ id: 'old-1', productId: 9, sponsorId: SPONSOR, brand: '', name: 'Old', unitPrice: 50, currency: 'NOK', imageUrl: '', quantity: 3 }],
        },
      }),
    )
    const cart = new CartManager()
    const line = cart.getCart(SPONSOR)!.items[0]!
    expect(line.origins).toBeUndefined()
    // Reporting fills the gap with an empty origin for the whole quantity…
    expect(lineOrigins(line)).toEqual([{ quantity: 3 }])
    // …and a new add starts tracking from there.
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: HERO })
    expect(line.origins).toEqual([{ ...HERO, quantity: 1 }])
    expect(lineOrigins(line)).toEqual([{ ...HERO, quantity: 1 }, { quantity: 3 }])
    cart.adjustQuantity(line.id, SPONSOR, -1)
    expect(lineOrigins(line)).toEqual([{ quantity: 3 }])
  })
})

describe('a quantity the server answers squares the origins', () => {
  it('reconciledOrigins adds the difference to the most recent origin and removes from it first', () => {
    const origins = [
      { ...HERO, quantity: 2 },
      { ...SIDEBAR, quantity: 1 },
    ]
    expect(reconciledOrigins(origins, 5)).toEqual([
      { ...HERO, quantity: 2 },
      { ...SIDEBAR, quantity: 3 },
    ])
    expect(reconciledOrigins(origins, 1)).toEqual([{ ...HERO, quantity: 1 }])
    expect(reconciledOrigins(origins, 3)).toEqual(origins)
    expect(reconciledOrigins(undefined, 3)).toBeUndefined()
    // Never mutates its input.
    expect(origins[1]!.quantity).toBe(1)
  })

  it('updateFromBackendCart keeps the local origins of a matched line, clamped to the server quantity', () => {
    const cart = new CartManager()
    lamp(cart, 2, HERO)
    lamp(cart, 2, SIDEBAR)
    cart.updateFromBackendCart(SPONSOR, {
      cart_id: 'cart-1',
      currency: 'NOK',
      line_items: [{ id: 'srv-1', product_id: 9, title: 'Morris', quantity: 3, price: { amount: 100, currency_code: 'NOK' } }],
    })
    const line = cart.getCart(SPONSOR)!.items[0]!
    expect(line.cartItemId).toBe('srv-1')
    expect(line.quantity).toBe(3)
    expect(line.origins).toEqual([
      { ...HERO, quantity: 2 },
      { ...SIDEBAR, quantity: 1 },
    ])
  })
})
