/**
 * What the shopper saves on a line and on the cart: the shop's own price cut
 * (the line's «før-pris») and the discount code, together.
 */
import { describe, expect, it } from 'vitest'
import { cartSavingsTotal, compareAtFromPrice, lineBeforeTotal, lineCompareAt, lineSavings } from './savings.js'

describe('compareAtFromPrice — the «før-pris» Commerce says of a price', () => {
  it('taxes included when Commerce says so, as the price is read', () => {
    expect(compareAtFromPrice({ compare_at: 191.92, compare_at_incl_taxes: 239.9 }, 143.94)).toBe(239.9)
  })

  it('`compare_at` when there is no tax-inclusive one', () => {
    expect(compareAtFromPrice({ compare_at: 239.9, compare_at_incl_taxes: null }, 143.94)).toBe(239.9)
  })

  it('none when Commerce has none: 0, null or absent', () => {
    expect(compareAtFromPrice({ compare_at: 0, compare_at_incl_taxes: 0 }, 143.94)).toBeUndefined()
    expect(compareAtFromPrice({ compare_at: null, compare_at_incl_taxes: null }, 143.94)).toBeUndefined()
    expect(compareAtFromPrice({}, 143.94)).toBeUndefined()
    expect(compareAtFromPrice(null, 143.94)).toBeUndefined()
  })

  it('none when it is not above the price: that is no cut', () => {
    expect(compareAtFromPrice({ compare_at_incl_taxes: 143.94 }, 143.94)).toBeUndefined()
    expect(compareAtFromPrice({ compare_at_incl_taxes: 99 }, 143.94)).toBeUndefined()
  })

  it('a numeric string is a number; anything else is none', () => {
    expect(compareAtFromPrice({ compare_at_incl_taxes: '239.90' }, 143.94)).toBe(239.9)
    expect(compareAtFromPrice({ compare_at_incl_taxes: 'n/a' }, 143.94)).toBeUndefined()
  })
})

describe('a line', () => {
  const CREAM = { unitPrice: 143.94, quantity: 2, compareAtPrice: 239.9 }

  it('before: the «før-pris» of every unit; saved: the difference to what it costs', () => {
    expect(lineCompareAt(CREAM)).toBe(239.9)
    expect(lineBeforeTotal(CREAM)).toBe(479.8)
    expect(lineSavings(CREAM)).toBe(191.92)
  })

  it('without a «før-pris»: before is its list price and nothing is saved', () => {
    const line = { unitPrice: 349, quantity: 2 }
    expect(lineCompareAt(line)).toBe(0)
    expect(lineBeforeTotal(line)).toBe(698)
    expect(lineSavings(line)).toBe(0)
  })

  it('a «før-pris» that is not above the price does not count', () => {
    expect(lineSavings({ unitPrice: 349, quantity: 1, compareAtPrice: 349 })).toBe(0)
    expect(lineSavings({ unitPrice: 349, quantity: 1, compareAtPrice: 300 })).toBe(0)
    expect(lineBeforeTotal({ unitPrice: 349, quantity: 1, compareAtPrice: 300 })).toBe(349)
  })

  it('a discount code alone: what the code takes off', () => {
    expect(lineSavings({ unitPrice: 349, quantity: 2, discount: 69.8 })).toBe(69.8)
  })

  it('the shop’s cut and the code together', () => {
    // 2 × (239.90 − 143.94) + 28.79 off by the code
    expect(lineSavings({ ...CREAM, discount: 28.79 })).toBe(220.71)
  })

  it('a gift: its whole price', () => {
    expect(lineSavings({ unitPrice: 52, quantity: 1, discount: 52 })).toBe(52)
  })

  it('odd lines save nothing and never throw', () => {
    expect(lineSavings(null)).toBe(0)
    expect(lineSavings(undefined)).toBe(0)
    expect(lineSavings({})).toBe(0)
    expect(lineSavings({ unitPrice: Number.NaN, quantity: 1, compareAtPrice: 10 })).toBe(10)
    expect(lineSavings({ unitPrice: 10, quantity: 0, compareAtPrice: 20 })).toBe(0)
  })
})

describe('the cart', () => {
  it('the lines’ savings, added up', () => {
    expect(
      cartSavingsTotal([
        { unitPrice: 143.94, quantity: 1, compareAtPrice: 239.9 },
        { unitPrice: 349, quantity: 2, discount: 69.8 },
        { unitPrice: 84.95, quantity: 3 },
      ]),
    ).toBe(165.76)
  })

  it('0 when nothing is saved, or without lines', () => {
    expect(cartSavingsTotal([{ unitPrice: 84.95, quantity: 3 }])).toBe(0)
    expect(cartSavingsTotal([])).toBe(0)
    expect(cartSavingsTotal(null)).toBe(0)
  })
})
