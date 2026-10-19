/**
 * ADR-0035 phase B: the origins the cart keeps per line reach Commerce.
 * `AddItem` carries `origin` on the line; an increase carries the origin of
 * the units it adds on `UpdateItem`; a decrease and a removal carry none;
 * an add without an origin sends none. Runs the real CartManager over a
 * mocked gateway.
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

import { CartManager } from './cart-manager.js'

const SPONSOR = 5
const HERO = { campaignId: 12, slot: 'hero', contentId: 'art-1', componentKind: 'card' }
const CAROUSEL = { campaignId: 10, slot: 'carousel-1', contentId: 'art-1', componentKind: 'carousel' }
const PAGE = 'https://host.example/article?x=1'

const serverCart = (quantity: number) => ({
  cart_id: 'cart-1',
  currency: 'NOK',
  line_items: [{ id: 'srv-1', product_id: 9, title: 'Morris', quantity, price: { amount: 100, currency_code: 'NOK' } }],
})

const lamp = (cart: CartManager, origin?: Record<string, unknown>, quantity = 1) =>
  cart.addManual({ productId: 9, sponsorId: SPONSOR, brand: 'S', name: 'Morris', unitPrice: 100, currency: 'NOK', imageUrl: '', quantity, origin })

const flush = () => new Promise((r) => setTimeout(r, 0))

const sentLine = (i = 0) => (gql.addItem.mock.calls[i]![1] as Array<Record<string, unknown>>)[0]!
const lastUpdate = () => gql.updateItem.mock.calls.at(-1)!

beforeEach(() => {
  vi.stubGlobal('localStorage', undefined)
  vi.stubGlobal('location', { href: PAGE, pathname: '/article', search: '?x=1' })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  gql.addItem.mockReset().mockImplementation(async () => serverCart(1))
  gql.updateItem.mockReset().mockImplementation(async (_c: string, _i: string, _s: unknown, qty: number) => serverCart(qty))
  gql.deleteItem.mockReset().mockImplementation(async () => ({ cart_id: 'cart-1', line_items: [] }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AddItem carries the origin of the line', () => {
  it('as snake_case, with the page the units were added on', async () => {
    const cart = new CartManager()
    lamp(cart, HERO, 2)
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.addItem).toHaveBeenCalledTimes(1)
    expect(sentLine()).toEqual({
      product_id: 9,
      quantity: 2,
      variant_id: null,
      origin: { campaign_id: 12, location_id: 'hero', component_kind: 'card', content_url: PAGE },
    })
  })

  it('an element\'s attribution (componentTemplateId, contentUrl, contentTitle) is understood as an origin', async () => {
    const cart = new CartManager()
    lamp(cart, { ...HERO, componentKind: undefined, componentTemplateId: 'product-detail', contentUrl: 'https://host.example/then', contentTitle: 'Then' })
    await cart.waitForCartMutations(SPONSOR)
    expect(sentLine().origin).toEqual({
      campaign_id: 12,
      location_id: 'hero',
      component_kind: 'detail',
      content_url: 'https://host.example/then',
      content_title: 'Then',
    })
  })

  it('sends no origin when the host gave none', async () => {
    const cart = new CartManager()
    lamp(cart)
    await cart.waitForCartMutations(SPONSOR)
    expect(sentLine()).toEqual({ product_id: 9, quantity: 1, variant_id: null })
    expect(sentLine()).not.toHaveProperty('origin')
  })

  it('each add sends ITS origin — the second add of a line is another AddItem with another place', async () => {
    const cart = new CartManager()
    lamp(cart, HERO)
    await cart.waitForCartMutations(SPONSOR)
    gql.addItem.mockImplementation(async () => serverCart(2))
    lamp(cart, CAROUSEL)
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.addItem).toHaveBeenCalledTimes(2)
    expect(sentLine(0).origin).toMatchObject({ campaign_id: 12, location_id: 'hero' })
    expect(sentLine(1).origin).toMatchObject({ campaign_id: 10, location_id: 'carousel-1', component_kind: 'carousel' })
  })
})

describe('UpdateItem carries the origin of the units an increase adds', () => {
  /** A line synced with the backend: it goes by its backend id from then on. */
  async function synced(origin: Record<string, unknown> | null = HERO) {
    const cart = new CartManager()
    lamp(cart, origin ?? undefined)
    await cart.waitForCartMutations(SPONSOR)
    await flush()
    const line = cart.getCart(SPONSOR)!.items[0]!
    expect(line.cartItemId).toBe('srv-1')
    return { cart, line }
  }

  it('+1 with an origin: that origin', async () => {
    const { cart, line } = await synced()
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: CAROUSEL })
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(1)
    expect(lastUpdate().slice(0, 4)).toEqual(['cart-1', 'srv-1', null, 2])
    expect(lastUpdate()[5]).toEqual({
      origin: { campaign_id: 10, location_id: 'carousel-1', component_kind: 'carousel', content_url: PAGE },
    })
  })

  it('+1 without an origin: the most recent origin of the line (what the SDK credited the units to)', async () => {
    const { cart, line } = await synced()
    cart.adjustQuantity(line.id, SPONSOR, +1)
    await cart.waitForCartMutations(SPONSOR)
    expect(lastUpdate()[5]).toEqual({
      origin: { campaign_id: 12, location_id: 'hero', component_kind: 'card', content_url: PAGE },
    })
  })

  it('−1: no origin; 0: DeleteItem', async () => {
    const { cart, line } = await synced()
    gql.updateItem.mockImplementation(async (_c: string, _i: string, _s: unknown, qty: number) => serverCart(qty))
    cart.adjustQuantity(line.id, SPONSOR, +1)
    await cart.waitForCartMutations(SPONSOR)
    cart.adjustQuantity(line.id, SPONSOR, -1)
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(2)
    expect(lastUpdate().slice(0, 4)).toEqual(['cart-1', 'srv-1', null, 1])
    expect(lastUpdate()).toHaveLength(5)
    cart.removeItem(line.id, SPONSOR)
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.deleteItem).toHaveBeenCalledWith('cart-1', 'srv-1', expect.anything())
  })

  it('a line without any origin sends none on +1 either', async () => {
    const { cart, line } = await synced(null)
    cart.adjustQuantity(line.id, SPONSOR, +1)
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(1)
    expect(lastUpdate()).toHaveLength(5)
  })

  it('targets coalesced while one is in flight go out with the origin of the LAST intent', async () => {
    const { cart, line } = await synced()
    let release!: (v: unknown) => void
    gql.updateItem.mockImplementationOnce(() => new Promise((r) => (release = r)))
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: HERO }) // in flight: 2, hero
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: CAROUSEL }) // pending: 3, carousel
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: CAROUSEL }) // pending: 4, carousel
    await flush()
    expect(gql.updateItem).toHaveBeenCalledTimes(1)
    release(serverCart(2))
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(2)
    expect(lastUpdate()[3]).toBe(4)
    expect(lastUpdate()[5]).toEqual({ origin: expect.objectContaining({ campaign_id: 10, location_id: 'carousel-1' }) })
  })
})
