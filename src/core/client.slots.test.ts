/**
 * Slots on the facade (ADR-0027 / ADR-0034): `Vio.declareSlots()`,
 * `Vio.registerSlot()` and `Vio.campaignForSlot()` against the real VioApi
 * with `fetch` and `localStorage` stubbed — what leaves the browser is the
 * contract with the campaigns micro, so the tests read the request itself.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from './configuration.js'
import type { BootstrapResponse, ManifestResult } from './types.js'

let Vio: typeof import('./client.js').Vio

const sponsor = (id: number) => ({ id, name: `Sponsor ${id}`, commerce: { apiKey: `key-${id}` } })

const BOOT: BootstrapResponse = {
  campaign: { id: 10, name: 'Default' },
  primarySponsor: sponsor(4),
  secondarySponsors: [sponsor(5)],
  campaigns: [
    {
      id: 12,
      name: 'Newer',
      status: 'active',
      primarySponsor: sponsor(7),
      secondarySponsors: [sponsor(8)],
      slots: [
        { name: 'hero', platform: null },
        { name: 'sidebar', platform: 'web' },
      ],
    },
    { id: 10, name: 'Default', status: 'active', isDefault: true, primarySponsor: sponsor(4), slots: [] },
  ],
}

const MANIFEST_OK: ManifestResult = {
  clientAppId: 1,
  platform: 'web',
  mode: 'merge',
  locations: [{ id: 1, locationId: 'hero', displayName: null }],
  deprecatedCount: 0,
  warnings: [],
}

/** Every request `fetch` saw: url + parsed init. */
let requests: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>
let manifestAnswer: () => Response
let store: Map<string, string>

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function fakeStorage() {
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
}

const manifestRequests = () => requests.filter((r) => r.url.endsWith('/v2/mobile/components/manifest'))
const configRequests = () => requests.filter((r) => r.url.includes('/v2/mobile/config'))

beforeAll(async () => {
  // The facade is a page-wide singleton on globalThis: this file gets its own.
  delete (globalThis as { __VIO_FACADE__?: unknown }).__VIO_FACADE__
  ;({ Vio } = await import('./client.js'))
})

beforeEach(() => {
  requests = []
  store = new Map()
  manifestAnswer = () => jsonResponse(MANIFEST_OK)
  vi.stubGlobal('localStorage', fakeStorage())
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      if (url.endsWith('/v2/mobile/components/manifest')) return manifestAnswer()
      if (url.includes('/v2/mobile/config')) return jsonResponse(BOOT)
      throw new Error(`unexpected request ${url}`)
    }),
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Configuration.reset()
})

const init = (platform?: 'web' | 'custom-web' | 'vev', apiKey = 'key-A') =>
  Vio.init({ apiKey, environment: 'testing', platform })

describe('Vio.init({ platform }) and the bootstrap', () => {
  it('defaults the platform to web and sends it as ?platform= on /v2/mobile/config', async () => {
    init()
    expect(Vio.config.platform).toBe('web')
    await Vio.bootstrap()
    expect(configRequests()[0]!.url).toMatch(/\/v2\/mobile\/config\?platform=web$/)
    expect(configRequests()[0]!.headers['X-API-Key']).toBe('key-A')
  })

  it('sends the configured platform', async () => {
    init('custom-web')
    await Vio.bootstrap()
    expect(configRequests()[0]!.url).toMatch(/\?platform=custom-web$/)
  })
})

describe('Vio.declareSlots()', () => {
  it('POSTs the manifest with mode merge, the init platform and the normalized locations', async () => {
    init('vev')
    const result = await Vio.declareSlots([
      ' hero ',
      '',
      { id: 'footer', displayName: 'Footer' },
      'hero',
      'z'.repeat(140),
    ])
    expect(result).toEqual(MANIFEST_OK)
    const [req] = manifestRequests()
    expect(req).toBeDefined()
    expect(req!.method).toBe('POST')
    expect(req!.url).toMatch(/^https:\/\/api-staging\.vio\.live\/v2\/mobile\/components\/manifest$/)
    expect(req!.headers['X-API-Key']).toBe('key-A')
    expect(req!.headers['Content-Type']).toBe('application/json')
    expect(req!.body).toEqual({
      platform: 'vev',
      mode: 'merge',
      locations: [{ id: 'hero' }, { id: 'footer', displayName: 'Footer' }, { id: 'z'.repeat(100) }],
    })
  })

  it('does not POST again for the same set within 24 h, in any order; a new set or force does', async () => {
    init()
    expect(await Vio.declareSlots(['hero', 'footer'])).toEqual(MANIFEST_OK)
    expect(await Vio.declareSlots(['footer', 'hero '])).toBeNull()
    expect(manifestRequests()).toHaveLength(1)

    expect(await Vio.declareSlots(['hero', 'footer'], { force: true })).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(2)

    expect(await Vio.declareSlots(['hero', 'footer', 'sidebar'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(3)
  })

  it('declares again once 24 h have passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
    init()
    await Vio.declareSlots(['hero'])
    vi.setSystemTime(new Date('2026-10-17T09:59:00Z'))
    expect(await Vio.declareSlots(['hero'])).toBeNull()
    vi.setSystemTime(new Date('2026-10-17T10:00:01Z'))
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(2)
  })

  it('remembers per platform and per key — and never writes the key itself', async () => {
    init('web', 'sk_live_SECRET_KEY')
    await Vio.declareSlots(['hero'])
    const keys = [...store.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^vio\.slots\.web\.[0-9a-f]{8}$/)
    expect(JSON.stringify([...store.entries()])).not.toContain('SECRET')
    expect(JSON.parse(store.get(keys[0]!)!)).toEqual({ ids: ['hero'], at: expect.any(Number) })

    // Another key on the same origin (Vev's remembered key → the page's own).
    init('web', 'another-key')
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    // Another platform with the first key.
    init('vev', 'sk_live_SECRET_KEY')
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(3)
  })

  it('works without localStorage (private mode): it just posts every time', async () => {
    vi.stubGlobal('localStorage', undefined)
    init()
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(2)

    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    vi.stubGlobal('localStorage', throwing)
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(3)
  })

  it('never throws: network failure, HTTP error, no init, nothing to declare → null + a warning', async () => {
    init()
    manifestAnswer = () => { throw new Error('network down') }
    await expect(Vio.declareSlots(['hero'])).resolves.toBeNull()
    manifestAnswer = () => jsonResponse({ message: 'unknown platform' }, 400)
    await expect(Vio.declareSlots(['hero'])).resolves.toBeNull()
    expect(console.warn).toHaveBeenCalledTimes(2)
    // A failure is not remembered: the next call tries again.
    manifestAnswer = () => jsonResponse(MANIFEST_OK)
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)

    expect(await Vio.declareSlots([])).toBeNull()
    expect(await Vio.declareSlots(['', '   '])).toBeNull()
    expect(await Vio.declareSlots(null as unknown as string[])).toBeNull()
    expect(manifestRequests()).toHaveLength(3)

    Configuration.reset()
    await expect(Vio.declareSlots(['hero'])).resolves.toBeNull()
    expect(manifestRequests()).toHaveLength(3)
  })

  it('an old server that ignores mode (no `mode` in the answer) replaces: the result is returned but NOT remembered', async () => {
    init()
    const { mode: _dropped, ...oldServer } = MANIFEST_OK
    manifestAnswer = () => jsonResponse(oldServer)
    expect(await Vio.declareSlots(['hero'])).toEqual(oldServer)
    expect(console.warn).toHaveBeenCalledWith(
      '[Vio]',
      expect.stringContaining('server ignored mode=merge'),
    )
    expect(store.size).toBe(0)
    // Next load tries again — and is remembered once the server merges.
    expect(await Vio.declareSlots(['hero'])).toEqual(oldServer)
    manifestAnswer = () => jsonResponse({ ...MANIFEST_OK, mode: 'replace' })
    expect(await Vio.declareSlots(['hero'])).toMatchObject({ mode: 'replace' })
    expect(store.size).toBe(0)
    manifestAnswer = () => jsonResponse(MANIFEST_OK)
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(store.size).toBe(1)
    expect(await Vio.declareSlots(['hero'])).toBeNull()
    expect(manifestRequests()).toHaveLength(4)
  })
})

describe('Vio.registerSlot()', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('declares the registry once, debounced, after the first successful bootstrap', async () => {
    init()
    const offs = [
      Vio.registerSlot('hero'),
      Vio.registerSlot(' footer '),
      Vio.registerSlot('hero'), // the carousel and its cards share a name
    ]
    await vi.advanceTimersByTimeAsync(5_000)
    expect(manifestRequests()).toHaveLength(0) // no bootstrap yet

    await Vio.bootstrap()
    expect(manifestRequests()).toHaveLength(0) // debounced
    await vi.advanceTimersByTimeAsync(999)
    expect(manifestRequests()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(manifestRequests()).toHaveLength(1)
    expect(manifestRequests()[0]!.body).toEqual({
      platform: 'web',
      mode: 'merge',
      locations: [{ id: 'hero' }, { id: 'footer' }],
    })
    offs.forEach((off) => off())
  })

  it('declares again when a new name appears later — removal alone never does', async () => {
    init()
    await Vio.bootstrap()
    const offHero = Vio.registerSlot('hero')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(1)

    offHero()
    offHero() // idempotent
    await vi.advanceTimersByTimeAsync(5_000)
    expect(manifestRequests()).toHaveLength(1)

    // A name that is already registered is not "new".
    const offAgain = Vio.registerSlot('sidebar')
    const offDup = Vio.registerSlot('sidebar')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(2)
    expect(manifestRequests()[1]!.body).toMatchObject({ locations: [{ id: 'sidebar' }] })
    offAgain()
    offDup()
  })

  it('collapses a mount storm into one request, and ignores blank names', async () => {
    init()
    await Vio.bootstrap()
    const offs = ['a', 'b', '', '  ', 'c'].map((n) => Vio.registerSlot(n))
    await vi.advanceTimersByTimeAsync(500)
    offs.push(Vio.registerSlot('d'))
    await vi.advanceTimersByTimeAsync(999)
    expect(manifestRequests()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(manifestRequests()).toHaveLength(1)
    expect(manifestRequests()[0]!.body).toMatchObject({
      locations: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    })
    offs.forEach((off) => off())
  })

  it('after a re-init the page slots are declared again under the new key, once it bootstraps', async () => {
    init('web', 'key-A')
    await Vio.bootstrap()
    const off = Vio.registerSlot('hero')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(1)

    init('web', 'key-B')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(manifestRequests()).toHaveLength(1) // waits for key-B's bootstrap
    await Vio.bootstrap()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(2)
    expect(manifestRequests()[1]!.headers['X-API-Key']).toBe('key-B')
    off()
  })
})

describe('Vio.campaignForSlot()', () => {
  it('reads the last bootstrap with the init platform; null before it', async () => {
    init('web')
    expect(Vio.campaignForSlot('hero')).toBeNull()
    await Vio.bootstrap()
    expect(Vio.campaignForSlot('hero')?.id).toBe(12)
    expect(Vio.campaignForSlot('sidebar')?.id).toBe(12)
    expect(Vio.campaignForSlot()?.id).toBe(10)
    expect(Vio.campaignForSlot(null)?.primarySponsor?.id).toBe(4)
    expect(Vio.campaignForSlot('unknown')?.id).toBe(10)
  })

  it('an assignment of another platform does not apply', async () => {
    init('vev')
    await Vio.bootstrap()
    expect(Vio.campaignForSlot('hero')?.id).toBe(12) // platform null → every platform
    expect(Vio.campaignForSlot('sidebar')?.id).toBe(10) // web-only
  })

  it("commerceFor() knows the sponsors of a slot's campaign, not only the default's", async () => {
    init('web')
    await Vio.bootstrap()
    const sponsorId = Vio.campaignForSlot('hero')!.primarySponsor!.id
    expect(sponsorId).toBe(7)
    expect(() => Vio.commerceFor(sponsorId)).not.toThrow()
    expect(() => Vio.commerceFor(8)).not.toThrow() // a secondary of that campaign
    expect(() => Vio.commerceFor(99)).toThrow(/Sponsor 99 not found/)
  })
})
