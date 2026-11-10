// @vitest-environment jsdom
/**
 * The checkout and a discount code: the summary's «Sum» stays the lines at
 * their list prices, and what is paid — «Totalt» and «Betal … med Vipps» — is
 * those less what the code takes off them, plus the shipping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

const SPONSOR = 5
const manager = Vio.checkout as any
const RATE = { id: 'p', name: 'Posten', method: 'Posten', price: 4900, priceMajor: 49, currency: 'NOK' }
const CREAM = { id: 'c', productId: 100, name: 'Krem', brand: 'Faves', quantity: 1, unitPrice: 349, currency: 'NOK' }
const MASK = { id: 'm', productId: 421306, name: 'Face mask', brand: 'Faves', quantity: 1, unitPrice: 52, discount: 52, currency: 'NOK' }

let items: any[]
let state: Record<string, unknown>

beforeEach(() => {
  items = [CREAM, MASK]
  state = { subtotal: 401, discount: 52 }
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 1, buyerRef: null })
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
  const proto = VioCheckout.prototype as any
  for (const m of ['refreshApplePay', 'refreshKlarna']) vi.spyOn(proto, m).mockResolvedValue(undefined)
  vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
    this.availableShippingsList = [RATE]
    this.shippingOption = RATE
    this.shippingsReadyFor = this.embedSession()
  })
  vi.spyOn(manager, 'items', 'get').mockImplementation(() => items)
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(manager, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }])
  vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(false)
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
  vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], session: 1, currency: 'NOK', ...state }
    manager.emit()
    return manager.state
  })
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  unmountAll()
  manager.state = null
  vi.restoreAllMocks()
})

async function cycles(el: HTMLElement, n = 6) {
  for (let i = 0; i < n; i++) await settle(el)
}

async function openWithVipps() {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  el.show()
  await cycles(el)
  manager.state = { ...manager.state, paymentMethod: 'vipps' }
  manager.emit()
  await cycles(el)
  return el
}

const summaryRow = (el: HTMLElement, label: string) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.order-summary .order-row') ?? [])]
    .map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim())
    .find((t) => t.startsWith(label))

const payButtonText = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.complete-cta') ?? [])].map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim()).join(' | ')

describe('what is paid', () => {
  it('«Sum» is the list prices; «Totalt» and the Vipps button are those less the discount, plus the shipping', async () => {
    const el = await openWithVipps()
    expect(summaryRow(el, 'Sum')).toMatch(/^Sum\s*401 Kr$/)
    expect(summaryRow(el, 'Frakt')).toMatch(/^Frakt – Posten\s*49 Kr$/)
    expect(summaryRow(el, 'Totalt')).toMatch(/^Totalt\s*398 Kr$/)
    expect(payButtonText(el)).toBe('Betal 398 Kr med Vipps')
  })

  it('the cart changes under the open checkout (the code goes on): the button follows', async () => {
    state = { subtotal: 401 }
    items = [CREAM, { ...MASK, discount: undefined }]
    const el = await openWithVipps()
    expect(payButtonText(el)).toBe('Betal 450 Kr med Vipps')

    items = [CREAM, MASK]
    manager.state = { ...manager.state, discount: 52 }
    manager.emit()
    await cycles(el)
    expect(summaryRow(el, 'Totalt')).toMatch(/^Totalt\s*398 Kr$/)
    expect(payButtonText(el)).toBe('Betal 398 Kr med Vipps')
  })

  it('a cart of a gift alone: nothing to pay — the button is off', async () => {
    state = { subtotal: 52, discount: 52 }
    items = [MASK]
    const el = await openWithVipps()
    const pay = el.shadowRoot!.querySelector<HTMLButtonElement>('.complete-cta')!
    expect(pay.disabled).toBe(true)
  })
})
