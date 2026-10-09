// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Vipps among other methods — nothing of ours stands in its way.
 *
 * Vipps collects the address, the delivery and the email in its own flow
 * (Express, 2026-09-29), so the checkout asks for nothing first: the first
 * click selects the method, the pay button starts it. The "Kontakt" section
 * still offers an email field, used when the shopper types one. Before
 * Express, on 2026-09-21, Alan (QA, web and mobile) found the dead end that
 * shaped this: on a channel whose methods ALL collect the address themselves
 * (Nexi + Qliro + Vipps) the Vipps button refused to select the method until
 * an email was typed — into a field that did not exist yet.
 */
const SPONSOR = 5
const manager = Vio.checkout as any

beforeEach(() => {
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
    this.shippingsReadyFor = this.embedSession()
  })
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

describe('Vipps among several methods', () => {
  it('every method collects the address: no form, and one click on Vipps selects it AND starts it — no email required', async () => {
    vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(true)
    // Express first: the app picks the delivery. A landing page = done.
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/x' })
    const el = await openWith(['Nexi', 'Qliro', 'Vipps'])
    expect(shadowText(el)).not.toContain('Leveringsadresse')
    expect(emailInput(el)).toBeNull()

    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    // Selected and started at once: the app hands the email back.
    expect(el.checkoutState?.paymentMethod).toBe('vipps')
    expect(el.paymentError).toBeFalsy()
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]![1]).not.toMatchObject({ email: expect.stringContaining('@') })
    expect(start.mock.calls[0]![2]).toEqual({ express: true })

    // An email the shopper did type travels with the payment.
    el.form = { ...el.form, email: 'kari@example.no' }
    await renderCycles(el)
    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls[1]![1]).toMatchObject({ email: 'kari@example.no' })
  })

  it('with the email already known (typed for another method), one click still starts Vipps', async () => {
    vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(true)
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/x' })
    const el = await openWith(['Stripe', 'Vipps'], { email: 'kari@example.no' })
    // Method first: no delivery form before a method is chosen.
    expect(shadowText(el)).not.toContain('Leveringsadresse')

    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('a cart Express cannot serve (several suppliers) pays plain: the backend says no, the second call follows', async () => {
    vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(true)
    const start = vi
      .spyOn(manager, 'startVippsPayment')
      .mockResolvedValueOnce({ express: false, reason: 'several suppliers' })
      .mockResolvedValueOnce({ payment_url: 'https://pay-mt.vipps.no/y' })
    const el = await openWith(['Vipps'])
    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls[0]![2]).toEqual({ express: true })
    expect(start.mock.calls[1]![2]).toBeUndefined()
  })

  it('with Express switched off for the channel, the checkout asks for the plain payment straight away', async () => {
    vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(false)
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://pay-mt.vipps.no/z' })
    const el = await openWith(['Vipps'])
    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]![2]).toBeUndefined()
  })

  it('a start the gateway refuses shows the shopper a sentence, not the gateway text (2026-10-09)', async () => {
    vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(false)
    // A cart emptied from another tab: what QA saw, word for word.
    vi.spyOn(manager, 'startVippsPayment').mockRejectedValue(
      new Error('Payment Vipps not initialize: [vipps] amount must be a positive integer in minor units, got 0'),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const el = await openWith(['Vipps'])
    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    expect(el.paymentError).toBe('Handlekurven er tom. Legg til et produkt og prøv igjen.')
    expect(shadowText(el)).not.toContain('not initialize')
    // The raw text is still there for whoever debugs it.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Vipps'), expect.anything())
  })
})
