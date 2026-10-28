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
import { normalizeLayoutOrigin } from '../detail-layout.js'
import type { CartLineItem, CartOrigin } from './types.js'

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
      // One item per product + variant AND detail layout (0.34): units added
      // under two layouts are two items, each credited to its own layout.
      const layout = itemLayoutOf(origin)
      const itemKey = `${line.productId}::${line.variantId ?? ''}::${layoutKeyOf(layout)}`
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
          ...layout,
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

/** The layout fields of an item (camelCase, `AnalyticsItemInput`): only when the origin names a detail layout. */
export type ItemLayout = Pick<VioItem, 'layoutId' | 'layoutRevision' | 'experimentId' | 'experimentVariantId'>

/**
 * The detail layout an origin's units were added from, as item fields
 * (`experimentVariantId` = the origin's experiment `variantId`); `{}` when
 * the units came from no layout (the default one, a card, the cart).
 */
export function itemLayoutOf(origin: CartOrigin | null | undefined): ItemLayout {
  const l = normalizeLayoutOrigin(origin)
  if (!l.layoutId) return {}
  return {
    layoutId: l.layoutId,
    layoutRevision: l.layoutRevision ?? '',
    experimentId: l.experimentId ?? '',
    experimentVariantId: l.variantId ?? '',
  }
}

function layoutKeyOf(layout: ItemLayout): string {
  return layout.layoutId
    ? [layout.layoutId, layout.layoutRevision, layout.experimentId, layout.experimentVariantId].join('|')
    : ''
}

/**
 * The lines as items, one per line AND detail layout (0.34): a line whose
 * units came from two layouts is two items with their own quantities — the
 * split `cartSlicesFrom` makes, for an event that is not split per campaign.
 * A line without layouts is exactly one item, as before.
 */
export function lineItemsByLayout(lines: ReadonlyArray<CartLineItem>): VioItem[] {
  const out: VioItem[] = []
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const base: VioItem = {
      productId: line.productId,
      name: line.name,
      brand: line.brand,
      variantId: line.variantId,
      price: line.unitPrice,
      quantity: line.quantity,
    }
    const origins = lineOrigins(line)
    if (!origins.some((o) => normalizeLayoutOrigin(o).layoutId)) {
      out.push(base)
      continue
    }
    const parts = new Map<string, VioItem>()
    for (const origin of origins) {
      const layout = itemLayoutOf(origin)
      const key = layoutKeyOf(layout)
      const part = parts.get(key)
      if (part) part.quantity = (part.quantity ?? 0) + origin.quantity
      else parts.set(key, { ...base, quantity: origin.quantity, ...layout })
    }
    out.push(...parts.values())
  }
  return out
}
