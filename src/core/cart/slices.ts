/**
 * The cart split per campaign (ADR-0034) — ONE rule, shared by the SDK's own
 * `begin_checkout` / `purchase` events, by `Vio.cartSlices()` and so by any
 * host with its own analytics sink (Vev).
 *
 * Every unit of every line goes to the campaign of its origin — the one the
 * place showed when it was added — and units without one to the campaign the
 * caller's rule resolves for the line's sponsor (`resolveCampaign`). One slice
 * per campaign: its items (quantities from the origins, merged per product +
 * variant), its value with two decimals, and `slot` / `contentId` /
 * `sponsorId` only when they are the same for the whole slice. A cart with
 * one campaign is one slice. Pure; never throws on odd lines.
 */

import type { AnalyticsItemInput } from '../analytics/analytics-manager.js'
import { lineOrigins } from './cart-manager.js'
import type { CartLineItem } from './types.js'

/** An item of a slice — the analytics item shape (ids as given, normalized on the wire). */
export type VioItem = AnalyticsItemInput

/** One campaign's share of the cart. */
export interface CartSlice {
  campaignId?: number
  sponsorId?: number
  slot?: string
  contentId?: string
  items: VioItem[]
  value: number
  currency?: string
  /** 1-based position of this slice and how many there are. */
  slice: number
  slices: number
}

/** The campaign of a unit without an explicit one: the caller's rule (slot assignment → sponsor → default). */
export type ResolveCampaign = (slot: string | undefined, sponsorId: number) => number | undefined

export function cartSlicesFrom(
  lines: ReadonlyArray<CartLineItem>,
  resolveCampaign: ResolveCampaign,
  fallbackCurrency?: string,
): CartSlice[] {
  if (!Array.isArray(lines) || lines.length === 0) return []
  const slices = new Map<
    string,
    {
      campaignId?: number
      sponsors: Set<number>
      slots: Set<string>
      contents: Set<string>
      items: Map<string, VioItem>
      value: number
      currency?: string
    }
  >()
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const sponsorId = Number(line.sponsorId)
    const unitPrice = Number(line.unitPrice) || 0
    for (const origin of lineOrigins(line)) {
      let campaignId = origin.campaignId
      if (campaignId === undefined) {
        try {
          campaignId = resolveCampaign(origin.slot, sponsorId)
        } catch {
          campaignId = undefined
        }
      }
      const key = campaignId === undefined ? 'default' : String(campaignId)
      let slice = slices.get(key)
      if (!slice) {
        slice = {
          campaignId,
          sponsors: new Set(),
          slots: new Set(),
          contents: new Set(),
          items: new Map(),
          value: 0,
          currency: line.currency || fallbackCurrency,
        }
        slices.set(key, slice)
      }
      if (Number.isFinite(sponsorId)) slice.sponsors.add(sponsorId)
      if (origin.slot) slice.slots.add(origin.slot)
      if (origin.contentId) slice.contents.add(origin.contentId)
      const itemKey = `${line.productId}::${line.variantId ?? ''}`
      const item = slice.items.get(itemKey)
      if (item) item.quantity = (item.quantity ?? 0) + origin.quantity
      else {
        slice.items.set(itemKey, {
          productId: line.productId,
          name: line.name,
          brand: line.brand,
          variantId: line.variantId,
          price: unitPrice,
          quantity: origin.quantity,
        })
      }
      slice.value += unitPrice * origin.quantity
    }
  }
  const list = [...slices.values()]
  return list.map((s, i) => ({
    campaignId: s.campaignId,
    sponsorId: s.sponsors.size === 1 ? [...s.sponsors][0] : undefined,
    slot: s.slots.size === 1 ? [...s.slots][0] : undefined,
    contentId: s.contents.size === 1 ? [...s.contents][0] : undefined,
    items: [...s.items.values()],
    value: Math.round(s.value * 100) / 100,
    currency: s.currency,
    slice: i + 1,
    slices: list.length,
  }))
}

/** True when at least one unit of these lines names its campaign itself (an origin with `campaignId`). */
export function hasExplicitCampaign(lines: ReadonlyArray<CartLineItem>): boolean {
  return lines.some((line) => lineOrigins(line).some((o) => o.campaignId !== undefined))
}
