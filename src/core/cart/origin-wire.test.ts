/**
 * A line origin as Commerce receives it (ADR-0035 phase B): snake_case,
 * the caps of shopcart's `LineOriginDto`, the kind of element as the
 * collector names it, the page of the origin (else the current one) as
 * origin + path — and nothing at all when the SDK knows no place for the
 * units. On a `minimal` surface (or one whose mode is not known) the slot
 * and the page stay out.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRAPHQL_INT_MAX, LINE_ORIGIN_CAPS, currentOriginPage, currentPrivacyMode, lineOriginWire } from './origin-wire.js'

const HERO = { campaignId: 12, slot: 'hero', contentId: 'art-1', componentKind: 'card' }
const PAGE = { contentUrl: 'https://host.example/article?x=1#top', contentTitle: 'Why the lamp matters' }
const STANDARD = { privacyMode: 'standard' } as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lineOriginWire on a standard surface', () => {
  it('maps the place, the kind and the page to snake_case', () => {
    expect(lineOriginWire({ ...HERO, contentUrl: 'https://host.example/a', contentTitle: 'A' }, STANDARD)).toEqual({
      campaign_id: 12,
      location_id: 'hero',
      component_kind: 'card',
      content_url: 'https://host.example/a',
      content_title: 'A',
    })
  })

  it('content_url is origin + path: no query string, no fragment (an e-mail or a token in the query never reaches the order)', () => {
    const leaky = 'https://host.example/article?email=kari@example.no&utm_source=nyhetsbrev&token=abc#frag'
    expect(lineOriginWire({ ...HERO, contentUrl: leaky }, STANDARD)!.content_url).toBe('https://host.example/article')
    expect(lineOriginWire(HERO, { ...STANDARD, page: { contentUrl: leaky } })!.content_url).toBe('https://host.example/article')
    expect(lineOriginWire({ ...HERO, contentUrl: '/relative?x=1#y' }, STANDARD)!.content_url).toBe('/relative')
  })

  it('takes the current page when the origin does not carry its own', () => {
    expect(lineOriginWire(HERO, { ...STANDARD, page: PAGE })).toEqual({
      campaign_id: 12,
      location_id: 'hero',
      component_kind: 'card',
      content_url: 'https://host.example/article',
      content_title: PAGE.contentTitle,
    })
    // The origin's own page wins: the units were added there, not here.
    expect(lineOriginWire({ ...HERO, contentUrl: 'https://host.example/then' }, { ...STANDARD, page: PAGE })).toMatchObject({
      content_url: 'https://host.example/then',
      content_title: PAGE.contentTitle,
    })
  })

  it('derives the kind from the slot id when the origin names none — the collector rule', () => {
    expect(lineOriginWire({ campaignId: 1, slot: 'article-9-carousel-2' }, STANDARD)).toMatchObject({ component_kind: 'carousel' })
    expect(lineOriginWire({ campaignId: 1, slot: 'detail-1' }, STANDARD)).toMatchObject({ component_kind: 'detail' })
    expect(lineOriginWire({ campaignId: 1, slot: 'sidebar' }, STANDARD)).not.toHaveProperty('component_kind')
  })

  it('sends nothing when no place is known — no campaign, no slot, no kind', () => {
    expect(lineOriginWire(undefined, STANDARD)).toBeUndefined()
    expect(lineOriginWire(null, STANDARD)).toBeUndefined()
    expect(lineOriginWire({}, STANDARD)).toBeUndefined()
    expect(lineOriginWire({ contentId: 'art-1', contentUrl: 'https://host.example/a' }, { ...STANDARD, page: PAGE })).toBeUndefined()
    // A slot alone is a place.
    expect(lineOriginWire({ slot: 'hero' }, STANDARD)).toEqual({ location_id: 'hero', component_kind: 'hero' })
  })

  it('campaign_id only as a positive 32-bit Int (the DTO refuses the rest; a bigger one fails the whole mutation)', () => {
    expect(lineOriginWire({ campaignId: 0, slot: 'hero' }, STANDARD)).toEqual({ location_id: 'hero', component_kind: 'hero' })
    expect(lineOriginWire({ campaignId: -3, slot: 'hero' }, STANDARD)).not.toHaveProperty('campaign_id')
    expect(lineOriginWire({ campaignId: 2.5, slot: 'hero' }, STANDARD)).not.toHaveProperty('campaign_id')
    expect(lineOriginWire({ campaignId: '12' as never, slot: 'hero' }, STANDARD)).toMatchObject({ campaign_id: 12 })
    expect(lineOriginWire({ campaignId: GRAPHQL_INT_MAX, slot: 'hero' }, STANDARD)).toMatchObject({ campaign_id: 2_147_483_647 })
    expect(lineOriginWire({ campaignId: GRAPHQL_INT_MAX + 1, slot: 'hero' }, STANDARD)).not.toHaveProperty('campaign_id')
    expect(lineOriginWire({ campaignId: GRAPHQL_INT_MAX + 1 }, STANDARD)).toBeUndefined()
  })

  it('cuts to the caps of LineOriginDto: slot 100, kind 32, url 2 048, title 255', () => {
    const long = (n: number, ch = 'x') => ch.repeat(n)
    const out = lineOriginWire(
      {
        campaignId: 1,
        slot: long(150, 's'),
        componentKind: long(40, 'k'),
        contentUrl: `https://host.example/${long(2_100, 'p')}?q=${long(10)}`,
        contentTitle: long(300, 't'),
      },
      STANDARD,
    )!
    expect(out.location_id).toHaveLength(LINE_ORIGIN_CAPS.locationId)
    expect(out.component_kind).toHaveLength(LINE_ORIGIN_CAPS.componentKind)
    expect(out.content_url).toHaveLength(LINE_ORIGIN_CAPS.contentUrl)
    expect(out.content_url).not.toContain('?')
    expect(out.content_title).toHaveLength(LINE_ORIGIN_CAPS.contentTitle)
  })
})

describe('lineOriginWire on a minimal surface — and when the mode is not known', () => {
  it('keeps the campaign and the kind; never the slot, the page or its title', () => {
    for (const privacyMode of ['minimal', 'unknown'] as const) {
      expect(lineOriginWire({ ...HERO, contentUrl: 'https://host.example/a', contentTitle: 'A' }, { privacyMode, page: PAGE })).toEqual({
        campaign_id: 12,
        component_kind: 'card',
      })
    }
    // The default is fail closed.
    expect(lineOriginWire(HERO, { page: PAGE })).toEqual({ campaign_id: 12, component_kind: 'card' })
    expect(lineOriginWire(HERO)).toEqual({ campaign_id: 12, component_kind: 'card' })
  })

  it('a slot alone becomes its kind word, or nothing', () => {
    expect(lineOriginWire({ slot: 'carousel-1' }, { privacyMode: 'minimal' })).toEqual({ component_kind: 'carousel' })
    expect(lineOriginWire({ slot: 'sidebar', contentUrl: 'https://host.example/a' }, { privacyMode: 'minimal' })).toBeUndefined()
  })
})

describe('currentOriginPage', () => {
  it('is the page as Vio.content() answers it when the facade is on the page, else location — origin + path', () => {
    vi.stubGlobal('location', { href: 'https://host.example/now?x=1#top', pathname: '/now', search: '?x=1' })
    expect(currentOriginPage()).toEqual({ contentUrl: 'https://host.example/now' })
    vi.stubGlobal('__VIO_FACADE__', { content: () => ({ id: 'a', url: 'https://host.example/facade?q=1', title: 'Facade' }) })
    expect(currentOriginPage()).toEqual({ contentUrl: 'https://host.example/facade', contentTitle: 'Facade' })
  })

  it('is {} without a page, and never throws', () => {
    expect(currentOriginPage()).toEqual({})
    vi.stubGlobal('__VIO_FACADE__', {
      content: () => {
        throw new Error('no')
      },
    })
    expect(currentOriginPage()).toEqual({})
  })
})

describe('currentPrivacyMode', () => {
  it('is what the facade answers; unknown without a facade, for a word it does not know, or when it throws', async () => {
    expect(await currentPrivacyMode()).toBe('unknown')
    vi.stubGlobal('__VIO_FACADE__', { privacyMode: async () => 'standard' })
    expect(await currentPrivacyMode()).toBe('standard')
    vi.stubGlobal('__VIO_FACADE__', { privacyMode: () => 'minimal' })
    expect(await currentPrivacyMode()).toBe('minimal')
    vi.stubGlobal('__VIO_FACADE__', { privacyMode: async () => 'strict' })
    expect(await currentPrivacyMode()).toBe('unknown')
    vi.stubGlobal('__VIO_FACADE__', {
      privacyMode: () => {
        throw new Error('no')
      },
    })
    expect(await currentPrivacyMode()).toBe('unknown')
  })
})
