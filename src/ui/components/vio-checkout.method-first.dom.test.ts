// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * The checkout asks for the payment method FIRST (Angelo, 2026-09-22).
 *
 * Until then our delivery form came first whenever one offered method needed
 * it, and a shopper who then chose Nexi, Qliro, Kustom or Walley typed it all
 * again inside the provider's widget (Alan, QA 2026-09-21). Now:
 *
 * - several methods: the list first; our form appears only once a method
 *   that needs it (Klarna, Adyen, Stripe, Apple Pay) is chosen, and choosing
 *   it never fails for an empty form — the form is where it leads;
 * - one method: no choice to make — it is selected on opening, so the form
 *   (or the provider's widget) comes straight up. Stripe included;
 * - Klarna, which can now be chosen before the form is filled, still creates
 *   its session only once the form is complete.
 */
const SPONSOR = 5
const manager = Vio.checkout as any

const FULL_FORM = {
  firstName: 'Kari', lastName: 'Nordmann', email: 'kari@example.no',
  address: 'Storgata 12B', postalCode: '0194', city: 'Oslo',
}

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
  // Embedded widgets: a mount that fills its container, no network.
  for (const m of ['mountQliroCheckout', 'mountNexiCheckout']) {
    vi.spyOn(manager, m).mockImplementation(async (...args: unknown[]) => {
      ;(args[0] as HTMLElement).innerHTML = '<div class="widget"></div>'
      return { order_id: 'O1', html_snippet: '<div></div>', total_price: 5198 }
    })
  }
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

/** Opens the checkout the way a shopper does: the list resolves after opening. */
async function openWith(methods: string[], extra: Record<string, unknown> = {}) {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  el.show()
  await renderCycles(el)
  Object.assign(el, extra)
  el.availableMethods = methods
  el.paymentMethodsResolved = true
  el.autoSelectSoleMethod()
  await renderCycles(el)
  return el
}

/** A method or pay button by its label — text, or a logo's alt (Stripe's is only a logo). */
const button = (el: HTMLElement, label: string) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.payment-btn') ?? [])].find((b) =>
    [b.textContent ?? '', ...[...b.querySelectorAll('img')].map((i) => i.alt)]
      .join(' ')
      .toLowerCase()
      .includes(label),
  )
const endre = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => (b.textContent ?? '').trim() === 'Endre',
  )

describe('several methods: the method first', () => {
  it('shows the list and no form; a method that needs the form brings it — without an error', async () => {
    const el = await openWith(['Stripe', 'Qliro'])
    expect(shadowText(el)).toContain('Velg betalingsmåte')
    expect(shadowText(el)).not.toContain('Leveringsadresse')

    button(el, 'stripe')!.click()
    await renderCycles(el)
    expect(el.checkoutState?.paymentMethod).toBe('stripe')
    expect(shadowText(el)).toContain('Leveringsadresse')
    expect(el.paymentError).toBeFalsy()
    // The pay button waits for the form.
    expect(button(el, 'med stripe')?.disabled).toBe(true)
  })

  it('an embedded method never shows our form — the provider asks once', async () => {
    const el = await openWith(['Stripe', 'Qliro'])
    button(el, 'qliro')!.click()
    await renderCycles(el)
    expect(el.checkoutState?.paymentMethod).toBe('qliro')
    expect(shadowText(el)).not.toContain('Leveringsadresse')
    expect(manager.mountQliroCheckout).toHaveBeenCalledTimes(1)
  })

  it('"Endre" goes back to the list, and what was typed is still there for the next method', async () => {
    const el = await openWith(['Stripe', 'Adyen', 'Qliro'])
    button(el, 'stripe')!.click()
    await renderCycles(el)
    el.form = { ...FULL_FORM }
    await renderCycles(el)

    endre(el)!.click()
    await renderCycles(el)
    expect(el.checkoutState?.paymentMethod).toBeFalsy()
    expect(shadowText(el)).not.toContain('Leveringsadresse')

    button(el, 'kort')!.click() // Adyen: "Kort, Vipps og flere"
    await renderCycles(el)
    expect(el.checkoutState?.paymentMethod).toBe('adyen')
    const firstName = el.shadowRoot?.querySelector<HTMLInputElement>('input[autocomplete="given-name"]')
    expect(firstName?.value).toBe('Kari')
  })
})

describe('one method: the choice is skipped', () => {
  it('a form method (Stripe) opens straight on the form and its pay button', async () => {
    const el = await openWith(['Stripe'])
    expect(el.checkoutState?.paymentMethod).toBe('stripe')
    expect(shadowText(el)).not.toContain('Velg betalingsmåte')
    expect(shadowText(el)).toContain('Leveringsadresse')
    expect(button(el, 'med stripe')).toBeTruthy()
  })

  it('an embedded method (Nexi) opens straight on its widget, without our form', async () => {
    const el = await openWith(['Nexi'])
    expect(el.checkoutState?.paymentMethod).toBe('nexi')
    expect(shadowText(el)).not.toContain('Velg betalingsmåte')
    expect(shadowText(el)).not.toContain('Leveringsadresse')
  })

  it('a sole Klarna whose script answers late is still selected when it does', async () => {
    const el = await openWith(['Klarna'])
    expect(el.checkoutState?.paymentMethod).toBeFalsy()
    el.klarnaAvailable = true
    await renderCycles(el)
    expect(el.checkoutState?.paymentMethod).toBe('klarna')
  })
})

describe('Klarna waits for the form', () => {
  it('chosen with an empty form: no Klarna session; complete form: the session is created', async () => {
    const mountKlarna = vi.spyOn(manager, 'mountKlarnaPayments').mockResolvedValue({
      categories: [], selected: 'pay_now', shippings: [], unmount: () => {}, authorize: async () => {},
    })
    const el = await openWith(['Klarna', 'Qliro'], { klarnaAvailable: true })
    button(el, 'klarna')!.click()
    await renderCycles(el)
    expect(el.checkoutState?.paymentMethod).toBe('klarna')
    expect(shadowText(el)).toContain('Leveringsadresse')
    expect(mountKlarna).not.toHaveBeenCalled()

    el.form = { ...FULL_FORM }
    await renderCycles(el)
    expect(mountKlarna).toHaveBeenCalledTimes(1)
  })
})
