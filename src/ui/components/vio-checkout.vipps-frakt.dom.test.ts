// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Vipps Express picks the delivery inside Vipps: with Vipps selected, our own
 * shipping rate is not added to the total and the summary says so (Angelo,
 * 2026-10-24 — the checkout showed 1 308 kr while Vipps asked 1 298).
 */
const SPONSOR = 5
const manager = Vio.checkout as any
const RATE = { id: 'r1', name: 'Default Shipping', method: 'Default Shipping', price: 1000, priceMajor: 10, currency: 'NOK' }

beforeEach(() => {
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 1, buyerRef: null })
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
  const proto = VioCheckout.prototype as any
  for (const m of ['refreshApplePay', 'refreshKlarna']) vi.spyOn(proto, m).mockResolvedValue(undefined)
  vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
    this.availableShippingsList = [RATE]
    this.shippingOption = RATE
    this.shippingsReadyFor = this.embedSession()
  })
  vi.spyOn(manager, 'items', 'get').mockReturnValue([
    { productId: 1, name: 'Genser', brand: 'Careless', quantity: 1, unitPrice: 1298, currency: 'NOK' } as any,
  ])
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(manager, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }, { name: 'Stripe' }])
  vi.spyOn(manager, 'getStripeMode').mockResolvedValue('link')
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], session: 1, subtotal: 1298, currency: 'NOK', items: [] }
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

async function cycles(el: HTMLElement, n = 6) {
  for (let i = 0; i < n; i++) await settle(el)
}

async function openWithMethod(method: string) {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  el.show()
  await cycles(el)
  manager.state = { ...manager.state, paymentMethod: method }
  manager.emit()
  await cycles(el)
  return el
}

const payButtonText = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.complete-cta') ?? [])].map((b) => b.textContent ?? '').join(' | ')

describe('Vipps Express: the delivery is chosen in Vipps', () => {
  it('Vipps Express selected: the total is the items only and the shipping row says it is chosen in Vipps', async () => {
    vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(true)
    const el = await openWithMethod('vipps')
    expect(el.vippsShipsInApp).toBe(true)
    const text = shadowText(el)
    expect(text).toContain('Velges i Vipps')
    expect(text).not.toMatch(/1\s?308/)
    expect(text).not.toMatch(/10\s?kr/i)
    expect(payButtonText(el)).toMatch(/1\s?298/)
  })

  it('Vipps without Express: our rate is part of the total, as before', async () => {
    vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(false)
    const el = await openWithMethod('vipps')
    expect(el.vippsShipsInApp).toBe(false)
    expect(shadowText(el)).not.toContain('Velges i Vipps')
    expect(shadowText(el)).toMatch(/Totalt\s*1\s?308/)
    expect(payButtonText(el)).toMatch(/1\s?308/)
  })

  it('another method with Express on: our rate still counts', async () => {
    vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(true)
    const el = await openWithMethod('stripe')
    expect(shadowText(el)).not.toContain('Velges i Vipps')
    expect(payButtonText(el)).toMatch(/1\s?308/)
  })
})
