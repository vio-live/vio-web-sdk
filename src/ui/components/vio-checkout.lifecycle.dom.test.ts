// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * The checkout's lifecycle: opening, and leaving the page.
 *
 * Three defects found while writing the method-first tests (2026-09-22):
 *
 * - removing the checkout unmounted Klarna, Nexi and Adyen, and the update
 *   that teardown caused mounted them again on the detached element — a new
 *   payment session for a checkout nobody could see;
 * - a Klarna mount that failed at once retried forever: every attempt reset
 *   the category list to a fresh (equal but new) array, which Lit counts as a
 *   change, which scheduled the next attempt;
 * - with a single method, the list answering after the checkout opened (the
 *   usual order on a first opening) left that method unselected: the opening
 *   had already spent the one auto-select attempt, before there was a list.
 */
const SPONSOR = 5
const manager = Vio.checkout as any

const FULL_FORM = {
  firstName: 'Kari', lastName: 'Nordmann', email: 'kari@example.no',
  address: 'Storgata 12B', postalCode: '0194', city: 'Oslo',
}

const klarnaHandle = () => ({
  categories: [], selected: 'pay_now', shippings: [], unmount: () => {}, authorize: async () => {},
})

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

const button = (el: HTMLElement, label: string) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.payment-btn') ?? [])].find((b) =>
    (b.textContent ?? '').toLowerCase().includes(label),
  )

/** The form complete, then Klarna chosen: the point where its session is created. */
async function klarnaReady() {
  const el = await openWith(['Klarna', 'Qliro'], { klarnaAvailable: true, form: { ...FULL_FORM } })
  button(el, 'klarna')!.click()
  await renderCycles(el)
  return el
}

describe('a checkout taken out of the page', () => {
  it('creates no new Klarna session once removed, and mounts again when put back', async () => {
    const mountKlarna = vi.spyOn(manager, 'mountKlarnaPayments').mockImplementation(async () => klarnaHandle())
    const el = await klarnaReady()
    expect(mountKlarna).toHaveBeenCalledTimes(1)

    el.remove()
    await renderCycles(el)
    expect(mountKlarna).toHaveBeenCalledTimes(1)

    document.body.appendChild(el)
    await renderCycles(el)
    expect(mountKlarna).toHaveBeenCalledTimes(2)
  })

  it('does not re-create an embedded widget (Nexi) behind a removed checkout', async () => {
    manager.mountNexiCheckout.mockImplementation(async (...args: unknown[]) => {
      ;(args[0] as HTMLElement).innerHTML = '<div class="widget"></div>'
      // The widget reports the rates for a typed address: state the teardown
      // clears, so removing the checkout causes an update.
      ;(args[2] as any).onShipping({ ok: true, shipping_id: 's1', options: [{ id: 's1', name: 'Posten', price: 99 }] })
      return { order_id: 'O1', html_snippet: '<div></div>', total_price: 5198 }
    })
    const el = await openWith(['Nexi', 'Qliro'])
    button(el, 'nexi')!.click()
    await renderCycles(el)
    expect(manager.mountNexiCheckout).toHaveBeenCalledTimes(1)

    el.remove()
    await renderCycles(el)
    expect(manager.mountNexiCheckout).toHaveBeenCalledTimes(1)
  })
})

describe('a Klarna mount that fails straight away', () => {
  it('is not retried in a loop', async () => {
    let calls = 0
    vi.spyOn(manager, 'mountKlarnaPayments').mockImplementation(() => {
      calls++
      // Past a handful, stop answering: a regression then fails this test
      // instead of spinning the worker forever.
      return calls > 20 ? new Promise(() => {}) : Promise.reject(new Error('no session'))
    })
    const el = await klarnaReady()
    await renderCycles(el, 10)
    expect(el.paymentError).toContain('Kunne ikke laste Klarna')
    expect(calls).toBeLessThanOrEqual(2)
  })
})

describe('the method list answering after the checkout opened', () => {
  it('still selects a sole method', async () => {
    // openWith resolves the list only after show(), as a first opening does.
    const el = await openWith(['Nexi'])
    expect(el.checkoutState?.paymentMethod).toBe('nexi')
  })
})
