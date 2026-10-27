/**
 * Internal traffic (ADR-0041 §5): `?vio_internal=1` marks the browser,
 * `?vio_internal=0` clears it, and while marked every event carries
 * `client.internal: true` — the collector's reads leave those out.
 *
 * Node env with a minimal fake DOM, like analytics-manager.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from '../configuration.js'
import { AnalyticsManager } from './analytics-manager.js'
import { INTERNAL_KEY, internalParam, readInternal, resolveInternal, writeInternal } from './internal-traffic.js'

function memoryStorage() {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
}

let storage: ReturnType<typeof memoryStorage>

function installFakeDom(search = '') {
  storage = memoryStorage()
  const g = globalThis as Record<string, unknown>
  g.window = {
    localStorage: storage,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }
  g.location = { href: `https://host.example/article${search}`, search, host: 'host.example' }
  ;(g.window as Record<string, unknown>).location = g.location
  g.document = { title: 'Artikkel', referrer: '' }
}

/** Another page of the same browser: same localStorage, a new URL. */
function navigate(search: string) {
  const g = globalThis as Record<string, any>
  g.location = { href: `https://host.example/other${search}`, search, host: 'host.example' }
  g.window.location = g.location
}

function removeFakeDom() {
  const g = globalThis as Record<string, unknown>
  delete g.window
  delete g.location
  delete g.document
}

const batches: Array<{ events: Array<Record<string, unknown>> }> = []

beforeEach(() => {
  installFakeDom()
  batches.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      batches.push(JSON.parse(init.body))
      return { ok: true, status: 202 } as Response
    }),
  )
  Configuration.reset()
  Configuration.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Configuration.reset()
  removeFakeDom()
})

async function eventsOf(m: AnalyticsManager): Promise<Array<Record<string, unknown>>> {
  await m.flush()
  return batches.flatMap((b) => b.events)
}

describe('internal-traffic (pure)', () => {
  it('the parameter: 1 marks, 0 clears, anything else says nothing', () => {
    expect(internalParam('?vio_internal=1')).toBe(true)
    expect(internalParam('?a=b&vio_internal=0')).toBe(false)
    expect(internalParam('?vio_internal=yes')).toBeUndefined()
    expect(internalParam('?vio_internal=')).toBeUndefined()
    expect(internalParam('')).toBeUndefined()
    expect(internalParam(undefined)).toBeUndefined()
  })

  it('the URL wins and is remembered; without the parameter, what the browser remembers', () => {
    const s = memoryStorage()
    expect(resolveInternal({ location: { search: '' }, storage: s })).toBe(false)
    expect(resolveInternal({ location: { search: '?vio_internal=1' }, storage: s })).toBe(true)
    expect(s.store.get(INTERNAL_KEY)).toBe('1')
    expect(resolveInternal({ location: { search: '?utm_source=x' }, storage: s })).toBe(true)
    expect(resolveInternal({ location: { search: '?vio_internal=0' }, storage: s })).toBe(false)
    expect(s.store.has(INTERNAL_KEY)).toBe(false)
    expect(resolveInternal({ location: { search: '' }, storage: s })).toBe(false)
  })

  it('a storage that throws (in-app browser, sandboxed frame) never throws: the URL still marks this page', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(() => writeInternal(true, throwing)).not.toThrow()
    expect(readInternal(throwing)).toBe(false)
    expect(resolveInternal({ location: { search: '?vio_internal=1' }, storage: throwing })).toBe(true)
    expect(resolveInternal({ location: { search: '' }, storage: throwing })).toBe(false)
    expect(resolveInternal({ location: null, storage: null })).toBe(false)
  })
})

describe('client.internal on the wire', () => {
  it('an unmarked browser sends no `internal` key at all', async () => {
    const m = new AnalyticsManager()
    m.track('view_item')
    const events = await eventsOf(m)
    expect(events.map((e) => e.name)).toEqual(['session_start', 'view_item'])
    for (const ev of events) expect(ev.client ?? {}).not.toHaveProperty('internal')
  })

  it('?vio_internal=1 marks the browser: every event of this page and of the next ones carries client.internal: true', async () => {
    installFakeDom('?vio_internal=1')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    Configuration.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
    const first = new AnalyticsManager()
    first.track('component_impression')
    first.track('select_item')
    const events = await eventsOf(first)
    expect(events.map((e) => e.name)).toEqual(['session_start', 'component_impression', 'select_item'])
    for (const ev of events) expect((ev.client as Record<string, unknown>).internal).toBe(true)
    expect(storage.store.get(INTERNAL_KEY)).toBe('1')

    // The next page, without the parameter: still marked.
    navigate('')
    batches.length = 0
    const second = new AnalyticsManager()
    second.track('view_item')
    for (const ev of await eventsOf(second)) expect((ev.client as Record<string, unknown>).internal).toBe(true)
  })

  it('the rest of the client block is untouched next to `internal`', async () => {
    installFakeDom('?vio_internal=1&utm_source=nyhetsbrev')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    Configuration.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
    vi.stubGlobal('navigator', { language: 'nb-NO' })
    const m = new AnalyticsManager()
    m.track('view_item')
    const ev = (await eventsOf(m))[1]!
    expect(ev.client).toMatchObject({ language: 'nb-NO', utm_source: 'nyhetsbrev', internal: true })
  })

  it('?vio_internal=0 clears the mark', async () => {
    storage.setItem(INTERNAL_KEY, '1')
    navigate('?vio_internal=0')
    const m = new AnalyticsManager()
    m.track('view_item')
    for (const ev of await eventsOf(m)) expect(ev.client ?? {}).not.toHaveProperty('internal')
    expect(storage.store.has(INTERNAL_KEY)).toBe(false)
  })

  it('Vio.analytics.setInternal(true | false): from the next event on, and remembered', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const m = new AnalyticsManager()
    m.track('view_item')
    m.setInternal(true)
    m.track('select_item')
    expect(m.isInternal).toBe(true)
    expect(storage.store.get(INTERNAL_KEY)).toBe('1')
    m.setInternal(false)
    m.track('add_to_cart')
    expect(storage.store.has(INTERNAL_KEY)).toBe(false)
    const events = await eventsOf(m)
    const internal = Object.fromEntries(
      events.map((e) => [e.name, (e.client as Record<string, unknown> | undefined)?.internal ?? null]),
    )
    expect(internal).toEqual({ session_start: null, view_item: null, select_item: true, add_to_cart: null })
  })

  it('the mark is read once per page load: a later change of the URL does not re-read it', async () => {
    const m = new AnalyticsManager()
    m.track('view_item')
    navigate('?vio_internal=1') // e.g. history.pushState in an SPA
    m.track('select_item')
    for (const ev of await eventsOf(m)) expect(ev.client ?? {}).not.toHaveProperty('internal')
  })

  it('tells the tester once, on the console, that the browser is marked', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    storage.setItem(INTERNAL_KEY, '1')
    const m = new AnalyticsManager()
    m.track('view_item')
    m.track('select_item')
    m.setInternal(true)
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0]![0])).toContain('internal')
  })

  it('localStorage that throws on access (in-app browser): events still go out, unmarked', async () => {
    const g = globalThis as Record<string, any>
    Object.defineProperty(g.window, 'localStorage', {
      get() {
        throw new Error('SecurityError')
      },
    })
    const m = new AnalyticsManager()
    expect(() => m.track('view_item')).not.toThrow()
    const events = await eventsOf(m)
    expect(events.map((e) => e.name)).toContain('view_item')
    for (const ev of events) expect(ev.client ?? {}).not.toHaveProperty('internal')
  })

  it('a page opened with ?vio_internal=1 marks the browser at Vio.init(), before analytics starts', async () => {
    installFakeDom('?vio_internal=1')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { Vio } = await import('../client.js')
    Vio.init({ apiKey: 'test-key', eventsBase: 'https://events.test' })
    expect(storage.store.get(INTERNAL_KEY)).toBe('1')
    expect(Vio.analytics.isInternal).toBe(true)
  })
})
