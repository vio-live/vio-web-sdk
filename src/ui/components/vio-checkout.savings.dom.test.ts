// @vitest-environment jsdom
/**
 * The checkout and what the shopper saves (Boots, 2026-11-26).
 *
 * The summary's lines show the price before struck through, then what the
 * line costs, as the cart does. «Du sparer» goes at the top of the payment
 * section — over the ways to pay and over the pay button, and over an
 * embedded checkout's own button, which the summary under it never reaches —
 * and is said once. What is paid does not change.
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
const savings = (el: HTMLElement) => [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.savings-row') ?? [])]
/** Whether `a` comes before `b` in the document. */
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

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

describe('«Du sparer»', () => {
  it('once, over the pay button', async () => {
    const el = await open('vipps')
    const rows = savings(el)
    expect(rows).toHaveLength(1)
    expect(text(rows[0])).toBe('Du sparer 95,96 Kr')
    expect(rows[0]!.getAttribute('part')).toBe('checkout-savings')
    expect(before(rows[0]!, el.shadowRoot!.querySelector('.complete-cta')!)).toBe(true)
    expect(before(rows[0]!, el.shadowRoot!.querySelector('.order-summary')!)).toBe(true)
  })

  it('over the ways to pay while none is chosen', async () => {
    methods = [{ name: 'Vipps' }, { name: 'Klarna' }]
    const el = await open()
    const rows = savings(el)
    expect(rows).toHaveLength(1)
    expect(before(rows[0]!, el.shadowRoot!.querySelector('.payment-grid')!)).toBe(true)
  })

  it('over an embedded checkout (Kustom), whose own buy button is above the summary', async () => {
    methods = [{ name: 'Kustom' }]
    const el = await open('kustom')
    const rows = savings(el)
    expect(rows).toHaveLength(1)
    expect(text(rows[0])).toBe('Du sparer 95,96 Kr')
    expect(before(rows[0]!, el.shadowRoot!.querySelector('.kustom-panel')!)).toBe(true)
  })

  it('the cuts and a discount code together', async () => {
    items = [{ ...CREAM, discount: 14.39 }, BALM]
    state = { subtotal: 228.89, discount: 14.39 }
    const el = await open('vipps')
    expect(text(savings(el)[0])).toBe('Du sparer 110,35 Kr')
    expect(summaryRow(el, 'Rabatt')).toMatch(/−14,39 Kr$/)
  })

  it('nothing saved: no such row, and the summary is the one it always was', async () => {
    items = [BALM]
    state = { subtotal: 84.95 }
    const el = await open('vipps')
    expect(savings(el)).toHaveLength(0)
    expect(el.shadowRoot!.querySelector('.order-summary s')).toBeNull()
  })
})
