// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Vipps in the checkout is the STANDARD payment (Mote & Livsstil,
 * 2026-10-28): our form collects name, address, mobile and the delivery with
 * its price before paying — even when the brand has Vipps Express on — and
 * the payment goes out with `express: false`. Express is the product
 * detail's «Kjøp nå med Vipps» only.
 *
 * Before, Vipps here skipped our form (Express, 2026-09-29) and the shopper
 * met the address and the delivery price for the first time inside the app.
 */
const SPONSOR = 5
const manager = Vio.checkout as any
const RATE = { id: 'r1', supplierId: '77', name: 'Posten', method: 'Posten', price: 4900, priceMajor: 49, currency: 'NOK' }
const FULL = {
  firstName: 'Kari', lastName: 'Nordmann', email: 'kari@example.no', phone: '912 34 567',
  address: 'Storgata 12B', postalCode: '0194', city: 'Oslo',
}

beforeEach(() => {
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 1, buyerRef: null }) // settled, no reference
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null) // the receipt's number: each test says
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
    this.availableShippingsList = [RATE]
    this.selectedShipping = RATE.id
    this.shippingsReadyFor = this.embedSession()
  })
  vi.spyOn(manager, 'updateShippingsBySupplier').mockResolvedValue({ cart_id: 'cart-1' })
  // The brand has Express on: the checkout pays standard all the same.
  vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(true)
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], session: 1, subtotal: 4999, currency: 'NOK' }
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

async function renderCycles(el: HTMLElement, n = 4) {
  for (let i = 0; i < n; i++) await settle(el)
}

async function openWith(methods: string[], form: Record<string, string> = {}) {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  el.availableMethods = methods
  el.paymentMethodsResolved = true
  el.form = { ...el.form, ...form }
  el.show()
  await renderCycles(el)
  return el
}

const methodButton = (el: HTMLElement, label: string) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.payment-btn') ?? [])].find((b) =>
    (b.textContent ?? '').toLowerCase().includes(label),
  )
const emailInput = (el: HTMLElement) =>
  el.shadowRoot?.querySelector<HTMLInputElement>('input[type="email"]') ?? null

const payCta = (el: HTMLElement) => el.shadowRoot?.querySelector<HTMLButtonElement>('.complete-cta') ?? null
const phoneInput = (el: HTMLElement) => el.shadowRoot?.querySelector<HTMLInputElement>('input[type="tel"]') ?? null

describe('Vipps in the checkout: the standard path', () => {
  it('choosing Vipps brings our form — address, mobile, delivery with its price — and starts nothing yet', async () => {
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/x' })
    const el = await openWith(['Nexi', 'Qliro', 'Vipps'])
    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    expect(el.checkoutState?.paymentMethod).toBe('vipps')
    const text = shadowText(el)
    expect(text).toContain('Leveringsadresse')
    expect(text).toContain('Mobilnummer *')
    expect(text).toContain('Posten')
    expect(text).toMatch(/49\s?Kr/)
    expect(text).not.toContain('adresse fylles ut i Vipps')
    expect(emailInput(el)).not.toBeNull()
    expect(phoneInput(el)).not.toBeNull()
    expect(start).not.toHaveBeenCalled()
    // Its pay button waits for a complete form.
    expect(payCta(el)!.disabled).toBe(true)
  })

  it('a complete form pays standard — express: false, the form and the delivery on the cart — even with Express on', async () => {
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/x' })
    const el = await openWith(['Vipps'], FULL)
    manager.selectPaymentMethod('vipps')
    await renderCycles(el)
    expect(payCta(el)!.disabled).toBe(false)
    expect(payCta(el)!.textContent).toMatch(/Betal\s+\S+\s?\S*\s*Kr med Vipps/)
    payCta(el)!.click()
    await renderCycles(el)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]![0]).toBe(SPONSOR)
    expect(start.mock.calls[0]![1]).toMatchObject({ phone: '912 34 567', address: 'Storgata 12B' })
    expect(start.mock.calls[0]![2]).toEqual({ express: false })
    expect(manager.updateShippingsBySupplier).toHaveBeenCalledWith([{ shipping_id: 'r1', supplier_id: 77 }], SPONSOR)
  })

  it('a missing address refuses Vipps with the form’s message and starts nothing', async () => {
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/x' })
    const el = await openWith(['Vipps'], { ...FULL, address: '' })
    manager.selectPaymentMethod('vipps')
    await renderCycles(el)
    await el.onPay('vipps')
    expect(start).not.toHaveBeenCalled()
    expect(el.paymentError).toBe('Vennligst fyll ut alle feltene i leveringsadresse.')
  })

  it('a number that is not a Norwegian mobile: the field says so and Vipps does not start', async () => {
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/x' })
    const el = await openWith(['Vipps'], { ...FULL, phone: '1234' })
    manager.selectPaymentMethod('vipps')
    await renderCycles(el)
    expect(shadowText(el)).toContain('Skriv et gyldig mobilnummer')
    expect(phoneInput(el)!.getAttribute('aria-invalid')).toBe('true')
    expect(payCta(el)!.disabled).toBe(true)
    await el.onPay('vipps')
    expect(start).not.toHaveBeenCalled()
  })

  it('a delivery that cannot be saved on the cart starts no payment, and says so', async () => {
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/x' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const failure of ['rejects', 'null', 'no-supplier'] as const) {
      if (failure === 'rejects') manager.updateShippingsBySupplier.mockRejectedValueOnce(new Error('503'))
      if (failure === 'null') manager.updateShippingsBySupplier.mockResolvedValueOnce(null)
      const el = await openWith(['Vipps'], FULL)
      manager.selectPaymentMethod('vipps')
      await renderCycles(el)
      if (failure === 'no-supplier') {
        el.shippingsAttempted = true // the stubbed load would put RATE back on the next state change
        el.availableShippingsList = [{ ...RATE, supplierId: undefined }]
      }
      await el.onPay('vipps')
      expect(start, failure).not.toHaveBeenCalled()
      expect(el.paymentError, failure).toBe('Kunne ikke lagre fraktmetoden. Prøv igjen.')
      expect(el.vippsLoading).toBe(false)
      expect(document.querySelector('.vio-redirect-overlay')).toBeNull()
      unmountAll()
      manager.state = null
    }
  })

  it('a foreign number with its +prefix is fine for Vipps', async () => {
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/x' })
    const el = await openWith(['Vipps'], { ...FULL, phone: '+46 70 123 45 67' })
    manager.selectPaymentMethod('vipps')
    await renderCycles(el)
    expect(shadowText(el)).not.toContain('Skriv et gyldig mobilnummer')
    await el.onPay('vipps')
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('the mobile is optional for any other method: it never gates their pay button', async () => {
    vi.spyOn(manager, 'getStripeMode').mockResolvedValue('link')
    const startStripe = vi.spyOn(manager, 'startStripePayment').mockResolvedValue({})
    const { phone: _omit, ...noPhone } = FULL
    const el = await openWith(['Stripe', 'Vipps'], noPhone)
    el.stripeMode = 'link'
    manager.selectPaymentMethod('stripe')
    await renderCycles(el)
    expect(shadowText(el)).toContain('Mobilnummer (valgfritt)')
    expect(payCta(el)!.disabled).toBe(false)
    await el.onPay('stripe')
    expect(startStripe).toHaveBeenCalledTimes(1)
    // Switching to Vipps makes it required.
    manager.selectPaymentMethod('vipps')
    await renderCycles(el)
    expect(shadowText(el)).toContain('Mobilnummer *')
    expect(payCta(el)!.disabled).toBe(true)
  })

  it('a start the gateway refuses shows the shopper a sentence, not the gateway text (2026-10-09)', async () => {
    // A cart emptied from another tab: what QA saw, word for word.
    vi.spyOn(manager, 'startVippsPayment').mockRejectedValue(
      new Error('Payment Vipps not initialize: [vipps] amount must be a positive integer in minor units, got 0'),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const el = await openWith(['Vipps'], FULL)
    manager.selectPaymentMethod('vipps')
    await renderCycles(el)
    payCta(el)!.click()
    await renderCycles(el)
    expect(el.paymentError).toBe('Handlekurven er tom. Legg til et produkt og prøv igjen.')
    expect(shadowText(el)).not.toContain('not initialize')
    // The raw text is still there for whoever debugs it.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Vipps'), expect.anything())
  })
})
