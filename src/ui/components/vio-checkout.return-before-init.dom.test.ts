// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'
import { cartStorageKey, cartScopeOf } from '../../core/cart/cart-manager.js'

/**
 * A provider's return handled before the page has called `Vio.init()`.
 *
 * Vev mounts the checkout as soon as the page renders and calls `Vio.init()`
 * a moment later, from its config block. So on the page load that brings the
 * shopper back from Vipps, the checkout reads the return first. Each
 * connection keeps its own carts (0.33), and before the init there is no
 * connection: the cart is not there, `open()` throws, the checkout has no
 * state, and nothing asks for the payment methods. Alan, 2026-10-29, on his
 * Vev page (SDK 0.37): he cancelled in Vipps and came back to «Betalingen ble
 * avbrutt…» above a «Henter betalingsmåter…» that never ended, with no cart
 * and no delivery form.
 */

const SPONSOR = 5
const CHECKOUT = 'CHK-VIPPS-CANCELLED'
const KEY = 'test-key'
const manager = Vio.checkout as any

/** This page's localStorage (jsdom here has none). */
let store: Map<string, string>

/** The shopper's cart, where this connection keeps it. */
function seedConnectionCart() {
  const line = {
    id: 'line-1',
    productId: 101,
    sponsorId: SPONSOR,
    brand: 'Test',
    name: 'Genser',
    unitPrice: 499,
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
})

afterEach(() => {
  unmountAll()
  manager.state = null
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

describe('a return read before Vio.init()', () => {
  it('Vipps cancelled: once init lands, the checkout opens on the cart and lists the methods', async () => {
    seedConnectionCart()
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'ABORTED', duplicate_of: null })
    const methods = vi.spyOn(manager, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }])
    vi.spyOn(manager, 'getStripeMode').mockResolvedValue('link')
    window.history.replaceState(
      {},
      '',
      `/?vio_payment=success&vio_method=vipps&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}`,
    )

    // Vev's order: the overlay first…
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    // …its config block's init after.
    Vio.init({ apiKey: KEY, environment: 'production' } as any)
    await renderCycles(el)

    expect(el.checkoutState?.sponsorId).toBe(SPONSOR)
    expect(el.checkoutState?.paymentMethod).toBe('vipps')
    expect(methods).toHaveBeenCalledWith(SPONSOR)
    const text = shadowText(el)
    expect(text).toContain('Betalingen ble avbrutt eller feilet')
    expect(text).not.toContain('Henter betalingsmåter')
    // The shopper can try again: the delivery form of the standard Vipps payment is back.
    expect(text).toContain('Leveringsadresse')
  })
})

describe('the payment step with no checkout to ask about', () => {
  it('says the cart is empty instead of loading forever', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    el.open = true
    el.checkoutState = null
    el.paymentMethodsResolved = false
    await renderCycles(el, 2)

    const text = shadowText(el)
    expect(text).not.toContain('Henter betalingsmåter')
    expect(text).toContain('Handlekurven er tom.')
  })
})
