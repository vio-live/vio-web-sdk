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

import { CONTENT_TITLE_MAX_LENGTH, originAndPath, resolveContent, type ContentRef } from '../content.js'
import { SLOT_ID_MAX_LENGTH, SLOT_KIND_MAX_LENGTH, componentKindOf } from '../slots.js'
import type { SurfacePrivacyMode } from '../types.js'
import type { CartOrigin } from './types.js'

/** The largest `Int` GraphQL coerces; a bigger id would fail the whole mutation. */
export const GRAPHQL_INT_MAX = 2_147_483_647

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

export interface LineOriginWireOptions {
  /** The current page, for an origin that does not carry its own. */
  page?: OriginPage
  /**
   * The surface's privacy mode. Only on a `standard` surface do the slot
   * (`location_id`) and the page (`content_url`, `content_title`) travel —
   * which screen a unit was sold from is what `minimal` keeps private, the
   * same promise the collector keeps for the events. `campaign_id` and
   * `component_kind` always do. Default `unknown`: fail closed.
   */
  privacyMode?: SurfacePrivacyMode | 'unknown'
}

/**
 * The origin for the wire, or `undefined` when the SDK knows no PLACE for the
 * units — no campaign, no slot, no kind of element (a host adding with no
 * attribution): then nothing is sent and the line inherits the order's
 * campaign on the server. The page is the origin's own when it has one — the
 * page the units were added from — else the current page's, as origin + path;
 * `campaign_id` only as a positive `Int` (the DTO's `@IsInt() @Min(1)`, the
 * gateway's 32-bit coercion).
 */
export function lineOriginWire(
  origin: CartOrigin | null | undefined,
  options: LineOriginWireOptions = {},
): LineOriginWire | undefined {
  if (!origin || typeof origin !== 'object') return undefined
  const page = options.page ?? {}
  const standard = options.privacyMode === 'standard'
  const out: LineOriginWire = {}
  const campaignId = Number(origin.campaignId)
  if (Number.isInteger(campaignId) && campaignId > 0 && campaignId <= GRAPHQL_INT_MAX) out.campaign_id = campaignId
  const locationId = cut(origin.slot, LINE_ORIGIN_CAPS.locationId)
  if (locationId && standard) out.location_id = locationId
  // The kind the element said, else the kind word in the slot id — the
  // collector's rule, so the order line and `breakdown?by=component_kind` agree.
  const kind = cut(origin.componentKind, LINE_ORIGIN_CAPS.componentKind) ?? componentKindOf(undefined, origin.slot)
  if (kind) out.component_kind = kind
  if (!out.campaign_id && !out.location_id && !out.component_kind) return undefined
  if (!standard) return out
  const url = originAndPath(origin.contentUrl, LINE_ORIGIN_CAPS.contentUrl) ?? originAndPath(page.contentUrl, LINE_ORIGIN_CAPS.contentUrl)
  if (url) out.content_url = url
  const title = cut(origin.contentTitle, LINE_ORIGIN_CAPS.contentTitle) ?? cut(page.contentTitle, LINE_ORIGIN_CAPS.contentTitle)
  if (title) out.content_title = title
  return out
}

/**
 * The current page as `OriginPage`: what `Vio.content()` answers (the init
 * options included) when the facade is on the page, else `resolveContent()`
 * — its url (origin + path, capped) and title; `{}` without a document.
 */
export function currentOriginPage(): OriginPage {
  const out: OriginPage = {}
  try {
    const facade = (globalThis as { __VIO_FACADE__?: { content?: () => ContentRef } }).__VIO_FACADE__
    const content = typeof facade?.content === 'function' ? facade.content() : resolveContent()
    const url = originAndPath(content?.url, LINE_ORIGIN_CAPS.contentUrl)
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

/**
 * The surface's privacy mode as the facade knows it, for the cart's lines:
 * the answer the facade preloaded at `Vio.init()` (`privacyMode()` resolves
 * at once when it is known, and never waits more than the preload's cap);
 * `unknown` — fail closed — without a facade or when it cannot tell.
 */
export async function currentPrivacyMode(): Promise<SurfacePrivacyMode | 'unknown'> {
  try {
    const facade = (globalThis as { __VIO_FACADE__?: { privacyMode?: () => Promise<unknown> | unknown } }).__VIO_FACADE__
    if (typeof facade?.privacyMode !== 'function') return 'unknown'
    const mode = await facade.privacyMode()
    return mode === 'standard' || mode === 'minimal' ? mode : 'unknown'
  } catch {
    return 'unknown'
  }
}
