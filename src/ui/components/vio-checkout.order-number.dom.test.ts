// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'
import { resetBuyerRefSupport, withBuyerRef } from '../../core/api/cart-queries.js'

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
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 1, buyerRef: null }) // settled, no reference
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null) // the receipt's number: each test says
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
  resetBuyerRefSupport()
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
      await settle(el) // the event follows the (mocked) buyer-reference ask
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
      await settle(el)
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
      await settle(el)
    } finally {
      off()
    }
    expect(seen[0]).toMatchObject({ method: 'kustom', sponsorId: SPONSOR, checkoutId: CHECKOUT })
  })
})

describe('the buyer reference in vio:payment-success (analytics buyer_id)', () => {
  const listen = () => {
    const seen: any[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    document.addEventListener('vio:payment-success', on)
    return { seen, off: () => document.removeEventListener('vio:payment-success', on) }
  }

  it('an emitter without one asks the checkout once and the event carries it; the cart is cleared after the event', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null) // the receipt's own ask, apart
    const ask = vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 4499, buyerRef: 'brf_7f3a9c' })
    const cleared = vi.mocked(Vio.cart.clearSponsorCart)
    cleared.mockClear()
    const { seen, off } = listen()
    try {
      el.confirmOrder('stripe', SPONSOR, { chargedTotal: 5198 })
      expect(cleared).not.toHaveBeenCalled() // not before the event
      await settle(el)
    } finally {
      off()
    }
    expect(ask).toHaveBeenCalledWith(CHECKOUT, SPONSOR)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'stripe', sponsorId: SPONSOR, checkoutId: CHECKOUT, buyerRef: 'brf_7f3a9c' })
    expect(cleared).toHaveBeenCalledWith(SPONSOR)
  })

  it('a slow answer does not hold the event: after 2.5 s it fires without the reference', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    await settle(el)
    vi.useFakeTimers() // after the mount: `settle` itself needs real timers
    vi.spyOn(manager, 'getOrderReference').mockReturnValue(new Promise(() => {}))
    const { seen, off } = listen()
    try {
      el.showProviderReceipt('qliro', SPONSOR, { orderId: 'Q-1' })
      await vi.advanceTimersByTimeAsync(2_400)
      expect(seen).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(200)
    } finally {
      off()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toHaveProperty('buyerRef')
    expect(seen[0]).toMatchObject({ method: 'qliro', checkoutId: CHECKOUT })
  })

  it('W1: a rejected ask does not hold the event: after the 1.2 s retry it fires without the reference and clears the cart', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    await settle(el)
    vi.useFakeTimers()
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
    const ask = vi.spyOn(manager, 'getOrderReference').mockRejectedValue(new Error('network'))
    const cleared = vi.mocked(Vio.cart.clearSponsorCart)
    cleared.mockClear()
    const { seen, off } = listen()
    try {
      el.confirmOrder('stripe', SPONSOR, { chargedTotal: 10 })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(seen).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(200)
    } finally {
      off()
    }
    expect(ask).toHaveBeenCalledTimes(2)
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toHaveProperty('buyerRef')
    expect(cleared).toHaveBeenCalledWith(SPONSOR)
  })

  it('W1c: the second ask at 1.2 s catches a reference the webhook wrote after the redirect', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    await settle(el)
    vi.useFakeTimers()
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
    const ask = vi
      .spyOn(manager, 'getOrderReference')
      .mockResolvedValueOnce({ orderNumber: null, buyerRef: null })
      .mockResolvedValueOnce({ orderNumber: 4499, buyerRef: 'brf_late' })
    const { seen, off } = listen()
    try {
      el.confirmOrder('stripe', SPONSOR, { chargedTotal: 10 })
      await vi.advanceTimersByTimeAsync(1_100)
      expect(seen).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(200)
    } finally {
      off()
    }
    expect(ask).toHaveBeenCalledTimes(2)
    expect(seen[0]).toMatchObject({ buyerRef: 'brf_late' })
  })

  it('W1a: the page hiding settles the event at once, without the reference, and the cart is cleared; the late answer and the timer add nothing', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    await settle(el)
    vi.useFakeTimers()
    let answer!: (v: unknown) => void
    vi.spyOn(manager, 'getOrderReference').mockReturnValue(new Promise((r) => { answer = r }))
    const cleared = vi.mocked(Vio.cart.clearSponsorCart)
    cleared.mockClear()
    const { seen, off } = listen()
    try {
      el.showProviderReceipt('qliro', SPONSOR, { orderId: 'Q-1' })
      await vi.advanceTimersByTimeAsync(100)
      expect(seen).toHaveLength(0)
      window.dispatchEvent(new Event('pagehide'))
      expect(seen).toHaveLength(1) // synchronously, inside the pagehide handler
      expect(seen[0]).not.toHaveProperty('buyerRef')
      expect(cleared).toHaveBeenCalledWith(SPONSOR)
      answer({ orderNumber: 1, buyerRef: 'brf_too_late' })
      await vi.advanceTimersByTimeAsync(3_000)
    } finally {
      off()
    }
    expect(seen).toHaveLength(1)
  })

  it('W1a: visibilitychange → hidden settles it the same way', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    await settle(el)
    vi.useFakeTimers()
    vi.spyOn(manager, 'getOrderReference').mockReturnValue(new Promise(() => {}))
    const { seen, off } = listen()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    try {
      el.showProviderReceipt('walley', SPONSOR, { orderId: 'W-1' })
      document.dispatchEvent(new Event('visibilitychange'))
      expect(seen).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(seen).toHaveLength(1)
    } finally {
      off()
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    }
  })

  it('W1a: removing the element while it waits fires the event at once — on the element and, detached, on the window', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    await settle(el)
    vi.spyOn(manager, 'getOrderReference').mockReturnValue(new Promise(() => {}))
    const onWindow: unknown[] = []
    const listener = (e: Event) => onWindow.push((e as CustomEvent).detail)
    window.addEventListener('vio:payment-success', listener)
    const onElement: unknown[] = []
    el.addEventListener('vio:payment-success', (e: Event) => onElement.push((e as CustomEvent).detail))
    try {
      el.showProviderReceipt('qliro', SPONSOR, { orderId: 'Q-2' })
      await settle(el)
      expect(onElement).toHaveLength(0)
      el.remove()
      expect(onElement).toHaveLength(1)
      expect(onWindow).toHaveLength(1)
      expect(onWindow[0]).toMatchObject({ method: 'qliro', checkoutId: CHECKOUT })
    } finally {
      window.removeEventListener('vio:payment-success', listener)
    }
  })

  it('W1b: once the gateway refused buyer_ref on this page load, nothing is asked and the event is immediate', async () => {
    await withBuyerRef(async (withRef) => {
      if (withRef) throw Object.assign(new Error('Cannot query field "buyer_ref" on type "X".'), { graphql: { hasData: false, errors: [] } })
      return null
    })
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
    const ask = vi.spyOn(manager, 'getOrderReference')
    const { seen, off } = listen()
    try {
      el.confirmOrder('stripe', SPONSOR, { chargedTotal: 10 })
      await Promise.resolve()
    } finally {
      off()
    }
    expect(ask).not.toHaveBeenCalled()
    expect(seen).toHaveLength(1)
  })

  it('a result that already carries it (Apple Pay / Klarna native) is sent at once, without asking', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.state = { sponsorId: SPONSOR, subtotal: 4999, currency: 'NOK', checkoutId: CHECKOUT }
    manager.emit()
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null) // fillOrderNumber goes through getOrderNumber
    const ask = vi.spyOn(manager, 'getOrderReference')
    const { seen, off } = listen()
    try {
      el.confirmOrder('klarna', SPONSOR, { order: { orderId: 'K-1' }, buyerRef: 'brf_klarna' })
      await settle(el)
    } finally {
      off()
    }
    expect(ask).not.toHaveBeenCalled()
    expect(seen[0]).toMatchObject({ method: 'klarna', buyerRef: 'brf_klarna' })
  })
})
