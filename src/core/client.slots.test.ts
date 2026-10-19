/**
 * Slots on the facade (ADR-0027 / ADR-0034): `Vio.declareSlots()`,
 * `Vio.registerSlot()` and `Vio.campaignForSlot()` against the real VioApi
 * with `fetch` and `localStorage` stubbed — what leaves the browser is the
 * contract with the campaigns micro, so the tests read the request itself.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The cart stays local (no commerce key resolved): these tests are about
// slots, not about the backend cart sync.
vi.mock('./api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: false })),
}))

import { Configuration } from './configuration.js'
import type { BootstrapResponse, ManifestResult } from './types.js'
import type { CartLineItem } from './cart/types.js'

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

  it('remembers per id for 24 h: a known set POSTs nothing, a new page POSTs only its new ids, force POSTs all', async () => {
    init()
    expect(await Vio.declareSlots(['hero', 'footer'])).toEqual(MANIFEST_OK)
    // Revisiting the page (any order, trimmed): nothing to say.
    expect(await Vio.declareSlots(['footer', 'hero '])).toBeNull()
    expect(manifestRequests()).toHaveLength(1)

    // Another page of the site shares `hero` and adds one: only the new id goes out.
    expect(await Vio.declareSlots(['hero', 'sidebar'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(2)
    expect(manifestRequests()[1]!.body).toEqual({ platform: 'web', mode: 'merge', locations: [{ id: 'sidebar' }] })

    // Back on the first page within 24 h: nothing.
    expect(await Vio.declareSlots(['hero', 'footer'])).toBeNull()

    // force: everything, remembered or not.
    expect(await Vio.declareSlots(['hero', 'footer'], { force: true })).toEqual(MANIFEST_OK)
    expect(manifestRequests()[2]!.body).toMatchObject({ locations: [{ id: 'hero' }, { id: 'footer' }] })
    expect(manifestRequests()).toHaveLength(3)
  })

  it('declares an id again once its 24 h have passed — only that id', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
    init()
    await Vio.declareSlots(['hero'])
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'))
    await Vio.declareSlots(['hero', 'footer']) // footer only
    vi.setSystemTime(new Date('2026-10-17T09:59:00Z'))
    expect(await Vio.declareSlots(['hero', 'footer'])).toBeNull()
    vi.setSystemTime(new Date('2026-10-17T10:00:01Z'))
    expect(await Vio.declareSlots(['hero', 'footer'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(3)
    expect(manifestRequests()[1]!.body).toMatchObject({ locations: [{ id: 'footer' }] })
    expect(manifestRequests()[2]!.body).toMatchObject({ locations: [{ id: 'hero' }] })
  })

  it('remembers per platform and per key — and never writes the key itself', async () => {
    init('web', 'sk_live_SECRET_KEY')
    await Vio.declareSlots(['hero'])
    const keys = [...store.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^vio\.slots\.web\.[0-9a-f]{8}$/)
    expect(JSON.stringify([...store.entries()])).not.toContain('SECRET')
    expect(JSON.parse(store.get(keys[0]!)!)).toEqual({ hero: expect.any(Number) })

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
    await expect(Vio.declareSlots(['footer'])).resolves.toBeNull()
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(manifestRequests()).toHaveLength(2)

    expect(await Vio.declareSlots([])).toBeNull()
    expect(await Vio.declareSlots(['', '   '])).toBeNull()
    expect(await Vio.declareSlots(null as unknown as string[])).toBeNull()
    expect(manifestRequests()).toHaveLength(2)

    Configuration.reset()
    await expect(Vio.declareSlots(['sidebar'])).resolves.toBeNull()
    expect(manifestRequests()).toHaveLength(2)
  })

  it('a failure is negative-cached for 1 h: no POST on every view, a retry after the hour', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
    init()
    manifestAnswer = () => { throw new Error('network down') }
    expect(await Vio.declareSlots(['hero'])).toBeNull()
    manifestAnswer = () => jsonResponse(MANIFEST_OK)
    vi.setSystemTime(new Date('2026-10-16T10:59:00Z'))
    expect(await Vio.declareSlots(['hero'])).toBeNull() // still the failed attempt
    expect(manifestRequests()).toHaveLength(1)
    // Another id is not held back by hero's failure.
    expect(await Vio.declareSlots(['hero', 'footer'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()[1]!.body).toMatchObject({ locations: [{ id: 'footer' }] })
    vi.setSystemTime(new Date('2026-10-16T11:00:01Z'))
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(3)
    // And a success is then remembered for the full 24 h.
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'))
    expect(await Vio.declareSlots(['hero'])).toBeNull()
  })

  it('caps a declaration at 100 locations and a page load at 3 manifests, warning once each; force bypasses the load cap', async () => {
    init()
    const many = Array.from({ length: 150 }, (_, i) => `slot-${i}`)
    expect(await Vio.declareSlots(many)).toEqual(MANIFEST_OK)
    expect((manifestRequests()[0]!.body as { locations: unknown[] }).locations).toHaveLength(100)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith('[Vio]', expect.stringContaining('only the first 100'))

    expect(await Vio.declareSlots(['a'])).toEqual(MANIFEST_OK)
    expect(await Vio.declareSlots(['b'])).toEqual(MANIFEST_OK)
    expect(await Vio.declareSlots(['c'])).toBeNull() // the 4th of this load
    expect(await Vio.declareSlots(['d'])).toBeNull()
    expect(manifestRequests()).toHaveLength(3)
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenLastCalledWith('[Vio]', expect.stringContaining('already 3 manifests'))
    expect(await Vio.declareSlots(['c'], { force: true })).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(4)
  })

  it('an old server that ignores mode (no `mode` in the answer) replaces: the result is returned, remembered only for 1 h', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
    init()
    const { mode: _dropped, ...oldServer } = MANIFEST_OK
    manifestAnswer = () => jsonResponse(oldServer)
    expect(await Vio.declareSlots(['hero'])).toEqual(oldServer)
    expect(console.warn).toHaveBeenCalledWith(
      '[Vio]',
      expect.stringContaining('server ignored mode=merge'),
    )
    // Not on every view…
    expect(await Vio.declareSlots(['hero'])).toBeNull()
    // …but the next load after an hour tries again — and is remembered for 24 h once the server merges.
    vi.setSystemTime(new Date('2026-10-16T11:00:01Z'))
    manifestAnswer = () => jsonResponse({ ...MANIFEST_OK, mode: 'replace' })
    expect(await Vio.declareSlots(['hero'])).toMatchObject({ mode: 'replace' })
    vi.setSystemTime(new Date('2026-10-16T12:00:02Z'))
    manifestAnswer = () => jsonResponse(MANIFEST_OK)
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    vi.setSystemTime(new Date('2026-10-17T11:00:00Z'))
    expect(await Vio.declareSlots(['hero'])).toBeNull()
    expect(manifestRequests()).toHaveLength(3)
  })

  it('tolerates the 0.23.0 memory shape ({ keys, at }): declares once more and moves on', async () => {
    init('web', 'key-A')
    const key = `vio.slots.web.${(await import('./slots.js')).fnv1a('key-A')}`
    store.set(key, JSON.stringify({ keys: ['hero'], at: Date.now() }))
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(JSON.parse(store.get(key)!)).toEqual({ hero: expect.any(Number) })
    expect(await Vio.declareSlots(['hero'])).toBeNull()
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
    expect(manifestRequests()[1]!.body).toMatchObject({ locations: [{ id: 'sidebar' }] }) // hero was declared already
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

describe('Vio.registerSlot(name, displayName) and Vio.declareSlots with names', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('sends the display name in the manifest; a later name for the same id replaces it and re-declares', async () => {
    init()
    await Vio.bootstrap()
    const offs = [Vio.registerSlot('hero', 'Hero banner'), Vio.registerSlot('carousel-1', 'Carousel 1')]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(1)
    expect(manifestRequests()[0]!.body).toMatchObject({
      locations: [{ id: 'hero', displayName: 'Hero banner' }, { id: 'carousel-1', displayName: 'Carousel 1' }],
    })

    // The same id again without a name (a card inheriting the carousel's slot): nothing new.
    offs.push(Vio.registerSlot('hero'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(1)

    // Renamed in the editor: declared again, with the new name.
    offs.push(Vio.registerSlot('hero', 'Hero (top)'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(2)
    expect(manifestRequests()[1]!.body).toMatchObject({
      locations: [{ id: 'hero', displayName: 'Hero (top)' }],
    })
    offs.forEach((off) => off())
  })

  it('the memory keys on the names too: a renamed id POSTs again (and only it)', async () => {
    init()
    expect(await Vio.declareSlots([{ id: 'hero', displayName: 'Hero' }, 'footer'])).toEqual(MANIFEST_OK)
    expect(await Vio.declareSlots([{ id: 'hero', displayName: 'Hero' }, 'footer'])).toBeNull()
    expect(await Vio.declareSlots([{ id: 'hero', displayName: 'Hero banner' }, 'footer'])).toEqual(MANIFEST_OK)
    expect(await Vio.declareSlots(['hero', 'footer'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()).toHaveLength(3)
    expect(manifestRequests()[1]!.body).toEqual({ platform: 'web', mode: 'merge', locations: [{ id: 'hero', displayName: 'Hero banner' }] })
    expect(manifestRequests()[2]!.body).toEqual({ platform: 'web', mode: 'merge', locations: [{ id: 'hero' }] })
  })

  it('stays backwards compatible: registerSlot(name) alone', async () => {
    init()
    await Vio.bootstrap()
    const off = Vio.registerSlot('footer')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()[0]!.body).toEqual({ platform: 'web', mode: 'merge', locations: [{ id: 'footer' }] })
    off()
  })
})

describe('Vio.attribution()', () => {
  it('is {} before the bootstrap (plus the content when there is a document)', () => {
    init()
    expect(Vio.attribution('hero')).toEqual({ slot: 'hero' })
    expect(Vio.attribution()).toEqual({})
    expect(Vio.attribution(null, { sponsorId: '3' })).toEqual({ sponsorId: 3 })
  })

  it('caps the slot like registerSlot does (same 100-char id everywhere)', () => {
    init()
    expect(Vio.attribution(' ' + 'h'.repeat(130)).slot).toBe('h'.repeat(100))
    expect(Vio.attribution('h'.repeat(99) + ' tail').slot).toBe('h'.repeat(99))
  })

  it("after the bootstrap: the slot's campaign and its primary sponsor; the default without a slot or assignment", async () => {
    init('web')
    await Vio.bootstrap()
    expect(Vio.attribution('hero')).toEqual({ slot: 'hero', campaignId: 12, sponsorId: 7 })
    expect(Vio.attribution('carousel-1')).toEqual({ slot: 'carousel-1', campaignId: 10, sponsorId: 4 })
    expect(Vio.attribution()).toEqual({ campaignId: 10, sponsorId: 4 })
    expect(Vio.attribution('  ')).toEqual({ campaignId: 10, sponsorId: 4 })
  })

  it('keeps a known sponsor and attributes its campaign the way analytics does', async () => {
    init('web')
    await Vio.bootstrap()
    // Sponsor 8 is only a secondary of campaign 12: no slot assignment → the sponsor's campaign.
    expect(Vio.attribution('carousel-1', { sponsorId: 8 })).toEqual({ slot: 'carousel-1', campaignId: 12, sponsorId: 8 })
    // A slot assignment still wins over the sponsor rule.
    expect(Vio.attribution('hero', { sponsorId: 4 })).toEqual({ slot: 'hero', campaignId: 12, sponsorId: 4 })
    expect(Vio.attribution('x', { sponsorId: 'nope' })).toEqual({ slot: 'x', campaignId: 10, sponsorId: 4 })
  })

  it('never throws on a broken bootstrap', async () => {
    init('web')
    await Vio.bootstrap()
    const g = globalThis as { __VIO_FACADE__?: { cachedBootstrap?: unknown } }
    g.__VIO_FACADE__!.cachedBootstrap = { campaign: 'what', campaigns: 'nope' }
    expect(() => Vio.attribution('hero')).not.toThrow()
  })
})

describe('Vio.content()', () => {
  it('answers {} without a document (SSR) and does not cache that', () => {
    init()
    expect(Vio.content()).toEqual({})
    vi.stubGlobal('document', { title: 'Later hydrated', querySelector: () => null })
    vi.stubGlobal('location', { pathname: '/sport/42', search: '' })
    expect(Vio.content()).toEqual({ id: '/sport/42', title: 'Later hydrated' })
  })

  it('is live: an SPA route change or a new title is seen without a re-init; init() may carry its own content', () => {
    const doc = { title: 'Article A', querySelector: () => null }
    const loc = { pathname: '/a', search: '' }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('location', loc)
    init()
    expect(Vio.content()).toEqual({ id: '/a', title: 'Article A' })
    doc.title = 'Article B'
    loc.pathname = '/b'
    expect(Vio.content()).toEqual({ id: '/b', title: 'Article B' })

    Vio.init({ apiKey: 'key-A', environment: 'testing', contentId: 123, contentTitle: 'From init' })
    expect(Vio.content()).toEqual({ id: '123', title: 'From init' })
    expect(Vio.attribution('hero')).toMatchObject({ slot: 'hero', contentId: '123', contentTitle: 'From init' })
  })
})

describe('Vio.cartSlices() — the split rule as public API', () => {
  const line = (over: Partial<CartLineItem>): CartLineItem => ({
    id: 'l',
    productId: 1,
    sponsorId: 4,
    brand: 'B',
    name: 'Lamp',
    unitPrice: 100,
    currency: 'NOK',
    imageUrl: '',
    quantity: 1,
    ...over,
  })

  it('is empty with an empty cart and pure over a given snapshot', async () => {
    init('web')
    await Vio.bootstrap()
    Vio.cart.clearAllCarts()
    expect(Vio.cartSlices()).toEqual([])
    const items = [
      line({ id: 'a', productId: 1, unitPrice: 100, quantity: 3, origins: [
        { campaignId: 12, slot: 'hero', contentId: 'art-1', quantity: 2 },
        { campaignId: 10, slot: 'carousel-1', contentId: 'art-1', quantity: 1 },
      ] }),
      line({ id: 'b', productId: 2, unitPrice: 33.333, quantity: 1 }), // no origins → resolved: sponsor 4 → default 10
    ]
    const slices = Vio.cartSlices(undefined, { items })
    expect(slices).toEqual([
      {
        campaignId: 12,
        sponsorId: 4,
        slot: 'hero',
        contentId: 'art-1',
        items: [{ productId: 1, name: 'Lamp', brand: 'B', variantId: undefined, price: 100, quantity: 2 }],
        value: 200,
        currency: 'NOK',
        slice: 1,
        slices: 2,
      },
      {
        campaignId: 10,
        sponsorId: 4,
        // Unique among the units that HAVE one: an originless unit (no slot, no
        // content) does not veto it. Two different slots would (see the analytics tests).
        slot: 'carousel-1',
        contentId: 'art-1',
        items: [
          { productId: 1, name: 'Lamp', brand: 'B', variantId: undefined, price: 100, quantity: 1 },
          { productId: 2, name: 'Lamp', brand: 'B', variantId: undefined, price: 33.333, quantity: 1 },
        ],
        value: 133.33,
        currency: 'NOK',
        slice: 2,
        slices: 2,
      },
    ])
    // The snapshot was not touched.
    expect(items[0]!.origins).toHaveLength(2)
  })

  it("reads the live cart, filters by sponsor, and resolves a slot's campaign for units without a campaignId", async () => {
    init('web')
    await Vio.bootstrap()
    Vio.cart.clearAllCarts()
    Vio.cart.addManual({ productId: 1, sponsorId: 4, brand: 'B', name: 'A', unitPrice: 10, currency: 'NOK', imageUrl: '', origin: { slot: 'hero' } })
    Vio.cart.addManual({ productId: 2, sponsorId: 7, brand: 'B', name: 'B', unitPrice: 20, currency: 'NOK', imageUrl: '' })
    const all = Vio.cartSlices()
    // hero → campaign 12 (slot assignment); sponsor 7 alone → its campaign 12 too → one slice of both sponsors
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ campaignId: 12, sponsorId: undefined, value: 30, slice: 1, slices: 1 })
    expect(Vio.cartSlices(4)).toHaveLength(1)
    expect(Vio.cartSlices(4)[0]).toMatchObject({ campaignId: 12, sponsorId: 4, slot: 'hero', value: 10 })
    expect(Vio.cartSlices(99)).toEqual([])
    Vio.cart.clearAllCarts()
  })

  it('never throws on odd input', () => {
    init('web')
    expect(Vio.cartSlices(undefined, { items: [null as unknown as CartLineItem, line({ quantity: NaN, origins: 'x' as never })] })).toEqual([])
  })
})

describe('page campaign (ADR-0034, amendment 3)', () => {
  const initWithCampaign = (campaignId: number | undefined) =>
    Vio.init({ apiKey: 'key-A', environment: 'testing', platform: 'web', campaignId })

  it('Vio.pageCampaign(): the init campaign when the bootstrap lists it as active; null otherwise', async () => {
    initWithCampaign(12)
    expect(Vio.pageCampaign()).toBeNull() // before the bootstrap
    await Vio.bootstrap()
    expect(Vio.pageCampaign()?.id).toBe(12)
    initWithCampaign(99)
    await Vio.bootstrap()
    expect(Vio.pageCampaign()).toBeNull()
    initWithCampaign(undefined)
    await Vio.bootstrap()
    expect(Vio.pageCampaign()).toBeNull()
    Vio.init({ apiKey: 'key-A', environment: 'testing', campaignId: -3 })
    expect(Vio.config.campaignId).toBeUndefined()
  })

  it('campaignForSlot / attribution: assignment > page campaign > default; the hint overrides the init page campaign', async () => {
    initWithCampaign(12)
    await Vio.bootstrap()
    // hero is assigned (to 12 anyway); carousel-1 has no assignment → the page's 12, not the default 10.
    expect(Vio.campaignForSlot('carousel-1')?.id).toBe(12)
    expect(Vio.campaignForSlot()?.id).toBe(12)
    expect(Vio.attribution('carousel-1')).toEqual({ slot: 'carousel-1', campaignId: 12, sponsorId: 7 })
    // An element's own campaign (vio-campaign / data-vio-campaign) over the page's.
    expect(Vio.campaignForSlot('carousel-1', { campaignId: 10 })?.id).toBe(10)
    expect(Vio.attribution('carousel-1', { campaignId: 10 })).toEqual({ slot: 'carousel-1', campaignId: 10, sponsorId: 4 })
    // With a known sponsor the page campaign applies only when the sponsor takes part in it:
    // 8 is a secondary of 12 → 12; 4 is not in 12 → its own campaign (the default's primary) → 10.
    expect(Vio.attribution('carousel-1', { sponsorId: 8 })).toEqual({ slot: 'carousel-1', campaignId: 12, sponsorId: 8 })
    expect(Vio.attribution('carousel-1', { sponsorId: 4 })).toEqual({ slot: 'carousel-1', campaignId: 10, sponsorId: 4 })
    // W7: the hint is a candidate list; an unusable level falls through; 0 = unset.
    expect(Vio.campaignForSlot('carousel-1', { campaignId: [99, 10] })?.id).toBe(10)
    expect(Vio.campaignForSlot('carousel-1', { campaignId: [99] })?.id).toBe(12) // → init's 12
    expect(Vio.campaignForSlot('carousel-1', { campaignId: 0 })?.id).toBe(12)
    expect(Vio.attribution('carousel-1', { campaignId: [0, 10] }).campaignId).toBe(10)
    // An assignment beats everything.
    expect(Vio.campaignForSlot('hero', { campaignId: 10 })?.id).toBe(12)
    // attribution and campaignForSlot agree.
    for (const slot of ['hero', 'carousel-1', 'sidebar', undefined]) {
      expect(Vio.attribution(slot).campaignId).toBe(Vio.campaignForSlot(slot)?.id)
    }
  })

  it("a page-sourced assignment counts like the page campaign for a known sponsor (attribution agrees with campaignForSlot)", async () => {
    initWithCampaign(12)
    await Vio.bootstrap()
    const g = globalThis as { __VIO_FACADE__?: { cachedBootstrap?: BootstrapResponse } }
    g.__VIO_FACADE__!.cachedBootstrap = {
      campaign: { id: 10, name: 'Default' },
      primarySponsor: sponsor(4),
      campaigns: [
        { id: 10, name: 'Default', status: 'active', isDefault: true, primarySponsor: sponsor(4), slots: [] },
        { id: 12, name: 'Page', status: 'active', primarySponsor: sponsor(7), slots: [{ name: 'by-page', source: 'page' }, { name: 'by-dash', source: 'dashboard' }] },
        { id: 14, name: 'Other', status: 'active', primarySponsor: sponsor(9), slots: [] },
      ],
    }
    expect(Vio.attribution('by-page', { sponsorId: 9 })).toEqual({ slot: 'by-page', campaignId: 14, sponsorId: 9 })
    expect(Vio.attribution('free', { sponsorId: 9 })).toEqual({ slot: 'free', campaignId: 14, sponsorId: 9 })
    expect(Vio.attribution('by-dash', { sponsorId: 9 })).toEqual({ slot: 'by-dash', campaignId: 12, sponsorId: 9 })
    expect(Vio.campaignForSlot('by-page', { sponsorId: 9 })?.id).toBe(14)
    expect(Vio.campaignForSlot('by-dash', { sponsorId: 9 })?.id).toBe(12)
    expect(Vio.campaignForSlot('by-page')?.id).toBe(12)
  })

  it('an inactive page campaign falls through to the default', async () => {
    initWithCampaign(99)
    await Vio.bootstrap()
    expect(Vio.campaignForSlot('carousel-1')?.id).toBe(10)
    expect(Vio.attribution('carousel-1').campaignId).toBe(10)
  })

  it('the manifest carries the page campaign top-level, and a location its own only when it differs', async () => {
    initWithCampaign(12)
    expect(await Vio.declareSlots(['hero', { id: 'side', campaignId: 12 }, { id: 'other', campaignId: 10 }])).toEqual(MANIFEST_OK)
    expect(manifestRequests()[0]!.body).toEqual({
      platform: 'web',
      mode: 'merge',
      locations: [{ id: 'hero' }, { id: 'side' }, { id: 'other', campaignId: 10 }],
      campaignId: 12,
    })
    // Without a page campaign: no top-level field, locations keep their own.
    initWithCampaign(undefined)
    expect(await Vio.declareSlots([{ id: 'solo', campaignId: 10 }])).toEqual(MANIFEST_OK)
    expect(manifestRequests()[1]!.body).toEqual({ platform: 'web', mode: 'merge', locations: [{ id: 'solo', campaignId: 10 }] })
  })

  it('the memory key includes the campaign: A → B → A declares three times (one state per id), a revisit none', async () => {
    initWithCampaign(12)
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(await Vio.declareSlots(['hero'])).toBeNull()
    initWithCampaign(10)
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()[1]!.body).toMatchObject({ campaignId: 10 })
    expect(await Vio.declareSlots(['hero'])).toBeNull()
    // B1: back to A within 24 h — B replaced A's memory, so A goes out again.
    initWithCampaign(12)
    expect(await Vio.declareSlots(['hero'])).toEqual(MANIFEST_OK)
    expect(manifestRequests()[2]!.body).toMatchObject({ campaignId: 12 })
    expect(await Vio.declareSlots(['hero'])).toBeNull()
    expect(await Vio.declareSlots([{ id: 'hero', campaignId: 7 }])).toEqual(MANIFEST_OK) // its own campaign is another state
    expect(manifestRequests()).toHaveLength(4)
  })

  it('registerSlot(name, displayName, campaignId) reaches the manifest; a later campaign for the id re-declares', async () => {
    vi.useFakeTimers()
    initWithCampaign(12)
    await Vio.bootstrap()
    const offs = [Vio.registerSlot('carousel-1', 'Carousel 1'), Vio.registerSlot('hero', undefined, 10)]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()[0]!.body).toEqual({
      platform: 'web',
      mode: 'merge',
      locations: [{ id: 'carousel-1', displayName: 'Carousel 1' }, { id: 'hero', campaignId: 10 }],
      campaignId: 12,
    })
    offs.push(Vio.registerSlot('hero', undefined, 7))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(2)
    expect(manifestRequests()[1]!.body).toMatchObject({ locations: [{ id: 'hero', campaignId: 7 }] })
    offs.forEach((off) => off())
  })

  const warningsIncluding = (text: string) =>
    (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[1]).includes(text))

  it("warns ONCE per slot when the dashboard's assignment stands (only for a slot the page sent a campaign for); debug only when enabled; reset on init", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    initWithCampaign(12)
    manifestAnswer = () =>
      jsonResponse({
        ...MANIFEST_OK,
        locations: [
          { id: 1, locationId: 'hero', assignment: 'dashboard' },
          { id: 2, locationId: 'carousel-1', assignment: 'created' },
        ],
      })
    await Vio.declareSlots(['hero', 'carousel-1'], { force: true })
    await Vio.declareSlots(['hero', 'carousel-1'], { force: true })
    expect(console.debug).not.toHaveBeenCalled() // W6: debug is off
    expect(warningsIncluding('assigned from the dashboard')).toHaveLength(1)
    expect(warningsIncluding('assigned from the dashboard')[0]![1]).toContain('slot hero is assigned from the dashboard')

    // Reset on init: the same slot warns once more under the new configuration; debug now on.
    Vio.init({ apiKey: 'key-A', environment: 'testing', campaignId: 12, debug: true })
    await Vio.declareSlots(['hero'], { force: true })
    expect(warningsIncluding('assigned from the dashboard')).toHaveLength(2)
    expect(console.debug).toHaveBeenCalledWith('[Vio] slot', 'hero', 'assignment:', 'dashboard')

    // No campaign sent for the slot: nothing to warn about, whatever the micro says.
    initWithCampaign(undefined)
    await Vio.declareSlots(['hero'], { force: true })
    expect(warningsIncluding('assigned from the dashboard')).toHaveLength(2)
  })

  it("W2a: warns once per slot when this page moved it from an earlier page assignment ('replaced')", async () => {
    initWithCampaign(12)
    manifestAnswer = () =>
      jsonResponse({ ...MANIFEST_OK, locations: [{ id: 1, locationId: 'carousel-1', assignment: 'replaced' }] })
    await Vio.declareSlots(['carousel-1'], { force: true })
    await Vio.declareSlots([{ id: 'carousel-1', campaignId: 10 }], { force: true })
    expect(warningsIncluding('moved to campaign')).toHaveLength(1)
    expect(warningsIncluding('moved to campaign')[0]![1]).toContain('slot carousel-1 moved to campaign 12 by this page')
  })

  it('W3: a campaign the micro did not take up is remembered for 1 h, not 24 h (old micro without assignment; none for an active campaign)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
    initWithCampaign(12)
    await Vio.bootstrap()
    // Old micro: no `assignment` anywhere.
    manifestAnswer = () => jsonResponse({ ...MANIFEST_OK, locations: [{ id: 1, locationId: 'hero' }, { id: 2, locationId: 'plain' }] })
    expect(await Vio.declareSlots(['hero', 'plain'])).toEqual(expect.objectContaining({ mode: 'merge' }))
    vi.setSystemTime(new Date('2026-10-16T10:30:00Z'))
    expect(await Vio.declareSlots(['hero', 'plain'])).toBeNull()
    vi.setSystemTime(new Date('2026-10-16T11:00:01Z'))
    expect(await Vio.declareSlots(['hero', 'plain'])).toEqual(expect.objectContaining({ mode: 'merge' }))
    expect(manifestRequests()[1]!.body).toMatchObject({ locations: [{ id: 'hero' }, { id: 'plain' }] })

    // `none` for an active campaign (12) → 1 h; `created` → 24 h; `none` for an unknown one is fine.
    // (A fresh init: the per-load cap of 3 manifests would otherwise stop the 4th POST below.)
    initWithCampaign(12)
    await Vio.bootstrap()
    manifestAnswer = () =>
      jsonResponse({
        ...MANIFEST_OK,
        locations: [
          { id: 1, locationId: 'a', assignment: 'none' },
          { id: 2, locationId: 'b', assignment: 'created' },
          { id: 3, locationId: 'c', assignment: 'none' },
        ],
      })
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'))
    await Vio.declareSlots(['a', 'b', { id: 'c', campaignId: 99 }])
    vi.setSystemTime(new Date('2026-10-16T13:00:01Z'))
    expect(await Vio.declareSlots(['a', 'b', { id: 'c', campaignId: 99 }])).toEqual(expect.objectContaining({ mode: 'merge' }))
    expect(manifestRequests().at(-1)!.body).toMatchObject({ locations: [{ id: 'a' }] })
  })

  it('nit: registerSlot(id, name, -5) does not mark the registry changed', async () => {
    vi.useFakeTimers()
    initWithCampaign(undefined)
    await Vio.bootstrap()
    const off1 = Vio.registerSlot('hero', 'Hero', 12)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(1)
    const off2 = Vio.registerSlot('hero', 'Hero', -5)
    const off3 = Vio.registerSlot('hero', 'Hero', 'x')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(manifestRequests()).toHaveLength(1)
    off1()
    off2()
    off3()
  })
})

describe('slot kind in the manifest (ADR-0034, amendment 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('registerSlot(id, name, { kind }) and { kind, campaignId } reach the manifest as `kind`; (id), (id, name) and (id, name, campaignId) still work', async () => {
    init()
    await Vio.bootstrap()
    const offs = [
      Vio.registerSlot('carousel-1', 'Carousel 1', { kind: 'carousel' }),
      Vio.registerSlot('hero', 'Hero', { kind: 'card', campaignId: 10 }),
      Vio.registerSlot('footer'),
      Vio.registerSlot('aside', 'Aside', 12),
    ]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(1)
    expect(manifestRequests()[0]!.body).toEqual({
      platform: 'web',
      mode: 'merge',
      locations: [
        { id: 'carousel-1', displayName: 'Carousel 1', kind: 'carousel' },
        { id: 'hero', displayName: 'Hero', campaignId: 10, kind: 'card' },
        { id: 'footer' },
        { id: 'aside', displayName: 'Aside', campaignId: 12 },
      ],
    })
    offs.forEach((off) => off())
  })

  it('W4: registerSlot(id, name, campaignId, { kind }) — the campaign positional, the kind fourth — is what the elements send, so a 0.24 facade keeps the campaign', async () => {
    init()
    await Vio.bootstrap()
    const offs = [Vio.registerSlot('hero', 'Hero', 10, { kind: 'card' }), Vio.registerSlot('side', undefined, 12, { kind: 'CAROUSEL' })]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()[0]!.body).toEqual({
      platform: 'web',
      mode: 'merge',
      locations: [
        { id: 'hero', displayName: 'Hero', campaignId: 10, kind: 'card' },
        { id: 'side', campaignId: 12, kind: 'carousel' },
      ],
    })
    offs.forEach((off) => off())
  })

  it('the first kind an id gets stays: the cards a carousel renders share its id without turning it into a card', async () => {
    init()
    await Vio.bootstrap()
    const offs = [
      Vio.registerSlot('hero', undefined, { kind: 'carousel' }),
      Vio.registerSlot('hero', undefined, { kind: 'card' }),
      Vio.registerSlot('hero', undefined, { kind: 'card' }),
    ]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(1)
    expect(manifestRequests()[0]!.body).toMatchObject({ locations: [{ id: 'hero', kind: 'carousel' }] })
    offs.forEach((off) => off())
  })

  it('a kind learned later for an id without one re-declares (new memory key); Vio.declareSlots takes kind too', async () => {
    init()
    await Vio.bootstrap()
    const off1 = Vio.registerSlot('hero')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(1)
    const off2 = Vio.registerSlot('hero', undefined, { kind: ' detail ' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(manifestRequests()).toHaveLength(2)
    expect(manifestRequests()[1]!.body).toMatchObject({ locations: [{ id: 'hero', kind: 'detail' }] })
    expect(await Vio.declareSlots([{ id: 'sidebar', displayName: 'Sidebar', kind: 'k'.repeat(40) }])).toEqual(MANIFEST_OK)
    expect(manifestRequests()[2]!.body).toEqual({
      platform: 'web',
      mode: 'merge',
      locations: [{ id: 'sidebar', displayName: 'Sidebar', kind: 'k'.repeat(32) }],
    })
    off1()
    off2()
  })
})
