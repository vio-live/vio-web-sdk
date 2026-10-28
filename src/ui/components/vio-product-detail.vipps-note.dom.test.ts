// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'

/**
 * Under «Kjøp nå med Vipps», when it goes straight to the app (Express): one
 * line saying what happens there (Mote & Livsstil, 2026-10-28).
 */

const LINE = 'Vipps fyller inn navn og adresse – du godkjenner og betaler i appen'
const product = {
  id: 9,
  brand: 'Careless',
  title: 'Vilde genser',
  quantity: 10,
  price: { amount: 699, currency_code: 'NOK' },
  images: [{ id: 1, url: 'https://img.test/1.jpg', order: 0 }],
  options: [],
  variants: [],
}

beforeEach(() => {
  vi.spyOn(VioProductDetail.prototype as any, 'loadVippsButton').mockResolvedValue(undefined)
  vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockResolvedValue({ available: false, show: async () => {} } as any)
  vi.spyOn(Vio, 'commerceFor').mockReturnValue({
    channel: { product: { getByIds: vi.fn().mockResolvedValue([product]), getSellerCompany: vi.fn().mockResolvedValue(null), getShippingRates: vi.fn().mockResolvedValue(null) } },
  } as any)
})

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

async function open() {
  const el = await mount<HTMLElement & Record<string, any>>('vio-product-detail')
  document.dispatchEvent(new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: '4' } }))
  for (let i = 0; i < 6; i++) await settle(el)
  return el
}
const note = (el: HTMLElement) => el.shadowRoot!.querySelector('.vipps-note')?.textContent?.trim() ?? null

const methods = (list: unknown) => vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue(list as any)

describe('the line under the Vipps button', () => {
  it('a failed method lookup: the buttons show (unknown = all), the line does not — Express is not known', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockRejectedValue(new Error('network'))
    const el = await open()
    expect(el.shadowRoot!.querySelector('.buy-vipps')).not.toBeNull()
    expect(note(el)).toBeNull()
  })

  it('Express on and an empty cart: the line, right under the button', async () => {
    methods([{ name: 'Vipps', config: [{ name: 'express', value: 'true' }] }])
    const el = await open()
    expect(note(el)).toBe(LINE)
    const vipps = el.shadowRoot!.querySelector('.buy-vipps')!
    expect(vipps.nextElementSibling?.className).toContain('vipps-note')
  })

  it('Express off for the brand: no line (the checkout opens instead)', async () => {
    methods([{ name: 'Vipps', config: [{ name: 'express', value: 'false' }] }])
    const el = await open()
    expect(el.shadowRoot!.querySelector('.buy-vipps')).not.toBeNull()
    expect(note(el)).toBeNull()
  })

  it('lines already in the cart: no line (the checkout opens first)', async () => {
    methods([{ name: 'Vipps' }])
    vi.spyOn(Vio.cart, 'getCart').mockReturnValue({ sponsorId: 4, currency: 'NOK', items: [{ unitPrice: 1, quantity: 1 }] } as any)
    const el = await open()
    expect(note(el)).toBeNull()
  })
})
