// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * The buttons never open a checkout or start a payment for an empty cart or
 * one of 0 kr (Mote & Livsstil, 2026-10-28). CheckoutManager refuses it too
 * (empty-cart-guard.test.ts); these are the buttons themselves.
 */

const manager = Vio.checkout as any

afterEach(() => {
  unmountAll()
  manager.state = null
  vi.restoreAllMocks()
})

describe('vio-cart', () => {
  const cartOf = (unitPrice: number) =>
    new Map([
      [5, { sponsorId: 5, currency: 'NOK', items: [{ id: 'i1', productId: 1, name: 'Genser', quantity: 1, unitPrice, currency: 'NOK' }] }],
    ])

  async function cart(unitPrice: number) {
    const el = await mount<HTMLElement & Record<string, any>>('vio-cart')
    el.carts = cartOf(unitPrice)
    el.itemCount = 1
    el.availableMethods = ['Vipps']
    el.open = true
    await settle(el)
    return el
  }

  it('a cart of 0 kr: «Til kassen» is disabled and opens nothing', async () => {
    const el = await cart(0)
    const opened = vi.fn()
    document.addEventListener('vio:checkout-open', opened)
    const btn = el.shadowRoot!.querySelector<HTMLButtonElement>('.checkout-btn')!
    expect(btn.disabled).toBe(true)
    el.onCheckout()
    el.onVipps()
    document.removeEventListener('vio:checkout-open', opened)
    expect(opened).not.toHaveBeenCalled()
  })

  it('a cart with something to pay opens the checkout', async () => {
    const el = await cart(599)
    const opened = vi.fn()
    document.addEventListener('vio:checkout-open', opened)
    el.shadowRoot!.querySelector<HTMLButtonElement>('.checkout-btn')!.click()
    document.removeEventListener('vio:checkout-open', opened)
    expect(opened).toHaveBeenCalledTimes(1)
  })
})

describe('vio-checkout', () => {
  beforeEach(() => {
    const proto = VioCheckout.prototype as any
    for (const m of ['loadAvailablePaymentMethods', 'refreshApplePay', 'refreshKlarna']) {
      vi.spyOn(proto, m).mockResolvedValue(undefined)
    }
    vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
      this.shippingsReadyFor = this.embedSession()
    })
    vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  })

  it('a pay button on a cart that dropped to 0 says the cart is empty and starts nothing', async () => {
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/x' })
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: 5, session: 1, subtotal: 0, currency: 'NOK', paymentMethod: 'vipps' }
    manager.emit()
    el.availableMethods = ['Vipps']
    el.paymentMethodsResolved = true
    el.show()
    for (let i = 0; i < 4; i++) await settle(el)
    const pay = el.shadowRoot!.querySelector<HTMLButtonElement>('.complete-cta')!
    expect(pay.disabled).toBe(true)
    await el.onPay('vipps')
    expect(start).not.toHaveBeenCalled()
    expect(el.paymentError).toBe('Handlekurven er tom.')
  })
})
