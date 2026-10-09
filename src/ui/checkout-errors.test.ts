import { describe, it, expect } from 'vitest'
import {
  CART_CHANGED_MESSAGE,
  CART_PAID_MESSAGE,
  EMPTY_CART_MESSAGE,
  PAYMENT_START_FAILED_MESSAGE,
  errorText,
  friendlyPaymentError,
} from './checkout-errors.js'

/** The two messages a QA tester saw on screen, as they came (2026-10-09). */
const VIPPS_EMPTY_CART =
  'Payment Vipps not initialize: [vipps] amount must be a positive integer in minor units, got 0'
const STRIPE_UNDEFINED_ID =
  "Payment Stripe not intent execute: : Cannot read properties of undefined (reading 'id')"

describe('friendlyPaymentError', () => {
  it('an emptied cart (zero amount) says the cart is empty', () => {
    expect(friendlyPaymentError(VIPPS_EMPTY_CART, 'vipps')).toBe(EMPTY_CART_MESSAGE)
    expect(friendlyPaymentError('amount must be a positive integer', 'stripe')).toBe(EMPTY_CART_MESSAGE)
    expect(friendlyPaymentError('Amount Must Be A Positive number', 'klarna')).toBe(EMPTY_CART_MESSAGE)
  })

  it('a checkout replaced from another tab says to reload', () => {
    expect(friendlyPaymentError('checkout replaced by a newer one', 'vipps')).toBe(CART_CHANGED_MESSAGE)
    expect(friendlyPaymentError('Error: CHECKOUT_SUPERSEDED', 'stripe')).toBe(CART_CHANGED_MESSAGE)
  })

  it('a cart that was already paid says so', () => {
    expect(friendlyPaymentError('This cart has already been paid', 'qliro')).toBe(CART_PAID_MESSAGE)
    expect(friendlyPaymentError('CART_ALREADY_PAID', 'nexi')).toBe(CART_PAID_MESSAGE)
  })

  it('keeps the "kan ikke sendes sammen" sentence, which is already written for the shopper', () => {
    const sentence =
      'Produktene i handlekurven kan ikke sendes sammen. Fjern ett av dem for å fullføre kjøpet.'
    expect(friendlyPaymentError(sentence, 'vipps')).toBe(sentence)
    expect(friendlyPaymentError(`Payment Vipps not initialize: ${sentence}`, 'vipps')).toBe(sentence)
  })

  it('anything else gets the generic text, with none of the raw message in it', () => {
    for (const raw of [STRIPE_UNDEFINED_ID, 'no session', 'Network Error', '', '[object Object]']) {
      const shown = friendlyPaymentError(raw, 'stripe')
      expect(shown).toBe(PAYMENT_START_FAILED_MESSAGE)
      if (raw) expect(shown).not.toContain(raw)
    }
    expect(friendlyPaymentError(undefined as unknown as string, 'vipps')).toBe(PAYMENT_START_FAILED_MESSAGE)
  })

  it('never shows a stack-like text', () => {
    for (const raw of [VIPPS_EMPTY_CART, STRIPE_UNDEFINED_ID]) {
      const shown = friendlyPaymentError(raw, 'x')
      expect(shown).not.toMatch(/not (initialize|intent execute)|undefined|\[vipps\]/)
    }
  })
})

describe('errorText', () => {
  it('is the message of an Error, and the string of anything else', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
    expect(errorText(42)).toBe('42')
  })
})
