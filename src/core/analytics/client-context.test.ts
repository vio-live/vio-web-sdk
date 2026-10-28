/**
 * The `client` block (EVENTS_CONTRACT "client", 2026-10-19): read from the
 * browser's globals, capped to the collector's limits, and the landing
 * (referrer + utm) remembered for the session so later pages report where
 * the visit came from — never their own internal referrer. Pure: the globals
 * are injected here.
 */

import { describe, expect, it } from 'vitest'
import {
  CLIENT_LANGUAGE_MAX_LENGTH,
  CLIENT_REFERRER_MAX_LENGTH,
  CLIENT_SCREEN_MAX,
  CLIENT_TZ_MAX_LENGTH,
  CLIENT_UTM_MAX_LENGTH,
  LANDING_KEY,
  isSameHost,
  landingReferrer,
  landingUrl,
  persistLanding,
  removeLanding,
  resolveClientContext,
  resolveLanding,
  utmOf,
  type ClientEnvironment,
  type StorageLike,
} from './client-context.js'

function fakeStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  }
}

/** A page of the session: its own referrer and URL, the shared session storage. */
function page(over: Partial<ClientEnvironment> = {}): ClientEnvironment {
  return {
    navigator: { language: 'nb-NO' },
    document: { referrer: 'https://news.example/front' },
    location: { search: '' },
    screen: { width: 390, height: 844 },
    storage: null,
    timeZone: () => 'Europe/Oslo',
    ...over,
  }
}

describe('resolveClientContext', () => {
  it('reads language, referrer, utm, screen and tz — and nothing the collector derives itself', () => {
    const env = page({ location: { search: '?utm_source=nyhetsbrev&utm_medium=email&utm_campaign=okt&x=1' } })
    expect(resolveClientContext(env)).toEqual({
      language: 'nb-NO',
      referrer: 'https://news.example/front',
      utm_source: 'nyhetsbrev',
      utm_medium: 'email',
      utm_campaign: 'okt',
      screen_w: 390,
      screen_h: 844,
      tz: 'Europe/Oslo',
    })
  })

  it('caps every field to the collector (language 16, referrer 2048, utm 128, tz 64, screen ≤ 65 535 ints)', () => {
    const env = page({
      navigator: { language: 'x'.repeat(40) },
      document: { referrer: `https://r.example/${'p'.repeat(3000)}` },
      location: { search: `?utm_source=${'s'.repeat(300)}&utm_term=${'t'.repeat(200)}` },
      screen: { width: 99_999, height: 1080.7 },
      timeZone: () => 'z'.repeat(100),
    })
    const out = resolveClientContext(env)
    expect(out.language).toHaveLength(CLIENT_LANGUAGE_MAX_LENGTH)
    expect(out.referrer).toHaveLength(CLIENT_REFERRER_MAX_LENGTH)
    expect(out.utm_source).toHaveLength(CLIENT_UTM_MAX_LENGTH)
    expect(out.utm_term).toHaveLength(CLIENT_UTM_MAX_LENGTH)
    expect(out.tz).toHaveLength(CLIENT_TZ_MAX_LENGTH)
    expect(out.screen_w).toBe(CLIENT_SCREEN_MAX)
    expect(out.screen_h).toBe(1080)
  })

  it('answers {} without a browser, and never throws on a missing or throwing API', () => {
    expect(resolveClientContext({})).toEqual({})
    expect(resolveClientContext({ navigator: null, document: null, location: null, screen: null, storage: null })).toEqual({})
    const hostile: ClientEnvironment = {
      navigator: { language: 'en' },
      get document(): { referrer?: unknown } {
        throw new Error('no document for you')
      },
      screen: { width: 'wide', height: -1 },
      timeZone: () => {
        throw new Error('no Intl')
      },
      storage: {
        getItem: () => {
          throw new Error('SecurityError')
        },
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
      },
    }
    expect(resolveClientContext(hostile)).toEqual({ language: 'en' })
  })

  it('utmOf: only the five utm keys, empties dropped, none → undefined', () => {
    expect(utmOf('?utm_source=a&utm_content=c&utm_medium=&gclid=1')).toEqual({ utm_source: 'a', utm_content: 'c' })
    expect(utmOf('?gclid=1')).toBeUndefined()
    expect(utmOf(undefined)).toBeUndefined()
  })
})

describe('the landing is remembered for the session', () => {
  it('page 1 writes referrer + utm; page 2 (internal referrer, no utm) still reports the landing', () => {
    const storage = fakeStorage()
    const first = page({
      storage,
      location: { search: '?utm_source=nyhetsbrev&utm_campaign=okt' },
      document: { referrer: 'https://mail.example/' },
    })
    expect(resolveClientContext(first)).toMatchObject({
      referrer: 'https://mail.example/',
      utm_source: 'nyhetsbrev',
      utm_campaign: 'okt',
    })
    expect(storage.store.has(LANDING_KEY)).toBe(true)

    const second = page({ storage, location: { search: '' }, document: { referrer: 'https://site.example/article-1' } })
    const out = resolveClientContext(second)
    expect(out.referrer).toBe('https://mail.example/')
    expect(out.utm_source).toBe('nyhetsbrev')
    expect(out.utm_campaign).toBe('okt')
  })

  it('the referrer comes only from the landing: a direct landing (no referrer) keeps later internal referrers out', () => {
    const storage = fakeStorage()
    resolveClientContext(page({ storage, document: { referrer: '' } }))
    const later = resolveClientContext(page({ storage, document: { referrer: 'https://site.example/home' } }))
    expect(later.referrer).toBeUndefined()
  })

  it('a URL with utm mid-session is a new landing: it replaces what was remembered', () => {
    const storage = fakeStorage()
    resolveClientContext(page({ storage, location: { search: '?utm_source=a' }, document: { referrer: 'https://a.example/' } }))
    const out = resolveClientContext(
      page({ storage, location: { search: '?utm_source=b&utm_medium=cpc' }, document: { referrer: 'https://b.example/' } }),
    )
    expect(out).toMatchObject({ referrer: 'https://b.example/', utm_source: 'b', utm_medium: 'cpc' })
    expect(resolveClientContext(page({ storage }))).toMatchObject({ referrer: 'https://b.example/', utm_source: 'b' })
  })

  it('without storage each page stands alone; a corrupt memory is ignored', () => {
    expect(resolveClientContext(page({ storage: null, document: { referrer: 'https://x.example/' } })).referrer).toBe(
      'https://x.example/',
    )
    const storage = fakeStorage()
    storage.store.set(LANDING_KEY, '{not json')
    expect(resolveClientContext(page({ storage })).referrer).toBe('https://news.example/front')
    expect(JSON.parse(storage.store.get(LANDING_KEY)!)).toEqual({ referrer: 'https://news.example/front' })
  })

  it('W6: the referrer is kept as origin + path — no query, no fragment', () => {
    const out = resolveClientContext(page({ document: { referrer: 'https://news.example/front/story?fbclid=abc&x=1#top' } }))
    expect(out.referrer).toBe('https://news.example/front/story')
    expect(landingReferrer('not a url?q=1#f')).toBe('not a url')
    expect(landingReferrer('')).toBeUndefined()
  })

  it('W6: a referrer from this same host is a self-referral: dropped, and it never starts a new landing', () => {
    const storage = fakeStorage()
    // First page of the tab opened from the site itself (a new tab from the home page): no referrer kept.
    const first = resolveClientContext(
      page({ storage, location: { search: '', host: 'site.example' }, document: { referrer: 'https://site.example/home' } }),
    )
    expect(first.referrer).toBeUndefined()
    expect(isSameHost('https://site.example/home', 'site.example')).toBe(true)
    expect(isSameHost('https://site.example:8443/home', 'site.example')).toBe(false)
    expect(isSameHost('https://other.example/', 'site.example')).toBe(false)
  })

  it('W6: an internal link that propagates utm keeps the landing that was; an external utm click replaces it', () => {
    const storage = fakeStorage()
    resolveClientContext(
      page({ storage, location: { search: '?utm_source=nyhetsbrev', host: 'site.example' }, document: { referrer: 'https://mail.example/' } }),
    )
    const internal = resolveClientContext(
      page({ storage, location: { search: '?utm_source=internal-banner', host: 'site.example' }, document: { referrer: 'https://site.example/front' } }),
    )
    expect(internal).toMatchObject({ referrer: 'https://mail.example/', utm_source: 'nyhetsbrev' })
    const external = resolveClientContext(
      page({ storage, location: { search: '?utm_source=partner', host: 'site.example' }, document: { referrer: 'https://partner.example/deal' } }),
    )
    expect(external).toMatchObject({ referrer: 'https://partner.example/deal', utm_source: 'partner' })
  })

  it('removeLanding forgets the memory (consent withdrawn)', () => {
    const storage = fakeStorage()
    resolveClientContext(page({ storage, location: { search: '?utm_source=a' } }))
    expect(storage.store.has(LANDING_KEY)).toBe(true)
    removeLanding(storage)
    expect(storage.store.has(LANDING_KEY)).toBe(false)
  })

  it('persist=false reads the memory but writes nothing; persistLanding writes it later', () => {
    const storage = fakeStorage()
    const landing = resolveLanding(page({ storage, location: { search: '?utm_source=late' } }), false)
    expect(landing.utm).toEqual({ utm_source: 'late' })
    expect(storage.store.has(LANDING_KEY)).toBe(false)
    persistLanding(landing, storage)
    expect(JSON.parse(storage.store.get(LANDING_KEY)!)).toEqual({
      referrer: 'https://news.example/front',
      utm: { utm_source: 'late' },
    })
  })
})

describe('the landing page itself (for the order\'s entry context)', () => {
  it('is remembered as origin + path — no query, no fragment — and read back by the next page', () => {
    const storage = fakeStorage()
    const first = page({
      storage,
      location: { search: '?utm_source=a', href: 'https://host.example/landing?utm_source=a#frag', host: 'host.example' },
    })
    expect(resolveLanding(first)).toEqual({
      referrer: 'https://news.example/front',
      utm: { utm_source: 'a' },
      url: 'https://host.example/landing',
    })
    const second = page({
      storage,
      document: { referrer: 'https://host.example/landing' },
      location: { search: '', href: 'https://host.example/article', host: 'host.example' },
    })
    expect(resolveLanding(second).url).toBe('https://host.example/landing')
    // The `client` block of the events does not carry it: the collector derives the landing.
    expect(resolveClientContext(second)).not.toHaveProperty('url')
  })

  it('landingUrl: capped at 2 048, without query and fragment; nothing for nothing', () => {
    expect(landingUrl('https://host.example/a/b?x=1#y')).toBe('https://host.example/a/b')
    expect(landingUrl(`https://host.example/${'p'.repeat(3_000)}`)).toHaveLength(2_048)
    expect(landingUrl('/relative?x')).toBe('/relative')
    expect(landingUrl('')).toBeUndefined()
    expect(landingUrl(undefined)).toBeUndefined()
  })
})
