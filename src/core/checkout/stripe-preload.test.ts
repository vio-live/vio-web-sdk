/**
 * Stripe.js is ~300 KB. A page whose brands only take Vipps (Careless in Mote &
 * Livsstil) must not download it; a brand with Stripe gets it warmed before
 * any tap, because Apple Pay's sheet has to open synchronously.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const preload = vi.fn()
vi.mock('./payments/apple-pay.js', async (orig) => ({
  ...(await orig<typeof import('./payments/apple-pay.js')>()),
  preloadStripeJs: () => preload(),
}))

const methods = vi.fn()
vi.mock('../api/cart-queries.js', async (orig) => ({
  ...(await orig<typeof import('../api/cart-queries.js')>()),
  getCartGraphQLOptions: async () => ({}),
  getAvailablePaymentMethods: () => methods(),
}))

import { CheckoutManager, usesStripe } from './checkout-manager.js'

const STRIPE = { name: 'Stripe', config: [{ name: 'publishableKey', value: 'pk_test_x' }] }
const VIPPS = { name: 'Vipps', config: [] }
const fakeCart = {} as never

describe('Stripe.js is loaded only for a brand that uses Stripe', () => {
  beforeEach(() => {
    preload.mockReset()
    methods.mockReset()
  })

  it('creating the checkout does not load it', () => {
    new CheckoutManager(fakeCart)
    expect(preload).not.toHaveBeenCalled()
  })

  it('a brand with only Vipps: never loaded', async () => {
    methods.mockResolvedValue([VIPPS])
    await new CheckoutManager(fakeCart).getAvailablePaymentMethods(7)
    expect(preload).not.toHaveBeenCalled()
  })

  it('a brand with Stripe: warmed as soon as its methods arrive', async () => {
    methods.mockResolvedValue([VIPPS, STRIPE])
    await new CheckoutManager(fakeCart).getAvailablePaymentMethods(7)
    expect(preload).toHaveBeenCalledTimes(1)
  })
})

describe('usesStripe', () => {
  it('needs a Stripe method with a publishable key', () => {
    expect(usesStripe([STRIPE])).toBe(true)
    expect(usesStripe([{ name: 'stripe', config: [{ name: 'publishableKey', value: 'pk_live_y' }] }])).toBe(true)
    expect(usesStripe([{ name: 'Stripe', config: [] }])).toBe(false)
    expect(usesStripe([{ name: 'Stripe', config: [{ name: 'publishableKey', value: 'sk_x' }] }])).toBe(false)
    expect(usesStripe([VIPPS])).toBe(false)
    expect(usesStripe(null)).toBe(false)
  })
})
