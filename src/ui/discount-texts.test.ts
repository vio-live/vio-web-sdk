import { describe, expect, it } from 'vitest'
import { COUPON_REASONS, DISCOUNT_PAYMENT_REASONS } from '../core/cart/discount-code.js'
import { DISCOUNT_TEXT, couponReasonText, discountPaymentText, discountRowLabel } from './discount-texts.js'

describe('what the SDK says about a discount code', () => {
  it('every sentence is there, in one place, and none is empty', () => {
    for (const [key, text] of Object.entries(DISCOUNT_TEXT)) expect(text.trim().length, key).toBeGreaterThan(2)
  })

  it('the row: «Rabatt», with the code when it is known', () => {
    expect(discountRowLabel()).toBe('Rabatt')
    expect(discountRowLabel('')).toBe('Rabatt')
    expect(discountRowLabel('  ')).toBe('Rabatt')
    expect(discountRowLabel('gratis_face_mask')).toBe('Rabatt (gratis_face_mask)')
    expect(discountRowLabel(null)).toBe('Rabatt')
  })

  it('every reason Commerce gives for refusing a code has its own sentence', () => {
    const said = COUPON_REASONS.map((reason) => couponReasonText(reason))
    expect(new Set(said).size).toBe(COUPON_REASONS.length)
    for (const text of said) expect(text).not.toBe(DISCOUNT_TEXT.couponRefused)
    expect(couponReasonText('COUPON_NOT_FOUND')).toBe('Rabattkoden finnes ikke.')
    expect(couponReasonText('COUPON_EXPIRED')).toBe('Rabattkoden er ikke lenger gyldig.')
    expect(couponReasonText('COUPON_USAGE_LIMIT')).toBe('Rabattkoden er brukt opp.')
    expect(couponReasonText('COUPON_NOT_SUPPORTED')).toBe('Rabattkoden kan ikke brukes her.')
    expect(couponReasonText('COUPON_MIN_AMOUNT')).toBe('Handlekurven er under minstebeløpet for rabattkoden.')
    expect(couponReasonText('COUPON_OTHER_APPLIED')).toBe('Du har allerede en rabattkode. Fjern den først.')
    expect(couponReasonText('COUPON_UNAVAILABLE')).toBe('Vi kunne ikke sjekke rabattkoden akkurat nå. Prøv igjen.')
  })

  it('any other word, or none: the generic sentence — never Commerce\'s own text', () => {
    for (const other of ['SOMETHING_NEW', 'Discount not found', '', null, undefined]) {
      expect(couponReasonText(other)).toBe('Rabattkoden kunne ikke brukes.')
    }
  })

  it('a payment refused because of the discount: the gift\'s own rules say what to do', () => {
    expect(discountPaymentText('GIFT_MAX_ONE_UNIT')).toBe('Du kan bare få én gave per bestilling. Reduser antallet og prøv igjen.')
    expect(discountPaymentText('CHECKOUT_AMOUNT_ZERO')).toBe('Legg til et produkt for å få med gaven.')
    expect(discountPaymentText('DISCOUNT_UNAVAILABLE')).toBe('Rabatten kunne ikke beregnes akkurat nå. Prøv igjen om litt.')
    expect(discountPaymentText('COUPON_UNAVAILABLE')).toBe('Vi kunne ikke sjekke rabattkoden akkurat nå. Prøv igjen.')
    // The way to pay chosen does not take discounts: another one, or the code off.
    expect(discountPaymentText('DISCOUNT_PAYMENT_METHOD_UNSUPPORTED')).toBe(
      'Rabatten kan ikke brukes med denne betalingsmåten. Velg en annen, eller fjern rabatten.',
    )
  })

  it('…and a code that is no good any more says why, and that the cart is ready for another try', () => {
    expect(discountPaymentText('COUPON_EXPIRED')).toBe('Rabattkoden er ikke lenger gyldig. Handlekurven er oppdatert – prøv igjen.')
    expect(discountPaymentText('COUPON_MIN_AMOUNT')).toBe(
      'Handlekurven er under minstebeløpet for rabattkoden. Handlekurven er oppdatert – prøv igjen.',
    )
    for (const reason of ['COUPON_NOT_FOUND', 'COUPON_USAGE_LIMIT', 'COUPON_NOT_SUPPORTED'] as const) {
      expect(discountPaymentText(reason)).toMatch(/Handlekurven er oppdatert – prøv igjen\.$/)
    }
  })

  it('every reason has a sentence for the payment', () => {
    for (const reason of [...COUPON_REASONS, ...DISCOUNT_PAYMENT_REASONS]) expect(discountPaymentText(reason).length).toBeGreaterThan(10)
  })
})
