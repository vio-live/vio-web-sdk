// @vitest-environment jsdom
/**
 * The checkout and a product the shop has cut the price of (Boots,
 * 2026-11-26).
 *
 * The summary's lines show the price before struck through, over what the
 * line costs, as the cart does — and that is all: no «Du sparer» row
 * (Angelo, 2026-11-26). What is paid does not change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

const SPONSOR = 5
const manager = Vio.checkout as any
const RATE = { id: 'p', supplierId: '9', name: 'Posten', method: 'Posten', price: 4900, priceMajor: 49, currency: 'NOK' }
const CREAM = { id: 'c', productId: 416094, name: 'Sun Face Cream', brand: 'Cosmica', quantity: 1, unitPrice: 143.94, compareAtPrice: 239.9, currency: 'NOK' }
const BALM = { id: 'b', productId: 416095, name: 'Lip Butter', brand: 'Avène', quantity: 1, unitPrice: 84.95, currency: 'NOK' }

let items: any[]
let state: Record<string, unknown>
let methods: Array<{ name: string }>

beforeEach(() => {
  items = [CREAM, BALM]
  state = { subtotal: 228.89 }
  methods = [{ name: 'Vipps' }]
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 1, buyerRef: null })
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
  const proto = VioCheckout.prototype as any
  for (const m of ['refreshApplePay', 'refreshKlarna', 'mountKustomIfNeeded']) vi.spyOn(proto, m).mockResolvedValue(undefined)
  vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
    this.availableShippingsList = [RATE]
    this.selectedShipping = RATE.id
    this.shippingsReadyFor = this.embedSession()
  })
  vi.spyOn(manager, 'items', 'get').mockImplementation(() => items)
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(manager, 'getAvailablePaymentMethods').mockImplementation(async () => methods)
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
  document.querySelectorAll('.vio-redirect-overlay').forEach((n) => n.remove())
  manager.state = null
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

async function cycles(el: HTMLElement, n = 6) {
  for (let i = 0; i < n; i++) await settle(el)
}

async function open(method?: string) {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  el.show()
  await cycles(el)
  if (method) {
    manager.state = { ...manager.state, paymentMethod: method }
    manager.emit()
    await cycles(el)
  }
  return el
}

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
const summaryRows = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.order-summary .order-row') ?? [])].map((r) => text(r))
const summaryRow = (el: HTMLElement, label: string) => summaryRows(el).find((t) => t.startsWith(label))
const summaryLines = (el: HTMLElement) => [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.order-summary .order-line') ?? [])]

describe('the summary', () => {
  it('a line the shop cut the price of: the price before struck through, then what it costs', async () => {
    const el = await open('vipps')
    const [cream, balm] = summaryLines(el)
    expect(text(cream!.querySelector('.order-line-price s'))).toBe('239,90 Kr')
    expect(text(cream!.querySelector('.order-line-price .net-price'))).toBe('143,94 Kr')
    expect(balm!.querySelector('.order-line-price s')).toBeNull()
    expect(text(balm!.querySelector('.order-line-price'))).toBe('84,95 Kr')
  })

  it('what is paid does not change', async () => {
    const el = await open('vipps')
    expect(summaryRow(el, 'Sum')).toMatch(/^Sum\s*228,89 Kr$/)
    expect(summaryRow(el, 'Totalt')).toMatch(/^Totalt\s*277,89 Kr$/)
    expect(summaryRow(el, 'Rabatt')).toBeUndefined()
    expect(text(el.shadowRoot!.querySelector('.complete-cta'))).toBe('Betal 277,89 Kr med Vipps')
  })
})

describe('nothing else is said of it', () => {
  it('no «Du sparer», with our own pay button', async () => {
    const el = await open('vipps')
    expect(el.shadowRoot!.textContent).not.toMatch(/Du sparer/i)
  })

  it('nor over an embedded checkout (Kustom)', async () => {
    methods = [{ name: 'Kustom' }]
    const el = await open('kustom')
    expect(el.shadowRoot!.querySelector('.kustom-panel')).not.toBeNull()
    expect(el.shadowRoot!.textContent).not.toMatch(/Du sparer/i)
    // The summary under the widget still says the price before.
    expect(text(summaryLines(el)[0]!.querySelector('.order-line-price s'))).toBe('239,90 Kr')
  })

  it('with a discount code too: the «før-pris» struck through, over what the line costs with the code', async () => {
    items = [{ ...CREAM, discount: 14.39 }, BALM]
    state = { subtotal: 228.89, discount: 14.39 }
    const el = await open('vipps')
    const [cream] = summaryLines(el)
    expect(text(cream!.querySelector('.order-line-price s'))).toBe('239,90 Kr')
    expect(text(cream!.querySelector('.order-line-price .net-price'))).toBe('129,55 Kr')
    expect(summaryRow(el, 'Rabatt')).toMatch(/−14,39 Kr$/)
  })

  it('a checkout without a cut: the summary is the one it always was', async () => {
    items = [BALM]
    state = { subtotal: 84.95 }
    const el = await open('vipps')
    expect(el.shadowRoot!.querySelector('.order-summary s')).toBeNull()
  })
})
