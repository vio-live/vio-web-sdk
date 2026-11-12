// @vitest-environment jsdom
/**
 * A line the page never drew takes its image from the backend cart, and the
 * commerce gateway answers `image` as a LIST. QA, 2026-11-12 (Alan, #480): the
 * gift of `qa_gave` sat in the cart with a grey square while the carousel
 * showed its picture — GetCart had it, as `image: [{ id, url }]`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(async () => ({ cart_id: 'cart-1', line_items: [] })),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  getCart: vi.fn(),
}))

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { CartManager, lineImageUrl } from './cart-manager.js'
import { ensureLocalStorage } from './storage.testutil.js'

const SPONSOR = 1331
const P1_IMG = 'https://woo-dev.vio.live/wp-content/uploads/2026/11/p1.png'
const GIFT_IMG = 'https://woo-dev.vio.live/wp-content/uploads/2026/11/yellow-pillows.jpg'

/** GetCart as QA answered it for order 4719's cart (prices added). */
const line = (id: string, productId: number, title: string, url: string) => ({
  id,
  product_id: productId,
  variant_id: null,
  title,
  quantity: 1,
  image: [{ id: String(productId), url }],
  price: { amount: 1250, amount_incl_taxes: 1250, currency_code: 'NOK' },
})

describe('the image of a backend cart line', () => {
  beforeEach(() => {
    ensureLocalStorage().clear()
    gql.addItem.mockReset()
    gql.getCart.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('a line only the server has (a gift, another tab) gets the first image of the list', async () => {
    const m = new CartManager()
    gql.addItem.mockResolvedValueOnce({ cart_id: 'cart-1', currency: 'NOK', line_items: [line('l1', 411963, 'Producto Simple 1', P1_IMG)] })
    m.addManual({ productId: 411963, sponsorId: SPONSOR, brand: 'b', name: 'Producto Simple 1', unitPrice: 1250, currency: 'NOK', imageUrl: '' })
    await m.waitForCartMutations(SPONSOR)

    gql.getCart.mockResolvedValueOnce({
      cart_id: 'cart-1',
      currency: 'NOK',
      line_items: [line('l1', 411963, 'Producto Simple 1', P1_IMG), line('l2', 416099, 'Product Simple 3', GIFT_IMG)],
    })
    await m.refreshFromServer(SPONSOR)

    const items = m.getCart(SPONSOR)!.items
    expect(items.find((i) => i.productId === 416099)?.imageUrl).toBe(GIFT_IMG)
    // The page's own line had no image of its own: the server's fills it too.
    expect(items.find((i) => i.productId === 411963)?.imageUrl).toBe(P1_IMG)
  })

  it('every shape the backend may send', () => {
    expect(lineImageUrl([{ id: '1', url: GIFT_IMG }, { url: 'x' }])).toBe(GIFT_IMG)
    expect(lineImageUrl([null, { url: GIFT_IMG }])).toBe(GIFT_IMG)
    expect(lineImageUrl([GIFT_IMG])).toBe(GIFT_IMG)
    expect(lineImageUrl({ url: GIFT_IMG })).toBe(GIFT_IMG)
    expect(lineImageUrl(GIFT_IMG)).toBe(GIFT_IMG)
    expect(lineImageUrl([])).toBe('')
    expect(lineImageUrl(null)).toBe('')
    expect(lineImageUrl({})).toBe('')
  })
})
