// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * The receipt after Vipps (Alan, QA, 2026-11-04, SDK 0.37.7 on Vev 0.345):
 * after paying with Stripe the «Takk!» lists the order — lines, «Frakt …
 * Gratis», the total — and after paying with Vipps it listed nothing.
 * Stripe confirms on the page, with the cart still in memory; Vipps comes
 * back through a payment page, to a page that reloaded or to another tab,
 * and the receipt was built with no lines at all. It is now read from the
 * checkout of the return URL.
 *
 * Every test here lands like the phone does: a fresh page load, nothing in
 * memory, no cart in this tab.
 */

const SPONSOR = 1338
const CHECKOUT = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
const manager = Vio.checkout as any

const FREE = { id: 'free', name: 'Gratis frakt', description: '', price: { amount: 0, amount_incl_taxes: 0, currency_code: 'NOK' } }
const POSTEN = { id: 'posten', name: 'Posten', description: '', price: { amount: 39.2, amount_incl_taxes: 49, currency_code: 'NOK' } }

/** What GetCheckout answers for a checkout that was paid. */
function paidCheckout(shipping = FREE, totals = { currency_code: 'NOK', subtotal: 1797, shipping: 0, total: 1797 }) {
  return {
    id: CHECKOUT,
    status: 'SUCCESS',
    email: 'kari@example.no',
    cart: {
      cart_id: 'cart-1',
      currency: 'NOK',
      line_items: [
        {
          id: 'li-1',
          product_id: 101,
          variant_id: 11,
          brand: 'Careless',
          title: 'Genser',
          variant_title: 'M',
          quantity: 1,
          image: [{ id: 1, url: 'https://img.example/genser.jpg' }],
          price: { amount: 1038.4, amount_incl_taxes: 1298, currency_code: 'NOK' },
          shipping,
        },
        {
          id: 'li-2',
          product_id: 102,
          variant_id: null,
          brand: 'Careless',
          title: 'Lue',
          variant_title: null,
          quantity: 2,
          image: [],
          price: { amount: 199.6, amount_incl_taxes: 249.5, currency_code: 'NOK' },
          shipping,
        },
      ],
    },
    totals,
  }
}

const landOn = (method: string) =>
  window.history.replaceState(
    {},
    '',
    `/?vio_payment=success&vio_method=${method}&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}`,
  )

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  // Nothing here reaches the network: every read the receipt makes is stubbed below.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response),
  )
  Vio.init({ apiKey: 'test-key', environment: 'production' } as any)
  const proto = VioCheckout.prototype as any
  for (const m of [
    'loadAvailablePaymentMethods',
    'loadAvailableShippings',
    'refreshApplePay',
    'refreshKlarna',
    'prefillFormFromCheckout',
  ]) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue(null)
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(4512)
  vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
})

afterEach(() => {
  unmountAll()
  manager.state = null
  window.history.replaceState({}, '', '/')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function cycles(el: HTMLElement, n = 8) {
  for (let i = 0; i < n; i++) await settle(el)
}

const summary = (el: HTMLElement) => el.shadowRoot?.querySelector<HTMLElement>('.confirm-summary') ?? null
const lines = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.confirm-line') ?? [])].map((l) =>
    (l.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
const row = (el: HTMLElement, label: string) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.confirm-summary .order-row') ?? [])]
    .map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim())
    .find((t) => t.startsWith(label))

async function backFromVipps() {
  landOn('vipps')
  vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED', duplicate_of: null })
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  await cycles(el)
  return el
}

describe('the receipt after a Vipps return', () => {
  it('lists the lines — title, variant, quantity, price — «Frakt – Gratis frakt · Gratis» and the total', async () => {
    const read = vi.spyOn(manager, 'getCheckout').mockResolvedValue(paidCheckout())
    const el = await backFromVipps()

    expect(el.orderConfirmed).toBe(true)
    expect(read).toHaveBeenCalledWith(CHECKOUT, SPONSOR)
    expect(summary(el)).not.toBeNull()
    const [genser, lue] = lines(el)
    expect(genser).toContain('Careless')
    expect(genser).toContain('Genser — M')
    expect(genser).toContain('Antall: 1')
    expect(genser).toMatch(/1\s?298\s?Kr/)
    expect(lue).toContain('Lue')
    expect(lue).toContain('Antall: 2')
    expect(lue).toMatch(/499\s?Kr/)
    expect(el.shadowRoot?.querySelector<HTMLImageElement>('.confirm-thumb')?.getAttribute('src')).toBe(
      'https://img.example/genser.jpg',
    )
    expect(row(el, 'Frakt')).toBe('Frakt – Gratis frakt Gratis')
    expect(row(el, 'Totalt')).toMatch(/^Totalt\s*1\s?797\s?Kr$/)
    // Where the receipt goes, though this page never saw the form.
    expect(shadowText(el)).toMatch(/Kvittering til\s*kari@example\.no/)
    expect(shadowText(el)).toContain('#4512')
  })

  it('a paid rate: «Frakt – Posten · 49 Kr», and the total is what Vipps charged, shipping included', async () => {
    vi.spyOn(manager, 'getCheckout').mockResolvedValue(
      paidCheckout(POSTEN, { currency_code: 'NOK', subtotal: 1797, shipping: 49, total: 1846 }),
    )
    const el = await backFromVipps()

    expect(row(el, 'Frakt')).toMatch(/^Frakt – Posten 49\s?Kr$/)
    expect(row(el, 'Totalt')).toMatch(/^Totalt\s*1\s?846\s?Kr$/)
  })

  it('a checkout that cannot be read: still «Takk for bestillingen!», without lines and without an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(manager, 'getCheckout').mockRejectedValue(new Error('network'))
    const el = await backFromVipps()

    expect(el.orderConfirmed).toBe(true)
    expect(shadowText(el)).toContain('Takk for bestillingen!')
    expect(summary(el)).toBeNull()
    expect(el.paymentError).toBeFalsy()
  })

  it('an answer that lands after the drawer was closed fills nothing — the next opening is a new checkout', async () => {
    const read = deferred<any>()
    vi.spyOn(manager, 'getCheckout').mockReturnValue(read.promise)
    const el = await backFromVipps()
    expect(el.orderConfirmed).toBe(true)

    el.close()
    await cycles(el)
    read.resolve(paidCheckout())
    await cycles(el)

    expect(el.orderConfirmed).toBe(false)
    expect(el.confirmedOrder).toBeNull()
  })
})

describe('the receipt after a Stripe link return', () => {
  it('comes from the same read that found the checkout paid — no second ask', async () => {
    landOn('stripe')
    const read = vi.spyOn(manager, 'getCheckout').mockResolvedValue(paidCheckout())
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await cycles(el)

    expect(el.orderConfirmed).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
    expect(lines(el)).toHaveLength(2)
    expect(row(el, 'Frakt')).toBe('Frakt – Gratis frakt Gratis')
    expect(row(el, 'Totalt')).toMatch(/^Totalt\s*1\s?797\s?Kr$/)
  })
})

describe('the receipt after an Adyen redirect (Vipps inside Adyen)', () => {
  it('lists the lines from the checkout; the total stays the one Adyen reported', async () => {
    window.history.replaceState(
      {},
      '',
      `/?vio_payment=return&vio_method=adyen&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}&sessionId=CS1&redirectResult=RR`,
    )
    vi.spyOn(manager, 'getAdyenPayment').mockResolvedValue({
      order_id: 'CS1',
      status: 'authorised',
      psp_reference: 'PSP-1',
      payment_method: 'vipps',
      total_price: 1846,
      purchase_currency: 'NOK',
      order_created: true,
    })
    // A checkout total that disagrees, to tell which one the receipt prints.
    vi.spyOn(manager, 'getCheckout').mockResolvedValue(
      paidCheckout(POSTEN, { currency_code: 'NOK', subtotal: 1797, shipping: 49, total: 9999 }),
    )
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await cycles(el)

    expect(el.orderConfirmed).toBe(true)
    expect(lines(el)).toHaveLength(2)
    expect(row(el, 'Frakt')).toMatch(/^Frakt – Posten 49\s?Kr$/)
    expect(row(el, 'Totalt')).toMatch(/^Totalt\s*1\s?846\s?Kr$/)
    expect(shadowText(el)).toContain('PSP-1')
  })
})
