import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installQliroListeners, type Q1 } from './qliro-sync.js'

vi.mock('../../api/cart-queries.js', () => ({
  executeCartGraphQL: vi.fn(),
}))
const { executeCartGraphQL } = await import('../../api/cart-queries.js')

/**
 * Qliro's two rules — lock before touching the server, compare before
 * unlocking — plus the one they do not state: never leave a customer locked
 * out of paying.
 */

/** A `q1` that records what was called, and lets a test drive the callbacks. */
function fakeQ1() {
  const cb: Record<string, any> = {}
  const calls: string[] = []
  const q1: Q1 = {
    lock: () => calls.push('lock'),
    unlock: () => calls.push('unlock'),
    onCheckoutLoaded: (f) => (cb.loaded = f),
    onOrderUpdated: (f) => (cb.updated = f),
    onShippingMethodChanged: (f) => (cb.shipping = f),
    onShippingPriceChanged: (f) => (cb.shippingPrice = f),
    onCustomerInfoChanged: (f) => (cb.customer = f),
    onPaymentMethodChanged: (f) => (cb.paymentMethod = f),
    onPaymentDeclined: (f) => (cb.declined = f),
    onSessionExpired: (f) => (cb.expired = f),
  }
  return { q1, cb, calls }
}

const syncResult = (version: string) => ({
  data: { Payment: { SyncPaymentQliro: { order_id: '5557406', update_version: version, total_price: 848 } } },
})

describe('installQliroListeners', () => {
  const win = globalThis as any

  beforeEach(() => {
    vi.mocked(executeCartGraphQL).mockReset()
    delete win.q1Ready
  })
  afterEach(() => {
    delete win.q1Ready
  })

  it('does NOT register onOrderUpdated before there is a lock', () => {
    // Qliro's contract: registering it "initiates the order sync process".
    // Registered at ready, with no lock and no update coming, the widget sits
    // loading and polls its orders endpoint forever. Observed live.
    const c = installQliroListeners({ checkoutId: 'chk-1' })
    const { q1, cb } = fakeQ1()
    win.q1Ready(q1)
    expect(cb.updated).toBeUndefined()
    c.destroy()
  })

  it('registers it on the first lock, and only once', async () => {
    vi.mocked(executeCartGraphQL).mockResolvedValue(syncResult('v-1') as any)
    const c = installQliroListeners({ checkoutId: 'chk-1', unlockTimeoutMs: 40 })
    const { q1, cb } = fakeQ1()
    win.q1Ready(q1)
    expect(cb.updated).toBeUndefined()

    const first = c.sync()
    await vi.waitFor(() => expect(cb.updated).toBeTypeOf('function'))
    const registered = cb.updated
    cb.updated({ merchantUpdateVersion: 'v-1' })
    await first

    await c.sync()
    // Same callback: re-registering would start another sync.
    expect(cb.updated).toBe(registered)
    c.destroy()
  })

  it('defines q1Ready so the widget can hand us q1', () => {
    const c = installQliroListeners({ checkoutId: 'chk-1' })
    expect(typeof win.q1Ready).toBe('function')
    c.destroy()
  })

  it('chains a q1Ready that was already on the page instead of clobbering it', () => {
    const existing = vi.fn()
    win.q1Ready = existing
    const c = installQliroListeners({ checkoutId: 'chk-1' })
    const { q1 } = fakeQ1()
    win.q1Ready(q1)
    expect(existing).toHaveBeenCalledWith(q1)
    c.destroy()
    expect(win.q1Ready).toBe(existing)
  })

  it('locks before the server call and unlocks only once Qliro echoes the version', async () => {
    vi.mocked(executeCartGraphQL).mockResolvedValue(syncResult('v-1') as any)
    const c = installQliroListeners({ checkoutId: 'chk-1' })
    const { q1, cb, calls } = fakeQ1()
    win.q1Ready(q1)

    const pending = c.sync()
    await vi.waitFor(() => expect(executeCartGraphQL).toHaveBeenCalled())
    // Locked, and NOT yet unlocked: the order is still being synchronized.
    expect(calls).toEqual(['lock'])

    cb.updated({ merchantUpdateVersion: 'v-1', totalPrice: 848 })
    await pending
    expect(calls).toEqual(['lock', 'unlock'])
  })

  it('ignores an echo for a different version', async () => {
    vi.mocked(executeCartGraphQL).mockResolvedValue(syncResult('v-2') as any)
    const c = installQliroListeners({ checkoutId: 'chk-1', unlockTimeoutMs: 50 })
    const { q1, cb, calls } = fakeQ1()
    win.q1Ready(q1)

    const pending = c.sync()
    await vi.waitFor(() => expect(executeCartGraphQL).toHaveBeenCalled())
    cb.updated({ merchantUpdateVersion: 'v-1' })
    expect(calls).toEqual(['lock'])
    // The safety timeout still releases it, rather than stranding the buyer.
    await pending
    expect(calls).toEqual(['lock', 'unlock'])
  })

  it('unlocks on an echo with no version at all', async () => {
    // Older orders carry no MerchantUpdateVersion; an update is an update.
    vi.mocked(executeCartGraphQL).mockResolvedValue(syncResult('v-1') as any)
    const c = installQliroListeners({ checkoutId: 'chk-1' })
    const { q1, cb, calls } = fakeQ1()
    win.q1Ready(q1)
    const pending = c.sync()
    await vi.waitFor(() => expect(executeCartGraphQL).toHaveBeenCalled())
    cb.updated({ totalPrice: 848 })
    await pending
    expect(calls).toEqual(['lock', 'unlock'])
  })

  it('never leaves the customer locked out when Qliro goes quiet', async () => {
    vi.mocked(executeCartGraphQL).mockResolvedValue(syncResult('v-1') as any)
    const c = installQliroListeners({ checkoutId: 'chk-1', unlockTimeoutMs: 30 })
    const { q1, calls } = fakeQ1()
    win.q1Ready(q1)
    // onOrderUpdated is never called at all.
    await c.sync()
    expect(calls).toEqual(['lock', 'unlock'])
  })

  it('unlocks when the sync call itself fails', async () => {
    vi.mocked(executeCartGraphQL).mockRejectedValue(new Error('502'))
    const events: any[] = []
    const c = installQliroListeners({
      checkoutId: 'chk-1',
      onEvent: (e) => events.push(e),
    })
    const { q1, calls } = fakeQ1()
    win.q1Ready(q1)
    expect(await c.sync()).toBeNull()
    expect(calls).toEqual(['lock', 'unlock'])
    expect(events.map((e) => e.type)).toContain('sync-failed')
  })

  it('reports what the customer does inside the iframe', () => {
    const events: any[] = []
    const c = installQliroListeners({
      checkoutId: 'chk-1',
      onEvent: (e) => events.push(e),
    })
    const { q1, cb } = fakeQ1()
    win.q1Ready(q1)

    cb.loaded()
    cb.shipping({ method: 'HOME_DELIVERY', price: 199 })
    cb.shippingPrice(199, 249)
    cb.customer({ email: 'e2e@vio.live' })
    cb.paymentMethod({ method: 'QLIRO_INVOICE' })
    cb.declined('OutOfStock', 'Only 2 left')

    expect(events).toEqual([
      { type: 'loaded' },
      { type: 'shipping-changed', shipping: { method: 'HOME_DELIVERY', price: 199 } },
      { type: 'shipping-price-changed', price: 199, totalPrice: 249 },
      { type: 'customer-changed', customer: { email: 'e2e@vio.live' } },
      { type: 'payment-method-changed', paymentMethod: { method: 'QLIRO_INVOICE' } },
      { type: 'payment-declined', reason: 'OutOfStock', message: 'Only 2 left' },
    ])
    c.destroy()
  })

  it('recovers an expired session by re-syncing, which mints a new one', async () => {
    vi.mocked(executeCartGraphQL).mockResolvedValue(syncResult('v-1') as any)
    const events: any[] = []
    const c = installQliroListeners({
      checkoutId: 'chk-1',
      unlockTimeoutMs: 30,
      onEvent: (e) => events.push(e),
    })
    const { q1, cb } = fakeQ1()
    win.q1Ready(q1)

    cb.expired()
    expect(events.map((e) => e.type)).toContain('session-expired')
    await vi.waitFor(() => expect(executeCartGraphQL).toHaveBeenCalled())
    c.destroy()
  })

  it('a throwing host listener never breaks the checkout', () => {
    const c = installQliroListeners({
      checkoutId: 'chk-1',
      onEvent: () => {
        throw new Error('host bug')
      },
    })
    const { q1, cb } = fakeQ1()
    win.q1Ready(q1)
    expect(() => cb.loaded()).not.toThrow()
    c.destroy()
  })

  it('destroy releases a lock that is still held', async () => {
    vi.mocked(executeCartGraphQL).mockResolvedValue(syncResult('v-1') as any)
    const c = installQliroListeners({ checkoutId: 'chk-1', unlockTimeoutMs: 10_000 })
    const { q1, calls } = fakeQ1()
    win.q1Ready(q1)
    const pending = c.sync()
    await vi.waitFor(() => expect(executeCartGraphQL).toHaveBeenCalled())
    expect(calls).toEqual(['lock'])
    c.destroy()
    await pending
    expect(calls).toEqual(['lock', 'unlock'])
  })

  it('does nothing after destroy', async () => {
    const c = installQliroListeners({ checkoutId: 'chk-1' })
    c.destroy()
    expect(await c.sync()).toBeNull()
    expect(executeCartGraphQL).not.toHaveBeenCalled()
  })
})
