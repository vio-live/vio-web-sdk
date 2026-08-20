/**
 * Vio.analytics — queue/session/wire-format semantics.
 *
 * Runs in a minimal fake-DOM (node env): the manager only needs `window`,
 * `localStorage`, `location` and `fetch`, all stubbed here. What matters:
 * pre-init queuing, session rotation, wire shape (snake_case contract v1),
 * retry-safe flush, and no module side-effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from '../configuration.js'
import { AnalyticsManager } from './analytics-manager.js'

// ── Fake browser environment ────────────────────────────────────────────────

function installFakeDom() {
  const store = new Map<string, string>()
  const listeners = new Map<string, Set<(ev: Event) => void>>()
  const g = globalThis as Record<string, unknown>

  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: (t: string, h: (ev: Event) => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t)!.add(h)
    },
    removeEventListener: (t: string, h: (ev: Event) => void) => {
      listeners.get(t)?.delete(h)
    },
    dispatchEvent: (ev: Event) => {
      listeners.get(ev.type)?.forEach((h) => h(ev))
      return true
    },
  }
  ;(g.window as Record<string, unknown>).location = { href: 'https://host.example/article' }
  g.location = (g.window as Record<string, unknown>).location
  g.document = { title: 'Sneakers 2026 — trendy' }
  return { store, listeners }
}

function removeFakeDom() {
  const g = globalThis as Record<string, unknown>
  delete g.window
  delete g.location
  delete g.document
}

const flushedBatches: Array<{ apiKey: string; events: Array<Record<string, unknown>> }> = []

beforeEach(() => {
  installFakeDom()
  flushedBatches.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      flushedBatches.push(JSON.parse(init.body))
      return { ok: true, status: 202 } as Response
    }),
  )
  Configuration.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Configuration.reset()
  removeFakeDom()
})

function initVio() {
  Configuration.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('wire format (contract v1)', () => {
  it('builds snake_case events with ids, version and enrichment', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.track('component_impression', {
      context: { campaignComponentId: 512, sponsorId: 9, variant: 'top-b' },
    })
    await m.flush()

    expect(flushedBatches).toHaveLength(1)
    const batch = flushedBatches[0]!
    expect(batch.apiKey).toBe('test-key')
    // session_start (auto) + the tracked event
    const names = batch.events.map((e) => e.name)
    expect(names).toEqual(['session_start', 'component_impression'])

    const ev = batch.events[1]!
    expect(ev.surface).toBe('web')
    expect(ev.sdk_version).toBeTruthy()
    expect(String(ev.session_id)).toMatch(/^s-/)
    expect(String(ev.anon_id)).toMatch(/^a-/)
    const ctx = ev.context as Record<string, unknown>
    expect(ctx.campaign_component_id).toBe(512)
    expect(ctx.sponsor_id).toBe(9)
    expect(ctx.variant).toBe('top-b')
    expect(ctx.content_url).toBe('https://host.example/article')
    expect(ctx.content_title).toBe('Sneakers 2026 — trendy')
  })

  it('normalizes commerce ids to strings', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.track('add_to_cart', {
      commerce: { items: [{ productId: 408948, variantId: 100, price: 299 }], value: 299, currency: 'NOK' },
    })
    await m.flush()
    const item = (flushedBatches[0]!.events[1]!.commerce as { items: Array<Record<string, unknown>> })
      .items[0]!
    expect(item.product_id).toBe('408948')
    expect(item.variant_id).toBe('100')
  })
})

describe('pre-init queue', () => {
  it('holds events until Vio.init, then flushes them', async () => {
    const m = new AnalyticsManager()
    m.track('view_item', { commerce: { items: [{ productId: '1' }] } })
    await m.flush()
    expect(flushedBatches).toHaveLength(0) // no transport yet — held, not dropped

    initVio()
    await m.flush()
    expect(flushedBatches).toHaveLength(1)
    expect(flushedBatches[0]!.events.map((e) => e.name)).toContain('view_item')
  })
})

describe('sessions', () => {
  it('persists anon id across manager instances, rotates session after 30 min idle', async () => {
    initVio()
    const m1 = new AnalyticsManager()
    m1.track('view_item')
    await m1.flush()
    const first = flushedBatches[0]!.events.at(-1) as Record<string, unknown>

    // Same page, later manager instance (e.g. another chunk) — same ids.
    const m2 = new AnalyticsManager()
    m2.track('view_item')
    await m2.flush()
    const second = flushedBatches[1]!.events.at(-1) as Record<string, unknown>
    expect(second.anon_id).toBe(first.anon_id)
    expect(second.session_id).toBe(first.session_id)

    // 31 minutes of inactivity → new session (+ session_start re-emitted).
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31 * 60 * 1000)
    m2.track('view_item')
    await m2.flush()
    const third = flushedBatches[2]!.events
    expect(third.map((e) => e.name)).toContain('session_start')
    const rotated = third.at(-1) as Record<string, unknown>
    expect(rotated.session_id).not.toBe(first.session_id)
    expect(rotated.anon_id).toBe(first.anon_id) // anon survives rotation
  })
})

describe('flush + retry', () => {
  it('requeues the batch with the SAME event_ids on failure (server dedupes)', async () => {
    initVio()
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('net down')).mockResolvedValue({
      ok: true,
      status: 202,
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const m = new AnalyticsManager()
    m.track('view_item')
    await m.flush() // fails — requeued, backoff armed
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await m.flush() // inside backoff window — no call
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 10_000) // past backoff
    await m.flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstBody = JSON.parse((fetchMock.mock.calls[0]! as [string, { body: string }])[1].body)
    const retryBody = JSON.parse((fetchMock.mock.calls[1]! as [string, { body: string }])[1].body)
    expect(retryBody.events.map((e: { event_id: string }) => e.event_id)).toEqual(
      firstBody.events.map((e: { event_id: string }) => e.event_id),
    )
  })

  it('drops the batch on 401 instead of looping forever', async () => {
    initVio()
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const m = new AnalyticsManager()
    m.track('view_item')
    await m.flush()
    await m.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1) // queue emptied, nothing to resend
  })
})

describe('SSR safety', () => {
  it('is a silent no-op without window', async () => {
    removeFakeDom()
    const m = new AnalyticsManager()
    expect(() => {
      m.track('view_item')
      m.start()
    }).not.toThrow()
    await m.flush()
    expect(flushedBatches).toHaveLength(0)
  })
})

describe('autoTrack option', () => {
  it('start({autoTrack:false}) keeps the engine but installs no funnel listeners', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'vev', autoTrack: false })
    // Host dispatches an SDK funnel event — with autoTrack off, nothing queues.
    ;(globalThis as Record<string, unknown> as { window: Window }).window.dispatchEvent(
      new CustomEvent('vio:added-to-cart', { detail: { productId: 1 } }) as unknown as Event,
    )
    m.track('view_item') // manual track still works through the same engine
    await m.flush()
    const names = flushedBatches[0]!.events.map((e) => e.name)
    expect(names).not.toContain('add_to_cart')
    expect(names).toContain('view_item')
    m.stop()
  })
})

describe('UI auto-instrumentation', () => {
  it('vio:product-click from SDK components becomes select_item', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ host: 'custom' }) // autoTrack default: on
    ;(globalThis as Record<string, unknown> as { window: Window }).window.dispatchEvent(
      new CustomEvent('vio:product-click', {
        detail: { productId: 408948, sponsorId: 9, name: 'Bonding Oil', price: 300 },
      }) as unknown as Event,
    )
    await m.flush()
    const events = flushedBatches[0]!.events
    const sel = events.find((e) => e.name === 'select_item') as Record<string, unknown>
    expect(sel).toBeDefined()
    const commerce = sel.commerce as { items: Array<Record<string, unknown>> }
    expect(commerce.items[0]!.product_id).toBe('408948')
    expect(commerce.items[0]!.price).toBe(300)
    m.stop()
  })
})

describe('host attribution', () => {
  it('carries the host content id on the wire so it can join its own reporting', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.track('purchase', { context: { contentId: 123, contentUrl: '/artikkel/hostens-jakker' } })
    await m.flush()

    const ev = flushedBatches[0]!.events.at(-1) as Record<string, unknown>
    const ctx = ev.context as Record<string, unknown>
    expect(ctx.content_id).toBe(123)
    expect(ctx.content_url).toBe('/artikkel/hostens-jakker')
  })

  it('adopts a host-supplied session id instead of minting one', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.start({ sessionId: 'ml-sid-abc', collector: true })
    m.track('add_to_cart')
    await m.flush()

    const events = flushedBatches.flatMap((b) => b.events)
    expect(events.length).toBeGreaterThan(0)
    for (const ev of events) expect(ev.session_id).toBe('ml-sid-abc')
    m.stop()
  })

  it('keeps minting its own session when the host supplies none', async () => {
    initVio()
    const m = new AnalyticsManager()
    m.track('add_to_cart')
    await m.flush()

    const ev = flushedBatches[0]!.events.at(-1) as Record<string, unknown>
    expect(String(ev.session_id)).toMatch(/^s-/)
  })
})
