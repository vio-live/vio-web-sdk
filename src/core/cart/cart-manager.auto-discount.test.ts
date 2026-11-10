// @vitest-environment jsdom
/**
 * The page's own discount code (`Vio.init({ discountCode })`, or the
 * `?vio_discount=` the tab remembers): put on the cart without the shopper
 * typing it, through the same call the field makes. Commerce asks the brand's
 * shop about it (seconds), so nothing in the cart waits for it — only a
 * checkout or a payment does (`settleDiscountCode`). Asked once the cart has
 * lines, once per cart and code, again only when the answer could change, and
 * never at all on a page without a code.
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
import { syncDiscountParam } from './discount-code.js'
import { ensureLocalStorage } from './storage.testutil.js'
import { Configuration } from '../configuration.js'
import { resetStorageMemory } from '../safe-storage.js'

const SPONSOR = 5
const OPTS = { sponsorResolved: true }

const line = (id: string, productId: number, title: string, quantity = 1) => ({
  id,
  product_id: productId,
  title,
  quantity,
  price: { amount: 100, amount_incl_taxes: 100, currency_code: 'NOK' },
})
const serverCart = (lines: Array<ReturnType<typeof line>>, extra: Record<string, unknown> = {}, cartId = 'cart-1') => ({
  cart_id: cartId,
  currency: 'NOK',
  line_items: lines,
  ...extra,
})
const JUMPER = line('srv-1', 146, 'Sofie genser XL')
const TOP = line('srv-2', 147, 'Vilde XS')

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
/** Until nothing of the cart is in flight: its mutations, a discount call and what follows it. */
async function idle(m: CartManager) {
  for (let quiet = 0; quiet < 4; ) {
    await m.waitForCartMutations(SPONSOR)
    await tick()
    quiet = m.discountBusy() ? 0 : quiet + 1
  }
}

/** Every backend call, in order. */
let order: string[]
/** The fake server's cart: the code it carries (set when an ApplyDiscount is taken) and its lines. */
let serverCode: string | null
let serverLines: Array<ReturnType<typeof line>>
const record = (name: string, fn: ReturnType<typeof vi.fn>) =>
  fn.mockImplementation(async () => undefined).mockName(name)

function addJumper(m: CartManager) {
  gql.addItem.mockImplementationOnce(async () => (order.push('AddItem'), serverCart([JUMPER], {}, m.getCart(SPONSOR)?.cartId ?? 'cart-1')))
  m.addManual({ productId: 146, sponsorId: SPONSOR, brand: 'Careless', name: 'Sofie genser XL', unitPrice: 100, currency: 'NOK', imageUrl: '' })
}

/** Commerce's answers to ApplyDiscount, in order (the last one repeats). */
function applyAnswers(...answers: Array<{ executed: boolean; message: string } | Error>) {
  let i = 0
  gql.applyDiscount.mockImplementation(async () => {
    order.push('ApplyDiscount')
    const answer = answers[Math.min(i++, answers.length - 1)]!
    if (answer instanceof Error) throw answer
    if (answer.executed) serverCode = String(gql.applyDiscount.mock.calls.at(-1)?.[1])
    return answer
  })
}

/** + on the jumper: the server answers with two of it, and keeps them. */
function plusOne(m: CartManager) {
  serverLines = [{ ...JUMPER, quantity: 2 }]
  const cartId = m.getCart(SPONSOR)?.cartId ?? 'cart-1'
  gql.updateItem.mockImplementationOnce(async () => (order.push('UpdateItem'), serverCart(serverLines, {}, cartId)))
  m.adjustQuantity('srv-1', SPONSOR, +1)
}
const TAKEN = { executed: true, message: '' }

function page(config: { discountCode?: string } = {}) {
  Configuration.init({ apiKey: 'surface-key', ...config })
}

beforeEach(() => {
  order = []
  serverCode = null
  serverLines = [JUMPER]
  ensureLocalStorage().clear()
  resetStorageMemory()
  syncDiscountParam('?vio_discount=')
  for (const [name, fn] of Object.entries(gql)) if (name !== 'getCartGraphQLOptions' && name !== 'createCart') record(name, fn)
  gql.getCartGraphQLOptions.mockReset().mockImplementation(async () => ({ sponsorResolved: true }))
  let carts = 0
  gql.createCart.mockReset().mockImplementation(async () => (order.push('CreateCart'), { cart_id: `cart-${++carts}`, line_items: [] }))
  gql.getCart.mockImplementation(async (cartId: string, _o: unknown, extra?: { discountCode?: boolean }) => {
    order.push(extra?.discountCode ? 'GetCart+code' : 'GetCart')
    return serverCart(serverLines, extra?.discountCode ? { discount_code: serverCode } : {}, cartId)
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  Configuration.reset()
  syncDiscountParam('?vio_discount=')
  vi.restoreAllMocks()
})

describe('Vio.init({ discountCode }) — the code goes on the cart by itself', () => {
  it('first add: cart and line as always, THEN the code, and the lines read again with what it takes off them', async () => {
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN)
    const m = new CartManager()
    addJumper(m)
    await idle(m)

    expect(order).toEqual(['CreateCart', 'AddItem', 'ApplyDiscount', 'GetCart+code'])
    expect(gql.applyDiscount).toHaveBeenCalledWith('cart-1', 'GAVE', OPTS)
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
  })

  it('the add does not wait for it: the line is synced while Commerce is still asking the brand\'s shop', async () => {
    page({ discountCode: 'GAVE' })
    let answer!: (v: typeof TAKEN) => void
    gql.applyDiscount.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const m = new CartManager()
    addJumper(m)
    await m.waitForCartMutations(SPONSOR)
    await tick()

    expect(m.getCart(SPONSOR)?.items[0]?.cartItemId).toBe('srv-1')
    expect(m.discountBusy(SPONSOR)).toEqual({ kind: 'applying', code: 'GAVE', sponsorId: SPONSOR })
    expect(m.getCart(SPONSOR)?.discountCode).toBeUndefined()

    serverCode = 'GAVE'
    answer(TAKEN)
    await idle(m)
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
  })

  it('once it is on the cart it is not asked for again: more adds, quantities, reads and a checkout', async () => {
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN)
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    serverLines = [JUMPER, TOP]
    gql.addItem.mockImplementationOnce(async () => serverCart(serverLines))
    m.addManual({ productId: 147, sponsorId: SPONSOR, brand: 'Careless', name: 'Vilde XS', unitPrice: 100, currency: 'NOK', imageUrl: '' })
    await idle(m)
    await m.refreshFromServer(SPONSOR)
    await m.settleDiscountCode(SPONSOR)
    await idle(m)

    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
  })

  it('a code Commerce refuses for good (expired, unknown, used up, not for here): asked once, and the cart goes on without it', async () => {
    for (const reason of ['COUPON_EXPIRED', 'COUPON_NOT_FOUND', 'COUPON_USAGE_LIMIT', 'COUPON_NOT_SUPPORTED', 'Something new']) {
      ensureLocalStorage().clear()
      gql.applyDiscount.mockClear()
      serverLines = [JUMPER]
      page({ discountCode: 'GAVE' })
      applyAnswers({ executed: false, message: reason })
      const m = new CartManager()
      addJumper(m)
      await idle(m)
      await m.refreshFromServer(SPONSOR)
      await m.settleDiscountCode(SPONSOR)
      plusOne(m)
      await idle(m)

      expect(gql.applyDiscount, reason).toHaveBeenCalledTimes(1)
      expect(m.getCart(SPONSOR)?.discountCode).toBeUndefined()
      expect(m.getCart(SPONSOR)?.items[0]?.quantity).toBe(2)
    }
  })

  it('a code that asks for more in the cart is asked for again when the lines change — not before', async () => {
    page({ discountCode: 'GAVE' })
    applyAnswers({ executed: false, message: 'COUPON_MIN_AMOUNT' }, TAKEN)
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    await m.refreshFromServer(SPONSOR)
    await m.settleDiscountCode(SPONSOR)
    await idle(m)
    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)

    plusOne(m)
    await idle(m)

    expect(gql.applyDiscount).toHaveBeenCalledTimes(2)
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
    expect(m.getCart(SPONSOR)?.items[0]?.quantity).toBe(2)
  })

  it('a call that fails (or a shop that cannot be asked) is tried once more, then left alone until the lines change', async () => {
    for (const cannotSay of [new Error('timed out'), { executed: false, message: 'COUPON_UNAVAILABLE' }]) {
      ensureLocalStorage().clear()
      gql.applyDiscount.mockClear()
      serverLines = [JUMPER]
      page({ discountCode: 'GAVE' })
      applyAnswers(cannotSay)
      const m = new CartManager()
      addJumper(m)
      await idle(m)
      expect(gql.applyDiscount).toHaveBeenCalledTimes(1)

      await m.settleDiscountCode(SPONSOR)
      expect(gql.applyDiscount).toHaveBeenCalledTimes(2)
      await m.settleDiscountCode(SPONSOR)
      await m.refreshFromServer(SPONSOR)
      await idle(m)
      expect(gql.applyDiscount).toHaveBeenCalledTimes(2)

      plusOne(m)
      await idle(m)
      expect(gql.applyDiscount).toHaveBeenCalledTimes(3)
      expect(m.getCart(SPONSOR)?.items[0]?.quantity).toBe(2)
    }
  })

  it('settleDiscountCode waits for the answer — what a checkout or a payment is built after', async () => {
    page({ discountCode: 'GAVE' })
    let answer!: (v: typeof TAKEN) => void
    gql.applyDiscount.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const m = new CartManager()
    addJumper(m)
    await m.waitForCartMutations(SPONSOR)
    await tick()

    let settled = false
    const settling = m.settleDiscountCode(SPONSOR).then(() => (settled = true))
    await tick()
    expect(settled).toBe(false)
    serverCode = 'GAVE'
    answer(TAKEN)
    await settling
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
  })

  it('a new cart (after a purchase) is given the code again', async () => {
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN)
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    m.clearSponsorCart(SPONSOR)
    addJumper(m)
    await idle(m)

    expect(gql.applyDiscount).toHaveBeenCalledTimes(2)
    expect(gql.applyDiscount).toHaveBeenLastCalledWith('cart-2', 'GAVE', OPTS)
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
  })

  it('an empty cart is not asked: a code is asked for once there is something to discount', async () => {
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN)
    const m = new CartManager()
    await m.ensureCartId(SPONSOR)
    await m.settleDiscountCode(SPONSOR)
    m.ensureDiscountCodes()
    await idle(m)
    expect(gql.applyDiscount).not.toHaveBeenCalled()
  })

  it('a cart that already carries another code keeps it: one code per cart', async () => {
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN)
    const m = new CartManager()
    ensureLocalStorage().clear()
    gql.addItem.mockImplementationOnce(async () => serverCart([JUMPER]))
    // The server cart says it carries another code as soon as it is read.
    m.addManual({ productId: 146, sponsorId: SPONSOR, brand: 'Careless', name: 'Sofie genser XL', unitPrice: 100, currency: 'NOK', imageUrl: '' })
    m.getCart(SPONSOR)!.discountCode = 'ANNEN'
    await idle(m)
    await m.settleDiscountCode(SPONSOR)
    expect(gql.applyDiscount).not.toHaveBeenCalled()
    expect(m.getCart(SPONSOR)?.discountCode).toBe('ANNEN')
  })

  it('removeDiscountCode: the code is gone for the rest of the page load, the page\'s own included', async () => {
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN)
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    gql.deleteAppliedDiscount.mockImplementation(async () => ((serverCode = null), { executed: true, message: '' }))

    await m.removeDiscountCode()
    plusOne(m)
    await idle(m)
    await m.refreshFromServer(SPONSOR)
    await m.settleDiscountCode(SPONSOR)
    await idle(m)

    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
    expect(m.getCart(SPONSOR)?.discountCode).toBeUndefined()
  })
})

describe('the carts a page opens with', () => {
  const persist = (cart: Record<string, unknown>) =>
    ensureLocalStorage().setItem(
      cartStorageKey(''),
      JSON.stringify({
        [SPONSOR]: {
          sponsorId: SPONSOR,
          currency: 'NOK',
          cartId: 'cart-9',
          items: [{ id: 'srv-1', cartItemId: 'srv-1', productId: 146, sponsorId: SPONSOR, brand: 'Careless', name: 'Sofie genser XL', unitPrice: 100, currency: 'NOK', imageUrl: '', quantity: 1 }],
          ...cart,
        },
      }),
    )

  it('a cart with lines and no code is asked for the page\'s code — without anyone waiting', async () => {
    persist({})
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN)
    const m = new CartManager()
    m.ensureDiscountCodes()
    await idle(m)
    expect(order).toEqual(['ApplyDiscount', 'GetCart+code'])
    expect(gql.applyDiscount).toHaveBeenCalledWith('cart-9', 'GAVE', OPTS)
    expect(m.getCart(SPONSOR)?.discountCode).toBe('GAVE')
  })

  it('a cart that already carries the code is left alone', async () => {
    persist({ discountCode: 'GAVE' })
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN)
    const m = new CartManager()
    m.ensureDiscountCodes()
    await m.settleDiscountCode(SPONSOR)
    await idle(m)
    expect(order).toEqual([])
  })
})

describe('where the page\'s code comes from', () => {
  it('?vio_discount= of the URL, remembered for the tab, when the config names none', async () => {
    syncDiscountParam('?vio_discount=FRA-URL')
    page()
    applyAnswers(TAKEN)
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    expect(gql.applyDiscount).toHaveBeenCalledWith('cart-1', 'FRA-URL', OPTS)
  })

  it('the config\'s code wins over the URL\'s', async () => {
    syncDiscountParam('?vio_discount=FRA-URL')
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN)
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    expect(gql.applyDiscount).toHaveBeenCalledWith('cart-1', 'GAVE', OPTS)
  })

  it('a code typed by the shopper (applyDiscountCode) is the one the next cart gets, over the page\'s', async () => {
    page({ discountCode: 'GAVE' })
    applyAnswers({ executed: false, message: 'COUPON_EXPIRED' }, TAKEN)
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    await expect(m.applyDiscountCode('MIN-KODE')).resolves.toMatchObject({ status: 'applied', code: 'MIN-KODE' })
    m.clearSponsorCart(SPONSOR)
    addJumper(m)
    await idle(m)
    expect(gql.applyDiscount.mock.calls.map((c) => c[1])).toEqual(['GAVE', 'MIN-KODE', 'MIN-KODE'])
  })

  it('a typed code Commerce refuses is not kept: the next cart gets the page\'s again', async () => {
    page({ discountCode: 'GAVE' })
    applyAnswers(TAKEN, { executed: false, message: 'COUPON_OTHER_APPLIED' }, TAKEN)
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    await expect(m.applyDiscountCode('FEIL')).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_OTHER_APPLIED' })
    m.clearSponsorCart(SPONSOR)
    addJumper(m)
    await idle(m)
    expect(gql.applyDiscount.mock.calls.map((c) => c[1])).toEqual(['GAVE', 'FEIL', 'GAVE'])
  })

  it('what is not a code in the config is no code', async () => {
    page({ discountCode: 'to ord' })
    expect(Configuration.get()).not.toHaveProperty('discountCode')
    page({ discountCode: '  GAVE ' })
    expect(Configuration.get().discountCode).toBe('GAVE')
  })
})

describe('a page without a discount code', () => {
  it('never asks for one: adds, quantities, reads and settleDiscountCode are the calls they always were', async () => {
    page()
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    plusOne(m)
    await idle(m)
    await m.settleDiscountCode(SPONSOR)
    await m.refreshFromServer(SPONSOR)
    m.ensureDiscountCodes()
    await idle(m)

    expect(order).toEqual(['CreateCart', 'AddItem', 'UpdateItem', 'GetCart'])
    expect(gql.applyDiscount).not.toHaveBeenCalled()
    expect(m.discountBusy()).toBeUndefined()
  })

  it('before Vio.init there is no code either', async () => {
    const m = new CartManager()
    addJumper(m)
    await idle(m)
    await m.settleDiscountCode(SPONSOR)
    expect(gql.applyDiscount).not.toHaveBeenCalled()
  })
})
