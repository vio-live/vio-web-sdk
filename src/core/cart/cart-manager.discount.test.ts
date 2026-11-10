// @vitest-environment jsdom
/**
 * The discount code of a cart, asked for from code (`applyDiscountCode` /
 * `removeDiscountCode` — what a host's own "discount code" field calls).
 * Commerce takes one code per backend cart; whatever it answers, nothing
 * throws and a cart that did not take the code is as it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(async () => ({ cart_id: 'cart-1', line_items: [] })),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  getCart: vi.fn(),
  applyDiscount: vi.fn(),
  deleteAppliedDiscount: vi.fn(),
}))

vi.mock('../api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { CartManager, cartStorageKey } from './cart-manager.js'
import { ensureLocalStorage } from './storage.testutil.js'

const SPONSOR = 5
const OPTS = { sponsorResolved: true }

const line = (id: string, productId: number, title: string, quantity = 1) => ({
  id,
  product_id: productId,
  title,
  quantity,
  price: { amount: 100, amount_incl_taxes: 100, currency_code: 'NOK' },
})
const serverCart = (lines: Array<ReturnType<typeof line>>, extra: Record<string, unknown> = {}) => ({
  cart_id: 'cart-1',
  currency: 'NOK',
  line_items: lines,
  ...extra,
})
const JUMPER = line('srv-1', 146, 'Sofie genser XL')

/** A manager whose cart holds the jumper, synced with the backend. */
async function withJumper(): Promise<CartManager> {
  const m = new CartManager()
  gql.addItem.mockResolvedValueOnce(serverCart([JUMPER]))
  m.addManual({
    productId: 146,
    sponsorId: SPONSOR,
    brand: 'Careless',
    name: 'Sofie genser XL',
    unitPrice: 100,
    currency: 'NOK',
    imageUrl: '',
  })
  await m.waitForCartMutations(SPONSOR)
  return m
}

/** Let awaited mocks and their continuations run. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

const stored = () => JSON.parse(ensureLocalStorage().getItem(cartStorageKey('')) ?? '{}') as Record<string, { discountCode?: string }>

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  ensureLocalStorage().clear()
  gql.getCartGraphQLOptions.mockReset().mockImplementation(async () => ({ sponsorResolved: true }))
  gql.createCart.mockReset().mockImplementation(async () => ({ cart_id: 'cart-1', line_items: [] }))
  for (const fn of [gql.addItem, gql.updateItem, gql.deleteItem, gql.getCart, gql.applyDiscount, gql.deleteAppliedDiscount]) fn.mockReset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CartManager.applyDiscountCode', () => {
  it('a code Commerce takes: on the backend cart, remembered with the cart, and the lines read again', async () => {
    const m = await withJumper()
    gql.applyDiscount.mockResolvedValueOnce({ executed: true, message: '' })
    gql.getCart.mockResolvedValueOnce(serverCart([JUMPER], { discount_code: 'GAVE' }))
    const changes = vi.fn()
    m.addEventListener('change', changes)

    const result = await m.applyDiscountCode('  GAVE ')

    expect(result).toEqual({
      status: 'applied',
      code: 'GAVE',
      carts: [{ sponsorId: SPONSOR, status: 'applied', answer: { executed: true, message: '' } }],
    })
    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
    expect(gql.applyDiscount).toHaveBeenCalledWith('cart-1', 'GAVE', OPTS)
    // The lines are the server's again — asked together with the code the cart carries.
    expect(gql.getCart).toHaveBeenCalledTimes(1)
    expect(gql.getCart).toHaveBeenCalledWith('cart-1', OPTS, { discountCode: true })
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
    expect(m.discountCodeForSponsor(SPONSOR)).toBe('GAVE')
    expect(stored()[String(SPONSOR)]?.discountCode).toBe('GAVE')
    expect(changes).toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('a code Commerce refuses: the reason in the answer, a line in the console, and the cart is as it was', async () => {
    const m = await withJumper()
    gql.applyDiscount.mockResolvedValueOnce({ executed: false, message: 'COUPON_EXPIRED' })

    const result = await m.applyDiscountCode('NOPE')

    expect(result).toEqual({
      status: 'refused',
      code: 'NOPE',
      reason: 'COUPON_EXPIRED',
      carts: [
        {
          sponsorId: SPONSOR,
          status: 'refused',
          reason: 'COUPON_EXPIRED',
          message: 'COUPON_EXPIRED',
          answer: { executed: false, message: 'COUPON_EXPIRED' },
        },
      ],
    })
    expect(m.getCart(SPONSOR)?.discountCode).toBeUndefined()
    expect(m.getCart(SPONSOR)?.items.map((i) => i.name)).toEqual(['Sofie genser XL'])
    expect(gql.getCart).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a refusal in words the SDK does not know: refused all the same, with the words and no reason', async () => {
    const m = await withJumper()
    gql.applyDiscount.mockResolvedValueOnce({ executed: false, message: 'Something new' })
    const result = await m.applyDiscountCode('NOPE')
    expect(result.status).toBe('refused')
    expect(result).not.toHaveProperty('reason')
    expect(result.carts[0]).toMatchObject({ status: 'refused', message: 'Something new' })
    expect(result.carts[0]).not.toHaveProperty('reason')
  })

  it('everything Commerce answers reaches the caller, whatever the selection grows to', async () => {
    const m = await withJumper()
    const answer = { executed: true, message: '', added_line_items: [{ product_id: 500, quantity: 1 }] }
    gql.applyDiscount.mockResolvedValueOnce(answer)
    gql.getCart.mockResolvedValueOnce(serverCart([JUMPER], { discount_code: 'GAVE' }))
    const result = await m.applyDiscountCode('GAVE')
    expect(result.carts[0]!.answer).toEqual(answer)
  })

  it('a call that fails: `failed`, nothing thrown, the cart is as it was', async () => {
    const m = await withJumper()
    gql.applyDiscount.mockRejectedValueOnce(new Error('GraphQL request timed out after 15000ms'))

    const result = await m.applyDiscountCode('GAVE')

    expect(result.status).toBe('failed')
    expect(result.carts).toEqual([{ sponsorId: SPONSOR, status: 'failed', message: 'GraphQL request timed out after 15000ms' }])
    expect(m.getCart(SPONSOR)?.discountCode).toBeUndefined()
    expect(m.getCart(SPONSOR)?.items).toHaveLength(1)
  })

  it('no backend cart yet: `pending`, and nothing is asked', async () => {
    const m = new CartManager()
    await expect(m.applyDiscountCode('GAVE')).resolves.toEqual({ status: 'pending', code: 'GAVE', carts: [] })
    expect(gql.applyDiscount).not.toHaveBeenCalled()
  })

  it('what is not a code is never sent', async () => {
    const m = await withJumper()
    for (const bad of ['', '   ', 'TO ORD', 'x'.repeat(65), null as unknown as string]) {
      await expect(m.applyDiscountCode(bad)).resolves.toEqual({ status: 'refused', code: '', carts: [] })
    }
    expect(gql.applyDiscount).not.toHaveBeenCalled()
  })

  it('only the sponsor named, when one is', async () => {
    const m = await withJumper()
    await expect(m.applyDiscountCode('GAVE', 99)).resolves.toEqual({ status: 'pending', code: 'GAVE', carts: [] })
    expect(gql.applyDiscount).not.toHaveBeenCalled()
  })

  it('the same code again is asked again (it is harmless) and does not read the lines twice', async () => {
    const m = await withJumper()
    gql.applyDiscount.mockResolvedValue({ executed: true, message: '' })
    gql.getCart.mockResolvedValue(serverCart([JUMPER], { discount_code: 'GAVE' }))
    await m.applyDiscountCode('GAVE')
    await m.applyDiscountCode('GAVE')
    expect(gql.applyDiscount).toHaveBeenCalledTimes(2)
    expect(gql.getCart).toHaveBeenCalledTimes(1)
  })

  it('two calls at once for the same cart and code share one ApplyDiscount', async () => {
    const m = await withJumper()
    let answer!: (v: { executed: boolean; message: string }) => void
    gql.applyDiscount.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    gql.getCart.mockResolvedValue(serverCart([JUMPER], { discount_code: 'GAVE' }))
    const a = m.applyDiscountCode('GAVE')
    const b = m.applyDiscountCode('GAVE')
    await tick()
    answer({ executed: true, message: '' })
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.status).toBe('applied')
    expect(rb.status).toBe('applied')
    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
  })

  it('while Commerce answers (it asks the brand\'s shop): busy is said, and the rest of the cart goes on', async () => {
    const m = await withJumper()
    let answer!: (v: { executed: boolean; message: string }) => void
    gql.applyDiscount.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    gql.updateItem.mockResolvedValue(serverCart([{ ...JUMPER, quantity: 2 }]))
    gql.getCart.mockResolvedValue(serverCart([{ ...JUMPER, quantity: 2 }], { discount_code: 'GAVE' }))
    const busy: Array<string | undefined> = []
    m.addEventListener('change', () => busy.push(m.discountBusy(SPONSOR)?.kind))

    expect(m.discountBusy()).toBeUndefined()
    const applying = m.applyDiscountCode('GAVE')
    await tick()
    expect(m.discountBusy()).toEqual({ kind: 'applying', code: 'GAVE', sponsorId: SPONSOR })
    expect(m.discountBusy(SPONSOR)?.kind).toBe('applying')
    expect(m.discountBusy(99)).toBeUndefined()
    expect(busy).toContain('applying')

    // A tap on + while the code is being checked: sent at once, not behind it.
    m.adjustQuantity('srv-1', SPONSOR, +1)
    await m.waitForCartMutations(SPONSOR)
    expect(gql.updateItem).toHaveBeenCalledTimes(1)
    expect(m.getCart(SPONSOR)?.items[0]?.quantity).toBe(2)
    expect(m.discountBusy()?.kind).toBe('applying')

    answer({ executed: true, message: '' })
    await expect(applying).resolves.toMatchObject({ status: 'applied' })
    expect(m.discountBusy()).toBeUndefined()
    expect(busy[busy.length - 1]).toBeUndefined()
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
  })

  it('a code typed while the cart is still being created waits for its backend cart', async () => {
    const m = new CartManager()
    let created!: (v: { cart_id: string; line_items: never[] }) => void
    gql.createCart.mockImplementationOnce(() => new Promise((resolve) => (created = resolve)))
    gql.addItem.mockResolvedValueOnce(serverCart([JUMPER]))
    gql.applyDiscount.mockResolvedValueOnce({ executed: true, message: '' })
    gql.getCart.mockResolvedValue(serverCart([JUMPER], { discount_code: 'GAVE' }))
    m.addManual({ productId: 146, sponsorId: SPONSOR, brand: 'Careless', name: 'Sofie genser XL', unitPrice: 100, currency: 'NOK', imageUrl: '' })

    const applying = m.applyDiscountCode('GAVE')
    await tick()
    expect(gql.applyDiscount).not.toHaveBeenCalled()
    created({ cart_id: 'cart-1', line_items: [] })

    await expect(applying).resolves.toMatchObject({ status: 'applied' })
    expect(gql.applyDiscount).toHaveBeenCalledWith('cart-1', 'GAVE', OPTS)
  })

  it('a removal and an apply never overlap: one discount call at a time per cart', async () => {
    const m = await withJumper()
    gql.applyDiscount.mockResolvedValueOnce({ executed: true, message: '' })
    gql.getCart.mockResolvedValue(serverCart([JUMPER], { discount_code: 'GAVE' }))
    await m.applyDiscountCode('GAVE')

    const order: string[] = []
    let removed!: (v: { executed: boolean; message: string }) => void
    gql.deleteAppliedDiscount.mockImplementationOnce(() => {
      order.push('delete:start')
      return new Promise((resolve) => (removed = (v) => (order.push('delete:end'), resolve(v))))
    })
    gql.applyDiscount.mockImplementationOnce(async () => {
      order.push('apply')
      return { executed: true, message: '' }
    })
    gql.getCart.mockResolvedValue(serverCart([JUMPER]))
    const removing = m.removeDiscountCode()
    await tick()
    expect(m.discountBusy()).toEqual({ kind: 'removing', code: 'GAVE', sponsorId: SPONSOR })
    const applying = m.applyDiscountCode('NY')
    await tick()
    expect(order).toEqual(['delete:start'])
    removed({ executed: true, message: '' })
    await Promise.all([removing, applying])
    expect(order).toEqual(['delete:start', 'delete:end', 'apply'])
  })
})

describe('CartManager.removeDiscountCode', () => {
  async function withCode(): Promise<CartManager> {
    const m = await withJumper()
    gql.applyDiscount.mockResolvedValueOnce({ executed: true, message: '' })
    gql.getCart.mockResolvedValueOnce(serverCart([JUMPER], { discount_code: 'GAVE' }))
    await m.applyDiscountCode('GAVE')
    gql.getCart.mockReset()
    return m
  }

  it('takes the code off the backend cart, forgets it, and reads the lines again — as a cart without a code', async () => {
    const m = await withCode()
    gql.deleteAppliedDiscount.mockResolvedValueOnce({ executed: true, message: '' })
    gql.getCart.mockResolvedValueOnce(serverCart([JUMPER]))

    const result = await m.removeDiscountCode()

    expect(result).toEqual({
      removed: true,
      carts: [{ sponsorId: SPONSOR, code: 'GAVE', status: 'removed', answer: { executed: true, message: '' } }],
    })
    expect(gql.deleteAppliedDiscount).toHaveBeenCalledWith('cart-1', 'GAVE', OPTS)
    expect(m.getCart(SPONSOR)?.discountCode).toBeUndefined()
    expect(stored()[String(SPONSOR)]?.discountCode).toBeUndefined()
    // No code in play any more: the query a page without discounts sends.
    expect(gql.getCart).toHaveBeenCalledTimes(1)
    expect(gql.getCart).toHaveBeenCalledWith('cart-1', OPTS)
  })

  it('Commerce refuses, or the call fails: the code stays on the cart, and the answer says so', async () => {
    const m = await withCode()
    gql.deleteAppliedDiscount.mockResolvedValueOnce({ executed: false, message: 'no' })
    await expect(m.removeDiscountCode()).resolves.toEqual({
      removed: false,
      carts: [{ sponsorId: SPONSOR, code: 'GAVE', status: 'refused', message: 'no', answer: { executed: false, message: 'no' } }],
    })
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')

    gql.deleteAppliedDiscount.mockRejectedValueOnce(new Error('offline'))
    await expect(m.removeDiscountCode()).resolves.toEqual({
      removed: false,
      carts: [{ sponsorId: SPONSOR, code: 'GAVE', status: 'failed', message: 'offline' }],
    })
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
  })

  it('a cart without a code: nothing is asked', async () => {
    const m = await withJumper()
    await expect(m.removeDiscountCode()).resolves.toEqual({ removed: false, carts: [] })
    expect(gql.deleteAppliedDiscount).not.toHaveBeenCalled()
  })
})

describe('the code the server cart carries', () => {
  it('a GetCart that names it is believed: a code this tab did not put is adopted, and null clears one', async () => {
    const m = await withJumper()
    m.updateFromBackendCart(SPONSOR, serverCart([JUMPER], { discount_code: 'ANNEN' }))
    expect(m.getCart(SPONSOR)?.discountCode).toBe('ANNEN')
    m.updateFromBackendCart(SPONSOR, serverCart([JUMPER], { discount_code: null }))
    expect(m.getCart(SPONSOR)?.discountCode).toBeUndefined()
  })

  it('an answer that does not name the field says nothing about the code', async () => {
    const m = await withJumper()
    m.updateFromBackendCart(SPONSOR, serverCart([JUMPER], { discount_code: 'GAVE' }))
    m.updateFromBackendCart(SPONSOR, serverCart([JUMPER]))
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
  })

  it('a cart that carries a code is read with it, whoever put it there', async () => {
    const m = await withJumper()
    m.updateFromBackendCart(SPONSOR, serverCart([JUMPER], { discount_code: 'GAVE' }))
    gql.getCart.mockResolvedValueOnce(serverCart([JUMPER], { discount_code: 'GAVE' }))
    await m.refreshFromServer(SPONSOR)
    expect(gql.getCart).toHaveBeenCalledWith('cart-1', OPTS, { discountCode: true })
    expect(gql.applyDiscount).not.toHaveBeenCalled()
  })
})

describe('a page without discount codes', () => {
  it('asks for the cart exactly as before, and never for a discount', async () => {
    const m = await withJumper()
    gql.getCart.mockResolvedValue(serverCart([JUMPER]))
    await m.refreshFromServer(SPONSOR)
    await m.fetchCartFromBackend(SPONSOR)
    expect(gql.getCart).toHaveBeenCalledTimes(2)
    for (const call of gql.getCart.mock.calls) expect(call).toEqual(['cart-1', OPTS])
    expect(gql.applyDiscount).not.toHaveBeenCalled()
    expect(gql.deleteAppliedDiscount).not.toHaveBeenCalled()
    expect(m.getCart(SPONSOR)).not.toHaveProperty('discountCode')
  })
})
