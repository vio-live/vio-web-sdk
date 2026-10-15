// @vitest-environment jsdom
/**
 * Quick +/− bursts on a cart line (Alan, 2026-10-15, with screenshots): the
 * drawer fired one UpdateItem per click, in parallel, and every response
 * re-applied the whole backend cart — an older one landing after a newer
 * optimistic change rolled the quantity back, and the next click started
 * from the rolled-back value. The fix is in the manager: targets are computed
 * on its live state, one request is in flight per line, later targets are
 * coalesced, and a line keeps its optimistic quantity until its own sync
 * settles.
 *
 * jsdom on purpose: `vio:removed-from-cart` goes out on `document` and
 * counting it is part of what is pinned here.
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

import { CART_GRAPHQL_TIMEOUT_MS } from '../api/cart-queries.js'
import { CartManager } from './cart-manager.js'

const SPONSOR = 5

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let awaited mocks and their continuations run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** Line id → product id, so backend lines match the local ones. */
const productOf = (lineId: string) => Number(lineId.replace(/\D/g, ''))

/** A backend cart response, as Commerce returns it: the WHOLE cart. */
const serverCart = (lines: Record<string, number>) => ({
  cart_id: 'cart-1',
  currency: 'NOK',
  line_items: Object.entries(lines).map(([id, quantity]) => ({
    id,
    product_id: productOf(id),
    title: `P${productOf(id)}`,
    quantity,
    price: { amount: 100, amount_incl_taxes: 100, currency_code: 'NOK' },
  })),
})

/** Record every UpdateItem as a deferred so the test decides when it answers. */
function holdUpdates() {
  const sent: Array<{ id: string; qty: number; d: Deferred<unknown> }> = []
  gql.updateItem.mockImplementation((_cart: string, id: string, _ship: unknown, qty: number) => {
    const d = deferred()
    sent.push({ id, qty, d })
    return d.promise
  })
  return sent
}

/** A manager whose lines are already synced with the backend (ids `srv-N`). */
async function managerWith(lines: Record<string, number>): Promise<CartManager> {
  const m = new CartManager()
  gql.addItem.mockImplementation(async () => serverCart(lines))
  for (const [id, quantity] of Object.entries(lines)) {
    m.addManual({
      productId: productOf(id),
      sponsorId: SPONSOR,
      brand: 'B',
      name: `P${productOf(id)}`,
      unitPrice: 100,
      currency: 'NOK',
      imageUrl: '',
      quantity,
    })
  }
  await m.waitForCartMutations(SPONSOR)
  return m
}

const qty = (m: CartManager, id: string) =>
  m.getCart(SPONSOR)?.items.find((i) => i.id === id)?.quantity
const ids = (m: CartManager) => m.getCart(SPONSOR)?.items.map((i) => i.id) ?? []

describe('CartManager — quantity bursts', () => {
  beforeEach(() => {
    localStorage.clear()
    gql.getCartGraphQLOptions.mockReset().mockImplementation(async () => ({ sponsorResolved: true }))
    gql.addItem.mockReset()
    gql.updateItem.mockReset()
    gql.deleteItem.mockReset()
    gql.getCart.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('five quick increments from 1 land on 6: one request in flight at a time, the last one with 6', async () => {
    const m = await managerWith({ 'srv-1': 1 })
    const sent = holdUpdates()

    for (let i = 0; i < 5; i++) m.adjustQuantity('srv-1', SPONSOR, +1)
    expect(qty(m, 'srv-1')).toBe(6) // optimistic, at once
    await tick()
    expect(sent.map((s) => s.qty)).toEqual([2]) // only the first one went out

    // The first answer (2) arrives while the shopper is already at 6.
    sent[0]!.d.resolve(serverCart({ 'srv-1': 2 }))
    await tick()
    expect(qty(m, 'srv-1')).toBe(6) // not rolled back
    expect(sent.map((s) => s.qty)).toEqual([2, 6]) // 3, 4, 5 were coalesced away

    sent[1]!.d.resolve(serverCart({ 'srv-1': 6 }))
    await m.waitForCartMutations(SPONSOR)
    expect(qty(m, 'srv-1')).toBe(6)
    expect(gql.updateItem).toHaveBeenCalledTimes(2)
  })

  it('responses out of order: the last intent wins, not the last answer to arrive', async () => {
    const m = await managerWith({ 'srv-1': 1, 'srv-2': 1 })
    const sent = holdUpdates()

    m.adjustQuantity('srv-1', SPONSOR, +1) // slow
    m.adjustQuantity('srv-2', SPONSOR, +1) // fast
    await tick()
    expect(sent.map((s) => s.id)).toEqual(['srv-1', 'srv-2'])

    // srv-2 answers first and, as Commerce does, carries the whole cart — with
    // srv-1 still at 1 because its update has not been processed yet.
    sent[1]!.d.resolve(serverCart({ 'srv-1': 1, 'srv-2': 2 }))
    await tick()
    expect(qty(m, 'srv-1')).toBe(2) // kept: its own sync is still in flight
    expect(qty(m, 'srv-2')).toBe(2)

    sent[0]!.d.resolve(serverCart({ 'srv-1': 2, 'srv-2': 2 }))
    await m.waitForCartMutations(SPONSOR)
    expect(qty(m, 'srv-1')).toBe(2)
    expect(qty(m, 'srv-2')).toBe(2)
  })

  it('a stale backend snapshot applied mid-burst keeps the intended quantity', async () => {
    const m = await managerWith({ 'srv-1': 1 })
    holdUpdates() // never answered: 2 in flight, 3 queued
    m.adjustQuantity('srv-1', SPONSOR, +1)
    m.adjustQuantity('srv-1', SPONSOR, +1)
    // What a slow GetCart / AddItem from before the burst would do.
    m.updateFromBackendCart(SPONSOR, serverCart({ 'srv-1': 1 }))
    expect(qty(m, 'srv-1')).toBe(3)
  })

  it('a burst that ends at 0 removes the line once: one DeleteItem, one vio:removed-from-cart, no ghost', async () => {
    const m = await managerWith({ 'srv-1': 2, 'srv-2': 1 })
    const removed = vi.fn()
    document.addEventListener('vio:removed-from-cart', removed)
    const sent = holdUpdates()
    gql.deleteItem.mockImplementation(async () => serverCart({ 'srv-2': 1 }))

    m.adjustQuantity('srv-1', SPONSOR, -1) // 1 — sent
    m.adjustQuantity('srv-1', SPONSOR, -1) // 0 — removed locally, queued behind the 1
    m.adjustQuantity('srv-1', SPONSOR, -1) // the line is gone: nothing
    expect(m.getCart(SPONSOR)?.items.map((i) => i.id)).toEqual(['srv-2'])
    expect(removed).toHaveBeenCalledTimes(1)
    await tick()
    expect(sent.map((s) => s.qty)).toEqual([1])

    // The answer to "1" still lists the line: it must not come back for a frame.
    sent[0]!.d.resolve(serverCart({ 'srv-1': 1, 'srv-2': 1 }))
    await tick()
    expect(m.getCart(SPONSOR)?.items.map((i) => i.id)).toEqual(['srv-2'])

    await m.waitForCartMutations(SPONSOR)
    expect(gql.deleteItem).toHaveBeenCalledTimes(1)
    expect(gql.deleteItem).toHaveBeenCalledWith('cart-1', 'srv-1', expect.anything())
    expect(gql.updateItem).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledTimes(1)
    expect(m.getCart(SPONSOR)?.items.map((i) => i.id)).toEqual(['srv-2'])
    document.removeEventListener('vio:removed-from-cart', removed)
  })

  it('decrementing below 0 sends nothing, and a negative target is a plain removal', async () => {
    gql.deleteItem.mockImplementation(async () => serverCart({}))
    const m = await managerWith({ 'srv-1': 1 })
    m.adjustQuantity('srv-1', SPONSOR, -1) // 0 → removed, DeleteItem
    m.adjustQuantity('srv-1', SPONSOR, -1) // gone
    m.updateQuantity('srv-1', SPONSOR, -4) // gone
    await m.waitForCartMutations(SPONSOR)
    expect(gql.deleteItem).toHaveBeenCalledTimes(1)
    expect(gql.updateItem).not.toHaveBeenCalled()
    expect(m.itemCount).toBe(0)

    const m2 = await managerWith({ 'srv-1': 1 })
    m2.updateQuantity('srv-1', SPONSOR, -3)
    await m2.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).not.toHaveBeenCalled()
    expect(gql.deleteItem).toHaveBeenCalledTimes(2)
    expect(gql.deleteItem).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.any(Number))
  })

  it('asking again for the quantity already reached (a stale render) sends nothing', async () => {
    const m = await managerWith({ 'srv-1': 1 })
    holdUpdates()
    m.updateQuantity('srv-1', SPONSOR, 1)
    await tick()
    expect(gql.updateItem).not.toHaveBeenCalled()
  })

  it('a rejected update reconciles from the server, emits change + error, and drops what was queued', async () => {
    const m = await managerWith({ 'srv-1': 1 })
    const sent = holdUpdates()
    gql.getCart.mockImplementation(async () => serverCart({ 'srv-1': 1 }))
    const change = vi.fn()
    const error = vi.fn()
    m.addEventListener('change', change)
    m.addEventListener('error', error)

    m.adjustQuantity('srv-1', SPONSOR, +1) // 2 — sent
    m.adjustQuantity('srv-1', SPONSOR, +1) // 3 — queued
    expect(qty(m, 'srv-1')).toBe(3)
    change.mockClear()
    await tick()

    sent[0]!.d.reject(new Error('Out of stock'))
    await m.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(1) // the queued 3 never went out
    expect(gql.getCart).toHaveBeenCalledTimes(1)
    expect(qty(m, 'srv-1')).toBe(1) // what the server says
    expect(error).toHaveBeenCalledTimes(1)
    expect(change).toHaveBeenCalled()
  })

  // ---- Review of 2026-10-16 (W1–W5 + nit) ----

  it('W1: a final answer discarded by the per-sponsor seq race still reconciles its own line (stock clamp)', async () => {
    const m = await managerWith({ 'srv-1': 1, 'srv-2': 1 })
    const sent = holdUpdates()
    m.adjustQuantity('srv-1', SPONSOR, +4) // asks for 5 — slow
    m.adjustQuantity('srv-2', SPONSOR, +1) // asks for 2 — fast
    await tick()
    sent[1]!.d.resolve(serverCart({ 'srv-1': 1, 'srv-2': 2 })) // B answers first
    await tick()
    expect(qty(m, 'srv-1')).toBe(5)

    const change = vi.fn()
    m.addEventListener('change', change)
    // A answers later, clamped to 3 by stock and repriced. Its seq is older
    // than B's, so the whole-cart apply is skipped — the line must take it.
    const clamped = serverCart({ 'srv-1': 3, 'srv-2': 2 })
    clamped.line_items[0]!.price = { amount: 90, amount_incl_taxes: 90, currency_code: 'NOK' }
    sent[0]!.d.resolve(clamped)
    await m.waitForCartMutations(SPONSOR)
    expect(qty(m, 'srv-1')).toBe(3)
    expect(m.getCart(SPONSOR)?.items.find((i) => i.id === 'srv-1')?.unitPrice).toBe(90)
    expect(qty(m, 'srv-2')).toBe(2)
    expect(change).toHaveBeenCalled()
  })

  it('W2: a removal queued behind a rejected update is still sent — and the line never comes back', async () => {
    const m = await managerWith({ 'srv-1': 1, 'srv-2': 1 })
    const removed = vi.fn()
    document.addEventListener('vio:removed-from-cart', removed)
    const sent = holdUpdates()
    const del = deferred()
    gql.deleteItem.mockImplementation(() => del.promise)
    // The server refused the +, so it still has the line at 1.
    gql.getCart.mockImplementation(async () => serverCart({ 'srv-1': 1, 'srv-2': 1 }))

    m.adjustQuantity('srv-1', SPONSOR, +1) // 2 — in flight
    m.removeItem('srv-1', SPONSOR) // X — queued as 0
    expect(removed).toHaveBeenCalledTimes(1)
    expect(ids(m)).toEqual(['srv-2'])
    await tick()
    sent[0]!.d.reject(new Error('Out of stock'))
    await tick()
    expect(gql.getCart).toHaveBeenCalledTimes(1)
    expect(ids(m)).toEqual(['srv-2']) // the reconcile did not resurrect it
    expect(gql.deleteItem).toHaveBeenCalledTimes(1)
    expect(gql.deleteItem).toHaveBeenCalledWith('cart-1', 'srv-1', expect.anything())

    del.resolve(serverCart({ 'srv-2': 1 }))
    await m.waitForCartMutations(SPONSOR)
    expect(ids(m)).toEqual(['srv-2'])
    expect(removed).toHaveBeenCalledTimes(1)
    document.removeEventListener('vio:removed-from-cart', removed)
  })

  it('W2: the queued removal is retried once, not forever — a second refusal reconciles the line back', async () => {
    const m = await managerWith({ 'srv-1': 1, 'srv-2': 1 })
    const sent = holdUpdates()
    gql.deleteItem.mockRejectedValue(new Error('locked'))
    gql.getCart.mockImplementation(async () => serverCart({ 'srv-1': 1, 'srv-2': 1 }))
    m.adjustQuantity('srv-1', SPONSOR, +1)
    m.removeItem('srv-1', SPONSOR)
    await tick()
    sent[0]!.d.reject(new Error('Out of stock'))
    await m.waitForCartMutations(SPONSOR)
    expect(gql.deleteItem).toHaveBeenCalledTimes(1)
    expect(gql.getCart).toHaveBeenCalledTimes(2)
    expect(ids(m)).toEqual(['srv-1', 'srv-2']) // the server kept it: so do we
  })

  it('W3: removing a line while its AddItem is in flight emits vio:removed-from-cart once and sends one DeleteItem', async () => {
    const m = await managerWith({ 'srv-1': 1 })
    const removed = vi.fn()
    document.addEventListener('vio:removed-from-cart', removed)
    const add = deferred()
    gql.addItem.mockImplementation(() => add.promise)
    gql.deleteItem.mockImplementation(async () => serverCart({ 'srv-1': 1 }))

    const line = m.addManual({
      productId: 2, sponsorId: SPONSOR, brand: 'B', name: 'P2', unitPrice: 100, currency: 'NOK', imageUrl: '',
    })
    m.removeItem(line.id, SPONSOR) // before the backend id exists
    expect(removed).toHaveBeenCalledTimes(1)
    expect(ids(m)).toEqual(['srv-1'])

    add.resolve(serverCart({ 'srv-1': 1, 'srv-2': 1 })) // the AddItem lands, listing the line
    await m.waitForCartMutations(SPONSOR)
    expect(ids(m)).toEqual(['srv-1']) // no ghost line
    expect(removed).toHaveBeenCalledTimes(1) // no second event from the replay
    expect(gql.deleteItem).toHaveBeenCalledTimes(1)
    expect(gql.deleteItem).toHaveBeenCalledWith('cart-1', 'srv-2', expect.anything())
    document.removeEventListener('vio:removed-from-cart', removed)
  })

  it('nit: +, +, − while in flight sends nothing redundant — the server already has 2', async () => {
    const m = await managerWith({ 'srv-1': 1 })
    const sent = holdUpdates()
    m.adjustQuantity('srv-1', SPONSOR, +1)
    m.adjustQuantity('srv-1', SPONSOR, +1)
    m.adjustQuantity('srv-1', SPONSOR, -1)
    expect(qty(m, 'srv-1')).toBe(2)
    await tick()
    sent[0]!.d.resolve(serverCart({ 'srv-1': 2 }))
    await m.waitForCartMutations(SPONSOR)
    expect(sent.map((s) => s.qty)).toEqual([2])
    expect(qty(m, 'srv-1')).toBe(2)
  })

  it('W5: an UpdateItem that never answers times out and counts as a rejection — GetCart reconcile, no eternal lock', async () => {
    const m = await managerWith({ 'srv-1': 1 })
    // The real updateItem → executeCartGraphQL, over a fetch that never answers.
    const real = await vi.importActual<typeof import('../api/cart-queries.js')>('../api/cart-queries.js')
    gql.getCartGraphQLOptions.mockImplementation(
      async () => ({ sponsorResolved: true, apiKey: 'k', endpoint: 'http://commerce.test' }) as never,
    )
    gql.updateItem.mockImplementation(real.updateItem as never)
    const fetchSpy = vi.fn(() => new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetchSpy)
    gql.getCart.mockImplementation(async () => serverCart({ 'srv-1': 1 }))
    const error = vi.fn()
    m.addEventListener('error', error)

    vi.useFakeTimers()
    try {
      m.adjustQuantity('srv-1', SPONSOR, +1)
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      const settled = m.waitForCartMutations(SPONSOR)
      await vi.advanceTimersByTimeAsync(CART_GRAPHQL_TIMEOUT_MS)
      await settled
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.signal?.aborted).toBe(true)
    expect(gql.getCart).toHaveBeenCalledTimes(1)
    expect(qty(m, 'srv-1')).toBe(1)
    expect(error).toHaveBeenCalled()
  })

})
