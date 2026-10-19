/**
 * A line origin as Commerce receives it (ADR-0035 phase B): `origin` on each
 * line of `AddItem` and, when the quantity goes UP, on `UpdateItem` — the
 * origin of the units that update adds. shopcart keeps every origin of a
 * line with its units (`cart_item.origins`) and writes the order from them:
 * `order_item.campaign_id` / `location_id` / `component_kind`, and the
 * order's page when the checkout does not name one.
 *
 * snake_case on the wire, the caps of shopcart's `LineOriginDto` enforced
 * here, once. Pure: `lineOriginWire()` takes the origin and the page.
 */

import { CONTENT_TITLE_MAX_LENGTH, capContentUrl, resolveContent, type ContentRef } from '../content.js'
import { SLOT_ID_MAX_LENGTH, SLOT_KIND_MAX_LENGTH, componentKindOf } from '../slots.js'
import type { CartOrigin } from './types.js'

/** `LineOriginDto` (shopcart `cart/dtos/send/line-origin.dto.ts`). */
export interface LineOriginWire {
  campaign_id?: number
  location_id?: string
  component_kind?: string
  content_url?: string
  content_title?: string
}

/** The caps of `LineOriginDto` — a longer value is refused whole by the API, so it is cut here. */
export const LINE_ORIGIN_CAPS = Object.freeze({
  locationId: SLOT_ID_MAX_LENGTH,
  componentKind: SLOT_KIND_MAX_LENGTH,
  contentUrl: 2_048,
  contentTitle: CONTENT_TITLE_MAX_LENGTH,
})

/** The page the units are added from, for an origin that does not carry its own. */
export interface OriginPage {
  contentUrl?: string
  contentTitle?: string
}

/**
 * The origin for the wire, or `undefined` when the SDK knows no PLACE for the
 * units — no campaign, no slot, no kind of element (a host adding with no
 * attribution): then nothing is sent and the line inherits the order's
 * campaign on the server. The page (`content_url` / `content_title`) is the
 * origin's own when it has one — the page the units were added from — else
 * the current page's; `campaign_id` only as a positive integer (the DTO's
 * `@IsInt() @Min(1)`).
 */
export function lineOriginWire(
  origin: CartOrigin | null | undefined,
  page: OriginPage = {},
): LineOriginWire | undefined {
  if (!origin || typeof origin !== 'object') return undefined
  const out: LineOriginWire = {}
  const campaignId = Number(origin.campaignId)
  if (Number.isInteger(campaignId) && campaignId > 0) out.campaign_id = campaignId
  const locationId = cut(origin.slot, LINE_ORIGIN_CAPS.locationId)
  if (locationId) out.location_id = locationId
  // The kind the element said, else the kind word in the slot id — the
  // collector's rule, so the order line and `breakdown?by=component_kind` agree.
  const kind = cut(origin.componentKind, LINE_ORIGIN_CAPS.componentKind) ?? componentKindOf(undefined, origin.slot)
  if (kind) out.component_kind = kind
  if (!out.campaign_id && !out.location_id && !out.component_kind) return undefined
  const url = capContentUrl(origin.contentUrl) ?? capContentUrl(page.contentUrl)
  if (url) out.content_url = url
  const title = cut(origin.contentTitle, LINE_ORIGIN_CAPS.contentTitle) ?? cut(page.contentTitle, LINE_ORIGIN_CAPS.contentTitle)
  if (title) out.content_title = title
  return out
}

/**
 * The current page as `OriginPage`: what `Vio.content()` answers (the init
 * options included) when the facade is on the page, else `resolveContent()`
 * — its url (`location.href`, capped) and title; `{}` without a document.
 */
export function currentOriginPage(): OriginPage {
  const out: OriginPage = {}
  try {
    const facade = (globalThis as { __VIO_FACADE__?: { content?: () => ContentRef } }).__VIO_FACADE__
    const content = typeof facade?.content === 'function' ? facade.content() : resolveContent()
    const url = capContentUrl(content?.url)
    if (url) out.contentUrl = url
    const title = cut(content?.title, LINE_ORIGIN_CAPS.contentTitle)
    if (title) out.contentTitle = title
  } catch {
    /* no page to speak of */
  }
  return out
}

function cut(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim()
  if (!text) return undefined
  return text.length > max ? text.slice(0, max).trim() || undefined : text
}
