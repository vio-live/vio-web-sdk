// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * «Avbryt» on the Vipps wait (Angelo, 2026-11-03): a shopper who opened Vipps
 * and closed the app without approving or cancelling came back to «Bekrefter
 * betalingen med Vipps…» and could only wait — the payment stays CREATED and
 * the checkout kept asking until its polling ran out. «Avbryt» ends the wait
 * at once and brings the checkout back with the cart as it was.
 */

const SPONSOR = 1338
const CHECKOUT = 'bc143456-5af7-4ab7-9a7e-e78cbbac039b'
const manager = Vio.checkout as any
const realDelay = (VioCheckout as any).VIPPS_STATUS_DELAY_MS

beforeEach(() => {
  Vio.init({ apiKey: 'test-key', environment: 'production' } as any)
  // A long gap between asks: only «Avbryt» can end the wait inside the test.
  ;(VioCheckout as any).VIPPS_STATUS_DELAY_MS = 60_000
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
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
  // The receipt's lines are read from the checkout (vio-checkout.vipps-receipt): none here.
  vi.spyOn(manager, 'getCheckout').mockResolvedValue(null)
  vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
  window.history.replaceState(
    {},
    '',
    `/?vio_payment=success&vio_method=vipps&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}`,
  )
})

afterEach(() => {
  ;(VioCheckout as any).VIPPS_STATUS_DELAY_MS = realDelay
  unmountAll()
  manager.state = null
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

async function cycles(el: HTMLElement, n = 6) {
  for (let i = 0; i < n; i++) await settle(el)
}

const cancelButton = (el: HTMLElement) =>
  el.shadowRoot?.querySelector<HTMLButtonElement>('.verifying-cancel') ?? null

describe('«Avbryt» on the Vipps wait', () => {
  it('Vipps still CREATED (app closed): «Avbryt» ends the wait and brings the checkout back, cart kept', async () => {
    const status = vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'CREATED', duplicate_of: null })
    const clear = vi.spyOn(Vio.cart, 'clearSponsorCart')
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await cycles(el)

    expect(shadowText(el)).toContain('Bekrefter betalingen med Vipps')
    const button = cancelButton(el)
    expect(button?.textContent?.trim()).toBe('Avbryt')
    expect(status).toHaveBeenCalledTimes(1)

    button!.click()
    await cycles(el)

    const text = shadowText(el)
    expect(text).not.toContain('Bekrefter betalingen med Vipps')
    expect(text).toContain('Betalingen ble ikke fullført')
    expect(cancelButton(el)).toBeNull()
    // No more asks after «Avbryt», nothing paid, the cart untouched.
    expect(status).toHaveBeenCalledTimes(1)
    expect(el.orderConfirmed).toBeFalsy()
    expect(clear).not.toHaveBeenCalled()
    // The return URL is cleaned, so a reload does not start waiting again.
    expect(window.location.search).not.toContain('vio_method=vipps')
  })

  it('Vipps answers AUTHORIZED: the receipt, and no «Avbryt» left on screen', async () => {
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED', duplicate_of: null })
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await cycles(el, 8)

    expect(el.orderConfirmed).toBe(true)
    expect(cancelButton(el)).toBeNull()
    expect(shadowText(el)).not.toContain('Betalingen ble ikke fullført')
  })
})
