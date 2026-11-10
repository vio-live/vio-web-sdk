/**
 * What a cart line costs once the cart's discount code is counted.
 *
 * Commerce answers every line of a cart with what the code takes off it:
 * `price.discount`, the amount off the LINE — all its units — in major units,
 * taxes included (0 or null without one; the line a code gives away has a
 * discount equal to its price). A line keeps both: `unitPrice`, the list
 * price of one unit, and `discount`. Everything the shopper is shown as "to
 * pay" — the cart's total, the checkout's, the Vipps button, the receipt, the
 * value of a `purchase` — is the net of the two; the «Sum» stays the list
 * prices and a «Rabatt» row says the difference, so the rows add up.
 *
 * A code is a percentage — of one product or of the whole cart — or a gift:
 * a line whose discount is its whole price. That one shows «Gratis», and
 * there is one unit of it at most.
 *
 * Pure; never throws on odd lines. A line without a discount comes out
 * exactly as before discounts existed (no rounding added).
 */

/** The part of a line these helpers read. */
export interface DiscountedLine {
  unitPrice?: number
  quantity?: number
  discount?: number
}

/** Two decimals: amounts are major units. */
function cents(amount: number): number {
  return Math.round(amount * 100) / 100
}

const num = (value: unknown): number => {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/** What the line costs at its list price: unit price × quantity. */
export function lineListTotal(line: DiscountedLine | null | undefined): number {
  return num(line?.unitPrice) * num(line?.quantity)
}

/** What the cart's code takes off the line — never more than the line, never less than 0. */
export function lineDiscount(line: DiscountedLine | null | undefined): number {
  const discount = num(line?.discount)
  if (!(discount > 0)) return 0
  return Math.min(cents(discount), Math.max(0, cents(lineListTotal(line))))
}

/** What the line costs: its list price less its discount. */
export function lineNetTotal(line: DiscountedLine | null | undefined): number {
  const discount = lineDiscount(line)
  if (discount === 0) return lineListTotal(line)
  return Math.max(0, cents(lineListTotal(line) - discount))
}

/** What one unit of the line costs once the discount is spread over its units. */
export function netUnitPrice(line: DiscountedLine | null | undefined): number {
  const discount = lineDiscount(line)
  const quantity = num(line?.quantity)
  if (discount === 0 || !(quantity > 0)) return num(line?.unitPrice)
  return Math.max(0, cents(lineNetTotal(line) / quantity))
}

/** The line is given away: its discount is its whole price (and it has a price). */
export function isGiftLine(line: DiscountedLine | null | undefined): boolean {
  const list = cents(lineListTotal(line))
  return list > 0 && lineDiscount(line) >= list
}

/** The lines at their list prices. */
export function cartListTotal(lines: ReadonlyArray<DiscountedLine> | null | undefined): number {
  return (lines ?? []).reduce((sum, line) => sum + lineListTotal(line), 0)
}

/** What the cart's code takes off its lines, all together. */
export function cartDiscountTotal(lines: ReadonlyArray<DiscountedLine> | null | undefined): number {
  const total = (lines ?? []).reduce((sum, line) => sum + lineDiscount(line), 0)
  return total > 0 ? cents(total) : 0
}

/** What the lines cost: list prices less discounts (shipping apart). */
export function cartNetTotal(lines: ReadonlyArray<DiscountedLine> | null | undefined): number {
  return (lines ?? []).reduce((sum, line) => sum + lineNetTotal(line), 0)
}

/** Lines, a gift among them, and nothing to pay for: a cart of gifts alone — it cannot be paid for. */
export function isGiftOnlyCart(lines: ReadonlyArray<DiscountedLine> | null | undefined): boolean {
  const list = lines ?? []
  return list.length > 0 && list.some(isGiftLine) && !(cartNetTotal(list) > 0)
}

/** A gift line with more than its one unit: Commerce will not start a payment for it. */
export function hasGiftOverOneUnit(lines: ReadonlyArray<DiscountedLine> | null | undefined): boolean {
  return (lines ?? []).some((line) => isGiftLine(line) && num(line.quantity) > 1)
}

/**
 * The discount of a line as Commerce answers it (`price.discount`, a number
 * or a numeric string, for `serverQuantity` units), for a line of `quantity`
 * units at `unitPrice`: scaled when the line is heading to another quantity
 * than the answer knew (a code is a percentage: the amount follows the
 * units), and never more than the line. 0 without one.
 */
export function serverLineDiscount(raw: unknown, unitPrice: number, quantity: number, serverQuantity: number = quantity): number {
  let discount = num(raw)
  if (!(discount > 0)) return 0
  if (serverQuantity > 0 && quantity !== serverQuantity) discount = (discount * quantity) / serverQuantity
  return lineDiscount({ unitPrice, quantity, discount })
}
