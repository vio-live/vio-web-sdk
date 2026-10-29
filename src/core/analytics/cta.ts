/**
 * Button tracking (`cta_click`): which buttons shoppers use.
 *
 * One event per tap on a button of the SDK's elements (they dispatch
 * `vio:cta-click`, which `Vio.analytics` turns into `cta_click` once started)
 * or of a host's own UI (`Vio.trackCta()`). The wire contract is shared with
 * the collector — everything rides in `context`:
 *
 * | field                | what                                                              |
 * |----------------------|-------------------------------------------------------------------|
 * | `cta`                | the button's id, `[a-z0-9_.:-]{1,64}` (README lists them)         |
 * | `cta_location`       | `detail` · `cart` · `card` · `checkout` · `host` · `block`        |
 * | `cta_label`          | the visible text of the button, trimmed, ≤ 64                     |
 * | `cta_variant`        | the host's name of the button option it tests, `[A-Za-z0-9._:-]{1,64}` |
 * | `option_value`       | the option value chosen (`size`), ≤ 64                            |
 * | `product_id`         | the product, as a string                                          |
 * | `product_variant_id` | the PRODUCT variant (on `cta_click`, `variant_id` is the layout's EXPERIMENT variant, as on `view_item`) |
 * | `layout_id` · `layout_revision` · `experiment_id` · `variant_id` | the detail's layout, only a non-default one |
 *
 * …plus `sponsor_id`, `campaign_id`, `location_id` (the slot), `content_*`
 * and `component_template_id` as every other event carries them.
 *
 * Pure module: no DOM, no side effects.
 */

import { normalizeLayoutOrigin, type DetailLayoutOrigin } from '../detail-layout.js'
import { toNumber } from '../slots.js'
import type { AnalyticsContext } from './analytics-manager.js'

/** Where the button is: the SDK's elements, a host's own UI, a host's article block. */
export const CTA_LOCATIONS = ['detail', 'cart', 'card', 'checkout', 'host', 'block'] as const
export type CtaLocation = (typeof CTA_LOCATIONS)[number]

/** A button id: lower case, digits and `_ . : -`, 1–64 chars. */
export const CTA_ID_PATTERN = /^[a-z0-9_.:-]{1,64}$/
/** A host's button option (`cta_variant`): letters, digits and `. _ : -`, 1–64 chars. */
export const CTA_VARIANT_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
/** The cap of `cta_label` and `option_value`. */
export const CTA_TEXT_MAX_LENGTH = 64
/** The collector's cap on ids (`product_id`, `location_id`, `content_id`…). */
const ID_MAX_LENGTH = 128

/**
 * A button tap, as `Vio.trackCta()` takes it and as the SDK's elements put it
 * in the `detail` of `vio:cta-click`.
 */
export interface CtaInput {
  /** The button's id (`add_to_cart`, `vipps`, `size`…). Invalid → the call is ignored (one `console.warn`). */
  cta: string
  /** Where the button is. Default `host`. */
  location?: CtaLocation | string
  /** The visible text of the button (`Legg i handlekurv`). Trimmed, cut to 64. */
  label?: string
  /** The host's name of the button option it is testing (`bar-kjop`). Invalid → left out. */
  variant?: string
  /** The option value chosen (`M`, `42`) — for `size`. */
  optionValue?: string
  productId?: number | string
  /** The PRODUCT variant (`product_variant_id` on the wire). */
  productVariantId?: number | string
  sponsorId?: number | string
  campaignId?: number | string
  slot?: string
  contentId?: string | number
  contentTitle?: string
  componentTemplateId?: string
  /** The `<vio-product-detail>` layout shown, when the button is in one (`{ layoutId, layoutRevision, experimentId, variantId }`). */
  layout?: DetailLayoutOrigin | null
}

/** What `vio:cta-click` carries: a `CtaInput` whose `location` is always said. */
export interface CtaClickDetail extends CtaInput {
  location: CtaLocation
}

/** A valid button id? */
export function isCtaId(value: unknown): value is string {
  return typeof value === 'string' && CTA_ID_PATTERN.test(value)
}

/**
 * Visible text as the wire takes it: control characters out, whitespace
 * collapsed, trimmed, cut to `max` (UTF-16 units, never inside a surrogate
 * pair). `undefined` when nothing is left.
 */
export function ctaText(value: unknown, max = CTA_TEXT_MAX_LENGTH): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  // eslint-disable-next-line no-control-regex
  const clean = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return undefined
  if (clean.length <= max) return clean
  let cut = clean.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut.trimEnd() || undefined
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return v && v.length <= ID_MAX_LENGTH ? v : undefined
}

/** A positive whole id; 0 / '' / junk = not said (the SDK's elements use 0 for «none»). */
function positive(value: unknown): number | undefined {
  const n = toNumber(value)
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined
}

function warn(message: string): void {
  try {
    console.warn(`[Vio.trackCta] ${message}`)
  } catch {
    /* no console */
  }
}

/**
 * The `context` of a `cta_click`, or `null` when the button id is invalid
 * (warned once for the call). An unknown `location` becomes `host` and an
 * invalid `variant` is left out, each with a warning; everything else that
 * does not fit is left out quietly.
 */
export function ctaContextOf(input: CtaInput | null | undefined): AnalyticsContext | null {
  const cta = input?.cta
  if (!isCtaId(cta)) {
    warn(`ignored: cta must be 1–64 chars of [a-z0-9_.:-], got ${JSON.stringify(cta)}`)
    return null
  }
  let location: CtaLocation = 'host'
  if (input!.location !== undefined && input!.location !== null && input!.location !== '') {
    if ((CTA_LOCATIONS as readonly string[]).includes(String(input!.location))) {
      location = input!.location as CtaLocation
    } else {
      warn(`unknown location ${JSON.stringify(input!.location)} — sent as 'host' (${CTA_LOCATIONS.join(' | ')})`)
    }
  }
  let variant: string | undefined
  if (input!.variant !== undefined && input!.variant !== null && input!.variant !== '') {
    if (typeof input!.variant === 'string' && CTA_VARIANT_PATTERN.test(input!.variant)) variant = input!.variant
    else warn(`variant left out: 1–64 chars of [A-Za-z0-9._:-], got ${JSON.stringify(input!.variant)}`)
  }
  const i = input!
  const layout = normalizeLayoutOrigin(i.layout)
  const contentId =
    typeof i.contentId === 'number' ? (Number.isFinite(i.contentId) ? i.contentId : undefined) : idOf(i.contentId)
  const slot = typeof i.slot === 'string' && i.slot.trim() ? i.slot.trim() : undefined
  const ctx: AnalyticsContext = {
    cta,
    ctaLocation: location,
    ctaLabel: ctaText(i.label),
    ctaVariant: variant,
    optionValue: ctaText(i.optionValue),
    productId: idOf(i.productId),
    productVariantId: idOf(i.productVariantId),
    sponsorId: positive(i.sponsorId),
    campaignId: positive(i.campaignId),
    slot,
    contentId,
    contentTitle: typeof i.contentTitle === 'string' && i.contentTitle.trim() ? i.contentTitle.trim() : undefined,
    componentTemplateId: idOf(i.componentTemplateId),
    ...(layout.layoutId
      ? {
          layoutId: layout.layoutId,
          layoutRevision: layout.layoutRevision ?? '',
          experimentId: layout.experimentId,
          variantId: layout.variantId,
        }
      : {}),
  }
  for (const key of Object.keys(ctx) as Array<keyof AnalyticsContext>) {
    if (ctx[key] === undefined) delete ctx[key]
  }
  return ctx
}
