/**
 * Apple Pay resolves its Stripe publishable key from the sponsor's own commerce
 * channel. Hosts should not have to configure it: the key belongs to the
 * brand's Stripe account, which is what `GetAvailablePaymentMethods` returns.
 * A regression here is invisible — the button simply never appears.
 */
import { describe, expect, it, vi } from 'vitest'
import { CheckoutManager } from './checkout-manager.js'

// The shape Commerce returns for a channel with Stripe enabled.
const CHANNEL_METHODS = [
  { name: 'Stripe', config: [{ name: 'publishableKey', type: 'string', value: 'pk_test_from_channel' }] },
  { name: 'Klarna', config: [] },
  { name: 'Vipps', config: [] },
]

function managerWith(methods: unknown) {
  const m = new CheckoutManager()
  vi.spyOn(m, 'getAvailablePaymentMethods').mockResolvedValue(methods as never)
  return m as unknown as {
    resolveStripePublishableKey(sponsorId?: number): Promise<string>
  }
}

describe('Apple Pay publishable key', () => {
  it('takes it from the sponsor channel when the host configured none', async () => {
    const m = managerWith(CHANNEL_METHODS)
    expect(await m.resolveStripePublishableKey(14)).toBe('pk_test_from_channel')
  })

  it('returns empty when the channel has no Stripe — Apple Pay stays hidden', async () => {
    const m = managerWith([{ name: 'Klarna', config: [] }])
    expect(await m.resolveStripePublishableKey(14)).toBe('')
  })

  it('ignores a config value that is not a publishable key', async () => {
    const m = managerWith([{ name: 'Stripe', config: [{ name: 'publishableKey', value: 'sk_live_oops' }] }])
    expect(await m.resolveStripePublishableKey(14)).toBe('')
  })

  it('never throws when the channel is unreachable', async () => {
    const m = new CheckoutManager()
    vi.spyOn(m, 'getAvailablePaymentMethods').mockRejectedValue(new Error('commerce down'))
    const r = m as unknown as { resolveStripePublishableKey(id?: number): Promise<string> }
    await expect(r.resolveStripePublishableKey(14)).resolves.toBe('')
  })
})
