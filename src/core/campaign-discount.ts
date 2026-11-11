/**
 * The campaign's discount — set in Vio's dashboard, on the campaign, per
 * sponsor — as the bootstrap (`GET /v2/mobile/config`) gives it: every
 * sponsor block of `campaigns[]` (`primarySponsor`, `secondarySponsors[]`)
 * carries `discount: { ref } | null`, the discount of THAT campaign for THAT
 * brand, and so do the top-level blocks (the default campaign). The code
 * itself never reaches the page: `ref` is an opaque reference, and the SDK
 * asks Commerce to apply "the code of this campaign" (`ApplyDiscount` with
 * the campaign); Commerce looks the code up. `ref` changes every time the
 * dashboard sets the code again, so a new `ref` is a new code. `null` is no
 * code, and a Commerce that predates the field does not send it: the same.
 * (The sponsor blocks' old `discountCode` is not read: Commerce sends it as
 * `null`.)
 *
 * Which campaign's discount a sponsor's cart gets on a page is the page's
 * campaign — the one the SDK already takes as the page's: the campaigns its
 * elements name (`vio-campaign`, an ancestor's `data-vio-campaign`, in
 * document order), then `Vio.init({ campaignId })` — the first of them that
 * is active and that the sponsor takes part in; when none of them has the
 * sponsor (or the page names none), the surface's default campaign, when the
 * sponsor takes part in it. Only that sponsor's own block counts: the
 * discount of one brand never goes on another brand's cart.
 *
 * Whether a brand's cart may get a code nobody typed at all — the campaign's
 * or the page's own — is `sponsorTakesDiscounts`: only when one of the ways
 * the brand is paid with takes discounts.
 *
 * Pure, side-effect free; never throws on a malformed bootstrap.
 */

import {
  activeCampaignEntry,
  campaignSponsorIds,
  defaultCampaignEntry,
  toNumber,
  type CampaignHint,
} from './slots.js'
import type { BootstrapCampaignEntry, BootstrapResponse } from './types.js'

type BootLike = Pick<BootstrapResponse, 'campaign' | 'campaigns' | 'primarySponsor' | 'secondarySponsors'>

/** The longest reference the SDK takes from a bootstrap. */
const REF_MAX_LENGTH = 128

/** The discount a campaign gives a sponsor's cart: its reference, and the campaign it comes from. */
export interface CampaignDiscount {
  ref: string
  campaignId: number
}

/**
 * A reference as the SDK keeps it: trimmed; `undefined` for anything that is
 * not one — not a string, empty, too long, or with a space or a control
 * character inside.
 */
export function normalizeDiscountRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const ref = value.trim()
  if (!ref || ref.length > REF_MAX_LENGTH) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(ref)) return undefined
  return ref
}

/** A sponsor block's discount reference; `undefined` for `null`, absent, or something that is not one. */
export function sponsorDiscountRef(sponsor: unknown): string | undefined {
  if (!sponsor || typeof sponsor !== 'object') return undefined
  const discount = (sponsor as { discount?: unknown }).discount
  if (!discount || typeof discount !== 'object') return undefined
  return normalizeDiscountRef((discount as { ref?: unknown }).ref)
}

/** The block of `sponsorId` in a campaign: its primary, else one of its secondaries. */
function sponsorBlockIn(campaign: BootstrapCampaignEntry, sponsorId: number): unknown {
  if (toNumber(campaign.primarySponsor?.id) === sponsorId) return campaign.primarySponsor
  const secondaries = Array.isArray(campaign.secondarySponsors) ? campaign.secondarySponsors : []
  return secondaries.find((s) => !!s && typeof s === 'object' && toNumber(s.id) === sponsorId)
}

/**
 * The campaign whose discount a sponsor's cart gets on this page: the first
 * of the page's campaigns (`candidates`, in precedence order) that is active
 * and that the sponsor takes part in; else the default campaign, when the
 * sponsor takes part in it; `null` otherwise.
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
 * The discount the page's campaign (`discountCampaignFor`) gives a sponsor's
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
    const ref = sponsorDiscountRef(sponsorBlockIn(campaign, sponsorId))
    return ref ? { ref, campaignId } : undefined
  } catch {
    return undefined
  }
}

/**
 * What campaign `campaignId` gives a sponsor NOW — to tell whether a
 * discount the SDK put on a cart from it still holds: its reference; `null`
 * when it gives none any more — `discount: null` on the sponsor's block, the
 * sponsor is no longer in it, or the campaign is neither the default one nor
 * an active one of `campaigns[]` (paused, ended, gone from the bootstrap);
 * `undefined` — cannot tell — when the sponsor's block has no `discount` at
 * all (a Commerce that predates it: what is on the cart is left as it is).
 */
export function campaignDiscountNow(
  boot: BootLike | null | undefined,
  campaignId: number,
  sponsorId: number,
): string | null | undefined {
  if (!boot) return null
  try {
    const fallback = defaultCampaignEntry(boot)
    const campaign =
      fallback && toNumber(fallback.id) === campaignId ? fallback : activeCampaignEntry(boot, campaignId)
    if (!campaign) return null
    const block = sponsorBlockIn(campaign, sponsorId)
    if (block && typeof block === 'object' && !('discount' in block)) return undefined
    return sponsorDiscountRef(block) ?? null
  } catch {
    return null
  }
}

/**
 * Every discount the bootstrap gives, as one string — `campaign:sponsor=ref`,
 * sorted — so a refresh that changed one is told from one that did not. `''`
 * when it gives none (no sponsor block carries one, or a Commerce that
 * predates the field).
 */
export function bootstrapDiscountRefs(boot: BootLike | null | undefined): string {
  if (!boot || typeof boot !== 'object') return ''
  const out = new Set<string>()
  const collect = (campaignId: unknown, sponsor: unknown) => {
    const ref = sponsorDiscountRef(sponsor)
    if (!ref) return
    out.add(`${toNumber(campaignId) ?? ''}:${toNumber((sponsor as { id?: unknown }).id) ?? ''}=${ref}`)
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

/** A payment method's slug as the bootstrap lists it (`vipps`, `apple_pay`…), letters only, lower case. */
function methodLetters(method: unknown): string {
  return typeof method === 'string' ? method.toLowerCase().replace(/[^a-z]/g, '') : ''
}

/**
 * Whether a brand's selling block (`sponsor.commerce` of the bootstrap) lets
 * a code nobody typed — the campaign's, or the page's own — go on its cart:
 * a code is paid for only with the methods that take discounts, so a brand
 * none of whose methods does would carry a code no way to pay accepts.
 *
 * - `discountMethods` (the methods of the brand's channel that take
 *   discounts): when listed, at least one;
 * - a bootstrap without it: when `paymentMethods` is listed, it has Vipps;
 * - a block that lists neither: yes — nothing says otherwise, and Commerce
 *   checks the method again when the payment starts;
 * - no selling block: no.
 */
export function sponsorTakesDiscounts(commerce: unknown): boolean {
  if (!commerce || typeof commerce !== 'object') return false
  const { discountMethods, paymentMethods } = commerce as { discountMethods?: unknown; paymentMethods?: unknown }
  if (Array.isArray(discountMethods)) return discountMethods.some((m) => methodLetters(m) !== '')
  if (Array.isArray(paymentMethods)) return paymentMethods.some((m) => methodLetters(m) === 'vipps')
  return true
}
