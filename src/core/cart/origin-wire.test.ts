/**
 * A line origin as Commerce receives it (ADR-0035 phase B): snake_case,
 * the caps of shopcart's `LineOriginDto`, the kind of element as the
 * collector names it, the page of the origin (else the current one) — and
 * nothing at all when the SDK knows no place for the units.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { LINE_ORIGIN_CAPS, currentOriginPage, lineOriginWire } from './origin-wire.js'

const HERO = { campaignId: 12, slot: 'hero', contentId: 'art-1', componentKind: 'card' }
const PAGE = { contentUrl: 'https://host.example/article?x=1', contentTitle: 'Why the lamp matters' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lineOriginWire', () => {
  it('maps the place, the kind and the page to snake_case', () => {
    expect(lineOriginWire({ ...HERO, contentUrl: 'https://host.example/a', contentTitle: 'A' })).toEqual({
      campaign_id: 12,
      location_id: 'hero',
      component_kind: 'card',
      content_url: 'https://host.example/a',
      content_title: 'A',
    })
  })

  it('takes the current page when the origin does not carry its own', () => {
    expect(lineOriginWire(HERO, PAGE)).toEqual({
      campaign_id: 12,
      location_id: 'hero',
      component_kind: 'card',
      content_url: PAGE.contentUrl,
      content_title: PAGE.contentTitle,
    })
    // The origin's own page wins: the units were added there, not here.
    expect(lineOriginWire({ ...HERO, contentUrl: 'https://host.example/then' }, PAGE)).toMatchObject({
      content_url: 'https://host.example/then',
      content_title: PAGE.contentTitle,
    })
  })

  it('derives the kind from the slot id when the origin names none — the collector rule', () => {
    expect(lineOriginWire({ campaignId: 1, slot: 'article-9-carousel-2' })).toMatchObject({ component_kind: 'carousel' })
    expect(lineOriginWire({ campaignId: 1, slot: 'detail-1' })).toMatchObject({ component_kind: 'detail' })
    expect(lineOriginWire({ campaignId: 1, slot: 'sidebar' })).not.toHaveProperty('component_kind')
  })

  it('sends nothing when no place is known — no campaign, no slot, no kind', () => {
    expect(lineOriginWire(undefined)).toBeUndefined()
    expect(lineOriginWire(null)).toBeUndefined()
    expect(lineOriginWire({})).toBeUndefined()
    expect(lineOriginWire({ contentId: 'art-1', contentUrl: 'https://host.example/a' }, PAGE)).toBeUndefined()
    // A slot alone is a place.
    expect(lineOriginWire({ slot: 'hero' })).toEqual({ location_id: 'hero', component_kind: 'hero' })
  })

  it('campaign_id only as a positive integer (the DTO refuses the rest)', () => {
    expect(lineOriginWire({ campaignId: 0, slot: 'hero' })).toEqual({ location_id: 'hero', component_kind: 'hero' })
    expect(lineOriginWire({ campaignId: -3, slot: 'hero' })).not.toHaveProperty('campaign_id')
    expect(lineOriginWire({ campaignId: 2.5, slot: 'hero' })).not.toHaveProperty('campaign_id')
    expect(lineOriginWire({ campaignId: '12' as never, slot: 'hero' })).toMatchObject({ campaign_id: 12 })
  })

  it('cuts to the caps of LineOriginDto: slot 100, kind 32, url 2 048 (query first), title 255', () => {
    const long = (n: number, ch = 'x') => ch.repeat(n)
    const out = lineOriginWire({
      campaignId: 1,
      slot: long(150, 's'),
      componentKind: long(40, 'k'),
      contentUrl: `https://host.example/${long(2_100, 'p')}?q=${long(10)}`,
      contentTitle: long(300, 't'),
    })!
    expect(out.location_id).toHaveLength(LINE_ORIGIN_CAPS.locationId)
    expect(out.component_kind).toHaveLength(LINE_ORIGIN_CAPS.componentKind)
    expect(out.content_url).toHaveLength(LINE_ORIGIN_CAPS.contentUrl)
    expect(out.content_url).not.toContain('?')
    expect(out.content_title).toHaveLength(LINE_ORIGIN_CAPS.contentTitle)
    // A URL over the cap loses its query string first; one that then fits is kept whole.
    const url = `https://host.example/a?q=${long(2_100)}`
    expect(lineOriginWire({ slot: 'hero', contentUrl: url })!.content_url).toBe('https://host.example/a')
  })
})

describe('currentOriginPage', () => {
  it('is the page as Vio.content() answers it when the facade is on the page, else location.href', () => {
    vi.stubGlobal('location', { href: 'https://host.example/now?x=1', pathname: '/now', search: '?x=1' })
    expect(currentOriginPage()).toEqual({ contentUrl: 'https://host.example/now?x=1' })
    vi.stubGlobal('__VIO_FACADE__', { content: () => ({ id: 'a', url: 'https://host.example/facade', title: 'Facade' }) })
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
