import { describe, expect, it } from 'vitest'
import {
  COUPON_REASONS,
  DISCOUNT_CODE_MAX_LENGTH,
  DISCOUNT_PAYMENT_REASONS,
  commonDiscountReason,
  discountReasonOf,
  normalizeDiscountCode,
  summarizeDiscountOutcomes,
} from './discount-code.js'

describe('normalizeDiscountCode', () => {
  it('a code is sent as written, trimmed', () => {
    expect(normalizeDiscountCode('GAVE')).toBe('GAVE')
    expect(normalizeDiscountCode('  Faves-2026_høst ')).toBe('Faves-2026_høst')
    expect(normalizeDiscountCode(2026)).toBe('2026')
    expect(normalizeDiscountCode('x'.repeat(DISCOUNT_CODE_MAX_LENGTH))).toHaveLength(DISCOUNT_CODE_MAX_LENGTH)
  })

  it('what is not a code is undefined: empty, too long, with a space or a control character, not a string', () => {
    for (const bad of ['', '   ', 'TO ORD', 'linje\nskift', 'tab\tulator', 'x'.repeat(DISCOUNT_CODE_MAX_LENGTH + 1), null, undefined, {}, [], true]) {
      expect(normalizeDiscountCode(bad)).toBeUndefined()
    }
  })
})

describe('summarizeDiscountOutcomes', () => {
  const cart = (status: 'applied' | 'refused' | 'failed', sponsorId = 1) => ({ sponsorId, status })

  it('no cart asked: pending', () => {
    expect(summarizeDiscountOutcomes([])).toBe('pending')
  })

  it('applied as soon as one cart took it', () => {
    expect(summarizeDiscountOutcomes([cart('refused'), cart('applied', 2)])).toBe('applied')
    expect(summarizeDiscountOutcomes([cart('failed'), cart('applied', 2)])).toBe('applied')
  })

  it('failed only when no cart could be asked; a refusal among failures is a refusal', () => {
    expect(summarizeDiscountOutcomes([cart('failed'), cart('failed', 2)])).toBe('failed')
    expect(summarizeDiscountOutcomes([cart('failed'), cart('refused', 2)])).toBe('refused')
    expect(summarizeDiscountOutcomes([cart('refused')])).toBe('refused')
  })
})

describe('discountReasonOf', () => {
  it('the word alone, as a refusal says it', () => {
    for (const reason of [...COUPON_REASONS, ...DISCOUNT_PAYMENT_REASONS]) expect(discountReasonOf(reason)).toBe(reason)
  })

  it('the word inside a payment error', () => {
    expect(discountReasonOf('Payment Vipps not initialize: GIFT_MAX_ONE_UNIT')).toBe('GIFT_MAX_ONE_UNIT')
    expect(discountReasonOf('[shopcart] COUPON_MIN_AMOUNT: the cart is below the minimum')).toBe('COUPON_MIN_AMOUNT')
    expect(discountReasonOf('CHECKOUT_AMOUNT_ZERO')).toBe('CHECKOUT_AMOUNT_ZERO')
  })

  it('the first one when a text names two; a whole word only', () => {
    expect(discountReasonOf('COUPON_EXPIRED (was COUPON_NOT_FOUND)')).toBe('COUPON_EXPIRED')
    expect(discountReasonOf('XCOUPON_EXPIRED')).toBeUndefined()
    expect(discountReasonOf('COUPON_EXPIRED_SOON')).toBeUndefined()
  })

  it('anything else names none', () => {
    for (const other of ['', 'Discount not found', 'coupon_expired', null, undefined, 42, {}]) {
      expect(discountReasonOf(other)).toBeUndefined()
    }
  })
})

describe('commonDiscountReason', () => {
  it('the reason the refusals share; none when they differ or nothing refused', () => {
    const refused = (reason?: 'COUPON_EXPIRED' | 'COUPON_NOT_FOUND', sponsorId = 1) => ({ sponsorId, status: 'refused' as const, ...(reason ? { reason } : {}) })
    expect(commonDiscountReason([refused('COUPON_EXPIRED')])).toBe('COUPON_EXPIRED')
    expect(commonDiscountReason([refused('COUPON_EXPIRED'), refused('COUPON_EXPIRED', 2), { sponsorId: 3, status: 'failed' }])).toBe('COUPON_EXPIRED')
    expect(commonDiscountReason([refused('COUPON_EXPIRED'), refused('COUPON_NOT_FOUND', 2)])).toBeUndefined()
    expect(commonDiscountReason([refused('COUPON_EXPIRED'), refused(undefined, 2)])).toBeUndefined()
    expect(commonDiscountReason([{ sponsorId: 1, status: 'applied' }])).toBeUndefined()
    expect(commonDiscountReason([])).toBeUndefined()
  })
})
