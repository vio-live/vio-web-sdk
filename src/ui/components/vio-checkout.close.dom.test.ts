// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Alan, 2026-09-14 (card IW0OSJp7): open the checkout with Qliro, close it with
 * the X or a click outside, change the cart, open it again — Qliro still asks
 * for the OLD total. Through "Endre" it was right.
 *
 * Closing left the embedded widget in the light DOM with the order it was
 * created for, and on the next open the "already mounted" guard kept it.
 * Paying there would have charged the old cart.
 */
const SPONSOR = 5
const manager = Vio.checkout as any
let cartTotal = 2100

beforeEach(() => {
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'loadAvailableShippings', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], subtotal: cartTotal, currency: 'NOK' }
    manager.emit()
    return manager.state
  })
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  unmountAll()
  manager.state = null
  vi.restoreAllMocks()
})

async function renderCycles(el: HTMLElement, n = 5) {
  for (let i = 0; i < n; i++) await settle(el)
}

for (const method of ['qliro', 'walley'] as const) {
  it(`${method}: closing with the X, changing the cart and reopening shows the NEW total`, async () => {
    cartTotal = 2100
    const mountName = method === 'qliro' ? 'mountQliroCheckout' : 'mountWalleyCheckout'
    const mountSpy = vi.spyOn(manager, mountName).mockImplementation(async (...args: unknown[]) => {
      const container = args[0] as HTMLElement
      container.innerHTML = `<iframe data-total="${manager.state?.subtotal}"></iframe>`
      return { order_id: `ORDER-${manager.state?.subtotal}`, html_snippet: '' }
    })
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    const shown = () => el.querySelector(`#vio-${method}-checkout-container iframe`)?.getAttribute('data-total')

    manager.open(SPONSOR)
    manager.selectPaymentMethod(method)
    el.show()
    await renderCycles(el)
    expect(shown()).toBe('2100')

    el.close() // what the X and the backdrop both call
    await renderCycles(el)
    cartTotal = 3300 // the shopper keeps shopping
    manager.open(SPONSOR)
    manager.selectPaymentMethod(method)
    el.show()
    await renderCycles(el)

    expect(shown()).toBe('3300')
    // A fresh order for the new cart — not the old widget kept alive.
    expect(mountSpy).toHaveBeenCalledTimes(2)
  })
}
