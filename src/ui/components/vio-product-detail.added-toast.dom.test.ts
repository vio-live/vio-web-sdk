// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'

/**
 * After «Legg i handlekurv» the detail closes and says so: «Lagt i
 * handlekurven», with «Til kassen» and «Fortsett å handle» (Mote & Livsstil,
 * 2026-10-28).
 */

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
  const proto = VioProductDetail.prototype as any
  vi.spyOn(proto, 'loadVippsButton').mockResolvedValue(undefined)
  vi.spyOn(proto, 'loadAvailablePaymentMethods').mockImplementation(async function (this: any) {
    this.availableMethods = ['Vipps']
  })
  vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockResolvedValue({ available: false, show: async () => {} } as any)
  vi.spyOn(Vio, 'commerceFor').mockReturnValue({
    channel: { product: { getByIds: vi.fn().mockResolvedValue([product]), getSellerCompany: vi.fn().mockResolvedValue(null), getShippingRates: vi.fn().mockResolvedValue(null) } },
  } as any)
  vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
})

afterEach(() => {
  unmountAll()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function openAndAdd(attrs: Record<string, string> = {}) {
  const el = await mount<HTMLElement & Record<string, any>>('vio-product-detail')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.dispatchEvent(new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: '4' } }))
  for (let i = 0; i < 6; i++) await settle(el)
  el.shadowRoot!.querySelector<HTMLButtonElement>('.add-to-cart')!.click()
  await settle(el)
  return el
}
const toast = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLElement>('.added-toast')

describe('«Lagt i handlekurven»', () => {
  it('shows after the add, with the detail closed', async () => {
    const el = await openAndAdd()
    expect(el.open).toBe(false)
    expect(toast(el)?.textContent).toContain('Lagt i handlekurven')
    const labels = [...toast(el)!.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).toEqual(['Til kassen', 'Fortsett å handle'])
  })

  it('«Til kassen» opens the checkout of that brand (vio:checkout-open), and the toast goes', async () => {
    vi.spyOn(Vio.cart, 'getCart').mockReturnValue({ sponsorId: 4, currency: 'NOK', items: [{ unitPrice: 699, quantity: 1 }] } as any)
    const el = await openAndAdd()
    const opened = vi.fn()
    document.addEventListener('vio:checkout-open', opened)
    toast(el)!.querySelector<HTMLButtonElement>('.added-toast-checkout')!.click()
    await settle(el)
    document.removeEventListener('vio:checkout-open', opened)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened.mock.calls[0]![0].detail).toMatchObject({ sponsorId: 4, express: false })
    expect(toast(el)).toBeNull()
  })

  it('«Til kassen» on a cart emptied meanwhile opens nothing', async () => {
    vi.spyOn(Vio.cart, 'getCart').mockReturnValue({ sponsorId: 4, currency: 'NOK', items: [] } as any)
    const el = await openAndAdd()
    const opened = vi.fn()
    document.addEventListener('vio:checkout-open', opened)
    toast(el)!.querySelector<HTMLButtonElement>('.added-toast-checkout')!.click()
    document.removeEventListener('vio:checkout-open', opened)
    expect(opened).not.toHaveBeenCalled()
  })

  it('«Fortsett å handle» just closes it', async () => {
    const el = await openAndAdd()
    const opened = vi.fn()
    document.addEventListener('vio:checkout-open', opened)
    toast(el)!.querySelector<HTMLButtonElement>('.added-toast-continue')!.click()
    await settle(el)
    document.removeEventListener('vio:checkout-open', opened)
    expect(toast(el)).toBeNull()
    expect(opened).not.toHaveBeenCalled()
  })

  it('goes by itself after a while', async () => {
    const el = await openAndAdd()
    vi.useFakeTimers()
    el.showAddedToast() // re-armed under fake timers
    await el.updateComplete
    vi.advanceTimersByTime(8000)
    await el.updateComplete
    expect(toast(el)).toBeNull()
  })

  it('a host with its own answer to vio:added-to-cart turns it off (no-added-toast)', async () => {
    const el = await openAndAdd({ 'no-added-toast': '' })
    expect(toast(el)).toBeNull()
  })
})
