/**
 * Which Stripe a channel offers. The two dashboard toggles (`Payment Intent`
 * = pay here, `Payment Link` = a hosted Stripe page) reach the SDK as one
 * method with a `mode` in its config (api-microservice, `stripe-offer.ts`).
 * A channel that predates that field, or a Commerce that cannot be reached,
 * answers `link` — what every client did before 2026-09-24.
 */
import { describe, expect, it, vi } from 'vitest'
import { CheckoutManager } from './checkout-manager.js'

const fakeCart = {} as never

function managerWith(methods: unknown) {
  const m = new CheckoutManager(fakeCart)
  vi.spyOn(m, 'getAvailablePaymentMethods').mockResolvedValue(methods as never)
  return m
}

const stripe = (mode?: string) => ({
  name: 'Stripe',
  config: [
    { name: 'publishableKey', type: 'string', value: 'pk_test' },
    ...(mode ? [{ name: 'mode', type: 'string', value: mode }] : []),
  ],
})

describe('the Stripe flow a channel offers', () => {
  it('native means the shopper never leaves our page', async () => {
    expect(await managerWith([stripe('native')]).getStripeMode(14)).toBe('native')
  })

  it('link keeps the hosted page', async () => {
    expect(await managerWith([stripe('link')]).getStripeMode(14)).toBe('link')
  })

  it('a channel that says nothing about the flow keeps the old behaviour', async () => {
    expect(await managerWith([stripe()]).getStripeMode(14)).toBe('link')
  })

  it('no Stripe at all is not a reason to mount one', async () => {
    expect(await managerWith([{ name: 'Klarna', config: [] }]).getStripeMode(14)).toBe('link')
  })

  it('an unreachable channel never throws into the pay button', async () => {
    const m = new CheckoutManager(fakeCart)
    vi.spyOn(m, 'getAvailablePaymentMethods').mockRejectedValue(new Error('offline'))
    expect(await m.getStripeMode(14)).toBe('link')
  })
})
