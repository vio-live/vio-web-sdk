// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Nexi has no shipping picker. Angelo, 2026-09-16: the product ships Standard
 * (199) or Express (300), and the Nexi checkout showed neither — the cheapest
 * was charged without a word. Once an address is typed in the widget, the
 * rates that reach it are listed above the widget and the pick is pushed to
 * the payment.
 */
const SPONSOR = 5
const manager = Vio.checkout as any
let onShipping: ((result: any, err?: unknown) => void) | undefined

beforeEach(() => {
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
    this.shippingsReadyFor = this.embedSession()
  })
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], session: 1, subtotal: 1000, currency: 'NOK' }
    manager.emit()
    return manager.state
  })
  vi.spyOn(manager, 'mountNexiCheckout').mockImplementation(async (...args: unknown[]) => {
    ;(args[0] as HTMLElement).innerHTML = '<iframe></iframe>'
    onShipping = (args[2] as any).onShipping
    return { order_id: 'PAY', status: 'Created', checkout_key: 'k', checkout_js_url: 'x' }
  })
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  unmountAll()
  manager.state = null
  onShipping = undefined
  vi.restoreAllMocks()
})

async function renderCycles(el: HTMLElement, n = 5) {
  for (let i = 0; i < n; i++) await settle(el)
}

async function openNexi() {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  manager.selectPaymentMethod('nexi')
  el.show()
  await renderCycles(el)
  return el
}

const rates = (el: HTMLElement): HTMLButtonElement[] =>
  [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.nexi-ship .ship-opt') ?? [])]

const answer = (shipping_id: string, extra: Record<string, unknown> = {}) => ({
  ok: true,
  order_id: 'PAY',
  shipping_id,
  shipping_name: shipping_id === '20' ? 'Express' : 'Standard',
  shipping_price: shipping_id === '20' ? 300 : 199,
  total_price: shipping_id === '20' ? 1300 : 1199,
  options: [
    { id: '10', name: 'Standard', price: 199 },
    { id: '20', name: 'Express', price: 300 },
  ],
  ...extra,
})

describe('vio-checkout — Nexi shipping choice', () => {
  it('lists nothing before an address is typed', async () => {
    const el = await openNexi()
    expect(onShipping).toBeTypeOf('function')
    expect(rates(el)).toHaveLength(0)
  })

  it('lists the rates for the address, with the charged one marked', async () => {
    const el = await openNexi()
    onShipping!(answer('10'))
    await renderCycles(el)
    expect(rates(el).map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('Standard'),
      expect.stringContaining('Express'),
    ])
    expect(rates(el)[0]!.getAttribute('aria-checked')).toBe('true')
    expect(shadowText(el)).toContain('Standard')
  })

  it('pushes the pick to the payment, and marks it once Nexi has it', async () => {
    const pick = vi.spyOn(manager, 'pickNexiShipping').mockImplementation(async () => {
      onShipping!(answer('20'))
    })
    const el = await openNexi()
    onShipping!(answer('10'))
    await renderCycles(el)

    rates(el)[1]!.click()
    await renderCycles(el)

    expect(pick).toHaveBeenCalledWith('20')
    expect(rates(el)[1]!.getAttribute('aria-checked')).toBe('true')
    expect(rates(el).every((b) => !b.disabled)).toBe(true)
  })

  it('does not re-push the rate already charged', async () => {
    const pick = vi.spyOn(manager, 'pickNexiShipping').mockResolvedValue(undefined)
    const el = await openNexi()
    onShipping!(answer('10'))
    await renderCycles(el)
    rates(el)[0]!.click()
    await renderCycles(el)
    expect(pick).not.toHaveBeenCalled()
  })

  it('shows no list when there is a single rate', async () => {
    const el = await openNexi()
    onShipping!(answer('10', { options: [{ id: '10', name: 'Standard', price: 199 }] }))
    await renderCycles(el)
    expect(rates(el)).toHaveLength(0)
  })

  it('drops the list where nothing ships, and says so', async () => {
    const el = await openNexi()
    onShipping!(answer('10'))
    await renderCycles(el)
    onShipping!({ ok: false, reason: 'NO_SHIPPING', order_id: 'PAY', options: [] })
    await renderCycles(el)
    expect(rates(el)).toHaveLength(0)
    expect(shadowText(el)).toContain('ikke sende til dette landet')
  })

  it('shows the market\'s rates before any address, with the suggested one marked', async () => {
    // Angelo, 2026-09-16: the choice appeared only after the address, mid-typing.
    const el = await openNexi()
    onShipping!(answer('10', { ok: false, reason: 'AWAITING_ADDRESS', total_price: undefined }))
    await renderCycles(el)
    expect(rates(el)).toHaveLength(2)
    expect(rates(el)[0]!.getAttribute('aria-checked')).toBe('true')
    expect(shadowText(el)).not.toContain('ikke sende')
  })

  it('a pick before the address is shown at once', async () => {
    const pick = vi.spyOn(manager, 'pickNexiShipping').mockImplementation(async (...args: unknown[]) => {
      onShipping!(answer(String(args[0]), { ok: false, reason: 'AWAITING_ADDRESS' }))
    })
    const el = await openNexi()
    onShipping!(answer('10', { ok: false, reason: 'AWAITING_ADDRESS' }))
    await renderCycles(el)
    rates(el)[1]!.click()
    await renderCycles(el)
    expect(pick).toHaveBeenCalledWith('20')
    expect(rates(el)[1]!.getAttribute('aria-checked')).toBe('true')
  })

  it('says so when the address does not take the rate the shopper had', async () => {
    const el = await openNexi()
    onShipping!(answer('20', { ok: false, reason: 'AWAITING_ADDRESS' }))
    await renderCycles(el)
    // The address arrives; Express does not reach it, Standard is charged.
    onShipping!(answer('10', { options: [{ id: '10', name: 'Standard', price: 199 }, { id: '30', name: 'Pickup', price: 49 }] }))
    await renderCycles(el)
    expect(shadowText(el)).toContain('Valgt frakt leveres ikke til denne adressen')
    expect(shadowText(el)).toContain('Standard')
  })

  it('no such notice when the address takes the rate', async () => {
    const el = await openNexi()
    onShipping!(answer('20', { ok: false, reason: 'AWAITING_ADDRESS' }))
    await renderCycles(el)
    onShipping!(answer('20'))
    await renderCycles(el)
    expect(shadowText(el)).not.toContain('leveres ikke')
    expect(rates(el)[1]!.getAttribute('aria-checked')).toBe('true')
  })
})
