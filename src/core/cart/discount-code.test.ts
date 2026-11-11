import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COUPON_REASONS,
  DISCOUNT_CODE_MAX_LENGTH,
  DISCOUNT_PARAM,
  DISCOUNT_PAYMENT_REASONS,
  DISCOUNT_SESSION_KEY,
  commonDiscountReason,
  discountParam,
  discountGiftsOf,
  discountReasonOf,
  discountReasonOfError,
  isFinalCouponReason,
  isGiftOf,
  normalizeDiscountCode,
  rememberedDiscountCode,
  summarizeDiscountOutcomes,
  syncDiscountParam,
} from './discount-code.js'
import { resetStorageMemory } from '../safe-storage.js'

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

describe('discountReasonOfError — a payment Commerce would not start', () => {
  /** What `executeCartGraphQL` throws for the gateway's answer. */
  const gatewayError = (errors: Array<Record<string, unknown>>, message = String(errors[0]?.message ?? '')) =>
    Object.assign(new Error(message), { graphql: { hasData: false, errors } })

  it('the code of the error (extensions.code) is read first', () => {
    const err = gatewayError([
      { message: 'Payment Vipps not initialize: the gift line has two units [GIFT_MAX_ONE_UNIT]', extensions: { code: 'GIFT_MAX_ONE_UNIT' } },
    ])
    expect(discountReasonOfError(err)).toBe('GIFT_MAX_ONE_UNIT')
    // …even when the text happens to name another word.
    expect(
      discountReasonOfError(gatewayError([{ message: 'was COUPON_EXPIRED before', extensions: { code: 'COUPON_MIN_AMOUNT' } }])),
    ).toBe('COUPON_MIN_AMOUNT')
  })

  it('without a code: the end of the text, as the gateway writes it', () => {
    expect(discountReasonOfError(gatewayError([{ message: 'Payment Vipps not initialize: nothing to pay [CHECKOUT_AMOUNT_ZERO]' }]))).toBe('CHECKOUT_AMOUNT_ZERO')
    expect(discountReasonOfError(new Error('[CheckoutManager] could not persist checkout details: x [COUPON_EXPIRED]'))).toBe('COUPON_EXPIRED')
    expect(discountReasonOfError('Payment Vipps not initialize: y [DISCOUNT_UNAVAILABLE]')).toBe('DISCOUNT_UNAVAILABLE')
    expect(discountReasonOfError('Payment Klarna not initialize: z [DISCOUNT_PAYMENT_METHOD_UNSUPPORTED]')).toBe(
      'DISCOUNT_PAYMENT_METHOD_UNSUPPORTED',
    )
  })

  it('a code that is not about the discount, and anything that is no error: none', () => {
    expect(discountReasonOfError(gatewayError([{ message: 'Payment Vipps not initialize: 503', extensions: { code: 'INTERNAL_SERVER_ERROR' } }]))).toBeUndefined()
    for (const other of [null, undefined, 42, {}, new Error('offline'), { graphql: { errors: null } }, { graphql: { errors: [null] } }]) {
      expect(discountReasonOfError(other)).toBeUndefined()
    }
  })
})

describe('the gifts of a code', () => {
  it('discountGiftsOf: each product once, with its variant when it names one; the quantity is not kept (a gift is one unit)', () => {
    expect(discountGiftsOf({ executed: true, gifts: [{ product_id: 421306, variant_id: null, quantity: 1 }] })).toEqual([{ productId: 421306 }])
    expect(
      discountGiftsOf({
        gifts: [
          { product_id: 5, variant_id: 9, quantity: 3 },
          { product_id: 5, variant_id: 9, quantity: 1 },
          { product_id: '7', variant_id: '0', quantity: 1 },
          { product_id: 0 },
          { variant_id: 3 },
          null,
        ],
      }),
    ).toEqual([{ productId: 5, variantId: 9 }, { productId: 7 }])
  })

  it('no gifts: null, empty, absent (a gateway that does not say), or no answer at all', () => {
    for (const answer of [{ gifts: null }, { gifts: [] }, { executed: true }, { gifts: 'x' }, null, undefined]) {
      expect(discountGiftsOf(answer)).toEqual([])
    }
  })

  it('isGiftOf: the product, and the variant when the gift names one', () => {
    expect(isGiftOf({ productId: 5 }, { productId: 5, variantId: 9 })).toBe(true)
    expect(isGiftOf({ productId: 5 }, { productId: '5' })).toBe(true)
    expect(isGiftOf({ productId: 5, variantId: 9 }, { productId: 5, variantId: 9 })).toBe(true)
    expect(isGiftOf({ productId: 5, variantId: 9 }, { productId: 5, variantId: 8 })).toBe(false)
    expect(isGiftOf({ productId: 5, variantId: 9 }, { productId: 5 })).toBe(false)
    expect(isGiftOf({ productId: 5 }, { productId: 6 })).toBe(false)
    expect(isGiftOf({ productId: 5 }, null)).toBe(false)
  })
})

describe('isFinalCouponReason', () => {
  it('the refusals that do not change with the cart', () => {
    for (const reason of ['COUPON_NOT_FOUND', 'COUPON_EXPIRED', 'COUPON_USAGE_LIMIT', 'COUPON_NOT_SUPPORTED']) expect(isFinalCouponReason(reason)).toBe(true)
    for (const reason of ['COUPON_MIN_AMOUNT', 'COUPON_OTHER_APPLIED', 'COUPON_UNAVAILABLE', 'GIFT_MAX_ONE_UNIT', undefined, 'x']) {
      expect(isFinalCouponReason(reason)).toBe(false)
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

describe('?vio_discount= — the page names the code', () => {
  it('discountParam: the code, null when empty (forget it), undefined when absent or not a code', () => {
    expect(DISCOUNT_PARAM).toBe('vio_discount')
    expect(discountParam('?vio_discount=GAVE')).toBe('GAVE')
    expect(discountParam('?utm_source=x&vio_discount=%20Faves10%20')).toBe('Faves10')
    expect(discountParam('?vio_discount=')).toBeNull()
    expect(discountParam('?vio_discount=%20')).toBeNull()
    expect(discountParam('?vio_discount=to%20ord')).toBeUndefined()
    expect(discountParam('?other=1')).toBeUndefined()
    expect(discountParam('')).toBeUndefined()
    expect(discountParam(undefined)).toBeUndefined()
    expect(discountParam(42)).toBeUndefined()
  })

  describe('kept for the tab', () => {
    let session: Map<string, string>
    beforeEach(() => {
      session = new Map()
      resetStorageMemory()
      vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => session.get(k) ?? null,
        setItem: (k: string, v: string) => void session.set(k, v),
        removeItem: (k: string) => void session.delete(k),
      })
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      resetStorageMemory()
    })

    it('a code in the URL is remembered in sessionStorage, and stays when the next page has none', () => {
      expect(rememberedDiscountCode()).toBeUndefined()
      expect(syncDiscountParam('?vio_discount=GAVE')).toBe('GAVE')
      expect(session.get(DISCOUNT_SESSION_KEY)).toBe('GAVE')
      expect(syncDiscountParam('?page=2')).toBe('GAVE')
      expect(rememberedDiscountCode()).toBe('GAVE')
    })

    it('another code replaces it; an empty one forgets it; something that is not a code changes nothing', () => {
      syncDiscountParam('?vio_discount=GAVE')
      expect(syncDiscountParam('?vio_discount=NY')).toBe('NY')
      expect(syncDiscountParam('?vio_discount=to%20ord')).toBe('NY')
      expect(syncDiscountParam('?vio_discount=')).toBeUndefined()
      expect(session.has(DISCOUNT_SESSION_KEY)).toBe(false)
    })

    it('reads the page\'s own URL by default', () => {
      vi.stubGlobal('location', { search: '?vio_discount=FRA-URL' })
      expect(syncDiscountParam()).toBe('FRA-URL')
    })

    it('a tab without storage keeps it for the page; a stored value that is not a code is no code', () => {
      vi.stubGlobal('sessionStorage', undefined)
      expect(syncDiscountParam('?vio_discount=GAVE')).toBe('GAVE')
      expect(rememberedDiscountCode()).toBe('GAVE')
      resetStorageMemory()
      vi.stubGlobal('sessionStorage', { getItem: () => 'to ord', setItem: () => {}, removeItem: () => {} })
      expect(rememberedDiscountCode()).toBeUndefined()
    })
  })
})
