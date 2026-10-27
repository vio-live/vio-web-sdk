// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, settle, unmountAll } from '../test-harness.js'
import { Vio } from '../../core/client.js'

/**
 * The carousel's `component_impression` carries the products it shows in
 * `commerce.items` (ADR-0041 — the collector counts the per-product "saw"
 * step from them; Replit's own wrapper already sent them). While the products
 * load the impression is not observed: the 1 s dwell counts on what the reader
 * actually sees.
 */

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  disconnected = false
  constructor(private readonly cb: (entries: unknown[]) => void) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(): void {}
  disconnect(): void {
    this.disconnected = true
  }
  intersect(): void {
    this.cb([{ isIntersecting: true, intersectionRatio: 1 }])
  }
}

const products = [
  { id: 9, title: 'Sindig Morris bordlampe', price: { amount: 1699, currency_code: 'NOK' }, images: [], variants: [] },
  { id: 10, title: 'Sindig pendel', price: { amount: 2499, currency_code: 'NOK' }, images: [], variants: [] },
]

const events: Array<Record<string, any>> = []
const onAnalytics = (e: Event) => events.push((e as CustomEvent).detail)
let getByIds: ReturnType<typeof vi.fn>

beforeEach(() => {
  events.length = 0
  FakeIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  Vio.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
  getByIds = vi.fn().mockResolvedValue(products)
  vi.spyOn(Vio, 'commerceFor').mockReturnValue({ channel: { product: { getByIds } } } as any)
  window.addEventListener('vio:analytics', onAnalytics)
})

afterEach(() => {
  window.removeEventListener('vio:analytics', onAnalytics)
  unmountAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The last observer created enters the viewport and stays 1 s. */
function seenForOneSecond(): void {
  vi.useFakeTimers()
  FakeIntersectionObserver.instances.at(-1)!.intersect()
  vi.advanceTimersByTime(1_000)
  vi.useRealTimers()
}

const impressions = () => events.filter((e) => e.name === 'component_impression')
const productIdsOf = (ev: Record<string, any>) => ev.commerce?.items?.map((i: { product_id: string }) => i.product_id)

describe('vio-product-carousel — component_impression with commerce.items', () => {
  it('carries the products shown, with names, prices and currency, once', async () => {
    const el = await mount<HTMLElement>('vio-product-carousel', {
      productIds: '9,10',
      sponsorId: 4,
      vioSlot: 'imp-a',
    } as any)
    for (let i = 0; i < 3; i++) await settle(el)
    seenForOneSecond()

    expect(impressions()).toHaveLength(1)
    const ev = impressions()[0]!
    expect(ev.context).toMatchObject({ sponsor_id: 4, location_id: 'imp-a' })
    expect(ev.commerce).toEqual({
      items: [
        { product_id: '9', name: 'Sindig Morris bordlampe', price: 1699 },
        { product_id: '10', name: 'Sindig pendel', price: 2499 },
      ],
      currency: 'NOK',
    })
    // The companion view_item_list names the same products.
    const list = events.find((e) => e.name === 'view_item_list')!
    expect(productIdsOf(list)).toEqual(['9', '10'])
  })

  it('while the products load nothing is observed; the dwell starts once they are here', async () => {
    let resolve!: (value: unknown) => void
    getByIds.mockReturnValue(new Promise((r) => (resolve = r)))
    const el = await mount<HTMLElement>('vio-product-carousel', {
      productIds: '9,10',
      sponsorId: 4,
      vioSlot: 'imp-b',
    } as any)
    expect(FakeIntersectionObserver.instances).toHaveLength(0)

    resolve(products)
    for (let i = 0; i < 3; i++) await settle(el)
    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    seenForOneSecond()
    expect(impressions()).toHaveLength(1)
    expect(productIdsOf(impressions()[0]!)).toEqual(['9', '10'])
  })

  it('React-style (properties set after mount): the observer started empty is replaced and the impression has the products', async () => {
    const el = await mount<HTMLElement>('vio-product-carousel', { sponsorId: 4, vioSlot: 'imp-c' } as any)
    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    ;(el as any).productIds = '9,10'
    for (let i = 0; i < 3; i++) await settle(el)
    expect(FakeIntersectionObserver.instances[0]!.disconnected).toBe(true)
    expect(FakeIntersectionObserver.instances).toHaveLength(2)
    seenForOneSecond()
    expect(impressions()).toHaveLength(1)
    expect(productIdsOf(impressions()[0]!)).toEqual(['9', '10'])
  })

  it('a fetch that fails still counts the impression (slotted fallback), without items', async () => {
    getByIds.mockRejectedValue(new Error('network'))
    const el = await mount<HTMLElement>('vio-product-carousel', {
      productIds: '9',
      sponsorId: 4,
      vioSlot: 'imp-d',
    } as any)
    for (let i = 0; i < 3; i++) await settle(el)
    seenForOneSecond()
    expect(impressions()).toHaveLength(1)
    expect(impressions()[0]).not.toHaveProperty('commerce')
  })
})
