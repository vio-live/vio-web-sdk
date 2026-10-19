/**
 * The buyer reference — shopcart's `buyer_ref`: the keyed hash Commerce
 * computes from the buyer's email, so one person is one ref across orders,
 * devices and platforms, and nothing in it can be turned back into an email
 * without Commerce's secret. The SDK forwards it as analytics `buyer_id`
 * (EVENTS_CONTRACT `commerce.buyer_id`, ≤ 64 chars) and never puts anything
 * else in its place: an email, a name, an over-long value are dropped — not
 * hashed client-side, not cut (a cut hash is another identity).
 */

export const BUYER_REF_MAX_LENGTH = 64

/** The reference when `value` is one; `undefined` for anything else (never an email). */
export function normalizeBuyerRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const ref = value.trim()
  if (!ref || ref.length > BUYER_REF_MAX_LENGTH) return undefined
  // A hash has no '@' and no spaces; whatever has them is not the ref.
  if (ref.includes('@') || /\s/.test(ref)) return undefined
  return ref
}
