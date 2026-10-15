// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Back from paying (Angelo, QA on a phone, 2026-10-08):
 *
 *  - while we asked Vipps whether it was paid — up to two minutes — the
 *    drawer showed the whole checkout behind a one-line notice: a form to
 *    type into and a "Betal" to press, for a purchase that may be paid;
 *  - the receipt's "Ordrenummer" was the checkout's uuid. The order is
 *    #4497 in the dashboard; the uuid is no order number at all.
 */

const SPONSOR = 5
const CHECKOUT = '0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d'
const manager = Vio.checkout as any

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const landOn = (search: string) => window.history.replaceState({}, '', `/${search}`)
const vippsReturn = `?vio_payment=success&vio_method=vipps&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}`

async function renderCycles(el: HTMLElement, n = 5) {
  for (let i = 0; i < n; i++) await settle(el)
}

const q = (el: HTMLElement, sel: string) => el.shadowRoot?.querySelector(sel) ?? null

beforeEach(() => {
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'loadAvailableShippings', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
  vi.spyOn(Vio.cart, 'clearSponsorCart').mockImplementation(() => {})
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], subtotal: 4999, currency: 'NOK' }
    manager.emit()
    return manager.state
  })
})

afterEach(() => {
  unmountAll()
  manager.state = null
  window.history.replaceState({}, '', '/')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('while the payment is being confirmed', () => {
  it('Vipps: only the confirming view — no form, no method buttons, no "Betal"', async () => {
    landOn(vippsReturn)
    const status = deferred<any>()
    vi.spyOn(manager, 'getVippsStatus').mockReturnValue(status.promise)
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(4497)

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)

    expect(q(el, '.verifying')).not.toBeNull()
    expect(shadowText(el)).toContain('Bekrefter betalingen med Vipps')
    expect(q(el, 'input')).toBeNull()
    expect(q(el, '.payment-btn')).toBeNull()
    expect(shadowText(el)).not.toContain('Leveringsadresse')

    status.resolve({ state: 'AUTHORIZED' })
    await renderCycles(el)
    expect(q(el, '.verifying')).toBeNull()
    expect(shadowText(el)).toContain('Takk')
  })

  it('the redirect methods too (Stripe): the confirming view, not the checkout', async () => {
    landOn(`?vio_payment=success&vio_method=stripe&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}`)
    const read = deferred<any>()
    vi.spyOn(manager, 'getCheckout').mockReturnValue(read.promise)
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(4498)

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(q(el, '.verifying')).not.toBeNull()
    expect(q(el, '.payment-btn')).toBeNull()

    read.resolve({ status: 'SUCCESS' })
    await renderCycles(el)
    expect(q(el, '.verifying')).toBeNull()
    expect(shadowText(el)).toContain('#4498')
  })

  it('a payment that failed leaves the confirming view for the error', async () => {
    landOn(vippsReturn)
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'ABORTED' })
    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(q(el, '.verifying')).toBeNull()
    expect(shadowText(el)).toContain('avbrutt')
  })

  it('a duplicate — the cart was paid in another tab — says "already paid", not "failed"', async () => {
    landOn(vippsReturn)
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'ERROR', duplicate_of: 'the-other-checkout' })
    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(q(el, '.verifying')).toBeNull()
    expect(shadowText(el)).toContain('allerede betalt')
    expect(shadowText(el)).not.toContain('avbrutt')
  })

  it('the same on a generic return (Stripe): GetCheckout says duplicate_of', async () => {
    landOn(`?vio_payment=success&vio_method=stripe&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}`)
    vi.spyOn(manager, 'getCheckout').mockResolvedValue({ status: 'cancel', duplicate_of: 'the-other-checkout' })
    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(shadowText(el)).toContain('allerede betalt')
    expect(shadowText(el)).not.toContain('avbrutt')
  })
})

describe('the order number on the receipt', () => {
  it('is the Vio order, #4497 — never the checkout uuid', async () => {
    landOn(vippsReturn)
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED' })
    const ask = vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(4497)

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el, 8)

    expect(ask).toHaveBeenCalledWith(CHECKOUT, SPONSOR)
    expect(shadowText(el)).toContain('Ordrenummer')
    expect(shadowText(el)).toContain('#4497')
    expect(shadowText(el)).not.toContain(CHECKOUT)
  })

  it('arrives when the order is born, a moment after the payment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    landOn(vippsReturn)
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED' })
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValueOnce(null).mockResolvedValue(4497)

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el, 8)
    expect(shadowText(el)).toContain('Takk')
    expect(shadowText(el)).not.toContain('Ordrenummer')

    await vi.advanceTimersByTimeAsync(1600)
    await renderCycles(el)
    expect(shadowText(el)).toContain('#4497')
  })

  it('while there is none, the line is simply not there', async () => {
    landOn(vippsReturn)
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED' })
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el, 8)
    expect(shadowText(el)).toContain('Takk')
    expect(shadowText(el)).not.toContain('Ordrenummer')
    expect(shadowText(el)).not.toContain(CHECKOUT)
  })

  it('the event for analytics keeps its id as before', async () => {
    landOn(vippsReturn)
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED' })
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(4497)
    const seen: any[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    document.addEventListener('vio:payment-success', on)
    try {
      const el = await mount<HTMLElement>('vio-checkout')
      await renderCycles(el, 8)
    } finally {
      document.removeEventListener('vio:payment-success', on)
    }
    expect(seen[0]).toMatchObject({ method: 'vipps', sponsorId: SPONSOR, orderId: CHECKOUT })
  })

  it("a provider's own order id is the provider's reference, under its name", async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(4499)
    el.confirmOrder('qliro', SPONSOR, { order: { orderId: '3361254' }, chargedTotal: 5198 })
    await renderCycles(el, 8)
    expect(shadowText(el)).toContain('Ordre hos Qliro')
    expect(shadowText(el)).toContain('3361254')
    expect(shadowText(el)).toContain('#4499')
  })
})

describe('the checkout id for analytics', () => {
  const listen = () => {
    const seen: any[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    document.addEventListener('vio:payment-success', on)
    return { seen, off: () => document.removeEventListener('vio:payment-success', on) }
  }

  it('confirmOrder emits the checkout id of the state in the detail', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(4499)
    const { seen, off } = listen()
    try {
      el.confirmOrder('qliro', SPONSOR, { order: { orderId: '3361254' }, chargedTotal: 5198 })
    } finally {
      off()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'qliro', sponsorId: SPONSOR, checkoutId: CHECKOUT })
    expect(seen[0].result).toEqual({ order: { orderId: '3361254' }, chargedTotal: 5198 })
  })

  it('back from a redirect the state has no checkout id: the one from the URL is passed in', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK' } // re-opened, no checkout
    manager.emit()
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
    const { seen, off } = listen()
    try {
      el.confirmOrder('qliro', SPONSOR, { order: { orderId: '3361254' } }, CHECKOUT)
      el.showProviderReceipt('walley', SPONSOR, { orderId: 'W-9' }, CHECKOUT)
    } finally {
      off()
    }
    expect(seen.map((d) => d.checkoutId)).toEqual([CHECKOUT, CHECKOUT])
    expect(seen[1]).toMatchObject({ method: 'walley', sponsorId: SPONSOR, result: { orderId: 'W-9' } })
  })

  it("showProviderReceipt falls back to the state's checkout id when none is passed", async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    const { seen, off } = listen()
    try {
      el.showProviderReceipt('kustom', SPONSOR, { order_id: 'K-1', checkout_id: 'K-CHK' })
    } finally {
      off()
    }
    expect(seen[0]).toMatchObject({ method: 'kustom', sponsorId: SPONSOR, checkoutId: CHECKOUT })
  })
})
