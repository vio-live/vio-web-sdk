/**
 * The campaign's discount code as the bootstrap gives it — per campaign and
 * per sponsor (`discountCode` on every sponsor block of `campaigns[]`, and on
 * the top-level ones of the default campaign) — and which campaign's code a
 * sponsor's cart gets on a page: the page's campaign that has the sponsor,
 * else the default one.
 */
import { describe, expect, it } from 'vitest'
import {
  bootstrapDiscountCodes,
  campaignDiscountFor,
  campaignDiscountNow,
  discountCampaignFor,
  sponsorDiscountCode,
} from './campaign-discount.js'
import type { BootstrapResponse, Sponsor } from './types.js'

const FAVES = 7
const TINT = 8
const LONE = 9
const sponsor = (id: number, discountCode?: string | null): Sponsor => ({
  id,
  name: `S${id}`,
  commerce: { apiKey: `key-${id}`, channelId: String(400 + id) },
  ...(discountCode !== undefined ? { discountCode } : {}),
})

/** Campaign 4 is the default (Faves); 5 has Faves and Tint; 6 is paused; Lone is only in the top-level blocks. */
const boot = (): BootstrapResponse => ({
  campaign: { id: 4, name: 'Høst' },
  primarySponsor: sponsor(FAVES, 'HOST'),
  campaigns: [
    { id: 4, name: 'Høst', status: 'active', isDefault: true, primarySponsor: sponsor(FAVES, 'HOST') },
    { id: 5, name: 'Jul', status: 'active', primarySponsor: sponsor(FAVES, 'gratis_face_mask'), secondarySponsors: [sponsor(TINT, 'TINT10')] },
    { id: 6, name: 'Pause', status: 'paused', primarySponsor: sponsor(FAVES, 'PAUSE') },
  ],
})

describe('sponsorDiscountCode — what a sponsor block carries', () => {
  it('the code, as the SDK sends codes; null, absent or not a code is none', () => {
    expect(sponsorDiscountCode(sponsor(FAVES, ' gratis_face_mask '))).toBe('gratis_face_mask')
    expect(sponsorDiscountCode(sponsor(FAVES, null))).toBeUndefined()
    expect(sponsorDiscountCode(sponsor(FAVES))).toBeUndefined()
    expect(sponsorDiscountCode(sponsor(FAVES, 'to ord'))).toBeUndefined()
    expect(sponsorDiscountCode(sponsor(FAVES, ''))).toBeUndefined()
    expect(sponsorDiscountCode(null)).toBeUndefined()
  })
})

describe('campaignDiscountFor — the code a sponsor\'s cart gets on a page', () => {
  it('the page\'s campaign gives the brand ITS code there — not the default campaign\'s', () => {
    expect(campaignDiscountFor(boot(), FAVES, 5)).toEqual({ code: 'gratis_face_mask', campaignId: 5 })
  })

  it('no page campaign: the default campaign\'s, when the sponsor is in it', () => {
    expect(campaignDiscountFor(boot(), FAVES, undefined)).toEqual({ code: 'HOST', campaignId: 4 })
    expect(campaignDiscountFor(boot(), FAVES, [])).toEqual({ code: 'HOST', campaignId: 4 })
    // Tint is not in the default campaign: no code at all.
    expect(campaignDiscountFor(boot(), TINT, undefined)).toBeUndefined()
  })

  it('the candidates in their order (the elements\' first, then Vio.init\'s): the first one active with the sponsor', () => {
    expect(campaignDiscountFor(boot(), FAVES, [5, 4])).toEqual({ code: 'gratis_face_mask', campaignId: 5 })
    expect(campaignDiscountFor(boot(), FAVES, ['4', 5])).toEqual({ code: 'HOST', campaignId: 4 })
    // A paused or unknown campaign is skipped.
    expect(campaignDiscountFor(boot(), FAVES, [6, 99, 5])).toEqual({ code: 'gratis_face_mask', campaignId: 5 })
    expect(campaignDiscountFor(boot(), FAVES, [6])).toEqual({ code: 'HOST', campaignId: 4 })
  })

  it('only the sponsor\'s own block counts: one brand\'s code never goes on another brand\'s cart', () => {
    expect(campaignDiscountFor(boot(), TINT, 5)).toEqual({ code: 'TINT10', campaignId: 5 })
    const noTint = boot()
    noTint.campaigns![1]!.secondarySponsors = [sponsor(TINT, null)]
    expect(campaignDiscountFor(noTint, TINT, 5)).toBeUndefined()
    expect(campaignDiscountFor(noTint, FAVES, 5)).toEqual({ code: 'gratis_face_mask', campaignId: 5 })
  })

  it('the page\'s campaign without a code for the sponsor gives none — it does not fall back to the default\'s', () => {
    const b = boot()
    b.campaigns![1]!.primarySponsor = sponsor(FAVES, null)
    expect(campaignDiscountFor(b, FAVES, 5)).toBeUndefined()
    expect(discountCampaignFor(b, FAVES, 5)?.id).toBe(5)
  })

  it('a page campaign the sponsor is not in: the default campaign decides for that sponsor', () => {
    expect(campaignDiscountFor(boot(), FAVES, 77)).toEqual({ code: 'HOST', campaignId: 4 })
    const b = boot()
    b.campaigns!.push({ id: 7, name: 'Tint alene', status: 'active', primarySponsor: sponsor(TINT, 'TINT7') })
    expect(campaignDiscountFor(b, FAVES, 7)).toEqual({ code: 'HOST', campaignId: 4 })
    expect(campaignDiscountFor(b, TINT, 7)).toEqual({ code: 'TINT7', campaignId: 7 })
  })

  it('the default campaign from the top-level blocks when campaigns[] does not list it', () => {
    const b: BootstrapResponse = {
      campaign: { id: 4, name: 'Høst' },
      primarySponsor: sponsor(FAVES, 'TOPP'),
      secondarySponsors: [sponsor(LONE, 'ALENE')],
      campaigns: [],
    }
    expect(campaignDiscountFor(b, FAVES, undefined)).toEqual({ code: 'TOPP', campaignId: 4 })
    expect(campaignDiscountFor(b, LONE, undefined)).toEqual({ code: 'ALENE', campaignId: 4 })
  })

  it('a Commerce that predates the field, no campaign at all, no bootstrap: no code — never a throw', () => {
    const old: BootstrapResponse = {
      campaign: { id: 4, name: 'Høst' },
      primarySponsor: sponsor(FAVES),
      campaigns: [{ id: 4, name: 'Høst', status: 'active', primarySponsor: sponsor(FAVES) }],
    }
    expect(campaignDiscountFor(old, FAVES, 4)).toBeUndefined()
    expect(campaignDiscountFor({ campaign: null, noActiveCampaign: true, primarySponsor: sponsor(FAVES, 'X'), campaigns: [] } as never, FAVES, undefined)).toBeUndefined()
    expect(campaignDiscountFor(null, FAVES, 4)).toBeUndefined()
    expect(campaignDiscountFor({ campaigns: 'broken' } as never, FAVES, 4)).toBeUndefined()
    expect(campaignDiscountFor({ campaigns: [null, { id: 5, status: 'active', primarySponsor: null }] } as never, FAVES, 5)).toBeUndefined()
  })
})

describe('campaignDiscountNow — whether a code put on a cart from a campaign still holds', () => {
  it('the code the campaign gives the sponsor now', () => {
    expect(campaignDiscountNow(boot(), 5, FAVES)).toBe('gratis_face_mask')
    expect(campaignDiscountNow(boot(), 5, TINT)).toBe('TINT10')
    expect(campaignDiscountNow(boot(), 4, FAVES)).toBe('HOST')
  })

  it('changed in the dashboard: the new one', () => {
    const b = boot()
    b.campaigns![1]!.primarySponsor = sponsor(FAVES, 'NY')
    expect(campaignDiscountNow(b, 5, FAVES)).toBe('NY')
  })

  it('null when it gives none any more: no code, the sponsor left, the campaign paused or gone', () => {
    const b = boot()
    b.campaigns![1]!.primarySponsor = sponsor(FAVES, null)
    expect(campaignDiscountNow(b, 5, FAVES)).toBeNull()
    expect(campaignDiscountNow(boot(), 5, LONE)).toBeNull()
    expect(campaignDiscountNow(boot(), 6, FAVES)).toBeNull()
    expect(campaignDiscountNow(boot(), 99, FAVES)).toBeNull()
    expect(campaignDiscountNow({ campaign: null, noActiveCampaign: true, campaigns: [] } as never, 5, FAVES)).toBeNull()
  })

  it('the default campaign from its top-level blocks; nothing readable is null, never a throw', () => {
    const b: BootstrapResponse = { campaign: { id: 4, name: 'Høst' }, primarySponsor: sponsor(FAVES, 'TOPP') }
    expect(campaignDiscountNow(b, 4, FAVES)).toBe('TOPP')
    expect(campaignDiscountNow(null, 4, FAVES)).toBeNull()
    expect(campaignDiscountNow({ campaigns: 'broken' } as never, 4, FAVES)).toBeNull()
  })
})

describe('bootstrapDiscountCodes — the codes of a bootstrap, to tell a refresh that changed them', () => {
  it('empty when no block carries one: null, absent (an older Commerce), or nothing at all', () => {
    expect(bootstrapDiscountCodes(null)).toBe('')
    expect(bootstrapDiscountCodes({ campaign: { id: 4, name: 'x' }, primarySponsor: sponsor(FAVES), campaigns: [] })).toBe('')
    expect(bootstrapDiscountCodes({ campaign: { id: 4, name: 'x' }, primarySponsor: sponsor(FAVES, null) })).toBe('')
  })

  it('the same codes say the same, in any order; one changed, added or removed says otherwise', () => {
    const same = boot()
    same.campaigns!.reverse()
    expect(bootstrapDiscountCodes(boot())).not.toBe('')
    expect(bootstrapDiscountCodes(same)).toBe(bootstrapDiscountCodes(boot()))
    const changed = boot()
    changed.campaigns![1]!.secondarySponsors = [sponsor(TINT, 'TINT20')]
    expect(bootstrapDiscountCodes(changed)).not.toBe(bootstrapDiscountCodes(boot()))
    const removed = boot()
    removed.campaigns![1]!.secondarySponsors = [sponsor(TINT, null)]
    expect(bootstrapDiscountCodes(removed)).not.toBe(bootstrapDiscountCodes(boot()))
  })
})
