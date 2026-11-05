// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, settle, unmountAll } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { experienceCacheKey, readCachedExperience } from '../../core/experience.js'

/** jsdom here has no usable localStorage (opaque origin): a Map stands in. */
function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size
    },
  } as Storage
}

/**
 * `<vio-reel>` against a fake API and a fake commerce client (ADR-0042):
 * what it renders, what it refuses, what it caches and what it reports.
 */

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  observed: Element[] = []
  constructor(readonly cb: (entries: unknown[]) => void) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  disconnect(): void {}
  /** What it observes is on screen (ratio) — or not. */
  show(ratio = 1): void {
    for (const target of this.observed) this.cb([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }])
  }
}

const experience = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 7,
  revision: 3,
  publishedAt: '2026-11-05T12:00:00.000Z',
  campaignId: 12,
  sponsorId: 1338,
  campaign: { id: 12, name: 'Careless Aller' },
  title: 'Slik styler du Careless',
  binding: { slot: null },
  theme: { '--vio-color-accent': '#ff0066' },
  videos: [
    {
      id: 'influencer',
      title: 'Se og shop',
      media: { mediaId: 1, provider: 'url', playbackUrl: 'https://v.test/a.mp4', dashUrl: null, posterUrl: 'https://v.test/a.jpg', durationSeconds: 12, width: 1080, height: 1920 },
      products: [
        { productId: 416052, imageOverrideUrl: 'https://cdn.test/override.jpg', focal: { x: 0.5, y: 0.2 } },
        { productId: 416053, imageOverrideUrl: null, focal: null },
      ],
      cues: [
        { productId: 416052, at: 2 },
        { productId: 416053, at: 8 },
      ],
    },
    {
      id: 'spray',
      title: null,
      media: { mediaId: 2, provider: 'url', playbackUrl: 'https://v.test/b.mp4', dashUrl: null, posterUrl: null, durationSeconds: 6, width: null, height: null },
      products: [{ productId: 416056, imageOverrideUrl: null, focal: null }],
      cues: [],
    },
  ],
  ...over,
})

const products = [
  { id: 416052, brand: 'Faves', title: 'Dr. Michael Zangani Skin Restore', price: { amount: 524, currency_code: 'NOK' }, images: [{ url: 'https://cdn.test/52.jpg' }], variants: [] },
  { id: 416053, brand: 'Faves', title: 'Hair spray', price: { amount: 299, currency_code: 'NOK' }, images: [{ url: 'https://cdn.test/53.jpg' }], variants: [] },
  { id: 416056, brand: 'Faves', title: 'Texture spray', price: { amount: 199, currency_code: 'NOK' }, images: [], variants: [] },
]

const events: Array<Record<string, any>> = []
const onAnalytics = (e: Event) => events.push((e as CustomEvent).detail)
let fetchMock: ReturnType<typeof vi.fn>
let getByIds: ReturnType<typeof vi.fn>
let play: ReturnType<typeof vi.fn>

const apiKey = 'test-surface-key'

/** The experience endpoint answers `body`; every other fetch (slot declaration, analytics) gets an empty 200. A fresh Response per call: a body reads once. */
function answer(body: unknown, init: { status?: number; etag?: string } = {}) {
  return (url: unknown) =>
    Promise.resolve(
      String(url).includes('/v2/experiences/')
        ? new Response(init.status === 304 ? null : JSON.stringify(body), {
            status: init.status ?? 200,
            headers: { 'Content-Type': 'application/json', ...(init.etag ? { ETag: init.etag } : {}) },
          })
        : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
}
const failing = () => (url: unknown) =>
  String(url).includes('/v2/experiences/') ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response('{}', { status: 200 }))

beforeEach(() => {
  events.length = 0
  vi.stubGlobal('localStorage', memoryStorage())
  FakeIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  play = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { configurable: true, value: vi.fn() })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  fetchMock = vi.fn().mockImplementation(answer(experience(), { etag: 'W/"exp-7-r3"' }))
  vi.stubGlobal('fetch', fetchMock)
  Vio.init({ apiKey, eventsBase: 'https://events.test' })
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

async function mountReel(props: Record<string, unknown> = {}) {
  const el = await mount<HTMLElement>('vio-reel', { experienceId: 7, ...props } as any)
  for (let i = 0; i < 5; i++) await settle(el)
  return el
}

const root = (el: HTMLElement) => el.shadowRoot!
const cards = (el: HTMLElement, index = 0) => Array.from(root(el).querySelectorAll(`.item[data-index="${index}"] .card`)) as HTMLElement[]
const apiCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/v2/experiences/'))

describe('vio-reel — what it shows', () => {
  it('fetches the experience with the surface key, the products with the sponsor and campaign, and renders videos and cards', async () => {
    const el = await mountReel()
    expect(apiCalls()).toHaveLength(1)
    const [url, init] = apiCalls()[0]!
    expect(String(url)).toBe('https://api-staging.vio.live/v2/experiences/7')
    expect((init as RequestInit).headers).toMatchObject({ 'X-API-Key': apiKey })
    expect(Vio.commerceFor).toHaveBeenCalledWith(1338, { campaignId: 12 })
    expect(getByIds).toHaveBeenCalledWith({ product_ids: [416052, 416053, 416056], currency: 'NOK', image_size: 'large' })

    const videos = root(el).querySelectorAll('video')
    expect(videos).toHaveLength(2)
    expect(videos[0]!.getAttribute('poster')).toBe('https://v.test/a.jpg')
    expect(videos[0]!.getAttribute('preload')).toBe('auto')
    expect(videos[1]!.getAttribute('preload')).toBe('metadata')
    expect(videos[0]!.hasAttribute('loop')).toBe(true)
    expect(videos[0]!.hasAttribute('playsinline')).toBe(true)

    const first = cards(el, 0)
    expect(first).toHaveLength(2)
    expect(first[0]!.textContent).toContain('Dr. Michael Zangani Skin Restore')
    expect(first[0]!.textContent).toContain('524')
    // The editor's image wins over the catalogue's, with its focal point.
    const img = first[0]!.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://cdn.test/override.jpg')
    expect(img.getAttribute('style')).toContain('object-position:50% 20%')
    expect(first[1]!.querySelector('img')!.getAttribute('src')).toBe('https://cdn.test/53.jpg')
    // Theme tokens land on the element, nothing else.
    expect(el.style.getPropertyValue('--vio-color-accent')).toBe('#ff0066')
    expect(root(el).textContent).toContain('1/2')
  })

  it('plays the video on screen (muted), wires only it and its neighbour, pauses the rest', async () => {
    const el = await mountReel()
    // The playback observer watches the reel itself (is it on the page's screen?); the feed's scroll picks the
    // video. The analytics impression observer watches the reel too, so every observer of the element is told.
    const ios = FakeIntersectionObserver.instances.filter((o) => o.observed.includes(el))
    expect(ios.length).toBeGreaterThanOrEqual(1)
    const io = { show: (ratio = 1) => ios.forEach((o) => o.show(ratio)) }
    io.show(1)
    for (let i = 0; i < 3; i++) await settle(el)
    const videos = root(el).querySelectorAll('video')
    expect(videos[0]!.getAttribute('src')).toBe('https://v.test/a.mp4')
    expect(videos[1]!.getAttribute('src')).toBe('https://v.test/b.mp4')
    expect(videos[0]!.muted).toBe(true)
    expect(play).toHaveBeenCalled()
    // view_item_list for the video that became active, with its products and the experience ids.
    const lists = events.filter((e) => e.name === 'view_item_list')
    expect(lists).toHaveLength(1)
    expect(lists[0]!.props).toMatchObject({ experience_id: 7, video_id: 'influencer', revision: 3 })
    expect(lists[0]!.commerce.items.map((i: any) => i.product_id)).toEqual(['416052', '416053'])
    expect(lists[0]!.context).toMatchObject({ sponsor_id: 1338, component_template_id: 'reel' })

    // The reader swipes to the second video (jsdom has no layout: activate by index, as the scroll handler would).
    await (el as any).activate(1)
    for (let i = 0; i < 3; i++) await settle(el)
    expect(root(el).textContent).toContain('2/2')
    expect(events.filter((e) => e.name === 'view_item_list')).toHaveLength(2)

    // Scrolled away from the reel: everything pauses; back: it plays again.
    const pause = HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>
    pause.mockClear()
    io.show(0)
    expect(pause).toHaveBeenCalled()
  })

  it('without any observer callback the first video still starts after a moment', async () => {
    const el = await mountReel()
    expect(root(el).querySelector('video')!.getAttribute('src')).toBeNull()
    await new Promise((r) => setTimeout(r, 500))
    await settle(el)
    expect(root(el).querySelector('video')!.getAttribute('src')).toBe('https://v.test/a.mp4')
  })

  it('the cue badge follows the second of the video', async () => {
    const el = await mountReel()
    FakeIntersectionObserver.instances.filter((o) => o.observed.includes(el)).forEach((o) => o.show(1))
    for (let i = 0; i < 3; i++) await settle(el)
    const video = root(el).querySelector('video')!
    const at = (t: number) => {
      Object.defineProperty(video, 'currentTime', { configurable: true, value: t })
      Object.defineProperty(video, 'duration', { configurable: true, value: 12 })
      video.dispatchEvent(new Event('timeupdate'))
    }
    expect(root(el).querySelector('.cue')).toBeNull()
    at(2.5)
    await settle(el)
    expect(cards(el)[0]!.classList.contains('current')).toBe(true)
    expect(cards(el)[0]!.querySelector('.cue')!.textContent).toBe('I videoen nå')
    at(9)
    await settle(el)
    expect(cards(el)[1]!.classList.contains('current')).toBe(true)
    expect(cards(el)[0]!.classList.contains('current')).toBe(false)
  })

  it('a card click emits vio:product-click like a <vio-product> — sponsor, campaign, experience — and does not pause the video', async () => {
    const el = await mountReel({ vioSlot: 'reel-a' })
    FakeIntersectionObserver.instances.filter((o) => o.observed.includes(el)).forEach((o) => o.show(1))
    for (let i = 0; i < 3; i++) await settle(el)
    const seen: any[] = []
    document.addEventListener('vio:product-click', (e) => seen.push((e as CustomEvent).detail))
    const pause = HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>
    pause.mockClear()
    cards(el)[0]!.click()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      productId: '416052',
      sponsorId: '1338',
      campaignId: 12,
      experienceId: 7,
      videoId: 'influencer',
      revision: 3,
      slot: 'reel-a',
      componentTemplateId: 'reel',
      name: 'Dr. Michael Zangani Skin Restore',
      imageUrl: 'https://cdn.test/override.jpg',
    })
    expect(pause).not.toHaveBeenCalled()
  })

  it('the impression carries the products shown and the experience ids', async () => {
    const el = await mountReel({ vioSlot: 'reel-imp' })
    // The impression observer is the one created after the products loaded (the playback one came first on setup).
    vi.useFakeTimers()
    for (const io of FakeIntersectionObserver.instances) io.cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }])
    vi.advanceTimersByTime(1_000)
    vi.useRealTimers()
    const imp = events.filter((e) => e.name === 'component_impression')
    expect(imp).toHaveLength(1)
    expect(imp[0]!.context).toMatchObject({ location_id: 'reel-imp', component_template_id: 'reel', sponsor_id: 1338 })
    expect(imp[0]!.props).toMatchObject({ experience_id: 7, revision: 3, videos: 2 })
    expect(imp[0]!.commerce.items.map((i: any) => i.product_id)).toEqual(['416052', '416053', '416056'])
  })

  it('renders from the `experience` property without fetching (the editor preview)', async () => {
    const el = await mountReel({ experienceId: 0, experience: experience({ revision: null, preview: true }) })
    expect(apiCalls()).toHaveLength(0)
    expect(root(el).querySelectorAll('video')).toHaveLength(2)
  })
})

describe('vio-reel — what it refuses and what it keeps', () => {
  it('an experience of another campaign than the page renders nothing and reports reel_incompatible', async () => {
    document.body.setAttribute('data-vio-campaign', '5')
    try {
      const el = await mountReel()
      expect(root(el).querySelector('video')).toBeNull()
      expect(root(el).querySelector('.reel')).toBeNull()
      expect(getByIds).not.toHaveBeenCalled()
      const err = events.find((e) => e.name === 'sdk_error')!
      expect(err.context).toMatchObject({ error_code: 'reel_incompatible' })
      expect(err.props).toMatchObject({ experience_id: 7, page_campaigns: [5] })
      expect(console.warn).toHaveBeenCalled()
    } finally {
      document.body.removeAttribute('data-vio-campaign')
    }
  })

  it('a page of the same campaign shows it', async () => {
    document.body.setAttribute('data-vio-campaign', '12')
    try {
      const el = await mountReel()
      expect(root(el).querySelectorAll('video')).toHaveLength(2)
    } finally {
      document.body.removeAttribute('data-vio-campaign')
    }
  })

  it('keeps the last good revision: shows the cached one at once, asks with If-None-Match, stores a newer one for the next mount', async () => {
    await mountReel()
    const key = experienceCacheKey(apiKey, 7)
    expect(readCachedExperience(key)?.etag).toBe('W/"exp-7-r3"')
    unmountAll()

    // The API publishes revision 4 with another title.
    fetchMock.mockImplementation(answer(experience({ revision: 4, title: 'Versjon fire' }), { etag: 'W/"exp-7-r4"' }))
    const el = await mountReel()
    const [, init] = apiCalls().at(-1)!
    expect((init as RequestInit).headers).toMatchObject({ 'If-None-Match': 'W/"exp-7-r3"' })
    // Still revision 3 on screen; 4 is stored for the next open.
    expect(root(el).textContent).toContain('Slik styler du Careless')
    expect(root(el).textContent).not.toContain('Versjon fire')
    expect(readCachedExperience(key)?.experience.revision).toBe(4)
    unmountAll()

    const again = await mountReel()
    expect(root(again).textContent).toContain('Versjon fire')
  })

  it('a 304 keeps the cached revision; a network failure with a cached copy still renders', async () => {
    await mountReel()
    unmountAll()
    fetchMock.mockImplementation(answer(null, { status: 304, etag: 'W/"exp-7-r3"' }))
    const el = await mountReel()
    expect(root(el).querySelectorAll('video')).toHaveLength(2)
    unmountAll()
    fetchMock.mockImplementation(failing())
    const offline = await mountReel()
    expect(root(offline).querySelectorAll('video')).toHaveLength(2)
  })

  it('without a cached copy, a 404 or a network failure renders nothing', async () => {
    fetchMock.mockImplementation(answer({ message: 'Experience not found' }, { status: 404 }))
    const el = await mountReel()
    expect(root(el).querySelector('.reel')).toBeNull()
    expect(readCachedExperience(experienceCacheKey(apiKey, 7))).toBeNull()
    unmountAll()
    fetchMock.mockImplementation(failing())
    const el2 = await mountReel()
    expect(root(el2).querySelector('.reel')).toBeNull()
  })

  it('a preview (revision null) is never written to the cache', async () => {
    fetchMock.mockImplementation(answer(experience({ revision: null, preview: true })))
    await mountReel()
    expect(readCachedExperience(experienceCacheKey(apiKey, 7))).toBeNull()
  })

  it('the products failing to load leaves the videos playing with empty cards', async () => {
    getByIds.mockRejectedValue(new Error('GraphQL down'))
    const el = await mountReel()
    expect(root(el).querySelectorAll('video')).toHaveLength(2)
    expect(cards(el)).toHaveLength(2)
    expect(cards(el)[0]!.textContent?.trim()).toBe('')
  })
})
