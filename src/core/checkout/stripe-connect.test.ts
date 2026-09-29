/**
 * Stripe Connect (ADR-0022): a seller who charges on a connected account
 * reaches the SDK as the channel's Stripe config carrying `stripeAccount`
 * (api-microservice). Every Stripe.js the SDK starts for that channel — the
 * Payment Element and the Apple Pay sheet — must name that account, and a
 * channel without it must look exactly as before.
 */
import { describe, expect, it, vi } from 'vitest'
import { CheckoutManager } from './checkout-manager.js'

const fakeCart = {} as never

function managerWith(methods: unknown) {
  const m = new CheckoutManager(fakeCart)
  vi.spyOn(m, 'getAvailablePaymentMethods').mockResolvedValue(methods as never)
  return m as any
}

const stripe = (account?: string) => ({
  name: 'Stripe',
  config: [
    { name: 'publishableKey', type: 'string', value: 'pk_test_platform' },
    { name: 'mode', type: 'string', value: 'native' },
    ...(account ? [{ name: 'stripeAccount', type: 'string', value: account }] : []),
  ],
})

describe('the connected account of a channel', () => {
  it('Connect: read from the channel Stripe config', async () => {
    const m = managerWith([stripe('acct_1Seller')])
    expect(await m.resolveStripeConnectAccount(14)).toBe('acct_1Seller')
  })

  it('recorded with the publishable key, for the Apple Pay sheet', async () => {
    const m = managerWith([stripe('acct_1Seller')])
    expect(await m.resolveStripePublishableKey(14)).toBe('pk_test_platform')
    expect(m.findStripeConnectAccount()).toBe('acct_1Seller')
  })

  it('no Connect: nothing, as before', async () => {
    const m = managerWith([stripe()])
    expect(await m.resolveStripeConnectAccount(14)).toBeUndefined()
    await m.resolveStripePublishableKey(14)
    expect(m.findStripeConnectAccount()).toBeUndefined()
  })

  it('something that is not an account id is ignored', async () => {
    const m = managerWith([stripe('cus_123')])
    expect(await m.resolveStripeConnectAccount(14)).toBeUndefined()
  })

  it('a Commerce that cannot be reached is no account, never an error', async () => {
    const m = new CheckoutManager(fakeCart) as any
    vi.spyOn(m, 'getAvailablePaymentMethods').mockRejectedValue(new Error('down'))
    expect(await m.resolveStripeConnectAccount(14)).toBeUndefined()
  })
})
