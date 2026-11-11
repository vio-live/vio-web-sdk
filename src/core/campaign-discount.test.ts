/**
 * The campaign's discount as the bootstrap gives it — per campaign and per
 * sponsor, by reference (`discount: { ref }` on every sponsor block of
 * `campaigns[]`, and on the top-level ones of the default campaign; the code
 * itself never reaches the page) — which campaign's discount a sponsor's
 * cart gets on a page (the page's campaign that has the sponsor, else the
 * default one), and whether a brand's ways to pay take codes at all.
 */
import { describe, expect, it } from 'vitest'
import {
  bootstrapDiscountRefs,
  campaignDiscountFor,
  campaignDiscountNow,
  discountCampaignFor,
  normalizeDiscountRef,
  sponsorDiscountRef,
  sponsorTakesDiscounts,
} from './campaign-discount.js'
import type { BootstrapResponse, Sponsor } from './types.js'

const BRAND_A = 7
const BRAND_B = 8
const LONE = 9
const sponsor = (id: number, ref?: string | null): Sponsor => ({
  id,
  name: `S${id}`,
  commerce: { apiKey: `key-${id}`, channelId: String(400 + id) },
  ...(ref !== undefined ? { discount: ref === null ? null : { ref } } : {}),
})

/** Campaign 4 is the default (brand A); 5 has A and B; 6 is paused; Lone is only in the top-level blocks. */
const boot = (): BootstrapResponse => ({
  campaign: { id: 4, name: 'Autumn' },
  primarySponsor: sponsor(BRAND_A, 'r-autumn'),
  campaigns: [
    { id: 4, name: 'Autumn', status: 'active', isDefault: true, primarySponsor: sponsor(BRAND_A, 'r-autumn') },
    { id: 5, name: 'Winter', status: 'active', primarySponsor: sponsor(BRAND_A, 'r-gift'), secondarySponsors: [sponsor(BRAND_B, 'r-b10')] },
    { id: 6, name: 'Paused', status: 'paused', primarySponsor: sponsor(BRAND_A, 'r-paused') },
  ],
})

describe('sponsorDiscountRef — what a sponsor block carries', () => {
  it('the reference, trimmed; null, absent or not a reference is none', () => {
    expect(sponsorDiscountRef(sponsor(BRAND_A, ' r-gift '))).toBe('r-gift')
    expect(sponsorDiscountRef(sponsor(BRAND_A, null))).toBeUndefined()
    expect(sponsorDiscountRef(sponsor(BRAND_A))).toBeUndefined()
    expect(sponsorDiscountRef(sponsor(BRAND_A, 'two words'))).toBeUndefined()
    expect(sponsorDiscountRef(sponsor(BRAND_A, ''))).toBeUndefined()
    expect(sponsorDiscountRef({ id: 1, discount: { ref: 42 } })).toBeUndefined()
    expect(sponsorDiscountRef(null)).toBeUndefined()
    expect(normalizeDiscountRef('x'.repeat(129))).toBeUndefined()
  })

  it('the code itself is never read: the old discountCode field (Commerce sends it as null) is ignored', () => {
    expect(sponsorDiscountRef({ ...sponsor(BRAND_A), discountCode: 'SOMECODE' })).toBeUndefined()
    expect(campaignDiscountFor({ ...boot(), campaigns: [{ id: 4, name: 'x', status: 'active', isDefault: true, primarySponsor: { ...sponsor(BRAND_A), discountCode: 'SOMECODE' } }] }, BRAND_A, 4)).toBeUndefined()
  })
})

describe('campaignDiscountFor — the discount a sponsor\'s cart gets on a page', () => {
  it('the page\'s campaign gives the brand ITS discount there — not the default campaign\'s', () => {
    expect(campaignDiscountFor(boot(), BRAND_A, 5)).toEqual({ ref: 'r-gift', campaignId: 5 })
  })

  it('no page campaign: the default campaign\'s, when the sponsor is in it', () => {
    expect(campaignDiscountFor(boot(), BRAND_A, undefined)).toEqual({ ref: 'r-autumn', campaignId: 4 })
    expect(campaignDiscountFor(boot(), BRAND_A, [])).toEqual({ ref: 'r-autumn', campaignId: 4 })
    // Brand B is not in the default campaign: none at all.
    expect(campaignDiscountFor(boot(), BRAND_B, undefined)).toBeUndefined()
  })

  it('the candidates in their order (the elements\' first, then Vio.init\'s): the first one active with the sponsor', () => {
    expect(campaignDiscountFor(boot(), BRAND_A, [5, 4])).toEqual({ ref: 'r-gift', campaignId: 5 })
    expect(campaignDiscountFor(boot(), BRAND_A, ['4', 5])).toEqual({ ref: 'r-autumn', campaignId: 4 })
    // A paused or unknown campaign is skipped.
    expect(campaignDiscountFor(boot(), BRAND_A, [6, 99, 5])).toEqual({ ref: 'r-gift', campaignId: 5 })
    expect(campaignDiscountFor(boot(), BRAND_A, [6])).toEqual({ ref: 'r-autumn', campaignId: 4 })
  })

  it('only the sponsor\'s own block counts: one brand\'s discount never goes on another brand\'s cart', () => {
    expect(campaignDiscountFor(boot(), BRAND_B, 5)).toEqual({ ref: 'r-b10', campaignId: 5 })
    const noB = boot()
    noB.campaigns![1]!.secondarySponsors = [sponsor(BRAND_B, null)]
    expect(campaignDiscountFor(noB, BRAND_B, 5)).toBeUndefined()
    expect(campaignDiscountFor(noB, BRAND_A, 5)).toEqual({ ref: 'r-gift', campaignId: 5 })
  })

  it('the page\'s campaign without one for the sponsor gives none — it does not fall back to the default\'s', () => {
    const b = boot()
    b.campaigns![1]!.primarySponsor = sponsor(BRAND_A, null)
    expect(campaignDiscountFor(b, BRAND_A, 5)).toBeUndefined()
    expect(discountCampaignFor(b, BRAND_A, 5)?.id).toBe(5)
  })

  it('a page campaign the sponsor is not in: the default campaign decides for that sponsor', () => {
    expect(campaignDiscountFor(boot(), BRAND_A, 77)).toEqual({ ref: 'r-autumn', campaignId: 4 })
    const b = boot()
    b.campaigns!.push({ id: 7, name: 'B alone', status: 'active', primarySponsor: sponsor(BRAND_B, 'r-b7') })
    expect(campaignDiscountFor(b, BRAND_A, 7)).toEqual({ ref: 'r-autumn', campaignId: 4 })
    expect(campaignDiscountFor(b, BRAND_B, 7)).toEqual({ ref: 'r-b7', campaignId: 7 })
  })

  it('the default campaign from the top-level blocks when campaigns[] does not list it', () => {
    const b: BootstrapResponse = {
      campaign: { id: 4, name: 'Autumn' },
      primarySponsor: sponsor(BRAND_A, 'r-top'),
      secondarySponsors: [sponsor(LONE, 'r-lone')],
      campaigns: [],
    }
    expect(campaignDiscountFor(b, BRAND_A, undefined)).toEqual({ ref: 'r-top', campaignId: 4 })
    expect(campaignDiscountFor(b, LONE, undefined)).toEqual({ ref: 'r-lone', campaignId: 4 })
  })

  it('a Commerce that predates the field, no campaign at all, no bootstrap: none — never a throw', () => {
    const old: BootstrapResponse = {
      campaign: { id: 4, name: 'Autumn' },
      primarySponsor: sponsor(BRAND_A),
      campaigns: [{ id: 4, name: 'Autumn', status: 'active', primarySponsor: sponsor(BRAND_A) }],
    }
    expect(campaignDiscountFor(old, BRAND_A, 4)).toBeUndefined()
    expect(campaignDiscountFor({ campaign: null, noActiveCampaign: true, primarySponsor: sponsor(BRAND_A, 'x'), campaigns: [] } as never, BRAND_A, undefined)).toBeUndefined()
    expect(campaignDiscountFor(null, BRAND_A, 4)).toBeUndefined()
    expect(campaignDiscountFor({ campaigns: 'broken' } as never, BRAND_A, 4)).toBeUndefined()
    expect(campaignDiscountFor({ campaigns: [null, { id: 5, status: 'active', primarySponsor: null }] } as never, BRAND_A, 5)).toBeUndefined()
  })
})

describe('campaignDiscountNow — whether a discount put on a cart from a campaign still holds', () => {
  it('the reference the campaign gives the sponsor now', () => {
    expect(campaignDiscountNow(boot(), 5, BRAND_A)).toBe('r-gift')
    expect(campaignDiscountNow(boot(), 5, BRAND_B)).toBe('r-b10')
    expect(campaignDiscountNow(boot(), 4, BRAND_A)).toBe('r-autumn')
  })

  it('set again in the dashboard: the new reference', () => {
    const b = boot()
    b.campaigns![1]!.primarySponsor = sponsor(BRAND_A, 'r-new')
    expect(campaignDiscountNow(b, 5, BRAND_A)).toBe('r-new')
  })

  it('null when it gives none any more: no discount, the sponsor left, the campaign paused or gone', () => {
    const b = boot()
    b.campaigns![1]!.primarySponsor = sponsor(BRAND_A, null)
    expect(campaignDiscountNow(b, 5, BRAND_A)).toBeNull()
    expect(campaignDiscountNow(boot(), 5, LONE)).toBeNull()
    expect(campaignDiscountNow(boot(), 6, BRAND_A)).toBeNull()
    expect(campaignDiscountNow(boot(), 99, BRAND_A)).toBeNull()
    expect(campaignDiscountNow({ campaign: null, noActiveCampaign: true, campaigns: [] } as never, 5, BRAND_A)).toBeNull()
  })

  it('a sponsor block without `discount` at all (a Commerce that predates it): cannot tell — undefined', () => {
    const b = boot()
    b.campaigns![1]!.primarySponsor = sponsor(BRAND_A)
    expect(campaignDiscountNow(b, 5, BRAND_A)).toBeUndefined()
  })

  it('the default campaign from its top-level blocks; nothing readable is null, never a throw', () => {
    const b: BootstrapResponse = { campaign: { id: 4, name: 'Autumn' }, primarySponsor: sponsor(BRAND_A, 'r-top') }
    expect(campaignDiscountNow(b, 4, BRAND_A)).toBe('r-top')
    expect(campaignDiscountNow(null, 4, BRAND_A)).toBeNull()
    expect(campaignDiscountNow({ campaigns: 'broken' } as never, 4, BRAND_A)).toBeNull()
  })
})

describe('bootstrapDiscountRefs — the discounts of a bootstrap, to tell a refresh that changed them', () => {
  it('empty when no block carries one: null, absent (an older Commerce), or nothing at all', () => {
    expect(bootstrapDiscountRefs(null)).toBe('')
    expect(bootstrapDiscountRefs({ campaign: { id: 4, name: 'x' }, primarySponsor: sponsor(BRAND_A), campaigns: [] })).toBe('')
    expect(bootstrapDiscountRefs({ campaign: { id: 4, name: 'x' }, primarySponsor: sponsor(BRAND_A, null) })).toBe('')
  })

  it('the same references say the same, in any order; one changed, added or removed says otherwise', () => {
    const same = boot()
    same.campaigns!.reverse()
    expect(bootstrapDiscountRefs(boot())).not.toBe('')
    expect(bootstrapDiscountRefs(same)).toBe(bootstrapDiscountRefs(boot()))
    const changed = boot()
    changed.campaigns![1]!.secondarySponsors = [sponsor(BRAND_B, 'r-b20')]
    expect(bootstrapDiscountRefs(changed)).not.toBe(bootstrapDiscountRefs(boot()))
    const removed = boot()
    removed.campaigns![1]!.secondarySponsors = [sponsor(BRAND_B, null)]
    expect(bootstrapDiscountRefs(removed)).not.toBe(bootstrapDiscountRefs(boot()))
  })
})

describe('sponsorTakesDiscounts — whether a brand\'s cart may get a code nobody typed', () => {
  it('discountMethods decides when the bootstrap lists it: at least one method', () => {
    expect(sponsorTakesDiscounts({ apiKey: 'k', paymentMethods: ['vipps', 'klarna'], discountMethods: ['vipps'] })).toBe(true)
    expect(sponsorTakesDiscounts({ apiKey: 'k', paymentMethods: ['vipps', 'klarna'], discountMethods: [] })).toBe(false)
    expect(sponsorTakesDiscounts({ apiKey: 'k', paymentMethods: ['klarna'], discountMethods: ['kustom'] })).toBe(true)
  })

  it('a bootstrap without it: the brand is paid with Vipps', () => {
    expect(sponsorTakesDiscounts({ apiKey: 'k', paymentMethods: ['klarna', 'vipps'] })).toBe(true)
    expect(sponsorTakesDiscounts({ apiKey: 'k', paymentMethods: ['klarna', 'apple_pay'] })).toBe(false)
    expect(sponsorTakesDiscounts({ apiKey: 'k', paymentMethods: [] })).toBe(false)
  })

  it('a block that lists neither says nothing against it; no selling block at all is no', () => {
    expect(sponsorTakesDiscounts({ apiKey: 'k' })).toBe(true)
    expect(sponsorTakesDiscounts(null)).toBe(false)
    expect(sponsorTakesDiscounts(undefined)).toBe(false)
  })
})
