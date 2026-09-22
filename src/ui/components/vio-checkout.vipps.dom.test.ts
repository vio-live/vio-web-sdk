// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Vipps among other methods — the email it needs must always be askable.
 *
 * Vipps collects the address in its own flow but not the email, so the
 * checkout asks for it in a "Kontakt" section that renders only once Vipps
 * is the selected method. On 2026-09-21 Alan (QA, web and mobile) found the
 * dead end: on a channel whose methods ALL collect the address themselves
 * (Nexi + Qliro + Vipps) there is no delivery form either, and the Vipps
 * button refused to select the method until an email was typed — into a
 * field that did not exist yet.
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
  it('every method collects the address: no form, and the Vipps button still reaches an email field', async () => {
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue(undefined)
    const el = await openWith(['Nexi', 'Qliro', 'Vipps'])
    expect(shadowText(el)).not.toContain('Leveringsadresse')
    expect(emailInput(el)).toBeNull()

    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    // Vipps is selected and asks for the email — no error, no dead end.
    expect(el.checkoutState?.paymentMethod).toBe('vipps')
    expect(shadowText(el)).toContain('Kontakt')
    expect(emailInput(el)).not.toBeNull()
    expect(el.paymentError).toBeFalsy()
    expect(start).not.toHaveBeenCalled()

    // Paying without the email says so; with it, Vipps starts.
    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    expect(el.paymentError).toContain('e-postadressen')
    expect(start).not.toHaveBeenCalled()

    el.form = { ...el.form, email: 'kari@example.no' }
    await renderCycles(el)
    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]![1]).toMatchObject({ email: 'kari@example.no' })
  })

  it('with the delivery form on screen and the email typed, one click still starts Vipps', async () => {
    const start = vi.spyOn(manager, 'startVippsPayment').mockResolvedValue(undefined)
    const el = await openWith(['Klarna', 'Vipps'], { email: 'kari@example.no' })
    expect(shadowText(el)).toContain('Leveringsadresse')

    methodButton(el, 'vipps')!.click()
    await renderCycles(el)
    expect(start).toHaveBeenCalledTimes(1)
  })
})
