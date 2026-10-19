/**
 * The checkout's attribution (ADR-0035 phase B), pure: the surface's key,
 * the page's campaign (else the campaign that explains most of the cart),
 * the page, and the entry — on a `standard` surface only — capped to
 * shopcart's `CheckoutAttributionDto`.
 */

import { describe, expect, it } from 'vitest'
import type { CartSlice } from '../cart/slices.js'
import { GRAPHQL_INT_MAX } from '../cart/origin-wire.js'
import { CHECKOUT_ATTRIBUTION_CAPS, checkoutAttributionOf, dominantCampaignOf, entryContextOf } from './attribution.js'

const LANDING = {
  referrer: 'https://news.example/front',
  utm: { utm_source: 'nyhetsbrev', utm_medium: 'email', utm_campaign: 'okt', utm_term: 'ignored', utm_content: 'ignored' },
  url: 'https://host.example/landing',
}
const CONTENT = { url: 'https://host.example/article?email=kari@example.no&utm_source=x#frag', title: 'Why the lamp matters' }
const PAGE = 'https://host.example/article'

const slice = (campaignId: number | undefined, units: number, value = units * 100): CartSlice => ({
  campaignId,
  items: [{ productId: 9, quantity: units }],
  value,
  slice: 1,
  slices: 1,
})

describe('checkoutAttributionOf', () => {
  it('the surface, the page campaign, the page and the entry — snake_case', () => {
    expect(
      checkoutAttributionOf({ surfaceKey: 'surface-key', pageCampaignId: 7, content: CONTENT, landing: LANDING, privacyMode: 'standard' }),
    ).toEqual({
      surface_key: 'surface-key',
      campaign_id: 7,
      content_url: PAGE,
      content_title: CONTENT.title,
      entry: {
        referrer: 'https://news.example/front',
        utm_source: 'nyhetsbrev',
        utm_medium: 'email',
        utm_campaign: 'okt',
        landing_url: 'https://host.example/landing',
      },
    })
  })

  it('without a page campaign, the campaign that explains most units of the cart', () => {
    const out = checkoutAttributionOf({
      surfaceKey: 'k',
      slices: [slice(7, 1), slice(9, 2), slice(undefined, 5)],
      privacyMode: 'standard',
    })
    expect(out?.campaign_id).toBe(9)
    // The page campaign wins over the cart.
    expect(checkoutAttributionOf({ pageCampaignId: 7, slices: [slice(9, 2)] })?.campaign_id).toBe(7)
    // No campaign anywhere: none.
    expect(checkoutAttributionOf({ surfaceKey: 'k', slices: [slice(undefined, 5)] })).toEqual({ surface_key: 'k' })
  })

  it('content_url is origin + path: the query (an e-mail, a token, the utm) and the fragment never reach the order', () => {
    expect(checkoutAttributionOf({ content: { url: CONTENT.url }, privacyMode: 'standard' })).toEqual({ content_url: PAGE })
    expect(checkoutAttributionOf({ content: { url: '/a/b?x=1#y' }, privacyMode: 'standard' })).toEqual({ content_url: '/a/b' })
  })

  it('minimal — or unknown — keeps the page, its title and the entry off the order; the surface and the campaign stay', () => {
    const base = { surfaceKey: 'k', pageCampaignId: 7, content: CONTENT, landing: LANDING }
    expect(checkoutAttributionOf({ ...base, privacyMode: 'minimal' })).toEqual({ surface_key: 'k', campaign_id: 7 })
    expect(checkoutAttributionOf({ ...base, privacyMode: 'unknown' })).toEqual({ surface_key: 'k', campaign_id: 7 })
    expect(checkoutAttributionOf(base)).toEqual({ surface_key: 'k', campaign_id: 7 })
    // Only the page known, on a minimal surface: nothing to say.
    expect(checkoutAttributionOf({ content: CONTENT, landing: LANDING, privacyMode: 'minimal' })).toBeUndefined()
  })

  it('an empty entry is omitted; nothing at all is undefined', () => {
    expect(checkoutAttributionOf({ surfaceKey: 'k', landing: {}, privacyMode: 'standard' })).toEqual({ surface_key: 'k' })
    expect(checkoutAttributionOf({ surfaceKey: 'k', landing: null, privacyMode: 'standard' })).toEqual({ surface_key: 'k' })
    expect(checkoutAttributionOf({})).toBeUndefined()
    expect(checkoutAttributionOf({ surfaceKey: '  ', content: { url: '', title: ' ' }, privacyMode: 'standard' })).toBeUndefined()
  })

  it('cuts to the caps of the DTO: key 255, title 255, url 2 048 (query first), referrer 2 048, utm 128, landing 2 048', () => {
    const long = (n: number, ch = 'x') => ch.repeat(n)
    const out = checkoutAttributionOf({
      surfaceKey: long(300, 'k'),
      pageCampaignId: 7,
      content: { url: `https://host.example/${long(2_100, 'p')}?q=1`, title: long(300, 't') },
      landing: {
        referrer: `https://ref.example/${long(2_100, 'r')}`,
        utm: { utm_source: long(200, 's'), utm_medium: long(200, 'm'), utm_campaign: long(200, 'c') },
        url: `https://host.example/${long(2_100, 'l')}`,
      },
      privacyMode: 'standard',
    })!
    expect(out.surface_key).toHaveLength(CHECKOUT_ATTRIBUTION_CAPS.surfaceKey)
    expect(out.content_title).toHaveLength(CHECKOUT_ATTRIBUTION_CAPS.contentTitle)
    expect(out.content_url).toHaveLength(CHECKOUT_ATTRIBUTION_CAPS.contentUrl)
    expect(out.content_url).not.toContain('?')
    expect(out.entry!.referrer).toHaveLength(CHECKOUT_ATTRIBUTION_CAPS.referrer)
    expect(out.entry!.utm_source).toHaveLength(CHECKOUT_ATTRIBUTION_CAPS.utm)
    expect(out.entry!.utm_medium).toHaveLength(CHECKOUT_ATTRIBUTION_CAPS.utm)
    expect(out.entry!.utm_campaign).toHaveLength(CHECKOUT_ATTRIBUTION_CAPS.utm)
    expect(out.entry!.landing_url).toHaveLength(CHECKOUT_ATTRIBUTION_CAPS.landingUrl)
  })

  it('campaign_id only as a positive 32-bit Int (a bigger one would fail the whole mutation)', () => {
    expect(checkoutAttributionOf({ pageCampaignId: 0, slices: [slice(2.5 as never, 1)] })).toBeUndefined()
    expect(checkoutAttributionOf({ pageCampaignId: -1 })).toBeUndefined()
    expect(checkoutAttributionOf({ pageCampaignId: GRAPHQL_INT_MAX })).toEqual({ campaign_id: 2_147_483_647 })
    expect(checkoutAttributionOf({ pageCampaignId: GRAPHQL_INT_MAX + 1 })).toBeUndefined()
    // Over the cap on the page: the cart's dominant campaign, if any, else nothing.
    expect(checkoutAttributionOf({ pageCampaignId: GRAPHQL_INT_MAX + 1, slices: [slice(9, 1)] })).toEqual({ campaign_id: 9 })
    expect(dominantCampaignOf([slice(GRAPHQL_INT_MAX + 1, 5), slice(7, 1)])).toBe(7)
  })
})

describe('dominantCampaignOf', () => {
  it('most units; ties to the higher value, then to the first; unattributed units never win', () => {
    expect(dominantCampaignOf([slice(7, 2), slice(9, 2, 500), slice(undefined, 9)])).toBe(9)
    expect(dominantCampaignOf([slice(7, 2, 200), slice(9, 2, 200)])).toBe(7)
    expect(dominantCampaignOf([slice(undefined, 9)])).toBeUndefined()
    expect(dominantCampaignOf([])).toBeUndefined()
    expect(dominantCampaignOf(null)).toBeUndefined()
  })
})

describe('entryContextOf', () => {
  it('only the four utm Commerce keeps, plus referrer and landing; undefined when it says nothing', () => {
    expect(entryContextOf(LANDING)).toEqual({
      referrer: LANDING.referrer,
      utm_source: 'nyhetsbrev',
      utm_medium: 'email',
      utm_campaign: 'okt',
      landing_url: LANDING.url,
    })
    expect(entryContextOf({ utm: { utm_term: 'x' } })).toBeUndefined()
    expect(entryContextOf(undefined)).toBeUndefined()
  })
})
