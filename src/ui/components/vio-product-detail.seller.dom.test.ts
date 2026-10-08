// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'
import { createCommerceClient } from '../../core/api/commerce.js'

/**
 * The detail's header showed the product's brand ("SINDIG") — which the body
 * shows again under it. It now shows the seller's Company name, as set in
 * Vio Commerce → Settings → Company (Angelo, 2026-10-08).
 */

const SPONSOR = 5
const product = {
  id: 9,
  brand: 'SINDIG',
  title: 'Sindig Morris bordlampe',
  price: { amount: 1699, currency_code: 'NOK' },
  images: [],
  variants: [],
  options: [],
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const header = (el: HTMLElement) =>
  el.shadowRoot?.querySelector('.topbar-brand')?.textContent?.trim() ?? null

let seller: ReturnType<typeof vi.fn>

beforeEach(() => {
  const proto = VioProductDetail.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'loadVippsButton']) {
    if (typeof proto[m] === 'function') vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  seller = vi.fn()
  vi.spyOn(Vio, 'commerceFor').mockReturnValue({
    channel: { product: { getByIds: vi.fn().mockResolvedValue([product]), getSellerCompany: seller } },
  } as any)
})

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

async function open() {
  const el = await mount<HTMLElement>('vio-product-detail')
  document.dispatchEvent(
    new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: String(SPONSOR) } }),
  )
  for (let i = 0; i < 5; i++) await settle(el)
  return el
}

describe('the product detail header', () => {
  it("is the seller's Company name, not the brand", async () => {
    seller.mockResolvedValue('Bohus AS')
    const el = await open()
    expect(header(el)).toBe('Bohus AS')
    expect(seller).toHaveBeenCalledWith(9)
  })

  it('waits for it rather than flashing the brand first', async () => {
    const answer = deferred<string | null>()
    seller.mockReturnValue(answer.promise)
    const el = await open()
    expect(header(el)).toBe('')
    answer.resolve('Bohus AS')
    for (let i = 0; i < 3; i++) await settle(el)
    expect(header(el)).toBe('Bohus AS')
  })

  it('falls back to the brand when the seller has none, or the API does not say', async () => {
    seller.mockResolvedValue(null)
    const el = await open()
    expect(header(el)).toBe('SINDIG')
  })
})

describe('getSellerCompany', () => {
  it('asks outside the cache and never throws', async () => {
    const client = createCommerceClient({ endpoint: 'https://graph.test', apiKey: 'k' })
    const req = vi.spyOn(client.raw, 'request')
      .mockResolvedValueOnce({ Channel: { GetProductsByIds: [{ id: 9, supplier_company: ' Bohus AS ' }] } } as any)
      .mockRejectedValueOnce(new Error('Cannot query field "supplier_company" on type "Product".'))
    expect(await client.channel.product.getSellerCompany(9)).toBe('Bohus AS')
    expect((req.mock.calls as any[])[0][1]).toEqual({ productIds: [9], useCache: false })
    expect(await client.channel.product.getSellerCompany(9)).toBeNull()
  })
})
