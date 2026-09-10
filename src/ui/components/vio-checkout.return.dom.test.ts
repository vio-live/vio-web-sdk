// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Coming back from an embedded checkout's confirmation page must never start
 * a new payment.
 *
 * The return handler selects the method (so the panel has something to show)
 * and THEN awaits the provider to learn whether the order was paid. Selecting
 * the method is a state change; the re-render it triggers calls
 * `mount<Method>IfNeeded()`, which — with no order mounted in this fresh page
 * load — creates a new backend checkout and a new provider order for a cart
 * that was just paid for.
 */

const SPONSOR = 5

/** A promise we resolve by hand: the network call is "still in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const manager = Vio.checkout as any

function landOn(search: string) {
  window.history.replaceState({}, '', `/${search}`)
}

beforeEach(() => {
  // Everything the component fires at the backend on a state change.
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'loadAvailableShippings', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
  vi.spyOn(Vio.cart, 'clearSponsorCart').mockImplementation(() => {})
  // A fresh page load after the redirect: open() yields a state WITHOUT a
  // checkoutId, exactly like the real one does.
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
  vi.restoreAllMocks()
})

/**
 * A mount that behaves like the real one: it fills the container. A mock that
 * leaves it empty makes the component's "already mounted" guard fail forever
 * and it remounts on every render — a loop of the test's own making.
 */
async function fakeMount(...args: unknown[]) {
  const container = args[0] as HTMLElement
  container.innerHTML = '<iframe></iframe>'
  return { order_id: 'NEW-ORDER', html_snippet: '<iframe></iframe>' }
}

/** Let Lit render and its `updated()` hooks run a few times over. */
async function renderCycles(el: HTMLElement, n = 5) {
  for (let i = 0; i < n; i++) await settle(el)
}

describe('returning from a paid embedded checkout', () => {
  it('Qliro: does not create a new order while reading the paid one', async () => {
    landOn('?checkout_id=CHK-PAID&payment_processor=QLIRO')
    const read = deferred<any>()
    vi.spyOn(manager, 'getQliroOrder').mockReturnValue(read.promise)
    const mountSpy = vi.spyOn(manager, 'mountQliroCheckout')
      .mockImplementation(fakeMount)

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()

    read.resolve({ order_id: 'PAID-ORDER', status: 'Completed', total_price: 5198 })
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()
    expect(shadowText(el)).toContain('Takk')
  })

  it('Qliro: an order still on hold shows Qliro\'s own screen, not a new order', async () => {
    landOn('?checkout_id=CHK-HOLD&payment_processor=QLIRO')
    vi.spyOn(manager, 'getQliroOrder')
      .mockResolvedValue({ order_id: 'HOLD-ORDER', status: 'OnHold', html_snippet: '<p id="qliro-receipt"></p>' })
    const mountSpy = vi.spyOn(manager, 'mountQliroCheckout')
      .mockImplementation(fakeMount)
    vi.spyOn(manager, 'renderKustomSnippet').mockImplementation((c: any, h: any) => { c.innerHTML = h })

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()
  })

  it('Kustom: does not create a new order while reading the paid one', async () => {
    landOn('?order_id=KCO-PAID&payment_processor=KUSTOM')
    const read = deferred<any>()
    vi.spyOn(manager, 'getKustomOrder').mockReturnValue(read.promise)
    const mountSpy = vi.spyOn(manager, 'mountKustomCheckout')
      .mockImplementation(fakeMount)
    vi.spyOn(manager, 'renderKustomSnippet').mockImplementation((c: any, h: any) => { c.innerHTML = h })

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()

    read.resolve({ order_id: 'KCO-PAID', status: 'checkout_complete', html_snippet: '<p>receipt</p>' })
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()
  })

  it('Walley: does not create a new order while reading the paid one', async () => {
    landOn('?checkout_id=CHK-W&payment_processor=WALLEY')
    const read = deferred<any>()
    vi.spyOn(manager, 'getWalleyOrder').mockReturnValue(read.promise)
    const mountSpy = vi.spyOn(manager, 'mountWalleyCheckout')
      .mockImplementation(fakeMount)
    vi.spyOn(manager, 'renderKustomSnippet').mockImplementation((c: any, h: any) => { c.innerHTML = h })

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()

    read.resolve({ order_id: 'W-PAID', status: 'PurchaseCompleted', html_snippet: '<p>receipt</p>' })
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()
  })

  it('a failed read says so and still does not start a new payment', async () => {
    // Before: the notice vanished, the panel stayed empty, and the next render
    // created a fresh order — for a purchase that may well have gone through.
    landOn('?checkout_id=CHK-ERR&payment_processor=QLIRO')
    vi.spyOn(manager, 'getQliroOrder').mockRejectedValue(new Error('network down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mountSpy = vi.spyOn(manager, 'mountQliroCheckout').mockImplementation(fakeMount)

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()
    expect(shadowText(el)).toContain('Vi kunne ikke bekrefte betalingen')
  })

  it('closing and reopening is a fresh checkout again — the guard does not stick', async () => {
    // After a read that failed nothing is mounted, so once the shopper closes
    // the overlay and starts over they must be able to pay. (A return that DID
    // render the provider's screen keeps it on reopen, as any mounted widget
    // does — that is the widget's own guard, not this one.)
    landOn('?checkout_id=CHK-ERR&payment_processor=QLIRO')
    vi.spyOn(manager, 'getQliroOrder').mockRejectedValue(new Error('network down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mountSpy = vi.spyOn(manager, 'mountQliroCheckout').mockImplementation(fakeMount)

    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()

    el.close()
    await renderCycles(el)
    manager.open(SPONSOR)
    manager.selectPaymentMethod('qliro')
    el.show()
    await renderCycles(el)
    expect(mountSpy).toHaveBeenCalledTimes(1)
  })
})
