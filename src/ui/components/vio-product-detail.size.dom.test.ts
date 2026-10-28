// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'

/**
 * The size is the shopper's to choose (Mote & Livsstil, 2026-10-28): nothing
 * preselected unless there is a single value, the chosen one plainly shown,
 * and every buy button asks for it — «Velg størrelse» — instead of buying the
 * first size. «Få igjen» speaks of the chosen variant only.
 */

const variant = (id: number, size: string, quantity: number) => ({
  id,
  title: size,
  quantity,
  price: { amount: 599, currency_code: 'NOK' },
  images: [],
})

const sized = {
  id: 9,
  brand: 'Careless',
  title: 'Vilde genser',
  quantity: 14,
  price: { amount: 599, currency_code: 'NOK' },
  images: [{ id: 1, url: 'https://img.test/1.jpg', order: 0 }],
  options: [{ id: 1, name: 'Størrelse', order: 0, values: ['S', 'M', 'L'] }],
  variants: [variant(101, 'S', 2), variant(102, 'M', 12), variant(103, 'L', 0)],
}

let product: any = sized

beforeEach(() => {
  product = sized
  const proto = VioProductDetail.prototype as any
  vi.spyOn(proto, 'loadVippsButton').mockResolvedValue(undefined)
  vi.spyOn(proto, 'loadAvailablePaymentMethods').mockImplementation(async function (this: any) {
    this.availableMethods = ['Vipps']
  })
  vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockResolvedValue({ available: false, show: async () => {} } as any)
  vi.spyOn(Vio, 'commerceFor').mockImplementation(
    () =>
      ({
        channel: {
          product: {
            getByIds: vi.fn().mockImplementation(async () => [product]),
            getSellerCompany: vi.fn().mockResolvedValue(null),
          },
        },
      }) as any,
  )
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
const root = (el: HTMLElement) => el.shadowRoot!
const pills = (el: HTMLElement) => [...root(el).querySelectorAll<HTMLButtonElement>('.option-pill')]
const pill = (el: HTMLElement, v: string) => pills(el).find((b) => b.textContent?.trim() === v)!
const text = (el: HTMLElement, sel: string) => root(el).querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

describe('no size is chosen for the shopper', () => {
  it('opens with no size selected', async () => {
    const el = await open()
    expect(pills(el).filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(0)
    expect(text(el, '.option-label')).toBe('Størrelse')
  })

  it('an option with a single value is preselected (nothing to choose)', async () => {
    product = { ...sized, options: [{ id: 1, name: 'Størrelse', order: 0, values: ['One size'] }], variants: [variant(201, 'One size', 5)] }
    const el = await open()
    expect(pill(el, 'One size').getAttribute('aria-pressed')).toBe('true')
    const add = vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    root(el).querySelector<HTMLButtonElement>('.add-to-cart')!.click()
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ variantId: 201 }))
  })

  it('the chosen size is shown pressed and beside the option name', async () => {
    const el = await open()
    pill(el, 'M').click()
    await settle(el)
    expect(pill(el, 'M').getAttribute('aria-pressed')).toBe('true')
    expect(pill(el, 'M').getAttribute('part')).toContain('option-selected')
    expect(text(el, '.option-label')).toBe('Størrelse: M')
  })
})

describe('the buy buttons ask for the size', () => {
  it('«Legg i handlekurv» without a size says «Velg størrelse» and adds nothing', async () => {
    const add = vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    const el = await open()
    root(el).querySelector<HTMLButtonElement>('.add-to-cart')!.click()
    await settle(el)
    expect(add).not.toHaveBeenCalled()
    expect(text(el, '.option-prompt')).toBe('Velg størrelse')
    expect(el.open).toBe(true)
  })

  it('«Kjøp nå med Vipps» without a size says «Velg størrelse» and starts nothing', async () => {
    const add = vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    const express = vi.spyOn(Vio.checkout, 'startVippsExpress').mockResolvedValue({} as any)
    const el = await open()
    root(el).querySelector<HTMLButtonElement>('.buy-vipps')!.click()
    await settle(el)
    expect(add).not.toHaveBeenCalled()
    expect(express).not.toHaveBeenCalled()
    expect(document.querySelector('.vio-redirect-overlay')).toBeNull()
    expect(text(el, '.option-prompt')).toBe('Velg størrelse')
  })

  it('choosing the size clears the prompt, and the add carries that variant', async () => {
    const add = vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    const el = await open()
    root(el).querySelector<HTMLButtonElement>('.add-to-cart')!.click()
    await settle(el)
    pill(el, 'M').click()
    await settle(el)
    expect(root(el).querySelector('.option-prompt')).toBeNull()
    root(el).querySelector<HTMLButtonElement>('.add-to-cart')!.click()
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ variantId: 102 }))
  })

  it('another option name asks for itself («Velg farge»)', async () => {
    product = {
      ...sized,
      options: [{ id: 2, name: 'Farge', order: 0, values: ['Brun', 'Blå'] }],
      variants: [variant(301, 'Brun', 4), variant(302, 'Blå', 4)],
    }
    const el = await open()
    root(el).querySelector<HTMLButtonElement>('.add-to-cart')!.click()
    await settle(el)
    expect(text(el, '.option-prompt')).toBe('Velg farge')
  })
})

describe('the express buttons before a size is chosen', () => {
  it('a first variant at 0 does not hide Vipps when the product and its other sizes have a price', async () => {
    product = {
      ...sized,
      variants: [{ ...variant(101, 'S', 2), price: { amount: 0, currency_code: 'NOK' } }, variant(102, 'M', 12), variant(103, 'L', 0)],
    }
    const el = await open()
    expect(root(el).querySelector('.buy-vipps')).not.toBeNull()
  })

  it('a product that costs nothing anywhere shows no Vipps', async () => {
    const free = { amount: 0, currency_code: 'NOK' }
    product = { ...sized, price: free, variants: sized.variants.map((v) => ({ ...v, price: free })) }
    const el = await open()
    expect(root(el).querySelector('.buy-vipps')).toBeNull()
  })
})

describe('«Få igjen» is about the chosen variant', () => {
  it('before a size: «På lager», not the first variant’s low count', async () => {
    const el = await open()
    expect(text(el, '.stock')).toBe('På lager')
  })

  it('a low size says «Få igjen — 2 stk»; a full one «På lager»; a sold-out one is not choosable', async () => {
    const el = await open()
    pill(el, 'S').click()
    await settle(el)
    expect(text(el, '.stock')).toBe('Få igjen — 2 stk')
    pill(el, 'M').click()
    await settle(el)
    expect(text(el, '.stock')).toBe('På lager')
    expect(pill(el, 'L').disabled).toBe(true)
  })

  it('the quantity follows the chosen size’s stock', async () => {
    const el = await open()
    el.quantity = 5
    pill(el, 'S').click()
    await settle(el)
    expect(el.quantity).toBe(2)
  })
})
