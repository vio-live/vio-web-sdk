/**
 * The discount code of a cart.
 *
 * Commerce takes ONE code per backend cart (`Discounts.ApplyDiscount`) and
 * from then on answers that cart's lines with what the code takes off each
 * (`price.discount`, see cart/discount.ts). The code is the brand's own (its
 * shop's coupon): Commerce asks the brand's shop when it is applied — one to
 * three seconds — and again right before a payment. The same code again is
 * taken again; another code while one is on the cart is refused.
 *
 * A refusal says why with a stable word (`COUPON_EXPIRED`…) in the answer's
 * `message`; a payment Commerce would not start because of the discount
 * names one in its error. `discountReasonOf` reads it out of either.
 *
 * A code is put on the cart — and so validated — BEFORE paying, in the cart
 * or the checkout: Commerce answers there and then, the total changes there
 * and then, and a code that is no good is refused there. The check at a
 * payment's start is a safety net (a coupon that ended between applying and
 * paying), never where a shopper first hears about their code.
 *
 * Who is told what came of a code depends on who asked for it:
 * - a code someone ASKED for — typed in the «Rabattkode» field, or
 *   `Vio.applyDiscountCode()` from a host's own field — always has its answer
 *   said, taken or not, with why;
 * - the PAGE's own code (the campaign's, `discountCode`, `?vio_discount=`),
 *   which nobody typed, shows only once it is taken: refused, nothing is said and the
 *   purchase goes on at its prices (a visitor who typed nothing never reads
 *   «invalid code»).
 * A payment Commerce refuses because of the discount says why either way.
 *
 * The code that goes on a cart without the shopper typing it is, first of
 * all, the CAMPAIGN's: set in Vio's dashboard per campaign and sponsor, given
 * by the bootstrap (`discountCode` on the sponsor blocks), put on THAT
 * sponsor's cart on the campaign's pages, and followed when a newer bootstrap
 * changes or removes it (core/campaign-discount.ts). A page can also name one
 * for all its carts, as an override: `Vio.init({ discountCode })`, or
 * `?vio_discount=CODE` in its URL — kept for the tab (`sessionStorage`), so
 * it survives the pages of the visit and the way back from the payment;
 * `?vio_discount=` (empty) forgets it.
 *
 * Never throws; the URL and the storage are taken as arguments (defaults:
 * the real ones), like `analytics/internal-traffic.ts`.
 */

import type { DiscountAnswer } from '../api/cart-queries.js'
import { storageGet, storageRemove, storageSet } from '../safe-storage.js'

/** Longest code the SDK sends — anything longer is not a code a shopper or a campaign was given. */
export const DISCOUNT_CODE_MAX_LENGTH = 64

/**
 * The code as it is sent: trimmed, as written (Commerce decides about case).
 * `undefined` for anything that is not a code — empty, too long, or with a
 * control character or a space inside.
 */
export function normalizeDiscountCode(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const code = String(value).trim()
  if (!code || code.length > DISCOUNT_CODE_MAX_LENGTH) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(code)) return undefined
  return code
}

/**
 * Why Commerce refused a code (`ApplyDiscount` answered `executed: false`
 * with one of these as its `message`):
 * - `COUPON_NOT_FOUND` — there is no such code;
 * - `COUPON_EXPIRED` — it is no longer valid;
 * - `COUPON_USAGE_LIMIT` — it has been used as many times as it may;
 * - `COUPON_NOT_SUPPORTED` — it cannot be used here (a kind of coupon Vio does not take);
 * - `COUPON_MIN_AMOUNT` — the cart does not reach the amount it asks for;
 * - `COUPON_OTHER_APPLIED` — the cart already has another code: take it off first;
 * - `COUPON_UNAVAILABLE` — the brand's shop could not be asked right now.
 */
export const COUPON_REASONS = [
  'COUPON_NOT_FOUND',
  'COUPON_EXPIRED',
  'COUPON_USAGE_LIMIT',
  'COUPON_NOT_SUPPORTED',
  'COUPON_MIN_AMOUNT',
  'COUPON_OTHER_APPLIED',
  'COUPON_UNAVAILABLE',
] as const

/**
 * Why Commerce would not start a payment because of the cart's discount (in
 * the error of the payment's start, where a `COUPON_*` may come too — the
 * code is checked again right before charging):
 * - `GIFT_MAX_ONE_UNIT` — a line that is a gift has more than one unit;
 * - `CHECKOUT_AMOUNT_ZERO` — the cart holds only the gift: nothing to pay;
 * - `DISCOUNT_UNAVAILABLE` — the discount could not be worked out right now.
 */
export const DISCOUNT_PAYMENT_REASONS = ['GIFT_MAX_ONE_UNIT', 'CHECKOUT_AMOUNT_ZERO', 'DISCOUNT_UNAVAILABLE'] as const

export type CouponReason = (typeof COUPON_REASONS)[number]
export type DiscountPaymentReason = (typeof DISCOUNT_PAYMENT_REASONS)[number]
export type DiscountReason = CouponReason | DiscountPaymentReason

const ALL_REASONS: readonly DiscountReason[] = [...COUPON_REASONS, ...DISCOUNT_PAYMENT_REASONS]

/**
 * The reason a text names — a refusal's `message` (the word alone) or a
 * payment error's text (the word somewhere in it): the first of the known
 * ones, as a whole word. `undefined` when it names none.
 */
export function discountReasonOf(text: unknown): DiscountReason | undefined {
  if (typeof text !== 'string' || !text) return undefined
  let found: { reason: DiscountReason; at: number } | undefined
  for (const reason of ALL_REASONS) {
    const at = text.search(new RegExp(`(^|[^A-Z0-9_])${reason}($|[^A-Z0-9_])`))
    if (at !== -1 && (!found || at < found.at)) found = { reason, at }
  }
  return found?.reason
}

/**
 * The reason an error names — a payment Commerce would not start. The
 * gateway answers such a refusal with a GraphQL error whose
 * `extensions.code` is the reason and whose text ends with it
 * (`Payment Vipps not initialize: … [GIFT_MAX_ONE_UNIT]`), and
 * `executeCartGraphQL` attaches the envelope's errors to what it throws: the
 * code is read first, then the texts (the envelope's, the error's own). A
 * plain text is read as `discountReasonOf` reads it.
 */
export function discountReasonOfError(err: unknown): DiscountReason | undefined {
  if (typeof err === 'string') return discountReasonOf(err)
  if (!err || typeof err !== 'object') return undefined
  const { message, graphql } = err as {
    message?: unknown
    graphql?: { errors?: Array<{ message?: unknown; extensions?: { code?: unknown } | null } | null> | null } | null
  }
  const errors = Array.isArray(graphql?.errors) ? graphql.errors : []
  for (const e of errors) {
    const reason = discountReasonOf(e?.extensions?.code)
    if (reason) return reason
  }
  for (const e of errors) {
    const reason = discountReasonOf(e?.message)
    if (reason) return reason
  }
  return discountReasonOf(message)
}

/**
 * A refusal that stays what it is whatever the cart holds — the code does
 * not exist, is over, is used up or is of a kind that cannot be used here.
 * (`COUPON_MIN_AMOUNT` changes with the cart, `COUPON_OTHER_APPLIED` with the
 * other code, and `COUPON_UNAVAILABLE` says nothing about the code.)
 */
export function isFinalCouponReason(reason: unknown): boolean {
  return (
    reason === 'COUPON_NOT_FOUND' ||
    reason === 'COUPON_EXPIRED' ||
    reason === 'COUPON_USAGE_LIMIT' ||
    reason === 'COUPON_NOT_SUPPORTED'
  )
}

/**
 * A gift a code brings (`ApplyDiscount` → `gifts`): one unit of that product
 * — and variant, when the code names one — in the cart, free.
 */
export interface DiscountGift {
  productId: number
  variantId?: number
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * The gifts of an `ApplyDiscount` answer: each product once, with its
 * variant when it names one. The answer's quantity is not kept — a gift is
 * one unit. `[]` when the answer has none (null, empty, or a gateway that
 * does not say).
 */
export function discountGiftsOf(answer: unknown): DiscountGift[] {
  const list = (answer as { gifts?: unknown } | null | undefined)?.gifts
  if (!Array.isArray(list)) return []
  const out: DiscountGift[] = []
  for (const entry of list) {
    const productId = positiveInt((entry as { product_id?: unknown } | null)?.product_id)
    if (!productId) continue
    const variantId = positiveInt((entry as { variant_id?: unknown } | null)?.variant_id)
    if (out.some((g) => g.productId === productId && g.variantId === variantId)) continue
    out.push(variantId ? { productId, variantId } : { productId })
  }
  return out
}

/** Whether a cart line is that gift: its product, and its variant when the gift names one. */
export function isGiftOf(gift: DiscountGift, line: { productId?: unknown; variantId?: unknown } | null | undefined): boolean {
  if (!line || positiveInt(line.productId) !== gift.productId) return false
  return gift.variantId === undefined || positiveInt(line.variantId) === gift.variantId
}

/**
 * What came of asking for a code on ONE sponsor's backend cart:
 * `applied` — Commerce has it on the cart; `refused` — Commerce said no
 * (`reason` when it is one of the known ones; `message` is its own text,
 * never written for the shopper); `failed` — it could not be asked (network,
 * timeout): nothing is known, and the cart is as it was.
 *
 * `answer` is everything Commerce answered (`executed`, `message` and
 * whatever else the answer carries), when it answered.
 */
export interface CartDiscountOutcome {
  sponsorId: number
  status: 'applied' | 'refused' | 'failed'
  reason?: DiscountReason
  message?: string
  answer?: DiscountAnswer
}

/**
 * The answer of `Vio.applyDiscountCode()`. `status` sums the carts up:
 * `applied` when the code is on at least one cart; `pending` when there is no
 * backend cart yet — the code is kept for this page load and goes on the cart
 * once it has lines; `refused` when every cart asked said no (or `code` is
 * not a code); `failed` when none could be asked. `reason` is the refusal's,
 * when the carts that refused agree on one.
 */
export interface DiscountCodeResult {
  status: 'applied' | 'pending' | 'refused' | 'failed'
  /** The code as it was sent (`''` when it was not a code). */
  code: string
  reason?: DiscountReason
  carts: CartDiscountOutcome[]
}

/**
 * The answer of `Vio.removeDiscountCode()`: whether a code came off some
 * cart, and what each cart that carried one said (`removed`, `refused` by
 * Commerce, or `failed` — it could not be asked and the code is still on).
 */
export interface DiscountCodeRemoval {
  removed: boolean
  carts: Array<{
    sponsorId: number
    code: string
    status: 'removed' | 'refused' | 'failed'
    message?: string
    answer?: DiscountAnswer
  }>
}

/**
 * What `CartManager.settleDiscountCode` found before a payment is built on a
 * cart. `notTaken`: a code someone asked for (`applyDiscountCode` — the
 * field's «Bruk») was still being checked when the payment was started, and
 * Commerce did not take it (`reason` when it gave a known one; none when it
 * could not be asked). Whoever typed it is being told why right now: a
 * payment that takes the page away to its provider must not start before
 * they have read it.
 */
export interface DiscountSettlement {
  notTaken?: { code: string; reason?: DiscountReason }
}

/** `applied` if any cart took it, else `failed` if none could be asked, else `refused`; `pending` without carts. */
export function summarizeDiscountOutcomes(outcomes: ReadonlyArray<CartDiscountOutcome>): DiscountCodeResult['status'] {
  if (outcomes.length === 0) return 'pending'
  if (outcomes.some((o) => o.status === 'applied')) return 'applied'
  if (outcomes.every((o) => o.status === 'failed')) return 'failed'
  return 'refused'
}

/** The one reason the refusals among `outcomes` give — `undefined` when none refused, or they disagree. */
export function commonDiscountReason(outcomes: ReadonlyArray<CartDiscountOutcome>): DiscountReason | undefined {
  const reasons = new Set(outcomes.filter((o) => o.status === 'refused').map((o) => o.reason))
  if (reasons.size !== 1) return undefined
  return [...reasons][0]
}

// ── The page's code: `?vio_discount=` ───────────────────────────────────────

/** The URL parameter that names a discount code for the page's carts. */
export const DISCOUNT_PARAM = 'vio_discount'
/** Where the tab remembers the code its URL named (`sessionStorage`: this visit, not the browser for good). */
export const DISCOUNT_SESSION_KEY = 'vio.discount.v1'

/**
 * What `vio_discount` says in a query string: the code; `null` when the
 * parameter is there and empty (forget the code); `undefined` when it is not
 * there, or names something that is not a code.
 */
export function discountParam(search: unknown): string | null | undefined {
  try {
    const params = new URLSearchParams(typeof search === 'string' ? search : '')
    if (!params.has(DISCOUNT_PARAM)) return undefined
    const raw = params.get(DISCOUNT_PARAM) ?? ''
    if (!raw.trim()) return null
    return normalizeDiscountCode(raw)
  } catch {
    return undefined
  }
}

function currentSearch(): string {
  try {
    return typeof location !== 'undefined' && typeof location.search === 'string' ? location.search : ''
  } catch {
    return ''
  }
}

/** The code this tab remembers from a URL, if any. */
export function rememberedDiscountCode(): string | undefined {
  return normalizeDiscountCode(storageGet('session', DISCOUNT_SESSION_KEY))
}

/**
 * Read the page's URL: a `vio_discount` code is remembered for the tab, an
 * empty one forgets it, anything else leaves what was remembered. Returns
 * the code the tab remembers after that. `Vio.init` calls it.
 */
export function syncDiscountParam(search: unknown = currentSearch()): string | undefined {
  const param = discountParam(search)
  if (param === null) storageRemove('session', DISCOUNT_SESSION_KEY)
  else if (param) storageSet('session', DISCOUNT_SESSION_KEY, param)
  return rememberedDiscountCode()
}
