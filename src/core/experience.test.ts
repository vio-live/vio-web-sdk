// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cueProductAt,
  EXPERIENCE_CACHE_TTL_MS,
  experienceCacheKey,
  experienceCompatible,
  experienceProductRefs,
  keyTag,
  parseExperience,
  readCachedExperience,
  safeThemeEntries,
  writeCachedExperience,
} from './experience.js'

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

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))

const wire = () => ({
  schemaVersion: 1,
  id: 7,
  revision: 3,
  publishedAt: '2026-11-05T12:00:00.000Z',
  campaignId: 12,
  sponsorId: 1338,
  campaign: { id: 12, name: 'Careless Aller' },
  title: 'Slik styler du Careless',
  binding: { slot: null },
  theme: { '--vio-radius-lg': '4px', color: 'red', '--vio-color-accent': 'url(https://evil)' },
  videos: [
    {
      id: 'influencer',
      title: 'Se og shop',
      media: { mediaId: 1, provider: 'cloudflare-stream', playbackUrl: 'https://v.test/a/manifest/video.m3u8', dashUrl: null, posterUrl: 'https://v.test/a.jpg', durationSeconds: 12.5, width: 1080, height: 1920 },
      products: [
        { productId: 416052, imageOverrideUrl: 'https://cdn.test/a.jpg', focal: { x: 0.5, y: 0.2 } },
        { productId: 416053, imageOverrideUrl: null, focal: null },
        { productId: 'nope' },
      ],
      cues: [
        { productId: 416053, at: 8 },
        { productId: 416052, at: 2.5 },
        { productId: 999, at: 1 },
      ],
    },
    { id: 'broken', title: null, media: { playbackUrl: '' }, products: [], cues: [] },
  ],
})

describe('parseExperience', () => {
  it('keeps what the reel can play and sorts the cues', () => {
    const exp = parseExperience(wire())!
    expect(exp).toMatchObject({ id: 7, revision: 3, campaignId: 12, sponsorId: 1338, title: 'Slik styler du Careless' })
    expect(exp.videos).toHaveLength(1)
    const [v] = exp.videos
    expect(v!.products.map((p) => p.productId)).toEqual([416052, 416053])
    expect(v!.products[0]!.focal).toEqual({ x: 0.5, y: 0.2 })
    expect(v!.cues).toEqual([
      { productId: 416052, at: 2.5 },
      { productId: 416053, at: 8 },
    ])
    expect(v!.media.playbackUrl).toBe('https://v.test/a/manifest/video.m3u8')
    expect(exp.theme).toEqual({ '--vio-radius-lg': '4px', color: 'red', '--vio-color-accent': 'url(https://evil)' })
  })

  it('is null for another schema, no id or no campaign', () => {
    expect(parseExperience({ ...wire(), schemaVersion: 2 })).toBeNull()
    expect(parseExperience({ ...wire(), id: 0 })).toBeNull()
    expect(parseExperience({ ...wire(), campaignId: undefined })).toBeNull()
    expect(parseExperience('nope')).toBeNull()
    expect(parseExperience(null)).toBeNull()
  })

  it('a preview has no revision and says so', () => {
    const exp = parseExperience({ ...wire(), revision: null, preview: true })!
    expect(exp.revision).toBeNull()
    expect(exp.preview).toBe(true)
  })
})

describe('rules', () => {
  it('compatibility: a page without a campaign takes any; a page with one takes only its own', () => {
    expect(experienceCompatible({ campaignId: 12 }, [])).toBe(true)
    expect(experienceCompatible({ campaignId: 12 }, [12])).toBe(true)
    expect(experienceCompatible({ campaignId: 12 }, [5, 12])).toBe(true)
    expect(experienceCompatible({ campaignId: 12 }, [5])).toBe(false)
  })

  it('cueProductAt names the latest cue at or before the second', () => {
    const cues = [
      { productId: 1, at: 2.5 },
      { productId: 2, at: 8 },
    ]
    expect(cueProductAt(cues, 0)).toBeNull()
    expect(cueProductAt(cues, 2.5)).toBe(1)
    expect(cueProductAt(cues, 7.9)).toBe(1)
    expect(cueProductAt(cues, 8)).toBe(2)
    expect(cueProductAt([], 5)).toBeNull()
  })

  it('safeThemeEntries keeps only --vio-* tokens with harmless values', () => {
    expect(safeThemeEntries(parseExperience(wire())!.theme)).toEqual([['--vio-radius-lg', '4px']])
    expect(safeThemeEntries({ '--vio-x': 'red; } body { display:none' })).toEqual([])
    expect(safeThemeEntries(null)).toEqual([])
  })

  it('experienceProductRefs: every product once, with the sponsor of the experience', () => {
    const exp = parseExperience({ ...wire(), videos: [wire().videos[0], { ...wire().videos[0], id: 'two' }] })!
    expect(experienceProductRefs(exp)).toEqual([
      { sponsorId: 1338, productId: 416052 },
      { sponsorId: 1338, productId: 416053 },
    ])
  })
})

describe('cache', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('the key tags the surface key without storing it', () => {
    const key = experienceCacheKey('mote_livestill_hub_api_key_secret', 7)
    expect(key).toBe(`vio.reel.${keyTag('mote_livestill_hub_api_key_secret')}.7`)
    expect(key).not.toContain('secret')
    expect(experienceCacheKey('other_key', 7)).not.toBe(key)
  })

  it('writes and reads back; drops what is too old or broken', () => {
    const key = experienceCacheKey('k', 7)
    const experience = parseExperience(wire())!
    writeCachedExperience(key, { etag: 'W/"exp-7-r3"', experience, savedAt: 1_000 })
    expect(readCachedExperience(key, 2_000)).toEqual({ etag: 'W/"exp-7-r3"', experience, savedAt: 1_000 })
    expect(readCachedExperience(key, 1_000 + EXPERIENCE_CACHE_TTL_MS + 1)).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
    localStorage.setItem(key, '{not json')
    expect(readCachedExperience(key)).toBeNull()
  })
})
