/**
 * `observeImpression` with the products shown (ADR-0041): the impression
 * carries `commerce.items`, read when it fires, so the collector can count a
 * per-product "saw" step — and keeps its rule (≥50% visible ≥1s) and its
 * dedupe (once per session and key).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from '../configuration.js'
import { AnalyticsManager, type AnalyticsCommerce } from './analytics-manager.js'

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
  /** The element enters (ratio ≥ 0.5) or leaves the viewport. */
  intersect(ratio = 1): void {
    this.cb([{ isIntersecting: ratio > 0, intersectionRatio: ratio }])
  }
}

const events: Array<Record<string, any>> = []

beforeEach(() => {
  vi.useFakeTimers()
  FakeIntersectionObserver.instances = []
  events.length = 0
  const store = new Map<string, string>()
  const g = globalThis as Record<string, unknown>
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (ev: CustomEvent) => {
      if (ev.type === 'vio:analytics') events.push(ev.detail)
      return true
    },
  }
  g.location = { href: 'https://host.example/article', search: '' }
  g.document = { title: 'Artikkel' }
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202 }) as Response))
  Configuration.reset()
  Configuration.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Configuration.reset()
  const g = globalThis as Record<string, unknown>
  delete g.window
  delete g.location
  delete g.document
})

const element = {} as Element
const impressions = () => events.filter((e) => e.name === 'component_impression')
const shown: AnalyticsCommerce = {
  items: [
    { productId: 408948, name: 'Morris bordlampe', price: 1699 },
    { productId: 408949, name: 'Sindig pendel', price: 2499 },
  ],
  currency: 'NOK',
}

describe('observeImpression → commerce.items', () => {
  it('the impression carries the products shown, as the collector reads them', () => {
    const m = new AnalyticsManager()
    m.observeImpression(element, { sponsorId: 4, locationId: 'card-1' }, { key: 'carousel:a', commerce: () => shown })
    FakeIntersectionObserver.instances[0]!.intersect()
    vi.advanceTimersByTime(1_000)

    expect(impressions()).toHaveLength(1)
    const ev = impressions()[0]!
    expect(ev.context).toMatchObject({ sponsor_id: 4, location_id: 'card-1' })
    expect(ev.commerce).toEqual({
      items: [
        { product_id: '408948', name: 'Morris bordlampe', price: 1699 },
        { product_id: '408949', name: 'Sindig pendel', price: 2499 },
      ],
      currency: 'NOK',
    })
  })

  it('reads the products when it fires, not when it starts observing', () => {
    let current: AnalyticsCommerce | null = null
    const m = new AnalyticsManager()
    m.observeImpression(element, {}, { key: 'carousel:b', commerce: () => current })
    current = shown
    FakeIntersectionObserver.instances[0]!.intersect()
    vi.advanceTimersByTime(1_000)
    expect(impressions()[0]!.commerce.items.map((i: { product_id: string }) => i.product_id)).toEqual([
      '408948',
      '408949',
    ])
  })

  it('without products (or with a getter that throws) the impression goes out as before, without commerce', () => {
    const m = new AnalyticsManager()
    m.observeImpression(element, {}, { key: 'k1', commerce: () => null })
    m.observeImpression(element, {}, { key: 'k2', commerce: () => ({ items: [] }) })
    m.observeImpression(element, {}, {
      key: 'k3',
      commerce: () => {
        throw new Error('boom')
      },
    })
    m.observeImpression(element, {}, { key: 'k4' })
    for (const io of FakeIntersectionObserver.instances) io.intersect()
    vi.advanceTimersByTime(1_000)
    expect(impressions()).toHaveLength(4)
    for (const ev of impressions()) expect(ev).not.toHaveProperty('commerce')
  })

  it('keeps the rule and the dedupe: under 1 s is nothing; once per session and key', () => {
    const m = new AnalyticsManager()
    m.observeImpression(element, {}, { key: 'carousel:c', commerce: () => shown })
    const io = FakeIntersectionObserver.instances[0]!
    io.intersect()
    vi.advanceTimersByTime(900)
    io.intersect(0) // left before the dwell
    vi.advanceTimersByTime(1_000)
    expect(impressions()).toHaveLength(0)

    io.intersect()
    vi.advanceTimersByTime(1_000)
    expect(impressions()).toHaveLength(1)
    expect(io.disconnected).toBe(true)

    // The same key again (the element mounted again): no second impression this session.
    m.observeImpression(element, {}, { key: 'carousel:c', commerce: () => shown })
    FakeIntersectionObserver.instances[1]!.intersect()
    vi.advanceTimersByTime(1_000)
    expect(impressions()).toHaveLength(1)
  })

  it('never more lines than the collector takes (100): it would reject the whole event', () => {
    const m = new AnalyticsManager()
    const many = Array.from({ length: 150 }, (_, i) => ({ productId: i + 1 }))
    m.track('view_item_list', { commerce: { items: many } })
    const ev = events.find((e) => e.name === 'view_item_list')!
    expect(ev.commerce.items).toHaveLength(100)
    expect(ev.commerce.items[99].product_id).toBe('100')
  })
})
