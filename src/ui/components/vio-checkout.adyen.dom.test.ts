// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Adyen in the checkout: our form first, then Adyen's Drop-in on a session.
 *
 * Adyen collects no email, address or shipping, so — unlike Qliro or Nexi —
 * the delivery form STAYS, and a session is a photo of a finished form:
 *
 * - nothing is created while the shopper is still typing, only when they ask
 *   for the payment step;
 * - a change of form, shipping or cart under a mounted Drop-in takes it down
 *   (it is never patched, and never silently re-created);
 * - closing takes it down (the 2026-09-14 defect, for every widget);
 * - the return from Vipps/Klarna is finalised on the server, cleans the URL
 *   before anything else, and never starts a new payment.
 */
const SPONSOR = 5
const manager = Vio.checkout as any
let sessionSeq = 0

const FORM = {
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
  vi.spyOn(Vio.cart, 'clearSponsorCart').mockImplementation(() => {})
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], session: ++sessionSeq, subtotal: 4999, currency: 'NOK' }
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

/** A mount that behaves like the real one: Drop-in fills the container. */
function spyMount(capture?: (callbacks: any) => void) {
  return vi.spyOn(manager, 'mountAdyenCheckout').mockImplementation(async (...args: unknown[]) => {
    ;(args[0] as HTMLElement).innerHTML = '<div class="adyen-checkout__dropin"></div>'
    capture?.(args[3])
    return { session_id: 'CS1', total_price: 5198, purchase_currency: 'NOK' }
  })
}

async function openWithAdyen(form: Record<string, string> = FORM) {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  manager.selectPaymentMethod('adyen')
  el.form = { ...form }
  el.show()
  await renderCycles(el)
  return el
}

const dropin = (el: HTMLElement) => el.querySelector('#vio-adyen-checkout-container .adyen-checkout__dropin')
const panelButton = (el: HTMLElement) =>
  el.shadowRoot?.querySelector<HTMLButtonElement>('.adyen-panel button') ?? null

describe('Adyen in <vio-checkout>', () => {
  it('keeps the delivery form: Adyen asks for no address of its own', async () => {
    spyMount()
    const el = await openWithAdyen()
    expect(shadowText(el)).toContain('Leveringsadresse')
  })

  it('creates NO session just because the method is selected — only when asked', async () => {
    const mountSpy = spyMount()
    const el = await openWithAdyen()
    expect(mountSpy).not.toHaveBeenCalled()
    expect(panelButton(el)?.textContent).toContain('Gå til betaling')

    panelButton(el)!.click()
    await renderCycles(el)
    expect(mountSpy).toHaveBeenCalledTimes(1)
    expect(mountSpy.mock.calls[0]![2]).toMatchObject({ email: 'kari@example.no', postalCode: '0194' })
    expect(dropin(el)).not.toBeNull()
  })

  it('cannot be asked for with an unfinished form', async () => {
    const mountSpy = spyMount()
    const el = await openWithAdyen({ ...FORM, city: '' })
    expect(panelButton(el)?.disabled).toBe(true)
    el.adyenRequested = true // even if something asks anyway
    await renderCycles(el)
    expect(mountSpy).not.toHaveBeenCalled()
  })

  it('a change under a mounted Drop-in takes it down — and does not re-create it', async () => {
    const mountSpy = spyMount()
    const el = await openWithAdyen()
    panelButton(el)!.click()
    await renderCycles(el)
    expect(dropin(el)).not.toBeNull()

    el.form = { ...FORM, postalCode: '5003', city: 'Bergen' }
    await renderCycles(el)
    expect(dropin(el)).toBeNull()
    expect(mountSpy).toHaveBeenCalledTimes(1)
    expect(shadowText(el)).toContain('Bestillingen ble endret')
    expect(panelButton(el)?.textContent).toContain('Oppdater betaling')

    panelButton(el)!.click()
    await renderCycles(el)
    expect(mountSpy).toHaveBeenCalledTimes(2)
    expect(mountSpy.mock.calls[1]![2]).toMatchObject({ city: 'Bergen' })
  })

  it('closing takes Drop-in down; the next opening starts from the button again', async () => {
    const mountSpy = spyMount()
    const el = await openWithAdyen()
    panelButton(el)!.click()
    await renderCycles(el)
    expect(dropin(el)).not.toBeNull()

    el.close()
    await renderCycles(el)
    expect(dropin(el)).toBeNull()

    manager.open(SPONSOR)
    manager.selectPaymentMethod('adyen')
    el.form = { ...FORM }
    el.show()
    await renderCycles(el)
    expect(mountSpy).toHaveBeenCalledTimes(1)
  })

  it('"Pay" on a session that no longer pays for the checkout: down, nothing charged, says so', async () => {
    let callbacks: any
    spyMount((c) => (callbacks = c))
    const el = await openWithAdyen()
    panelButton(el)!.click()
    await renderCycles(el)

    callbacks.onReplaced('AMOUNT_CHANGED')
    await renderCycles(el)
    expect(dropin(el)).toBeNull()
    expect(shadowText(el)).toContain('Bestillingen ble endret')
  })

  it('an authorised payment shows Vio\'s confirmation with what Adyen reported', async () => {
    let callbacks: any
    spyMount((c) => (callbacks = c))
    const el = await openWithAdyen()
    panelButton(el)!.click()
    await renderCycles(el)

    callbacks.onCompleted(
      { order_id: 'CS1', status: 'authorised', psp_reference: 'PSP-883', payment_method: 'vipps', total_price: 5198, order_created: false },
      { session_id: 'CS1', total_price: 5198 },
    )
    await renderCycles(el)
    expect(dropin(el)).toBeNull()
    expect(shadowText(el)).toContain('Takk')
    expect(shadowText(el)).toContain('PSP-883')
    expect(Vio.cart.clearSponsorCart).toHaveBeenCalledWith(SPONSOR)
  })

  it('a pending payment (Swish, Trustly) promises the email, keeps the cart and offers no second payment', async () => {
    let callbacks: any
    const mountSpy = spyMount((c) => (callbacks = c))
    const el = await openWithAdyen()
    panelButton(el)!.click()
    await renderCycles(el)

    callbacks.onCompleted({ order_id: 'CS1', status: 'pending', order_created: false }, { session_id: 'CS1', total_price: 5198 })
    await renderCycles(el)
    expect(shadowText(el)).toContain('Betalingen behandles')
    expect(Vio.cart.clearSponsorCart).not.toHaveBeenCalled()
    expect(panelButton(el)).toBeNull()
    expect(mountSpy).toHaveBeenCalledTimes(1)
  })

  it('an unverifiable completion is "processing", never a made-up success', async () => {
    let callbacks: any
    spyMount((c) => (callbacks = c))
    const el = await openWithAdyen()
    panelButton(el)!.click()
    await renderCycles(el)

    callbacks.onCompleted(null, { session_id: 'CS1', total_price: 5198 })
    await renderCycles(el)
    expect(shadowText(el)).not.toContain('Takk')
    expect(shadowText(el)).toContain('Betalingen behandles')
  })

  it('a refused payment can be tried again — on a NEW session, when asked', async () => {
    let callbacks: any
    const mountSpy = spyMount((c) => (callbacks = c))
    const el = await openWithAdyen()
    panelButton(el)!.click()
    await renderCycles(el)

    callbacks.onFailed({ resultCode: 'Refused' })
    await renderCycles(el)
    expect(dropin(el)).toBeNull()
    expect(shadowText(el)).toContain('ikke gjennomført')
    expect(mountSpy).toHaveBeenCalledTimes(1)
    panelButton(el)!.click()
    await renderCycles(el)
    expect(mountSpy).toHaveBeenCalledTimes(2)
  })
})

describe('returning from a redirect inside Adyen (Vipps, Klarna, 3DS)', () => {
  const RETURN = `?utm=x&vio_payment=return&vio_method=adyen&vio_sponsor=${SPONSOR}&checkout_id=CHK-1&sessionId=CS1&redirectResult=RR`

  it('finalises on the server, cleans the URL first and shows the confirmation — without mounting anything', async () => {
    window.history.replaceState({}, '', `/${RETURN}`)
    const mountSpy = spyMount()
    let urlWhenRead = ''
    const read = vi.spyOn(manager, 'getAdyenPayment').mockImplementation(async () => {
      urlWhenRead = window.location.search
      return { order_id: 'CS1', status: 'authorised', psp_reference: 'PSP-VIPPS', payment_method: 'vipps', total_price: 5198, purchase_currency: 'NOK', order_created: true }
    })

    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)

    expect(read).toHaveBeenCalledWith('CHK-1', { redirectResult: 'RR' }, SPONSOR)
    // A reload must not submit a used redirectResult again.
    expect(urlWhenRead).toBe('?utm=x')
    expect(window.location.search).toBe('?utm=x')
    expect(mountSpy).not.toHaveBeenCalled()
    expect(shadowText(el)).toContain('Takk')
    expect(shadowText(el)).toContain('PSP-VIPPS')
  })

  it('a cancelled or refused return says so and lets the shopper pay again', async () => {
    window.history.replaceState({}, '', `/${RETURN}`)
    const mountSpy = spyMount()
    vi.spyOn(manager, 'getAdyenPayment').mockResolvedValue({ order_id: 'CS1', status: 'cancelled', order_created: false })

    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    expect(shadowText(el)).toContain('avbrutt eller feilet')
    expect(mountSpy).not.toHaveBeenCalled()
    expect(el.adyenSettled).toBe(false)
  })

  it('an unreadable return is "could not verify" — never "pay again", never success', async () => {
    window.history.replaceState({}, '', `/${RETURN}`)
    const mountSpy = spyMount()
    vi.spyOn(manager, 'getAdyenPayment').mockRejectedValue(new Error('network'))

    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el)
    expect(shadowText(el)).not.toContain('Takk')
    expect(mountSpy).not.toHaveBeenCalled()
    expect(el.adyenSettled).toBe(true)
  })

  it('our own params without a redirectResult are not a return: nothing is read, nothing resumed', async () => {
    window.history.replaceState({}, '', `/?vio_method=adyen&checkout_id=CHK-1&vio_sponsor=${SPONSOR}`)
    const read = vi.spyOn(manager, 'getAdyenPayment')
    const el = await mount<HTMLElement>('vio-checkout')
    await renderCycles(el)
    expect(read).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
  })
})
