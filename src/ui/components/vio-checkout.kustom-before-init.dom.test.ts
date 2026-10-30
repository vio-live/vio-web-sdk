// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { Configuration } from '../../core/configuration.js'
import { VioCheckout } from './vio-checkout.js'
import { cartStorageKey, cartScopeOf } from '../../core/cart/cart-manager.js'
import { rememberCheckoutSponsor } from '../../core/sponsor-identity.js'

/**
 * A Kustom return read before `Vio.init()`, as on Vev (the checkout mounts
 * with the page, the config block calls init a moment later).
 *
 * Alan, QA 2026-10-30, Vev 0.340: paid with Kustom (orders 4655 and 4656 were
 * created) and came back to «Handlekurven er tom.» over «Vi kunne ikke
 * bekrefte betalingen»: the return reopened the checkout and read the order
 * at once, before init — no cart yet (each connection keeps its own) and no
 * key to read with. The cart stayed full, so the second purchase paid again.
 */

const SPONSOR = 5
const KEY = 'test-key'
const manager = Vio.checkout as any

let store: Map<string, string>

function seedConnectionCart() {
  const line = {
    id: 'line-1',
    productId: 101,
    sponsorId: SPONSOR,
    brand: 'Vio QA Beauty',
    name: 'Day Cream',
    unitPrice: 399,
    currency: 'NOK',
    imageUrl: '',
    quantity: 1,
  }
  store.set(
    cartStorageKey(cartScopeOf('production', KEY)),
    JSON.stringify({ [SPONSOR]: { sponsorId: SPONSOR, items: [line], currency: 'NOK' } }),
  )
}

async function renderCycles(el: HTMLElement, n = 6) {
  for (let i = 0; i < n; i++) await settle(el)
}

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailableShippings', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue(null)
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
  vi.spyOn(manager, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Kustom' }])
  vi.spyOn(manager, 'getStripeMode').mockResolvedValue('link')
  vi.spyOn(manager, 'mountKustomCheckout').mockResolvedValue({ order_id: 'NEW', html_snippet: '' })
  vi.spyOn(manager, 'renderKustomSnippet').mockImplementation((c: any, h: any) => {
    c.innerHTML = h
  })
})

afterEach(() => {
  unmountAll()
  manager.state = null
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

describe('a Kustom return read before Vio.init()', () => {
  it('waits for init, reopens on the cart and shows the receipt — no «Vi kunne ikke bekrefte betalingen»', async () => {
    seedConnectionCart()
    rememberCheckoutSponsor('CHK-K', { sponsorId: SPONSOR, channelId: '77' })
    // Like the real read: before init there is no key to read with.
    const read = vi.spyOn(manager, 'getKustomOrder').mockImplementation(async () => {
      if (!Configuration.isInitialized) throw new Error('Vio is not initialized')
      return { order_id: 'KCO-1', status: 'checkout_complete', html_snippet: '<p>Takk for kjøpet</p>' }
    })
    window.history.replaceState({}, '', '/?order_id=KCO-1&payment_processor=KUSTOM&checkout_id=CHK-K')

    // Vev's order: the overlay first…
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    // …its config block's init after.
    Vio.init({ apiKey: KEY, environment: 'production' } as any)
    await renderCycles(el, 10)

    expect(el.checkoutState?.sponsorId).toBe(SPONSOR)
    expect(read).toHaveBeenCalledWith('KCO-1', SPONSOR, 'CHK-K')
    const text = shadowText(el)
    expect(text).not.toContain('Vi kunne ikke bekrefte betalingen')
    expect(text).not.toContain('Handlekurven er tom')
    // Reading the paid order never starts a new one.
    expect(manager.mountKustomCheckout).not.toHaveBeenCalled()
  })
})

describe('a Kustom return whose read is refused while the page settles', () => {
  const realDelays = (VioCheckout as any).RETURN_KEY_RETRY_DELAYS_MS
  beforeEach(() => {
    ;(VioCheckout as any).RETURN_KEY_RETRY_DELAYS_MS = [1, 1, 1, 1]
  })
  afterEach(() => {
    ;(VioCheckout as any).RETURN_KEY_RETRY_DELAYS_MS = realDelays
  })

  // Alan, QA 2026-10-30, Vev 0.341: on the page just back from Kustom, every
  // commerce call of the first second went out with the platform key (the
  // returning channel's key was not known yet) and GetKustomOrder got a 401;
  // 45 s later the same page read with the right key.
  it('tries again while the key is refused, and shows the receipt once it is accepted', async () => {
    seedConnectionCart()
    Vio.init({ apiKey: KEY, environment: 'production' } as any)
    rememberCheckoutSponsor('CHK-K2', { sponsorId: SPONSOR, channelId: '77' })
    const read = vi
      .spyOn(manager, 'getKustomOrder')
      .mockRejectedValueOnce(new Error('GraphQL request failed (HTTP 401)'))
      .mockRejectedValueOnce(new Error('Authentication failed'))
      .mockResolvedValue({ order_id: 'KCO-2', status: 'checkout_complete', html_snippet: '<p>Takk</p>' })
    window.history.replaceState({}, '', '/?order_id=KCO-2&payment_processor=KUSTOM&checkout_id=CHK-K2')

    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    for (let i = 0; i < 6; i++) {
      await renderCycles(el, 2)
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(read).toHaveBeenCalledTimes(3)
    expect(shadowText(el)).not.toContain('Vi kunne ikke bekrefte betalingen')
    expect(manager.mountKustomCheckout).not.toHaveBeenCalled()
  })

  it('any other failure is not retried: one read, and the shopper is told at once', async () => {
    seedConnectionCart()
    Vio.init({ apiKey: KEY, environment: 'production' } as any)
    rememberCheckoutSponsor('CHK-K3', { sponsorId: SPONSOR, channelId: '77' })
    const read = vi.spyOn(manager, 'getKustomOrder').mockRejectedValue(new Error('network down'))
    window.history.replaceState({}, '', '/?order_id=KCO-3&payment_processor=KUSTOM&checkout_id=CHK-K3')

    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el, 6)

    expect(read).toHaveBeenCalledTimes(1)
    expect(shadowText(el)).toContain('Vi kunne ikke bekrefte betalingen')
  })
})
