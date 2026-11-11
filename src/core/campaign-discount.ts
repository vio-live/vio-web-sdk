/**
 * The campaign's discount code — set in Vio's dashboard, on the campaign,
 * per sponsor — as the bootstrap (`GET /v2/mobile/config`) gives it: every
 * sponsor block of `campaigns[]` (`primarySponsor`, `secondarySponsors[]`)
 * carries `discountCode`, the code of THAT campaign for THAT brand, and so do
 * the top-level blocks (the default campaign). `null` is no code, and a
 * Commerce that predates the field does not send it: the same.
 *
 * Which campaign's code a sponsor's cart gets on a page is the page's
 * campaign — the one the SDK already takes as the page's: the campaigns its
 * elements name (`vio-campaign`, an ancestor's `data-vio-campaign`, in
 * document order), then `Vio.init({ campaignId })` — the first of them that
 * is active and that the sponsor takes part in; when none of them has the
 * sponsor (or the page names none), the surface's default campaign, when the
 * sponsor takes part in it. Only that sponsor's own block counts: the code of
 * one brand never goes on another brand's cart.
 *
 * Pure, side-effect free; never throws on a malformed bootstrap.
 */

import { normalizeDiscountCode } from './cart/discount-code.js'
import {
  activeCampaignEntry,
  campaignSponsorIds,
  defaultCampaignEntry,
  toNumber,
  type CampaignHint,
} from './slots.js'
import type { BootstrapCampaignEntry, BootstrapResponse } from './types.js'

type BootLike = Pick<BootstrapResponse, 'campaign' | 'campaigns' | 'primarySponsor' | 'secondarySponsors'>

/** The code a campaign gives a sponsor's cart, and the campaign it comes from. */
export interface CampaignDiscount {
  code: string
  campaignId: number
}

/** A sponsor block's code, as the SDK sends codes; `undefined` for `null`, absent, or something that is not a code. */
export function sponsorDiscountCode(sponsor: unknown): string | undefined {
  if (!sponsor || typeof sponsor !== 'object') return undefined
  return normalizeDiscountCode((sponsor as { discountCode?: unknown }).discountCode)
}

/** The block of `sponsorId` in a campaign: its primary, else one of its secondaries. */
function sponsorBlockIn(campaign: BootstrapCampaignEntry, sponsorId: number): unknown {
  if (toNumber(campaign.primarySponsor?.id) === sponsorId) return campaign.primarySponsor
  const secondaries = Array.isArray(campaign.secondarySponsors) ? campaign.secondarySponsors : []
  return secondaries.find((s) => !!s && typeof s === 'object' && toNumber(s.id) === sponsorId)
}

/**
 * The campaign whose code a sponsor's cart gets on this page: the first of
 * the page's campaigns (`candidates`, in precedence order) that is active and
 * that the sponsor takes part in; else the default campaign, when the sponsor
 * takes part in it; `null` otherwise.
 */
export function discountCampaignFor(
  boot: BootLike | null | undefined,
  sponsorId: number,
  candidates: CampaignHint,
): BootstrapCampaignEntry | null {
  if (!boot) return null
  try {
    const page = activeCampaignEntry(boot, candidates, sponsorId)
    if (page) return page
    const fallback = defaultCampaignEntry(boot)
    return fallback && campaignSponsorIds(fallback).includes(sponsorId) ? fallback : null
  } catch {
    return null
  }
}

/**
 * The code the page's campaign (`discountCampaignFor`) gives a sponsor's
 * cart, with that campaign's id; `undefined` when the campaign gives it none
 * (or there is no such campaign).
 */
export function campaignDiscountFor(
  boot: BootLike | null | undefined,
  sponsorId: number,
  candidates: CampaignHint,
): CampaignDiscount | undefined {
  try {
    const campaign = discountCampaignFor(boot, sponsorId, candidates)
    const campaignId = toNumber(campaign?.id)
    if (!campaign || campaignId === undefined) return undefined
    const code = sponsorDiscountCode(sponsorBlockIn(campaign, sponsorId))
    return code ? { code, campaignId } : undefined
  } catch {
    return undefined
  }
}

/**
 * What campaign `campaignId` gives a sponsor NOW — to tell whether a code the
 * SDK put on a cart from it still holds: the code; `null` when it gives none
 * any more — no code (or `null`) on the sponsor's block, the sponsor is no
 * longer in it, or the campaign is neither the default one nor an active one
 * of `campaigns[]` (paused, ended, gone from the bootstrap).
 */
export function campaignDiscountNow(
  boot: BootLike | null | undefined,
  campaignId: number,
  sponsorId: number,
): string | null {
  if (!boot) return null
  try {
    const fallback = defaultCampaignEntry(boot)
    const campaign =
      fallback && toNumber(fallback.id) === campaignId ? fallback : activeCampaignEntry(boot, campaignId)
    if (!campaign) return null
    return sponsorDiscountCode(sponsorBlockIn(campaign, sponsorId)) ?? null
  } catch {
    return null
  }
}

/**
 * Every code the bootstrap gives, as one string — `campaign:sponsor=code`,
 * sorted — so a refresh that changed one is told from one that did not. `''`
 * when it gives none (no sponsor block carries one, or a Commerce that
 * predates the field).
 */
export function bootstrapDiscountCodes(boot: BootLike | null | undefined): string {
  if (!boot || typeof boot !== 'object') return ''
  const out = new Set<string>()
  const collect = (campaignId: unknown, sponsor: unknown) => {
    const code = sponsorDiscountCode(sponsor)
    if (!code) return
    out.add(`${toNumber(campaignId) ?? ''}:${toNumber((sponsor as { id?: unknown }).id) ?? ''}=${code}`)
  }
  try {
    const campaigns = Array.isArray(boot.campaigns) ? boot.campaigns : []
    for (const c of campaigns) {
      if (!c || typeof c !== 'object') continue
      collect(c.id, c.primarySponsor)
      for (const s of Array.isArray(c.secondarySponsors) ? c.secondarySponsors : []) collect(c.id, s)
    }
    collect(boot.campaign?.id, boot.primarySponsor)
    for (const s of Array.isArray(boot.secondarySponsors) ? boot.secondarySponsors : []) collect(boot.campaign?.id, s)
  } catch {
    /* a malformed bootstrap gives what could be read */
  }
  return [...out].sort().join('|')
}
