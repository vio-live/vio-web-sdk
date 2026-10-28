/**
 * The buyer reference — shopcart's `buyer_ref`: the keyed hash Commerce
 * computes from the buyer's email, so one person is one ref across orders,
 * devices and platforms, and nothing in it can be turned back into an email
 * without Commerce's secret. The SDK forwards it as analytics `buyer_id`
 * (EVENTS_CONTRACT `commerce.buyer_id`, ≤ 128 chars in the collector's
 * schema) and never puts anything else in its place: an email, a name, an
 * over-long value are dropped — not hashed client-side, not cut (a cut hash
 * is another identity).
 */

export const BUYER_REF_MAX_LENGTH = 128

/** What a reference is made of: the unreserved URL characters. An email, a name, a sentence never match. */
const BUYER_REF_PATTERN = /^[A-Za-z0-9._~-]+$/

/** The reference when `value` is one; `undefined` for anything else (never an email). */
export function normalizeBuyerRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const ref = value.trim()
  if (!ref || ref.length > BUYER_REF_MAX_LENGTH || !BUYER_REF_PATTERN.test(ref)) return undefined
  return ref
}
