import { describe, expect, it } from 'vitest'
import {
  cartDiscountTotal,
  cartListTotal,
  cartNetTotal,
  hasGiftOverOneUnit,
  isGiftLine,
  isGiftOnlyCart,
  lineDiscount,
  lineListTotal,
  lineNetTotal,
  netUnitPrice,
  serverLineDiscount,
} from './discount.js'

const CREAM = { unitPrice: 349, quantity: 2 }
const MASK = { unitPrice: 52, quantity: 1, discount: 52 }
const TEN_OFF = { unitPrice: 349, quantity: 2, discount: 69.8 }

describe('a line and its discount', () => {
  it('without a discount a line is what it always was — no rounding of its own', () => {
    expect(lineListTotal(CREAM)).toBe(698)
    expect(lineDiscount(CREAM)).toBe(0)
    expect(lineNetTotal(CREAM)).toBe(698)
    expect(netUnitPrice(CREAM)).toBe(349)
    expect(isGiftLine(CREAM)).toBe(false)
    // 0.1 + 0.2 is left as the sum gives it: nothing here touches a line without a discount.
    expect(lineNetTotal({ unitPrice: 0.1 + 0.2, quantity: 1 })).toBe(0.1 + 0.2)
    expect(lineNetTotal({ unitPrice: 349, quantity: 2, discount: 0 })).toBe(698)
  })

  it('a percentage off: the line costs its list price less the amount, the unit its share', () => {
    expect(lineDiscount(TEN_OFF)).toBe(69.8)
    expect(lineNetTotal(TEN_OFF)).toBe(628.2)
    expect(netUnitPrice(TEN_OFF)).toBe(314.1)
    expect(isGiftLine(TEN_OFF)).toBe(false)
  })

  it('a gift: the discount is the whole line, so it costs 0', () => {
    expect(lineNetTotal(MASK)).toBe(0)
    expect(netUnitPrice(MASK)).toBe(0)
    expect(isGiftLine(MASK)).toBe(true)
    expect(isGiftLine({ unitPrice: 52, quantity: 2, discount: 104 })).toBe(true)
    // One of two units given away is half off, not a gift.
    expect(isGiftLine({ unitPrice: 52, quantity: 2, discount: 52 })).toBe(false)
    // A product that costs nothing is not a gift of a code.
    expect(isGiftLine({ unitPrice: 0, quantity: 1 })).toBe(false)
  })

  it('a discount is never more than the line, nor less than nothing', () => {
    expect(lineDiscount({ unitPrice: 52, quantity: 1, discount: 99 })).toBe(52)
    expect(lineNetTotal({ unitPrice: 52, quantity: 1, discount: 99 })).toBe(0)
    expect(lineDiscount({ unitPrice: 52, quantity: 1, discount: -5 })).toBe(0)
    expect(lineDiscount({ unitPrice: 52, quantity: 1, discount: Number.NaN })).toBe(0)
    expect(lineDiscount(null)).toBe(0)
    expect(lineNetTotal(undefined)).toBe(0)
  })

  it('amounts are cents: a third of a krone does not leak into what is paid', () => {
    const line = { unitPrice: 100, quantity: 3, discount: 33.333333 }
    expect(lineDiscount(line)).toBe(33.33)
    expect(lineNetTotal(line)).toBe(266.67)
    expect(netUnitPrice(line)).toBe(88.89)
  })
})

describe('a cart and its discount', () => {
  const cart = [CREAM, MASK]

  it('list prices, what the code takes off, and what is paid', () => {
    expect(cartListTotal(cart)).toBe(750)
    expect(cartDiscountTotal(cart)).toBe(52)
    expect(cartNetTotal(cart)).toBe(698)
  })

  it('a percentage on every line', () => {
    const lines = [TEN_OFF, { unitPrice: 52, quantity: 1, discount: 5.2 }]
    expect(cartDiscountTotal(lines)).toBe(75)
    expect(cartNetTotal(lines)).toBe(675)
  })

  it('without discounts, and without lines', () => {
    expect(cartDiscountTotal([CREAM])).toBe(0)
    expect(cartNetTotal([CREAM])).toBe(698)
    for (const none of [[], null, undefined]) {
      expect(cartListTotal(none)).toBe(0)
      expect(cartDiscountTotal(none)).toBe(0)
      expect(cartNetTotal(none)).toBe(0)
    }
  })

  it('a cart of gifts alone is nothing to pay for; with something else in it, it is', () => {
    expect(isGiftOnlyCart([MASK])).toBe(true)
    expect(isGiftOnlyCart(cart)).toBe(false)
    expect(isGiftOnlyCart([CREAM])).toBe(false)
    expect(isGiftOnlyCart([])).toBe(false)
    // A cart that costs nothing without any gift is just a cart of 0.
    expect(isGiftOnlyCart([{ unitPrice: 0, quantity: 1 }])).toBe(false)
  })

  it('a gift has one unit', () => {
    expect(hasGiftOverOneUnit(cart)).toBe(false)
    expect(hasGiftOverOneUnit([CREAM, { unitPrice: 52, quantity: 2, discount: 104 }])).toBe(true)
    expect(hasGiftOverOneUnit([TEN_OFF])).toBe(false)
  })
})

describe('serverLineDiscount — what Commerce answers for a line', () => {
  it('the amount off the line as it comes: a number, or a numeric string', () => {
    expect(serverLineDiscount(52, 52, 1)).toBe(52)
    expect(serverLineDiscount('69.8', 349, 2)).toBe(69.8)
  })

  it('0, null, absent or nonsense: no discount', () => {
    for (const none of [0, null, undefined, '', 'x', -3, Number.NaN]) expect(serverLineDiscount(none, 349, 2)).toBe(0)
  })

  it('never more than the line', () => {
    expect(serverLineDiscount(500, 52, 1)).toBe(52)
  })

  it('a line heading to another quantity than the answer knew: the amount follows the units', () => {
    // The answer was for 2 units (10 % of 698); the shopper is already at 3.
    expect(serverLineDiscount(69.8, 349, 3, 2)).toBe(104.7)
    // …or back at 1.
    expect(serverLineDiscount(69.8, 349, 1, 2)).toBe(34.9)
    expect(serverLineDiscount(52, 52, 1, 1)).toBe(52)
  })
})
