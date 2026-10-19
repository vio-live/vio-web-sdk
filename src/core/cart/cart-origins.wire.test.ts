/**
 * ADR-0035 phase B: the origins the cart keeps per line reach Commerce.
 * `AddItem` carries `origin` on the line; an increase carries the origin of
 * the units it adds on `UpdateItem` — one update per origin in a burst; a
 * decrease and a removal carry none; an add without an origin sends none;
 * on a `minimal` surface the slot and the page stay out. Runs the real
 * CartManager over a mocked gateway, with a facade stub for the privacy mode.
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
const HREF = 'https://host.example/article?x=1#top'
const PAGE = 'https://host.example/article'

const serverCart = (quantity: number) => ({
  cart_id: 'cart-1',
  currency: 'NOK',
  line_items: [{ id: 'srv-1', product_id: 9, title: 'Morris', quantity, price: { amount: 100, currency_code: 'NOK' } }],
})

const lamp = (cart: CartManager, origin?: Record<string, unknown>, quantity = 1) =>
  cart.addManual({ productId: 9, sponsorId: SPONSOR, brand: 'S', name: 'Morris', unitPrice: 100, currency: 'NOK', imageUrl: '', quantity, origin })

const flush = () => new Promise((r) => setTimeout(r, 0))

const sentLine = (i = 0) => (gql.addItem.mock.calls[i]![1] as Array<Record<string, unknown>>)[0]!
const update = (i: number) => gql.updateItem.mock.calls[i]!
const lastUpdate = () => gql.updateItem.mock.calls.at(-1)!

/** The facade as the cart sees it: the surface's privacy mode, preloaded. */
const facade = (privacyMode: 'standard' | 'minimal' | 'unknown') => vi.stubGlobal('__VIO_FACADE__', { privacyMode: async () => privacyMode })

beforeEach(() => {
  vi.stubGlobal('localStorage', undefined)
  vi.stubGlobal('location', { href: HREF, pathname: '/article', search: '?x=1' })
  facade('standard')
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
  it('as snake_case, with the page the units were added on — origin + path', async () => {
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

  it("an element's attribution (componentTemplateId, contentUrl, contentTitle) is understood as an origin", async () => {
    const cart = new CartManager()
    lamp(cart, { ...HERO, componentKind: undefined, componentTemplateId: 'product-detail', contentUrl: 'https://host.example/then?e=kari@example.no', contentTitle: 'Then' })
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

  it('on a minimal surface — or one whose mode is not known — neither the slot nor the page travel', async () => {
    for (const mode of ['minimal', 'unknown'] as const) {
      gql.addItem.mockClear()
      facade(mode)
      const cart = new CartManager()
      lamp(cart, { ...HERO, contentTitle: 'Why the lamp matters' })
      await cart.waitForCartMutations(SPONSOR)
      expect(sentLine().origin).toEqual({ campaign_id: 12, component_kind: 'card' })
    }
    // Without a facade at all: the same.
    vi.stubGlobal('__VIO_FACADE__', undefined)
    gql.addItem.mockClear()
    const cart = new CartManager()
    lamp(cart, HERO)
    await cart.waitForCartMutations(SPONSOR)
    expect(sentLine().origin).toEqual({ campaign_id: 12, component_kind: 'card' })
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

  it('on a minimal surface the increase names the campaign and the kind, nothing else', async () => {
    const { cart, line } = await synced()
    facade('minimal')
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: CAROUSEL })
    await cart.waitForCartMutations(SPONSOR)
    expect(lastUpdate()[5]).toEqual({ origin: { campaign_id: 10, component_kind: 'carousel' } })
  })

  it('−1: no origin; 0: DeleteItem', async () => {
    const { cart, line } = await synced()
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

  it('a cart persisted before 0.26 (origins without kind or page): +1 credits the slot, the kind word of its id and the current page', async () => {
    const store = new Map<string, string>([
      [
        'vio.cart.v1',
        JSON.stringify({
          [SPONSOR]: {
            sponsorId: SPONSOR,
            cartId: 'cart-1',
            currency: 'NOK',
            items: [
              {
                id: 'srv-1',
                cartItemId: 'srv-1',
                productId: 9,
                sponsorId: SPONSOR,
                brand: 'S',
                name: 'Morris',
                unitPrice: 100,
                currency: 'NOK',
                imageUrl: '',
                quantity: 1,
                origins: [{ campaignId: 12, slot: 'carousel-1', contentId: 'art-1', quantity: 1 }],
              },
            ],
          },
        }),
      ],
    ])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    const cart = new CartManager()
    cart.adjustQuantity('srv-1', SPONSOR, +1)
    await cart.waitForCartMutations(SPONSOR)
    expect(lastUpdate()[3]).toBe(2)
    expect(lastUpdate()[5]).toEqual({
      origin: { campaign_id: 12, location_id: 'carousel-1', component_kind: 'carousel', content_url: PAGE },
    })
    // A new add from the same place with a kind is another origin: the old one keeps its units.
    lamp(cart, CAROUSEL)
    expect(cart.getCart(SPONSOR)!.items[0]!.origins).toEqual([
      { campaignId: 12, slot: 'carousel-1', contentId: 'art-1', quantity: 2 },
      { ...CAROUSEL, quantity: 1 },
    ])
  })
})

describe('bursts while an update is in flight: one update per origin, in order', () => {
  async function inFlight() {
    const cart = new CartManager()
    lamp(cart, HERO)
    await cart.waitForCartMutations(SPONSOR)
    await flush()
    const line = cart.getCart(SPONSOR)!.items[0]!
    let release!: (v: unknown) => void
    gql.updateItem.mockImplementationOnce(() => new Promise((r) => (release = r)))
    return { cart, line, release: (qty: number) => release(serverCart(qty)) }
  }

  it('+1 hero in flight, then +1 carousel, +1 carousel, +1 hero: three more updates, each with its own origin', async () => {
    const { cart, line, release } = await inFlight()
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: HERO }) // in flight: 2, hero
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: CAROUSEL })
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: CAROUSEL })
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: HERO })
    await flush()
    expect(gql.updateItem).toHaveBeenCalledTimes(1)
    release(2)
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(3)
    expect(update(1)[3]).toBe(4)
    expect(update(1)[5]).toEqual({ origin: expect.objectContaining({ campaign_id: 10, location_id: 'carousel-1' }) })
    expect(update(2)[3]).toBe(5)
    expect(update(2)[5]).toEqual({ origin: expect.objectContaining({ campaign_id: 12, location_id: 'hero' }) })
    expect(cart.getCart(SPONSOR)!.items[0]!.quantity).toBe(5)
  })

  it('+1 hero in flight, then +1 carousel and −1: the carousel unit cancels, nothing more goes out, and hero keeps its origin', async () => {
    const { cart, line, release } = await inFlight()
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: HERO })
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: CAROUSEL })
    cart.adjustQuantity(line.id, SPONSOR, -1)
    await flush()
    release(2)
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(1)
    expect(update(0)[5]).toEqual({ origin: expect.objectContaining({ location_id: 'hero' }) })
    expect(cart.getCart(SPONSOR)!.items[0]!.quantity).toBe(2)
  })

  it('+1 hero in flight, then −2: one decrease below what is in flight, without origin', async () => {
    const { cart, line, release } = await inFlight()
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: HERO }) // 2 in flight
    cart.adjustQuantity(line.id, SPONSOR, -1)
    cart.adjustQuantity(line.id, SPONSOR, -1) // heading to 0
    await flush()
    release(2)
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(1)
    expect(gql.deleteItem).toHaveBeenCalledWith('cart-1', 'srv-1', expect.anything())
    expect(cart.getCart(SPONSOR)).toBeUndefined()
  })

  it('a decrease then an increase from another place: the decrease goes out without origin, the increase with its own', async () => {
    const { cart, line, release } = await inFlight()
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: HERO }) // 2 in flight
    cart.adjustQuantity(line.id, SPONSOR, -1) // back to 1
    cart.adjustQuantity(line.id, SPONSOR, +1, { origin: CAROUSEL }) // 2 again, from the carousel
    await flush()
    release(2)
    await cart.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(3)
    expect(update(1)[3]).toBe(1)
    expect(update(1)).toHaveLength(5)
    expect(update(2)[3]).toBe(2)
    expect(update(2)[5]).toEqual({ origin: expect.objectContaining({ location_id: 'carousel-1' }) })
  })
})
