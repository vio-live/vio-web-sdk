/**
 * The checkout's attribution (ADR-0035 phase B), pure: the surface's key,
 * the page's campaign (else the campaign that explains most of the cart),
 * the page, and the entry — on a `standard` surface only — capped to
 * shopcart's `CheckoutAttributionDto`.
 */

import { describe, expect, it } from 'vitest'
import type { CartSlice } from '../cart/slices.js'
import { CHECKOUT_ATTRIBUTION_CAPS, checkoutAttributionOf, dominantCampaignOf, entryContextOf } from './attribution.js'

const LANDING = {
  referrer: 'https://news.example/front',
  utm: { utm_source: 'nyhetsbrev', utm_medium: 'email', utm_campaign: 'okt', utm_term: 'ignored', utm_content: 'ignored' },
  url: 'https://host.example/landing',
}
const CONTENT = { url: 'https://host.example/article?x=1', title: 'Why the lamp matters' }

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
      content_url: CONTENT.url,
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

  it('minimal — or unknown — keeps the entry off the order', () => {
    const base = { surfaceKey: 'k', pageCampaignId: 7, content: CONTENT, landing: LANDING }
    expect(checkoutAttributionOf({ ...base, privacyMode: 'minimal' })).toEqual({
      surface_key: 'k',
      campaign_id: 7,
      content_url: CONTENT.url,
      content_title: CONTENT.title,
    })
    expect(checkoutAttributionOf({ ...base, privacyMode: 'unknown' })).not.toHaveProperty('entry')
    expect(checkoutAttributionOf(base)).not.toHaveProperty('entry')
  })

  it('an empty entry is omitted; nothing at all is undefined', () => {
    expect(checkoutAttributionOf({ surfaceKey: 'k', landing: {}, privacyMode: 'standard' })).toEqual({ surface_key: 'k' })
    expect(checkoutAttributionOf({ surfaceKey: 'k', landing: null, privacyMode: 'standard' })).toEqual({ surface_key: 'k' })
    expect(checkoutAttributionOf({})).toBeUndefined()
    expect(checkoutAttributionOf({ surfaceKey: '  ', content: { url: '', title: ' ' } })).toBeUndefined()
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
    // A page URL over the cap loses its query string first; one that then fits is kept whole.
    expect(checkoutAttributionOf({ content: { url: `https://host.example/a?q=${long(2_100)}` } })!.content_url).toBe('https://host.example/a')
  })

  it('campaign_id only as a positive integer', () => {
    expect(checkoutAttributionOf({ pageCampaignId: 0, slices: [slice(2.5 as never, 1)] })).toBeUndefined()
    expect(checkoutAttributionOf({ pageCampaignId: -1 })).toBeUndefined()
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
