// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Free shipping, Vipps first (2026-11-03): a rate at 0 must read «Gratis» in
 * the checkout — the picker said «0 Kr», the summary «Beregnes ved kasse» and
 * the receipt left the row out — and the payment goes ahead with the items'
 * total.
 */
const SPONSOR = 5
const manager = Vio.checkout as any
const FREE = { id: 'free', name: 'Gratis frakt', method: 'Gratis frakt', price: 0, priceMajor: 0, currency: 'NOK' }
const PAID = { id: 'paid', name: 'Ekspress', method: 'Ekspress', price: 9900, priceMajor: 99, currency: 'NOK' }

let rates: any[] = [FREE]

beforeEach(() => {
  rates = [FREE]
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 1, buyerRef: null })
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
  const proto = VioCheckout.prototype as any
  for (const m of ['refreshApplePay', 'refreshKlarna']) vi.spyOn(proto, m).mockResolvedValue(undefined)
  vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
    this.availableShippingsList = rates
    this.shippingOption = rates[0] ?? null
    this.shippingsReadyFor = this.embedSession()
  })
  vi.spyOn(manager, 'items', 'get').mockReturnValue([
    { productId: 1, name: 'Genser', brand: 'Careless', quantity: 1, unitPrice: 1298, currency: 'NOK' } as any,
  ])
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(manager, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }, { name: 'Stripe' }])
  vi.spyOn(manager, 'getStripeMode').mockResolvedValue('link')
  vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(false)
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

async function openWithVipps() {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  el.show()
  await cycles(el)
  manager.state = { ...manager.state, paymentMethod: 'vipps' }
  manager.emit()
  await cycles(el)
  return el
}

const summaryRow = (el: HTMLElement, label: string) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.order-row') ?? [])]
    .map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim())
    .find((t) => t.startsWith(label))

const payButtonText = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.complete-cta') ?? [])].map((b) => b.textContent ?? '').join(' | ')

describe('free shipping in the checkout (Vipps)', () => {
  it('the summary says «Frakt – Gratis frakt · Gratis», not «Beregnes ved kasse»', async () => {
    const el = await openWithVipps()
    expect(summaryRow(el, 'Frakt')).toBe('Frakt – Gratis frakt Gratis')
    expect(shadowText(el)).not.toContain('Beregnes ved kasse')
    expect(summaryRow(el, 'Totalt')).toMatch(/Totalt\s*1\s?298/)
  })

  it('the shipping picker shows «Gratis», never «0 Kr»', async () => {
    rates = [FREE, PAID]
    const el = await openWithVipps()
    const prices = [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.ship-price') ?? [])].map((s) =>
      (s.textContent ?? '').trim(),
    )
    expect(prices).toContain('Gratis')
    expect(prices.some((p) => /99/.test(p))).toBe(true)
    expect(shadowText(el)).not.toMatch(/(^|\s)0 Kr/)
  })

  it('the Vipps payment is the items alone: «Betal 1 298 Kr»', async () => {
    const el = await openWithVipps()
    expect(payButtonText(el)).toMatch(/1\s?298/)
  })

  it('the receipt keeps the shipping row: «Frakt – Gratis frakt · Gratis»', async () => {
    const el = await openWithVipps()
    el.confirmOrder('vipps', SPONSOR)
    await cycles(el)
    const text = shadowText(el)
    expect(text).toContain('Gratis frakt')
    expect(text).toMatch(/Frakt[^]*Gratis/)
  })

  it('no rate yet: still «Beregnes ved kasse» (unknown is not free)', async () => {
    rates = []
    const el = await openWithVipps()
    expect(summaryRow(el, 'Frakt')).toBe('Frakt Beregnes ved kasse')
  })

  it('a paid rate is unchanged: «Frakt – Ekspress · 99 Kr»', async () => {
    rates = [PAID]
    const el = await openWithVipps()
    expect(summaryRow(el, 'Frakt')).toMatch(/^Frakt – Ekspress 99\s?Kr$/)
  })
})
