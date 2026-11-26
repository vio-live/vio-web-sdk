/**
 * What the shopper saves on a cart line, and on the cart.
 *
 * Two things make a line cost less than it used to: the shop's own price cut
 * (the product has a «før-pris» — Commerce's `compare_at`) and the cart's
 * discount code (`discount`, cart/discount.ts). The first never changes what
 * is charged: `unitPrice` is the cut price already. So it lives apart from
 * the discount maths — a line keeps `compareAtPrice`, what one unit cost
 * before, and only when that is above `unitPrice`.
 *
 * «Før» of a line is `compareAtPrice × quantity` (its list price when it has
 * none); what it costs is `lineNetTotal`; the saving is the difference. The
 * cart, the checkout's summary and the receipt strike the first through over
 * the second — that is all the SDK draws of it. `cartSavingsTotal` adds the
 * lines up (the shop's cuts and the code together, the code's gift included,
 * as in «Rabatt») for a host that wants to say it in its own words.
 *
 * Pure; never throws on odd lines. A line with neither comes out exactly as
 * before savings existed.
 */

import { lineListTotal, lineNetTotal, type DiscountedLine } from './discount.js'

/** The part of a line these helpers read. */
export interface SavingsLine extends DiscountedLine {
  compareAtPrice?: number
}

/** Two decimals: amounts are major units. */
function cents(amount: number): number {
  return Math.round(amount * 100) / 100
}

const num = (value: unknown): number => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/**
 * The «før-pris» of one unit as Commerce prices it — taxes included when it
 * says so (`compare_at_incl_taxes`), else `compare_at`, as the product detail
 * reads it — for a unit that costs `unitPrice`. `undefined` when there is
 * none or it is not above the price: that is no cut to show.
 */
export function compareAtFromPrice(
  price: { compare_at?: unknown; compare_at_incl_taxes?: unknown } | null | undefined,
  unitPrice: number,
): number | undefined {
  const compareAt = cents(num(price?.compare_at_incl_taxes ?? price?.compare_at))
  return compareAt > 0 && compareAt > cents(num(unitPrice)) ? compareAt : undefined
}

/** What one unit of the line cost before the shop's cut; 0 when it has no «før-pris» above its price. */
export function lineCompareAt(line: SavingsLine | null | undefined): number {
  const compareAt = cents(num(line?.compareAtPrice))
  return compareAt > cents(num(line?.unitPrice)) ? compareAt : 0
}

/** The line at its «før» prices: `compareAtPrice × quantity`, or its list price without one. */
export function lineBeforeTotal(line: SavingsLine | null | undefined): number {
  const compareAt = lineCompareAt(line)
  if (compareAt === 0) return lineListTotal(line)
  return cents(compareAt * num(line?.quantity))
}

/** What the shopper saves on the line: the shop's cut and the discount code together; 0 without either. */
export function lineSavings(line: SavingsLine | null | undefined): number {
  const saved = cents(lineBeforeTotal(line) - lineNetTotal(line))
  return saved > 0 ? saved : 0
}

/** What the shopper saves on the lines, all together. */
export function cartSavingsTotal(lines: ReadonlyArray<SavingsLine> | null | undefined): number {
  const total = (lines ?? []).reduce((sum, line) => sum + lineSavings(line), 0)
  return total > 0 ? cents(total) : 0
}
