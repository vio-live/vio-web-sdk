// @vitest-environment jsdom
/**
 * Apple Pay on the product detail: the sheet's amount is fixed BEFORE the tap
 * (Apple blocks a sheet opened after an await), while the charge is the
 * sponsor's whole cart — the checkout is built on it. The sheet showed the
 * product's price and charged everything in the cart. Now the sheet opens
 * only when what it shows is what will be charged (an empty cart, a sheet
 * prepared for this product × quantity); otherwise the product is added and
 * the checkout opens with Apple Pay preselected, every line and the total on
 * screen — the same rule as «Kjøp nå med Vipps».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(async () => ({ cart_id: 'cart-1', line_items: [] })),
  addItem: vi.fn(async () => ({ cart_id: 'cart-1', currency: 'NOK', line_items: [] })),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  getCart: vi.fn(),
}))

vi.mock('../../core/api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { Vio } from '../../core/client.js'
import { VioProductDetail } from './vio-product-detail.js'
import { resetFailedLogos } from '../sponsor-identity.js'
import { ensureLocalStorage } from '../../core/cart/storage.testutil.js'
import { mount, unmountAll, settle } from '../test-harness.js'
import type { BootstrapResponse } from '../../core/types.js'

const SPONSOR = 4
const storage = ensureLocalStorage()

const product = {
  id: 9,
  brand: 'Careless',
  title: 'Vilde',
  quantity: 5,
  price: { amount: 899, currency_code: 'NOK' },
  images: [],
  variants: [],
  options: [],
}

const BOOT: BootstrapResponse = {
  campaign: { id: 10, name: 'Default' },
  primarySponsor: { id: SPONSOR, name: 'Careless', logoUrl: null, avatarUrl: null, commerce: { apiKey: 'key-4' } },
} as never

const facade = () => Vio as unknown as { cachedBootstrap: BootstrapResponse | null }

/** Document-level listeners, taken down after each test. */
const listeners: Array<() => void> = []
function heard(name: string): { calls: CustomEvent[] } {
  const calls: CustomEvent[] = []
  const on = (e: Event) => calls.push(e as CustomEvent)
  document.addEventListener(name, on)
  listeners.push(() => document.removeEventListener(name, on))
  return { calls }
}

type Detail = HTMLElement & { open: boolean; quantity: number; buyWithApplePay: () => void }
async function openDetail(): Promise<Detail> {
  const el = await mount<Detail>('vio-product-detail')
  document.dispatchEvent(
    new CustomEvent('vio:product-click', { detail: { productId: '9', sponsorId: String(SPONSOR) } }),
  )
  for (let i = 0; i < 5; i++) await settle(el)
  expect(el.open).toBe(true)
  return el
}

const productIds = () => Vio.cart.getCart(SPONSOR)?.items.map((i) => i.productId) ?? []


/** Every sheet prepared: its amount and its show(). */
const sheets: Array<{ amount: number; show: ReturnType<typeof vi.fn> }> = []
function preparesSheets(opts: { hold?: (amount: number) => boolean } = {}) {
  vi.spyOn(Vio.checkout, 'prepareApplePayFor').mockImplementation(((amount: number) => {
    const sheet = { amount, show: vi.fn(async () => {}) }
    sheets.push(sheet)
    if (opts.hold?.(amount)) return new Promise(() => {})
    return Promise.resolve({ available: true, show: sheet.show })
  }) as never)
}
const shown = () => sheets.filter((s) => s.show.mock.calls.length > 0)

describe('vio-product-detail — Apple Pay shows what it charges', () => {
  beforeEach(() => {
    sheets.length = 0
    storage.clear()
    Vio.cart.clearAllCarts()
    Vio.checkout.close()
    resetFailedLogos()
    facade().cachedBootstrap = BOOT
    const proto = VioProductDetail.prototype as unknown as Record<string, unknown>
    for (const m of ['loadAvailablePaymentMethods', 'loadVippsButton']) {
      if (typeof proto[m] === 'function') vi.spyOn(proto as never, m as never).mockResolvedValue(undefined as never)
    }
    vi.spyOn(Vio, 'commerceFor').mockReturnValue({
      channel: {
        product: {
          getByIds: vi.fn().mockResolvedValue([product]),
          getSellerCompany: vi.fn().mockResolvedValue('Careless AS'),
        },
      },
    } as never)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    await Vio.cart.waitForCartMutations(SPONSOR)
    for (const off of listeners.splice(0)) off()
    unmountAll()
    Vio.checkout.close()
    Vio.cart.clearAllCarts()
    facade().cachedBootstrap = null
    vi.restoreAllMocks()
  })

  it('an empty cart: the sheet opens, as before — its amount is the checkout total', async () => {
    preparesSheets()
    const el = await openDetail()
    const opened = heard('vio:checkout-open')

    el.buyWithApplePay()
    await settle(el)

    expect(shown()).toHaveLength(1)
    expect(opened.calls).toHaveLength(0)
    expect(productIds()).toEqual([9])
    // The checkout the sheet's authorize builds is this cart: its total is the sheet's.
    expect(Vio.checkout.currentState?.subtotal).toBe(899)
    expect(shown()[0]!.amount).toBe(Vio.checkout.currentState?.subtotal)
  })

  it('lines already in the cart: no sheet; the checkout opens with every line, Apple Pay preselected', async () => {
    preparesSheets()
    Vio.cart.addManual({ productId: 146, sponsorId: SPONSOR, brand: 'Careless', name: 'Sofie genser XL', unitPrice: 1299, currency: 'NOK', imageUrl: '' })
    await Vio.cart.waitForCartMutations(SPONSOR)
    const el = await openDetail()
    const opened = heard('vio:checkout-open')

    el.buyWithApplePay()
    await settle(el)

    // Before: a sheet for 899 that charged 2198.
    expect(shown()).toHaveLength(0)
    expect(productIds()).toEqual([146, 9])
    expect(opened.calls).toHaveLength(1)
    expect(opened.calls[0]!.detail).toMatchObject({ sponsorId: SPONSOR, paymentMethod: 'apple-pay', express: false })
    expect(el.open).toBe(false)
    // What the host does with the event: the checkout opens on the whole cart,
    // and its Apple Pay button charges that total (startApplePay → state.subtotal).
    Vio.checkout.open(SPONSOR)
    expect(Vio.checkout.currentState?.subtotal).toBe(2198)
    expect(Vio.checkout.currentState?.subtotal).toBe(Vio.cart.subtotalForSponsor(SPONSOR))
  })

  it('another quantity prepares the sheet again; the tap shows the sheet for product × quantity', async () => {
    preparesSheets()
    const el = await openDetail()
    el.quantity = 2
    await settle(el)
    await settle(el)
    expect(sheets.map((s) => s.amount)).toEqual([899, 1798])

    el.buyWithApplePay()
    await settle(el)
    expect(shown().map((s) => s.amount)).toEqual([1798])
    expect(Vio.checkout.currentState?.subtotal).toBe(1798)
  })

  it('a sheet still being prepared for the new quantity is never shown with the old amount: the checkout opens', async () => {
    preparesSheets({ hold: (amount) => amount === 1798 })
    const el = await openDetail()
    el.quantity = 2
    await settle(el)
    const opened = heard('vio:checkout-open')

    el.buyWithApplePay()
    await settle(el)

    expect(shown()).toHaveLength(0)
    expect(opened.calls).toHaveLength(1)
    expect(opened.calls[0]!.detail).toMatchObject({ paymentMethod: 'apple-pay' })
    expect(Vio.cart.subtotalForSponsor(SPONSOR)).toBe(1798)
  })
})
