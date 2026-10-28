// @vitest-environment jsdom
/**
 * Two tabs of the same site share the carts through localStorage, but each
 * tab read them once, at load. A payment in one tab left the other showing —
 * and adding to — a cart that was already paid; a line added in one tab was
 * not in the other until a reload (Mote & Livsstil, 2026-10-23). Other tabs'
 * writes arrive as `storage` events. Here two managers stand for two tabs and
 * the event is dispatched the way the browser would after a write — never to
 * the writer; here both hear it, and the writer's state already matches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  getCart: vi.fn(),
}))

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { CartManager, type CartUpdatedDetail } from './cart-manager.js'
import { ensureLocalStorage } from './storage.testutil.js'

const STORAGE_KEY = 'vio.cart.v1'
const SPONSOR = 5

const storage = ensureLocalStorage()
// One pair for the whole file: every manager listens to `storage` for as long
// as the window lives, so managers left over from earlier tests would answer too.
const tabA = new CartManager()
const tabB = new CartManager()

/** What the browser tells the OTHER tabs after one of them wrote the carts. */
function anotherTabWrote(key: string | null = STORAGE_KEY): void {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: key ? storage.getItem(key) : null }))
}

const serverCart = (cartId: string, lines: Array<[id: string, productId: number, title: string]>) => ({
  cart_id: cartId,
  currency: 'NOK',
  line_items: lines.map(([id, productId, title]) => ({
    id,
    product_id: productId,
    title,
    quantity: 1,
    price: { amount: 100, amount_incl_taxes: 100, currency_code: 'NOK' },
  })),
})

function add(m: CartManager, productId: number, name: string): void {
  m.addManual({ productId, sponsorId: SPONSOR, brand: 'Careless', name, unitPrice: 100, currency: 'NOK', imageUrl: '' })
}
const names = (m: CartManager) => m.getCart(SPONSOR)?.items.map((i) => i.name) ?? []

function cartUpdatedEvents() {
  const seen: CartUpdatedDetail[] = []
  const on = (e: Event) => seen.push((e as CustomEvent<CartUpdatedDetail>).detail)
  document.addEventListener('vio:cart-updated', on)
  return { seen, off: () => document.removeEventListener('vio:cart-updated', on) }
}

/** Tab A adds the jumper (backend cart `cart-1`) and tab B hears of it. */
async function jumperInBothTabs(): Promise<void> {
  gql.createCart.mockResolvedValueOnce({ cart_id: 'cart-1', line_items: [] })
  gql.addItem.mockResolvedValueOnce(serverCart('cart-1', [['srv-1', 146, 'Sofie genser XL']]))
  add(tabA, 146, 'Sofie genser XL')
  await tabA.waitForCartMutations(SPONSOR)
  anotherTabWrote()
}

describe('CartManager across tabs — what one tab writes, the others adopt', () => {
  beforeEach(() => {
    tabA.clearAllCarts()
    tabB.clearAllCarts()
    storage.clear()
    gql.getCartGraphQLOptions.mockReset().mockImplementation(async () => ({ sponsorResolved: true }))
    gql.createCart.mockReset()
    gql.addItem.mockReset()
    gql.updateItem.mockReset()
    gql.deleteItem.mockReset()
    gql.getCart.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a line added in tab A is in tab B — with the backend cart id — and B says so', async () => {
    gql.createCart.mockResolvedValueOnce({ cart_id: 'cart-1', line_items: [] })
    gql.addItem.mockResolvedValueOnce(serverCart('cart-1', [['srv-1', 146, 'Sofie genser XL']]))
    add(tabA, 146, 'Sofie genser XL')
    await tabA.waitForCartMutations(SPONSOR)
    expect(names(tabB)).toEqual([])

    const changes = vi.fn()
    tabB.addEventListener('change', changes)
    const events = cartUpdatedEvents()
    anotherTabWrote()
    events.off()
    tabB.removeEventListener('change', changes)

    expect(names(tabB)).toEqual(['Sofie genser XL'])
    expect(tabB.getCart(SPONSOR)?.cartId).toBe('cart-1')
    expect(tabB.getCart(SPONSOR)?.items[0]?.cartItemId).toBe('srv-1')
    expect(changes).toHaveBeenCalledTimes(1)
    // Only B changed: A wrote it and already had it.
    expect(events.seen).toEqual([
      expect.objectContaining({ sponsorId: SPONSOR, cartId: 'cart-1', itemCount: 1, source: 'storage' }),
    ])
  })

  it("a payment in tab A empties tab B too — and B's next add opens a NEW backend cart, not the paid one", async () => {
    await jumperInBothTabs()
    expect(tabB.getCart(SPONSOR)?.cartId).toBe('cart-1')

    // Tab A paid: the SDK clears the paid sponsor's cart there.
    tabA.clearSponsorCart(SPONSOR)
    anotherTabWrote()
    expect(tabB.getCart(SPONSOR)).toBeUndefined()
    expect(tabB.itemCount).toBe(0)

    // Tab B adds: a fresh backend cart; nothing goes to the paid one.
    gql.createCart.mockResolvedValueOnce({ cart_id: 'cart-2', line_items: [] })
    gql.addItem.mockResolvedValueOnce(serverCart('cart-2', [['srv-9', 147, 'Vilde XS']]))
    add(tabB, 147, 'Vilde XS')
    await tabB.waitForCartMutations(SPONSOR)
    expect(gql.createCart).toHaveBeenCalledTimes(2)
    expect(gql.addItem).toHaveBeenLastCalledWith('cart-2', expect.anything(), expect.anything())
    expect(tabB.getCart(SPONSOR)?.cartId).toBe('cart-2')
    expect(names(tabB)).toEqual(['Vilde XS'])
  })

  it('a sponsor this tab is mid-write for is left alone until its own answer lands', async () => {
    await jumperInBothTabs()
    // Tab B adds the top; its AddItem has not answered yet.
    let answer!: (cart: unknown) => void
    gql.addItem.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    add(tabB, 147, 'Vilde XS')
    expect(names(tabB)).toEqual(['Sofie genser XL', 'Vilde XS'])

    // Meanwhile tab A removes the jumper (its cart empties, its entry goes).
    gql.deleteItem.mockResolvedValueOnce(serverCart('cart-1', []))
    tabA.removeItem('srv-1', SPONSOR)
    await tabA.waitForCartMutations(SPONSOR)
    expect(storage.getItem(STORAGE_KEY)).toBe('{}')
    const events = cartUpdatedEvents()
    anotherTabWrote()
    events.off()
    // Not clobbered: B's optimistic line is still on its way.
    expect(names(tabB)).toEqual(['Sofie genser XL', 'Vilde XS'])
    expect(events.seen).toHaveLength(0)

    // B's own answer — the server's cart, without the jumper — is what B ends on.
    answer(serverCart('cart-1', [['srv-2', 147, 'Vilde XS']]))
    await tabB.waitForCartMutations(SPONSOR)
    expect(names(tabB)).toEqual(['Vilde XS'])
  })

  it('another key, or the same carts again, changes nothing', async () => {
    await jumperInBothTabs()
    const changes = vi.fn()
    tabB.addEventListener('change', changes)
    const events = cartUpdatedEvents()
    anotherTabWrote('vio.customer_session_id.v1')
    anotherTabWrote()
    events.off()
    tabB.removeEventListener('change', changes)
    expect(changes).not.toHaveBeenCalled()
    expect(events.seen).toHaveLength(0)
    expect(names(tabB)).toEqual(['Sofie genser XL'])
  })

  it('the other tab cleared the whole storage (key null): read as a reload', async () => {
    await jumperInBothTabs()
    storage.clear()
    anotherTabWrote(null)
    expect(tabB.getCart(SPONSOR)).toBeUndefined()
    expect(tabA.getCart(SPONSOR)).toBeUndefined()
  })
})
