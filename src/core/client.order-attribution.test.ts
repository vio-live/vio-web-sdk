/**
 * `Vio.orderAttribution()` (ADR-0035 phase B): what the checkout sends as
 * `attribution` — the surface's key, the page's campaign (else the one that
 * explains most of the cart), the page, and the entry only when the surface
 * is known to be `standard` (`Vio.privacyMode()`: the host, the bootstrap,
 * `GET /v2/mobile/surface`, in that order). Against the real VioApi with
 * `fetch` stubbed.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The cart stays local (no commerce key resolved): these tests are about the
// attribution, not about the backend cart sync.
vi.mock('./api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: false })),
}))

import { Configuration } from './configuration.js'
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

const PAGE = 'https://host.example/article?x=1'

let surfaceAnswer: () => Promise<Response>
let surfaceCalls: number

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

beforeAll(async () => {
  delete (globalThis as { __VIO_FACADE__?: unknown }).__VIO_FACADE__
  ;({ Vio } = await import('./client.js'))
})

beforeEach(() => {
  surfaceCalls = 0
  surfaceSays('standard')
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/v2/mobile/config')) return jsonResponse(BOOT)
    if (url.endsWith('/v2/mobile/surface')) {
      surfaceCalls++
      return surfaceAnswer()
    }
    return jsonResponse({ error: 'not found' }, 404)
  })
  vi.stubGlobal('document', { referrer: 'https://news.example/front', dispatchEvent: () => true })
  vi.stubGlobal('location', { href: PAGE, pathname: '/article', search: '?x=1', host: 'host.example' })
  vi.stubGlobal('localStorage', undefined)
  vi.stubGlobal('sessionStorage', undefined)
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

async function ready(config: Record<string, unknown> = {}) {
  Vio.init({ apiKey: 'surface-key', environment: 'testing', ...config } as never)
  await Vio.bootstrap()
}

describe('Vio.orderAttribution', () => {
  it('the surface key, the page campaign, the page and the entry of a standard surface', async () => {
    await ready({ campaignId: 12 })
    expect(await Vio.orderAttribution(4)).toEqual({
      surface_key: 'surface-key',
      campaign_id: 12,
      content_url: PAGE,
      entry: { referrer: 'https://news.example/front', landing_url: 'https://host.example/article' },
    })
    // The surface was asked once, not once per checkout step.
    await Vio.orderAttribution(4)
    expect(surfaceCalls).toBe(1)
  })

  it('without a page campaign, the campaign that explains most units of the cart (the rule purchase is split by)', async () => {
    await ready()
    const add = (campaignId: number, quantity: number) =>
      Vio.cart.addManual({ productId: 9, sponsorId: 4, brand: 'S', name: 'Morris', unitPrice: 100, currency: 'NOK', imageUrl: '', quantity, origin: { campaignId, slot: 'hero' } })
    add(12, 1)
    add(10, 2)
    expect((await Vio.orderAttribution(4))?.campaign_id).toBe(10)
    // Units without an origin fall into the campaign the rule resolves for the sponsor (the default, 10).
    Vio.cart.clearAllCarts()
    Vio.cart.addManual({ productId: 9, sponsorId: 4, brand: 'S', name: 'Morris', unitPrice: 100, currency: 'NOK', imageUrl: '', quantity: 1 })
    expect((await Vio.orderAttribution(4))?.campaign_id).toBe(10)
  })

  it('a minimal surface keeps the entry off the order', async () => {
    surfaceSays('minimal')
    await ready({ campaignId: 12 })
    expect(await Vio.orderAttribution(4)).toEqual({ surface_key: 'surface-key', campaign_id: 12, content_url: PAGE })
    expect(await Vio.privacyMode()).toBe('minimal')
  })

  it('the host\'s minimal wins without asking; the bootstrap\'s surface answers before the endpoint', async () => {
    surfaceSays('standard')
    await ready({ privacyMode: 'minimal' })
    expect(await Vio.privacyMode()).toBe('minimal')
    expect(surfaceCalls).toBe(0)
    expect(await Vio.orderAttribution(4)).not.toHaveProperty('entry')
    // The bootstrap says it: no request either.
    Configuration.reset()
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/v2/mobile/config')) return jsonResponse({ ...BOOT, surface: { id: 1, privacyMode: 'minimal' } })
      surfaceCalls++
      return surfaceAnswer()
    })
    Vio.init({ apiKey: 'surface-key-2', environment: 'testing' } as never)
    await Vio.bootstrap()
    expect(await Vio.privacyMode()).toBe('minimal')
    expect(surfaceCalls).toBe(0)
  })

  it('a service that predates the surface endpoint (404) is standard; any other failure is unknown — no entry, unless the host said standard', async () => {
    surfaceSays(null, 404)
    await ready()
    expect(await Vio.privacyMode()).toBe('standard')
    expect(await Vio.orderAttribution(4)).toHaveProperty('entry')

    Configuration.reset()
    surfaceSays(null, 500)
    Vio.init({ apiKey: 'surface-key-3', environment: 'testing' } as never)
    expect(await Vio.privacyMode()).toBe('unknown')
    expect(await Vio.orderAttribution(4)).not.toHaveProperty('entry')
    // Asked again on the next step (a failure is not remembered): the 404 once, the 500 on every ask.
    expect(await Vio.privacyMode()).toBe('unknown')
    expect(surfaceCalls).toBe(4)
    // …and the host's word stands in for the surface's when it has one.
    Configuration.reset()
    Vio.init({ apiKey: 'surface-key-4', environment: 'testing', privacyMode: 'standard' } as never)
    expect(await Vio.privacyMode()).toBe('standard')
  })

  it('never waits more than 1.5 s for the surface: the attribution goes out without the entry', async () => {
    vi.useFakeTimers()
    surfaceAnswer = () => new Promise(() => {})
    await ready({ campaignId: 12 })
    const pending = Vio.orderAttribution(4)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await pending).toEqual({ surface_key: 'surface-key', campaign_id: 12, content_url: PAGE })
  })

  it('before init: no surface, no campaign, no entry — only the page; and it never throws', async () => {
    Configuration.reset()
    expect(await Vio.orderAttribution(4)).toEqual({ content_url: PAGE })
    expect(await Vio.privacyMode()).toBe('unknown')
    vi.stubGlobal('location', undefined)
    expect(await Vio.orderAttribution(4)).toBeUndefined()
  })
})

describe('Vio.attribution carries the page URL', () => {
  it('contentUrl = location.href within the cap, next to contentId and contentTitle', async () => {
    await ready()
    const a = Vio.attribution('hero')
    expect(a.contentUrl).toBe(PAGE)
    expect(a.contentId).toBe('/article')
  })
})
