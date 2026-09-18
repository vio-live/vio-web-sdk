// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Kustom in the checkout: the widget does everything, in the light DOM.
 *
 * - the snippet is injected into a LIGHT-DOM container projected through a
 *   slot (Kustom's bootstrap resolves its mount point from the document);
 * - a cart change under a mounted widget UPDATES the same order — never a
 *   second order, never a widget showing a stale total;
 * - closing takes it down and disarms its listeners (the 2026-09-14 defect);
 * - what the widget reports (total, chosen rate) is what our summary shows;
 * - the return from Kustom renders KUSTOM's receipt in the receipt view that
 *   survives the cart being cleared (the 2026-09-08 Qliro defect), and never
 *   mounts a new widget; a refused purchase is a notice, not a receipt.
 */
const SPONSOR = 5
const manager = Vio.checkout as any
let sessionSeq = 0

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
  vi.spyOn(Vio.cart, 'clearSponsorCart').mockImplementation(() => {})
  vi.spyOn(manager, 'destroyKustomListeners').mockImplementation(() => {})
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], session: ++sessionSeq, subtotal: 4999, currency: 'NOK', checkoutId: 'CHK-1' }
    manager.emit()
    return manager.state
  })
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  unmountAll()
  manager.state = null
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

async function renderCycles(el: HTMLElement, n = 6) {
  for (let i = 0; i < n; i++) await settle(el)
}

const ORDER = {
  order_id: 'KCO-1',
  status: 'checkout_incomplete',
  html_snippet: '<div id="klarna-checkout-container"><p>widget</p></div>',
  checkout_id: 'CHK-1',
  total_price: 5198,
  shipping_name: 'Standard',
  shipping_price: 199,
  order_created: false,
}

/** A mount that behaves like the real one: the snippet fills the container. */
function spyMount(capture?: (handlers: any) => void) {
  return vi.spyOn(manager, 'mountKustomCheckout').mockImplementation(async (...args: unknown[]) => {
    ;(args[0] as HTMLElement).innerHTML = ORDER.html_snippet
    capture?.(args[2])
    return { ...ORDER }
  })
}

async function openWithKustom() {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  manager.selectPaymentMethod('kustom')
  el.show()
  await renderCycles(el)
  return el
}

const lightContainer = (el: HTMLElement) => el.querySelector<HTMLElement>('#vio-kustom-checkout-container')

describe('Kustom in <vio-checkout>', () => {
  it('mounts the snippet into a light-DOM container projected through the vio-kustom slot', async () => {
    const mountSpy = spyMount()
    const el = await openWithKustom()
    expect(mountSpy).toHaveBeenCalledTimes(1)
    const container = lightContainer(el)
    expect(container).not.toBeNull()
    expect(container!.getAttribute('slot')).toBe('vio-kustom')
    expect(container!.parentElement).toBe(el)
    expect(container!.querySelector('#klarna-checkout-container')).not.toBeNull()
    expect(el.shadowRoot?.querySelector('slot[name="vio-kustom"]')).not.toBeNull()
    // No delivery form of ours: the widget collects it.
    expect(shadowText(el)).not.toContain('Leveringsadresse')
  })

  it('shows the total and the rate the widget reports, never its own guess', async () => {
    let handlers: any
    spyMount((h) => (handlers = h))
    const el = await openWithKustom()
    expect(el.kustomShipping).toEqual({ name: 'Standard', price: 199 })
    expect(el.shippingMajor()).toBe(199)
    handlers.onShippingOptionChange({ id: 'pickup', name: 'Hent i butikk', price: 0 })
    handlers.onOrderTotalChange(499900)
    await renderCycles(el)
    expect(el.kustomShipping).toEqual({ name: 'Hent i butikk', price: 0 })
    expect(el.shippingMajor()).toBe(0)
    expect(el.kustomTotal).toBe(4999)
    handlers.onCannotComplete()
    await renderCycles(el)
    expect(shadowText(el)).toContain('Velg en annen betalingsmåte')
  })

  it('a cart change under the widget updates the SAME order: suspend → sync → resume, no second mount', async () => {
    const mountSpy = spyMount()
    const sync = vi.spyOn(manager, 'syncKustomOrder').mockResolvedValue({ ...ORDER, total_price: 10397 })
    const el = await openWithKustom()
    expect(mountSpy).toHaveBeenCalledTimes(1)

    el.items = [{ productId: 1, variantId: 9, quantity: 2 }]
    await renderCycles(el)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(mountSpy).toHaveBeenCalledTimes(1)
    expect(el.kustomTotal).toBe(10397)
    expect(lightContainer(el)?.querySelector('#klarna-checkout-container')).not.toBeNull()

    // The same cart again is not a change.
    el.items = [{ productId: 1, variantId: 9, quantity: 2 }]
    await renderCycles(el)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('a failed sync takes the stale widget down and asks the backend for the order again', async () => {
    const mountSpy = spyMount()
    vi.spyOn(manager, 'syncKustomOrder').mockRejectedValue(new Error('network'))
    const el = await openWithKustom()
    expect(mountSpy).toHaveBeenCalledTimes(1)
    el.items = [{ productId: 1, variantId: 9, quantity: 3 }]
    await renderCycles(el)
    // Never a widget showing a total the backend will not charge: the mount
    // that follows updates the same open order with the cart as it now is.
    expect(mountSpy).toHaveBeenCalledTimes(2)
    expect(lightContainer(el)?.querySelector('#klarna-checkout-container')).not.toBeNull()
    expect(el.kustomMountedKey).toBe(JSON.stringify([[[1, 9, 3]], 4999]))
  })

  it('closing takes the widget down and disarms its listeners; reopening asks the backend again', async () => {
    const mountSpy = spyMount()
    const el = await openWithKustom()
    expect(lightContainer(el)).not.toBeNull()

    el.close()
    await renderCycles(el)
    expect(lightContainer(el)).toBeNull()
    expect(manager.destroyKustomListeners).toHaveBeenCalled()

    manager.open(SPONSOR)
    manager.selectPaymentMethod('kustom')
    el.show()
    await renderCycles(el)
    // The backend updates the same open order — the browser just asks again.
    expect(mountSpy).toHaveBeenCalledTimes(2)
  })
})

describe('returning from Kustom', () => {
  it('a paid order shows KUSTOM\'s receipt in the receipt view, clears the cart, mounts nothing, cleans the URL first', async () => {
    window.history.replaceState({}, '', '/?utm=x&order_id=KCO-1&payment_processor=KUSTOM&checkout_id=CHK-1')
    const mountSpy = spyMount()
    let urlWhenRead = ''
    vi.spyOn(manager, 'getKustomOrder').mockImplementation(async () => {
      urlWhenRead = window.location.search
      return { ...ORDER, status: 'checkout_complete', html_snippet: '<div id="klarna-checkout-container"><p>receipt</p></div>', order_created: true, reference: 'K123' }
    })
    vi.spyOn(manager, 'renderKustomSnippet').mockImplementation((c: any, h: any) => {
      c.innerHTML = h
    })

    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    expect(urlWhenRead).toBe('?utm=x')
    expect(window.location.search).toBe('?utm=x')
    expect(mountSpy).not.toHaveBeenCalled()
    expect(el.providerReceipt).toBe('kustom')
    expect(el.shadowRoot?.querySelector('.provider-receipt slot[name="vio-kustom"]')).not.toBeNull()
    expect(lightContainer(el)?.textContent).toContain('receipt')
    expect(Vio.cart.clearSponsorCart).toHaveBeenCalledWith(SPONSOR)
    // A second purchase cannot start from the receipt.
    expect(el.mayStartEmbeddedPayment()).toBe(false)
  })

  it('sent back but not paid: no receipt, no new order, "could not verify"', async () => {
    window.history.replaceState({}, '', '/?order_id=KCO-1&payment_processor=KUSTOM')
    const mountSpy = spyMount()
    vi.spyOn(manager, 'getKustomOrder').mockResolvedValue({ ...ORDER, status: 'checkout_incomplete' })
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()
    expect(el.providerReceipt).toBeNull()
    expect(Vio.cart.clearSponsorCart).not.toHaveBeenCalled()
    expect(el.paymentError).toBe((VioCheckout as any).RETURN_UNVERIFIED_MESSAGE)
  })

  it('a purchase our validation refused is a notice — and the URL is cleaned', async () => {
    window.history.replaceState({}, '', '/?vio_payment=rejected&vio_method=kustom&checkout_id=CHK-1')
    const mountSpy = spyMount()
    const read = vi.spyOn(manager, 'getKustomOrder')
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    expect(window.location.search).toBe('')
    expect(read).not.toHaveBeenCalled()
    expect(mountSpy).not.toHaveBeenCalled()
    expect(el.kustomNotice).toContain('Bestillingen ble endret')
  })
})
