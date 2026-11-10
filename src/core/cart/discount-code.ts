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
 * Pure; never throws.
 */

import type { DiscountAnswer } from '../api/cart-queries.js'

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
