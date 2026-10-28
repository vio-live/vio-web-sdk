// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'

/**
 * The order of the sections below the gallery (0.34, asked by Replit for Mote
 * & Livsstil): `Vio.configureDetail({ layout })` for the page, the `layout`
 * property / attribute per element (it wins), the real DOM in that order, and
 * the layout really applied — `el.appliedLayout`, `vio:detail-layout-applied`,
 * `view_item` and the cart line origin.
 */

const variant = (id: number, size: string, quantity: number) => ({
  id,
  title: size,
  quantity,
  price: { amount: 599, currency_code: 'NOK' },
  images: [],
})

const product = {
  id: 9,
  brand: 'Careless',
  title: 'Vilde genser',
  description: '<p>Myk genser i ull.</p>',
  quantity: 14,
  price: { amount: 599, currency_code: 'NOK' },
  images: [{ id: 1, url: 'https://img.test/1.jpg', order: 0 }],
  options: [{ id: 1, name: 'Størrelse', order: 0, values: ['S', 'M', 'L'] }],
  variants: [variant(101, 'S', 2), variant(102, 'M', 12), variant(103, 'L', 0)],
}

const HIGHLIGHTS = [{ icon: 'plane', title: 'Rask levering' }]

beforeEach(() => {
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
  Vio.configureDetail({ layout: null })
  unmountAll()
  vi.restoreAllMocks()
})

async function open(props: Record<string, unknown> = {}, attrs: Record<string, string> = {}) {
  const el = await mount<HTMLElement & Record<string, any>>('vio-product-detail', { highlights: HIGHLIGHTS, ...props } as any)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.dispatchEvent(new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: '4' } }))
  for (let i = 0; i < 6; i++) await settle(el)
  return el
}
const root = (el: HTMLElement) => el.shadowRoot!
const kids = (node: Element | null) => [...(node?.children ?? [])].map((c) => c.className.trim())
const info = (el: HTMLElement) => root(el).querySelector('.info')!

describe('the default order (no configuration) is the DOM of 0.33', () => {
  it('brand, headline (title row + stock, price row), purchase (buy with the options first, then highlights, description, shipping)', async () => {
    const el = await open()
    expect(kids(info(el))).toEqual(['brand', 'headline', 'purchase'])
    const headline = root(el).querySelector('.info > .headline')!
    expect(kids(headline)).toEqual(['title-row', 'price-row'])
    expect(kids(headline.querySelector('.title-row'))).toEqual(['name', 'stock in-stock'])
    const purchase = root(el).querySelector('.info > .purchase')!
    expect(purchase.className).toBe('purchase')
    const inPurchase = kids(purchase)
    expect(inPurchase[0]).toBe('buy')
    expect(inPurchase[1]).toBe('highlights')
    expect(inPurchase[2]).toContain('description-block description-preview')
    expect(inPurchase[3]).toBe('description-block shipping-returns')
    expect(inPurchase).toHaveLength(4)
    expect(kids(purchase.querySelector('.buy'))[0]).toBe('buy-options')
    expect(root(el).querySelector('.options-apart')).toBeNull()
  })

  it('appliedLayout says the default', async () => {
    const el = await open()
    expect(el.appliedLayout).toEqual({
      id: 'default',
      revision: '0',
      sections: ['brand', 'title', 'stock', 'price', 'options', 'purchase', 'highlights', 'description', 'shippingReturns'],
      adjusted: [],
      source: 'default',
    })
  })
})

describe('a layout orders the real DOM', () => {
  it('the page layout: description first, the price before the title, no brand', async () => {
    Vio.configureDetail({
      layout: { id: 'pdp-b', revision: '2', sections: ['description', 'price', 'title', 'stock', 'options', 'purchase', 'shippingReturns'] },
    })
    const el = await open()
    const order = kids(info(el))
    expect(order[0]).toContain('description-block description-preview')
    expect(order.slice(1)).toEqual(['headline', 'purchase'])
    // price and title(+stock) are one headline run, in the asked order.
    expect(kids(root(el).querySelector('.headline'))).toEqual(['price-row', 'title-row'])
    expect(kids(root(el).querySelector('.title-row'))).toEqual(['name', 'stock in-stock'])
    expect(root(el).querySelector('.brand')).toBeNull()
    expect(root(el).querySelector('.highlights')).toBeNull()
    expect(kids(root(el).querySelector('.purchase'))).toEqual(['buy', 'description-block shipping-returns'])
    expect(kids(root(el).querySelector('.buy'))[0]).toBe('buy-options')
  })

  it('title and stock apart: each its own block', async () => {
    Vio.configureDetail({ layout: { id: 'apart', revision: '1', sections: ['stock', 'title', 'price', 'options', 'purchase'] } })
    const el = await open()
    expect(kids(root(el).querySelector('.headline'))).toEqual(['stock in-stock', 'title-row', 'price-row'])
    expect(kids(root(el).querySelector('.title-row'))).toEqual(['name'])
  })

  it('missing essentials come at the end; unknown and duplicate ids are said', async () => {
    Vio.configureDetail({ layout: { id: 'thin', revision: '1', sections: ['brand', 'reviews', 'brand', 'description'] } })
    const el = await open()
    expect(el.appliedLayout.sections).toEqual(['brand', 'description', 'title', 'price', 'options', 'purchase'])
    expect(el.appliedLayout.adjusted).toEqual([
      { section: 'reviews', reason: 'unknown' },
      { section: 'brand', reason: 'duplicate' },
      { section: 'title', reason: 'added-essential' },
      { section: 'price', reason: 'added-essential' },
      { section: 'options', reason: 'added-essential' },
      { section: 'purchase', reason: 'added-essential' },
    ])
    const order = kids(info(el))
    expect(order[0]).toBe('brand')
    expect(order[1]).toContain('description-block')
    expect(order.slice(2)).toEqual(['headline', 'purchase'])
  })

  it('a layout change re-renders an open detail', async () => {
    const el = await open()
    expect(kids(info(el))[0]).toBe('brand')
    Vio.configureDetail({ layout: { id: 'late', revision: '1', sections: ['title', 'price', 'brand', 'options', 'purchase'] } })
    await settle(el)
    expect(kids(info(el))).toEqual(['headline', 'brand', 'purchase'])
    Vio.configureDetail({ layout: null })
    await settle(el)
    expect(kids(info(el))).toEqual(['brand', 'headline', 'purchase'])
  })
})

describe('options outside the purchase group', () => {
  const layout = { id: 'sizes-up', revision: '1', sections: ['title', 'price', 'options', 'description', 'purchase'] }

  it('render as their own block, out of .buy', async () => {
    Vio.configureDetail({ layout })
    const el = await open()
    expect(kids(info(el))[1]).toBe('buy-options options-apart')
    expect(root(el).querySelector('.buy .buy-options')).toBeNull()
    expect(root(el).querySelector('.purchase')!.className).toBe('purchase options-apart')
  })

  it('the buy buttons still ask for the size and bring the options into view', async () => {
    Vio.configureDetail({ layout })
    const add = vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    const scroll = vi.fn()
    ;(Element.prototype as any).scrollIntoView = scroll
    const el = await open()
    root(el).querySelector<HTMLButtonElement>('.add-to-cart')!.click()
    await settle(el)
    expect(add).not.toHaveBeenCalled()
    expect(root(el).querySelector('.options-apart .option-prompt')?.textContent?.trim()).toBe('Velg størrelse')
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    delete (Element.prototype as any).scrollIntoView
  })
})

describe('element vs page', () => {
  it('the element layout (property) wins over the page one', async () => {
    Vio.configureDetail({ layout: { id: 'page', revision: '1', sections: ['description', 'title', 'price', 'options', 'purchase'] } })
    const el = await open({ layout: { id: 'own', revision: '4', sections: ['title', 'price', 'options', 'purchase', 'brand'] } })
    expect(el.appliedLayout).toMatchObject({ id: 'own', revision: '4', source: 'element' })
    expect(kids(info(el))).toEqual(['headline', 'purchase'])
    expect(kids(root(el).querySelector('.purchase')).at(-1)).toBe('brand')
  })

  it('the attribute takes the same layout as JSON; invalid JSON falls back to the page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const el = await open({}, { layout: JSON.stringify({ id: 'attr', revision: '1', sections: ['title', 'price', 'options', 'purchase'] }) })
    expect(el.appliedLayout).toMatchObject({ id: 'attr', source: 'element' })
    el.setAttribute('layout', '{nope')
    await settle(el)
    expect(el.appliedLayout.source).toBe('default')
    expect(warn).toHaveBeenCalled()
  })
})

describe('the applied layout is reported', () => {
  it('vio:detail-layout-applied once per product render with a layout, again on a change', async () => {
    const seen: any[] = []
    const onApplied = (e: Event) => seen.push((e as CustomEvent).detail)
    document.addEventListener('vio:detail-layout-applied', onApplied)
    Vio.configureDetail({ layout: { id: 'pdp-b', revision: '2', sections: ['title', 'price', 'options', 'purchase'], experimentId: 'exp-7', variantId: 'B' } })
    const el = await open()
    await settle(el)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: 'pdp-b', revision: '2', experimentId: 'exp-7', variantId: 'B', source: 'global', productId: 9 })
    Vio.configureDetail({ layout: null })
    await settle(el)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ id: 'default', source: 'default' })
    document.removeEventListener('vio:detail-layout-applied', onApplied)
  })

  it('view_item carries the layout of a non-default layout, as event context', async () => {
    const track = vi.spyOn(Vio.analytics, 'track').mockImplementation(() => {})
    Vio.configureDetail({ layout: { id: 'pdp-b', revision: '2', sections: ['title', 'price', 'options', 'purchase'], experimentId: 'exp-7', variantId: 'B' } })
    await open()
    const view = track.mock.calls.find(([name]) => name === 'view_item')!
    expect(view[1]!.context).toMatchObject({ layoutId: 'pdp-b', layoutRevision: '2', experimentId: 'exp-7', variantId: 'B' })
  })

  it('view_item of the default layout says nothing new', async () => {
    const track = vi.spyOn(Vio.analytics, 'track').mockImplementation(() => {})
    await open()
    const view = track.mock.calls.find(([name]) => name === 'view_item')!
    expect(view[1]!.context).not.toHaveProperty('layoutId')
    expect(view[1]!.context).not.toHaveProperty('variantId')
  })

  it('an add to cart carries the layout shown in the line origin and in vio:added-to-cart', async () => {
    Vio.configureDetail({ layout: { id: 'pdp-b', revision: '2', sections: ['title', 'price', 'options', 'purchase'], experimentId: 'exp-7', variantId: 'B' } })
    const add = vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    const added: any[] = []
    const onAdded = (e: Event) => added.push((e as CustomEvent).detail)
    document.addEventListener('vio:added-to-cart', onAdded)
    const el = await open({ noAddedToast: true })
    root(el).querySelectorAll<HTMLButtonElement>('.option-pill')[1]!.click()
    await settle(el)
    root(el).querySelector<HTMLButtonElement>('.add-to-cart')!.click()
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: 102,
        origin: expect.objectContaining({ layoutId: 'pdp-b', layoutRevision: '2', experimentId: 'exp-7', variantId: 'B' }),
      }),
    )
    expect(added[0]).toMatchObject({ variantId: 102, layout: { layoutId: 'pdp-b', layoutRevision: '2', experimentId: 'exp-7', variantId: 'B' } })
    document.removeEventListener('vio:added-to-cart', onAdded)
  })

  it('the default layout adds no layout to the origin', async () => {
    const add = vi.spyOn(Vio.cart, 'addProduct').mockReturnValue({} as any)
    const el = await open({ noAddedToast: true })
    root(el).querySelectorAll<HTMLButtonElement>('.option-pill')[1]!.click()
    await settle(el)
    root(el).querySelector<HTMLButtonElement>('.add-to-cart')!.click()
    expect(add.mock.calls[0]![0].origin).not.toHaveProperty('layoutId')
  })
})
