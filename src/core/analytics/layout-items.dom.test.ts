// @vitest-environment jsdom
/**
 * The layout of `<vio-product-detail>` on the events with items (0.34): every
 * cart unit remembers the layout it was added under (its line origin), that
 * survives a reload, another tab and a later change of the page's layout, and
 * every item of add_to_cart / view_cart / begin_checkout / add_payment_info /
 * purchase says it — `layout_id`, `layout_revision`, `experiment_id`,
 * `experiment_variant_id` (`variant_id` stays the PRODUCT variant), `''` when
 * none. A line with units from two layouts is two items, never the whole
 * purchase credited to the last product opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: false })),
}))

import { Vio } from '../client.js'
import { CartManager, lineOrigins } from '../cart/cart-manager.js'
import { cartSlicesFrom } from '../cart/slices.js'
import { ensureLocalStorage } from '../cart/storage.testutil.js'
import { AnalyticsManager } from './analytics-manager.js'

const SPONSOR = 1327
const LAYOUT_A = { layoutId: 'pdp-a', layoutRevision: '3', experimentId: 'exp-7', variantId: 'A' }
const LAYOUT_B = { layoutId: 'pdp-b', layoutRevision: '1', experimentId: 'exp-7', variantId: 'B' }
const PLACE = { campaignId: 12, slot: 'hero', contentId: 'article-1', componentKind: 'detail' }

const storage = ensureLocalStorage()

type Wire = { name: string; commerce?: { items?: Array<Record<string, unknown>> }; context?: Record<string, unknown> }
let recorded: Wire[]
let analytics: AnalyticsManager
const onAnalytics = (e: Event) => recorded.push((e as CustomEvent).detail)

function sweater(cart: CartManager, quantity: number, origin?: Record<string, unknown>, variantId = 102) {
  cart.addManual({
    productId: 77,
    sponsorId: SPONSOR,
    variantId,
    brand: 'Careless',
    name: 'Vilde genser',
    unitPrice: 599,
    currency: 'NOK',
    imageUrl: '',
    quantity,
    origin,
  } as never)
}

function useCart(cart: CartManager) {
  vi.spyOn(Vio.cart, 'getAllCarts').mockImplementation(() => cart.getAllCarts())
}

beforeEach(() => {
  storage.clear()
  recorded = []
  Vio.init({ apiKey: 'test-key', environment: 'production' } as never)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}) }) as Response))
  window.addEventListener('vio:analytics', onAnalytics)
  analytics = new AnalyticsManager()
  analytics.start({ host: 'replit' })
})

afterEach(() => {
  analytics.stop()
  window.removeEventListener('vio:analytics', onAnalytics)
  Vio.configureDetail({ layout: null })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const itemsOf = (name: string) => recorded.filter((e) => e.name === name).flatMap((e) => e.commerce?.items ?? [])
const layoutOf = (item: Record<string, unknown>) => ({
  layout_id: item.layout_id,
  layout_revision: item.layout_revision,
  experiment_id: item.experiment_id,
  experiment_variant_id: item.experiment_variant_id,
})
const NONE = { layout_id: '', layout_revision: '', experiment_id: '', experiment_variant_id: '' }
const A = { layout_id: 'pdp-a', layout_revision: '3', experiment_id: 'exp-7', experiment_variant_id: 'A' }
const B = { layout_id: 'pdp-b', layout_revision: '1', experiment_id: 'exp-7', experiment_variant_id: 'B' }

describe('the line origin keeps the layout', () => {
  it('units added under two layouts stay two origins', () => {
    const cart = new CartManager()
    sweater(cart, 1, { ...PLACE, ...LAYOUT_A })
    sweater(cart, 2, { ...PLACE, ...LAYOUT_B })
    sweater(cart, 1, { ...PLACE, ...LAYOUT_A })
    expect(lineOrigins(cart.getCart(SPONSOR)!.items[0]!)).toEqual([
      { ...PLACE, ...LAYOUT_B, quantity: 2 },
      { ...PLACE, ...LAYOUT_A, quantity: 2 },
    ])
  })

  it('survives a reload, another tab and a later change of the page layout', () => {
    Vio.configureDetail({ layout: { id: 'pdp-a', revision: '3', sections: ['title', 'price', 'options', 'purchase'] } })
    const tab = new CartManager()
    sweater(tab, 1, { ...PLACE, ...LAYOUT_A })
    // The page moves on to another layout: lines already in the cart keep theirs.
    Vio.configureDetail({ layout: { id: 'pdp-z', revision: '9', sections: ['price', 'title', 'options', 'purchase'] } })
    const reloaded = new CartManager()
    expect(reloaded.getCart(SPONSOR)!.items[0]!.origins).toEqual([{ ...PLACE, ...LAYOUT_A, quantity: 1 }])
    const other = new CartManager()
    sweater(tab, 1, { ...PLACE, ...LAYOUT_B })
    window.dispatchEvent(new StorageEvent('storage', { key: 'vio.cart.v1', newValue: storage.getItem('vio.cart.v1') }))
    expect(other.getCart(SPONSOR)!.items[0]!.origins).toEqual([
      { ...PLACE, ...LAYOUT_A, quantity: 1 },
      { ...PLACE, ...LAYOUT_B, quantity: 1 },
    ])
  })

  it('an invalid layout on an origin is dropped, the rest of the origin kept', () => {
    const cart = new CartManager()
    sweater(cart, 1, { ...PLACE, layoutId: 'not valid!', layoutRevision: '1' })
    expect(cart.getCart(SPONSOR)!.items[0]!.origins).toEqual([{ ...PLACE, quantity: 1 }])
  })
})

describe('items say their layout', () => {
  it('two layouts in one line: split items on view_cart, begin_checkout, add_payment_info and purchase', async () => {
    const cart = new CartManager()
    sweater(cart, 1, { ...PLACE, ...LAYOUT_A })
    sweater(cart, 2, { ...PLACE, ...LAYOUT_B })
    // A reload (the return from Vipps): what the events read is the stored cart.
    const back = new CartManager()
    useCart(back)
    window.dispatchEvent(new CustomEvent('vio:open-cart'))
    window.dispatchEvent(new CustomEvent('vio:checkout-open', { detail: { sponsorId: SPONSOR } }))
    window.dispatchEvent(new CustomEvent('vio:checkout-created', { detail: { sponsorId: SPONSOR, checkoutId: 'chk-1', paymentMethod: 'vipps' } }))
    window.dispatchEvent(new CustomEvent('vio:payment-success', { detail: { sponsorId: SPONSOR, orderNumber: '4415', checkoutId: 'chk-1', method: 'vipps' } }))
    for (const name of ['view_cart', 'begin_checkout', 'add_payment_info', 'purchase']) {
      const items = itemsOf(name)
      expect(items, name).toHaveLength(2)
      // The product variant is untouched.
      expect(items.every((i) => i.variant_id === '102'), name).toBe(true)
      const byLayout = Object.fromEntries(items.map((i) => [i.layout_id, i]))
      expect(layoutOf(byLayout['pdp-a']!), name).toEqual(A)
      expect(byLayout['pdp-a']!.quantity, name).toBe(1)
      expect(layoutOf(byLayout['pdp-b']!), name).toEqual(B)
      expect(byLayout['pdp-b']!.quantity, name).toBe(2)
    }
  })

  it('purchase lines keep their own layout: two products, two layouts, one without', async () => {
    const cart = new CartManager()
    sweater(cart, 1, { ...PLACE, ...LAYOUT_A }, 101)
    sweater(cart, 1, { ...PLACE, ...LAYOUT_B }, 102)
    sweater(cart, 1, { ...PLACE }, 103)
    useCart(cart)
    window.dispatchEvent(new CustomEvent('vio:payment-success', { detail: { sponsorId: SPONSOR, orderNumber: '4416', checkoutId: 'chk-2' } }))
    const byVariant = Object.fromEntries(itemsOf('purchase').map((i) => [i.variant_id, layoutOf(i)]))
    expect(byVariant).toEqual({ '101': A, '102': B, '103': NONE })
  })

  it('several campaigns: each slice splits its lines per layout too', () => {
    const cart = new CartManager()
    sweater(cart, 1, { ...PLACE, ...LAYOUT_A })
    sweater(cart, 1, { ...PLACE, ...LAYOUT_B })
    sweater(cart, 1, { ...PLACE, campaignId: 13, ...LAYOUT_A })
    const slices = cartSlicesFrom(cart.getCart(SPONSOR)!.items, () => undefined)
    expect(slices).toHaveLength(2)
    expect(slices[0]!.items.map((i) => [i.layoutId, i.quantity])).toEqual([
      ['pdp-a', 1],
      ['pdp-b', 1],
    ])
    expect(slices[1]!.items.map((i) => [i.layoutId, i.experimentVariantId, i.quantity])).toEqual([['pdp-a', 'A', 1]])
    useCart(cart)
    window.dispatchEvent(new CustomEvent('vio:checkout-open', { detail: { sponsorId: SPONSOR } }))
    const begins = recorded.filter((e) => e.name === 'begin_checkout')
    expect(begins).toHaveLength(2)
    expect(begins.map((e) => e.commerce!.items!.map((i) => i.layout_id))).toEqual([['pdp-a', 'pdp-b'], ['pdp-a']])
  })

  it('a cart without layouts: every item says "" (nothing else changes)', () => {
    const cart = new CartManager()
    sweater(cart, 2, { ...PLACE })
    useCart(cart)
    window.dispatchEvent(new CustomEvent('vio:checkout-open', { detail: { sponsorId: SPONSOR } }))
    const [item] = itemsOf('begin_checkout')
    expect(layoutOf(item!)).toEqual(NONE)
    expect(item).toMatchObject({ product_id: '77', variant_id: '102', quantity: 2, price: 599 })
    // Vio.cartSlices() (hosts with their own sink) is unchanged for such a cart.
    expect(cartSlicesFrom(cart.getCart(SPONSOR)!.items, () => 12)[0]!.items[0]).not.toHaveProperty('layoutId')
  })

  it('add_to_cart: the layout of the add from vio:added-to-cart, "" without one', () => {
    const cart = new CartManager()
    sweater(cart, 1, { ...PLACE, ...LAYOUT_A })
    useCart(cart)
    window.dispatchEvent(
      new CustomEvent('vio:added-to-cart', { detail: { productId: 77, sponsorId: SPONSOR, variantId: 102, quantity: 1, layout: LAYOUT_A } }),
    )
    window.dispatchEvent(new CustomEvent('vio:added-to-cart', { detail: { productId: 77, sponsorId: SPONSOR, variantId: 102, quantity: 1 } }))
    const [withLayout, without] = itemsOf('add_to_cart')
    expect(layoutOf(withLayout!)).toEqual(A)
    expect(withLayout!.variant_id).toBe('102')
    expect(layoutOf(without!)).toEqual(NONE)
  })

  it('view_item: the layout as event context next to campaign_id / location_id', () => {
    analytics.track('view_item', {
      context: { campaignId: 12, slot: 'hero', layoutId: 'pdp-a', layoutRevision: '3', experimentId: 'exp-7', variantId: 'A' },
      commerce: { items: [{ productId: 77, price: 599 }] },
    })
    const [view] = recorded.filter((e) => e.name === 'view_item')
    expect(view!.context).toMatchObject({
      campaign_id: 12,
      location_id: 'hero',
      layout_id: 'pdp-a',
      layout_revision: '3',
      experiment_id: 'exp-7',
      variant_id: 'A',
    })
    // view_item's items are not cart lines: no layout keys on them.
    expect(view!.commerce!.items![0]).not.toHaveProperty('layout_id')
  })
})
