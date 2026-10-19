/**
 * `Vio.orderAttribution()` (ADR-0035 phase B): what the checkout sends as
 * `attribution` — the surface's key, the page's campaign (else the one that
 * explains most of the cart), and only on a surface KNOWN to be `standard`
 * the page and the entry the session remembers. The privacy mode is asked
 * once at `Vio.init()` (`GET /v2/mobile/surface`) and the payment path
 * reads what is known without waiting (`privacyModeNow`). Against the real
 * VioApi with `fetch` stubbed.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The cart stays local (no commerce key resolved): these tests are about the
// attribution, not about the backend cart sync.
vi.mock('./api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: false })),
}))

import { Configuration } from './configuration.js'
import { LANDING_KEY } from './analytics/client-context.js'
import type { BootstrapResponse } from './types.js'

let Vio: typeof import('./client.js').Vio

const sponsor = (id: number) => ({ id, name: `Sponsor ${id}`, commerce: { apiKey: `key-${id}` } })

const BOOT: BootstrapResponse = {
  campaign: { id: 10, name: 'Default' },
  primarySponsor: sponsor(4),
  campaigns: [
    { id: 12, name: 'Newer', status: 'active', primarySponsor: sponsor(4), slots: [] },
    { id: 10, name: 'Default', status: 'active', isDefault: true, primarySponsor: sponsor(4), slots: [] },
  ],
}

const HREF = 'https://host.example/article?email=kari@example.no#frag'
const PAGE = 'https://host.example/article'
const LANDING = { referrer: 'https://news.example/front', utm: { utm_source: 'nyhetsbrev' }, url: 'https://host.example/landing' }

let surfaceAnswer: () => Promise<Response>
let surfaceCalls: number
let session: Map<string, string>

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const surfaceSays = (privacyMode: unknown, status = 200) => {
  surfaceAnswer = async () => jsonResponse({ surface: { id: 1, name: 'S', privacyMode } }, status)
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeAll(async () => {
  delete (globalThis as { __VIO_FACADE__?: unknown }).__VIO_FACADE__
  ;({ Vio } = await import('./client.js'))
})

beforeEach(() => {
  surfaceCalls = 0
  surfaceSays('standard')
  session = new Map()
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/v2/mobile/config')) return jsonResponse(BOOT)
    if (url.endsWith('/v2/mobile/surface')) {
      surfaceCalls++
      return surfaceAnswer()
    }
    return jsonResponse({ error: 'not found' }, 404)
  })
  vi.stubGlobal('document', { referrer: 'https://news.example/front', dispatchEvent: () => true })
  vi.stubGlobal('location', { href: HREF, pathname: '/article', search: '', host: 'host.example' })
  vi.stubGlobal('localStorage', undefined)
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  Vio.cart.clearAllCarts()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  Configuration.reset()
})

/** Init (which asks the surface), the bootstrap, and a tick for the ask to answer. */
async function ready(config: Record<string, unknown> = {}) {
  Vio.init({ apiKey: 'surface-key', environment: 'testing', ...config } as never)
  await Vio.bootstrap()
  await flush()
}

const remember = (landing: unknown = LANDING) => session.set(LANDING_KEY, JSON.stringify(landing))

describe('Vio.orderAttribution on a standard surface', () => {
  it('the surface key, the page campaign, the page as origin + path and the entry the session remembers', async () => {
    remember()
    await ready({ campaignId: 12 })
    expect(Vio.orderAttribution(4)).toEqual({
      surface_key: 'surface-key',
      campaign_id: 12,
      content_url: PAGE,
      entry: { referrer: 'https://news.example/front', utm_source: 'nyhetsbrev', landing_url: 'https://host.example/landing' },
    })
    expect(surfaceCalls).toBe(1)
  })

  it('without a remembered landing there is no entry — the page the shopper pays on is not taken for a landing', async () => {
    await ready({ campaignId: 12 })
    expect(Vio.orderAttribution(4)).toEqual({ surface_key: 'surface-key', campaign_id: 12, content_url: PAGE })
  })

  it('without a page campaign, the campaign that explains most units of the cart (the rule purchase is split by)', async () => {
    await ready()
    const add = (campaignId: number, quantity: number) =>
      Vio.cart.addManual({ productId: 9, sponsorId: 4, brand: 'S', name: 'Morris', unitPrice: 100, currency: 'NOK', imageUrl: '', quantity, origin: { campaignId, slot: 'hero' } })
    add(12, 1)
    add(10, 2)
    expect(Vio.orderAttribution(4)?.campaign_id).toBe(10)
    // Units without an origin fall into the campaign the rule resolves for the sponsor (the default, 10).
    Vio.cart.clearAllCarts()
    Vio.cart.addManual({ productId: 9, sponsorId: 4, brand: 'S', name: 'Morris', unitPrice: 100, currency: 'NOK', imageUrl: '', quantity: 1 })
    expect(Vio.orderAttribution(4)?.campaign_id).toBe(10)
  })

  it('Vio.attribution carries the page URL as origin + path', async () => {
    await ready()
    const a = Vio.attribution('hero')
    expect(a.contentUrl).toBe(PAGE)
    expect(a.contentId).toBe('/article')
  })
})

describe('the privacy mode: asked once at init, read without waiting on the way to a payment', () => {
  it('a minimal surface keeps the page, the slot and the entry off; the surface and the campaign stay', async () => {
    remember()
    surfaceSays('minimal')
    await ready({ campaignId: 12 })
    expect(Vio.privacyModeNow()).toBe('minimal')
    expect(Vio.orderAttribution(4)).toEqual({ surface_key: 'surface-key', campaign_id: 12 })
  })

  it("the host's minimal wins without asking; the bootstrap's surface answers before the endpoint", async () => {
    await ready({ privacyMode: 'minimal' })
    expect(Vio.privacyModeNow()).toBe('minimal')
    expect(surfaceCalls).toBe(0)
    Configuration.reset()
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/v2/mobile/config')) return jsonResponse({ ...BOOT, surface: { id: 1, privacyMode: 'minimal' } })
      surfaceCalls++
      return surfaceAnswer()
    })
    Vio.init({ apiKey: 'surface-key-2', environment: 'testing' } as never)
    await Vio.bootstrap()
    await flush()
    expect(Vio.privacyModeNow()).toBe('minimal')
    // init asked before the bootstrap answered; the bootstrap's word stands anyway.
    expect(surfaceCalls).toBe(1)
  })

  it('init starts the ask; the payment path never waits for it and reads what is known at that moment', async () => {
    vi.useFakeTimers()
    remember()
    let answer!: (r: Response) => void
    surfaceAnswer = () => new Promise<Response>((resolve) => (answer = resolve))
    Vio.init({ apiKey: 'surface-key', environment: 'testing', campaignId: 12 } as never)
    expect(surfaceCalls).toBe(1)
    await Vio.bootstrap()
    // Three steps of a checkout before the surface answered: synchronous, nothing waits, nothing is asked again.
    for (let i = 0; i < 3; i++) {
      expect(Vio.orderAttribution(4)).toEqual({ surface_key: 'surface-key', campaign_id: 12 })
    }
    expect(surfaceCalls).toBe(1)
    // The cap passes: unknown, believed for a minute.
    await vi.advanceTimersByTimeAsync(1_500)
    expect(Vio.privacyModeNow()).toBe('unknown')
    expect(surfaceCalls).toBe(1)
    // A late answer still lands for the next step.
    answer(jsonResponse({ surface: { id: 1, privacyMode: 'standard' } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(Vio.privacyModeNow()).toBe('standard')
    expect(Vio.orderAttribution(4)).toHaveProperty('content_url', PAGE)
    expect(Vio.orderAttribution(4)).toHaveProperty('entry')
  })

  it('a failure (HTTP 500) is unknown — believed for a minute, then asked again; the lines wait for the ask, the payment does not', async () => {
    vi.useFakeTimers()
    surfaceSays(null, 500)
    Vio.init({ apiKey: 'surface-key', environment: 'testing', campaignId: 12 } as never)
    await Vio.bootstrap()
    await vi.advanceTimersByTimeAsync(0)
    expect(surfaceCalls).toBe(1)
    expect(Vio.privacyModeNow()).toBe('unknown')
    expect(await Vio.privacyMode()).toBe('unknown')
    expect(Vio.orderAttribution(4)).toEqual({ surface_key: 'surface-key', campaign_id: 12 })
    expect(surfaceCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(Vio.privacyModeNow()).toBe('unknown')
    expect(surfaceCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(1_001)
    surfaceSays('standard')
    expect(Vio.privacyModeNow()).toBe('unknown') // and asks again…
    expect(surfaceCalls).toBe(2)
    expect(await Vio.privacyMode()).toBe('standard') // …which the lines wait for
    expect(Vio.privacyModeNow()).toBe('standard')
  })

  it("the host's standard stands in only once the surface could not tell", async () => {
    vi.useFakeTimers()
    surfaceAnswer = () => new Promise<Response>(() => {})
    Vio.init({ apiKey: 'surface-key', environment: 'testing', privacyMode: 'standard', campaignId: 12 } as never)
    await Vio.bootstrap()
    // In flight: not yet.
    expect(Vio.privacyModeNow()).toBe('unknown')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(Vio.privacyModeNow()).toBe('standard')
    expect(Vio.orderAttribution(4)).toHaveProperty('content_url', PAGE)
  })

  it('a service that predates the endpoint (404) is standard; a surface with no mode is standard; a word the SDK does not know is unknown', async () => {
    surfaceSays(null, 404)
    await ready()
    expect(Vio.privacyModeNow()).toBe('standard')

    Configuration.reset()
    surfaceSays(null)
    Vio.init({ apiKey: 'surface-key-3', environment: 'testing' } as never)
    await flush()
    expect(Vio.privacyModeNow()).toBe('standard')

    Configuration.reset()
    surfaceSays('strict')
    Vio.init({ apiKey: 'surface-key-4', environment: 'testing' } as never)
    await flush()
    expect(Vio.privacyModeNow()).toBe('unknown')

    Configuration.reset()
    surfaceAnswer = async () => jsonResponse({ nothing: true })
    Vio.init({ apiKey: 'surface-key-5', environment: 'testing' } as never)
    await flush()
    expect(Vio.privacyModeNow()).toBe('unknown')
  })

  it('before init: no surface, no campaign, no page; and it never throws', async () => {
    Configuration.reset()
    expect(Vio.orderAttribution(4)).toBeUndefined()
    expect(Vio.privacyModeNow()).toBe('unknown')
    expect(await Vio.privacyMode()).toBe('unknown')
  })
})
