import { describe, it, expect } from 'vitest'
import { shippingPickedAtCheckout } from './shipping-at-checkout.js'

describe('shippingPickedAtCheckout', () => {
  it('is true when every way to pay the brand picks the delivery in its widget (Kustom)', () => {
    expect(shippingPickedAtCheckout({ apiKey: 'k', paymentMethods: ['kustom'] })).toBe(true)
    expect(shippingPickedAtCheckout({ apiKey: 'k', paymentMethods: ['Kustom'] })).toBe(true)
  })

  it('is false when another way to pay uses the brand’s own rates', () => {
    expect(shippingPickedAtCheckout({ apiKey: 'k', paymentMethods: ['kustom', 'vipps'] })).toBe(false)
    expect(shippingPickedAtCheckout({ apiKey: 'k', paymentMethods: ['vipps'] })).toBe(false)
    expect(shippingPickedAtCheckout({ apiKey: 'k', paymentMethods: ['stripe', 'apple_pay'] })).toBe(false)
  })

  it('is false when nothing says how the brand is paid', () => {
    expect(shippingPickedAtCheckout({ apiKey: 'k', paymentMethods: [] })).toBe(false)
    expect(shippingPickedAtCheckout({ apiKey: 'k' })).toBe(false)
    expect(shippingPickedAtCheckout(null)).toBe(false)
    expect(shippingPickedAtCheckout(undefined)).toBe(false)
    expect(shippingPickedAtCheckout('kustom')).toBe(false)
  })
})
