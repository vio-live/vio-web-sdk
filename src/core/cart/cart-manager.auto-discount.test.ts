// @vitest-environment jsdom
/**
 * The page's own discount code (`Vio.init({ discountCode })`, or the
 * `?vio_discount=` the tab remembers): put on the cart without the shopper
 * typing it, through the same call the field makes. Commerce asks the brand's
 * shop about it (seconds), so nothing in the cart waits for it — only a
 * checkout or a payment does (`settleDiscountCode`). Asked once the cart has
 * lines, once per cart and code, again only when the answer could change, and
 * never at all on a page without a code.
 *
 * Nobody typed that code: it shows once it is taken, and is refused in
 * silence. A code someone ASKED for (`applyDiscountCode`: the field's «Bruk»)
 * always has its answer said — so a payment started while it is still being
 * checked waits for it, and is told when it was not taken.
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
  applyCampaignDiscount: vi.fn(),
  deleteCartDiscount: vi.fn(),
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
/** The campaign whose code the server cart carries (an ApplyDiscount by campaign that was taken): its text is never sent. */
let serverCampaign: number | null
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
  serverCampaign = null
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
    const discount = { discount_code: serverCode, discount_source: serverCode ? 'CODE' : serverCampaign !== null ? 'CAMPAIGN' : null }
    return serverCart(serverLines, extra?.discountCode ? discount : {}, cartId)
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
    // Nobody asked for it by name: a field does not show it being checked.
    expect(m.discountBusy(SPONSOR)).toEqual({ kind: 'applying', code: 'GAVE', sponsorId: SPONSOR, asked: false })
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

  it('discountField is kept as the page said it (true: shown, false: hidden) — a config that says nothing is the one it always was', async () => {
    page()
    expect(Configuration.get()).not.toHaveProperty('discountField')
    expect(Configuration.get()).not.toHaveProperty('discountCode')
    Configuration.init({ apiKey: 'surface-key', discountField: true })
    expect(Configuration.get().discountField).toBe(true)
    Configuration.init({ apiKey: 'surface-key', discountCode: 'GAVE', discountField: false })
    expect(Configuration.get().discountField).toBe(false)
    for (const notSaid of ['true', 'false', 1, 0, null, undefined]) {
      Configuration.init({ apiKey: 'surface-key', discountField: notSaid as never })
      expect(Configuration.get(), String(notSaid)).not.toHaveProperty('discountField')
    }
  })
})

describe('who asked for the code', () => {
  /** An ApplyDiscount that answers when the test says. */
  function pendingAnswer() {
    let answer!: (v: { executed: boolean; message: string } | Promise<never>) => void
    gql.applyDiscount.mockImplementation(() => {
      order.push('ApplyDiscount')
      return new Promise((resolve) => (answer = resolve))
    })
    return (v: { executed: boolean; message: string } | Error) => {
      if (!(v instanceof Error) && v.executed) serverCode = String(gql.applyDiscount.mock.calls.at(-1)?.[1])
      answer(v instanceof Error ? Promise.reject(v) : v)
    }
  }
  /** A cart with one line, on a page with (or without) a code of its own, and nothing in flight. */
  async function cartWithALine(config: { discountCode?: string } = {}) {
    page(config)
    const m = new CartManager()
    addJumper(m)
    await m.waitForCartMutations(SPONSOR)
    await tick()
    return m
  }

  it('the shopper typing the very code the page is putting on the cart: one request, theirs from then on', async () => {
    const answer = pendingAnswer()
    const m = await cartWithALine({ discountCode: 'GAVE' })
    expect(m.discountBusy(SPONSOR)?.asked).toBe(false)

    const typed = m.applyDiscountCode('GAVE', SPONSOR)
    await tick()
    expect(m.discountBusy(SPONSOR)).toEqual({ kind: 'applying', code: 'GAVE', sponsorId: SPONSOR, asked: true })
    answer(TAKEN)
    await expect(typed).resolves.toMatchObject({ status: 'applied', code: 'GAVE' })
    await idle(m)
    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
  })

  it('a payment started while a typed code is being checked waits for the answer, whatever the budget — and is told when the code was not taken', async () => {
    const answer = pendingAnswer()
    const m = await cartWithALine()
    const typed = m.applyDiscountCode('FEIL', SPONSOR)
    await tick()

    let found: unknown = 'waiting'
    const settling = m.settleDiscountCode(SPONSOR, { budgetMs: 5 }).then((r) => (found = r))
    await new Promise((r) => setTimeout(r, 30))
    expect(found).toBe('waiting')

    answer({ executed: false, message: 'COUPON_NOT_FOUND' })
    await settling
    expect(found).toEqual({ notTaken: { code: 'FEIL', reason: 'COUPON_NOT_FOUND' } })
    // Whoever typed it gets the same answer.
    await expect(typed).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_NOT_FOUND' })
    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
    expect(m.getCart(SPONSOR)?.discountCode).toBeUndefined()

    // Read and done: the next attempt to pay has nothing to wait for, and nothing to be told.
    await expect(m.settleDiscountCode(SPONSOR, { budgetMs: 5 })).resolves.toEqual({})
    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
  })

  it('a typed code that could not be asked: not taken, without a reason — and not asked again behind the shopper\'s back', async () => {
    const answer = pendingAnswer()
    const m = await cartWithALine()
    const typed = m.applyDiscountCode('KODE', SPONSOR)
    await tick()
    const settling = m.settleDiscountCode(SPONSOR, { budgetMs: 5 })
    answer(new Error('timed out'))
    await expect(settling).resolves.toEqual({ notTaken: { code: 'KODE' } })
    await expect(typed).resolves.toMatchObject({ status: 'failed' })
    await idle(m)
    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
  })

  it('a typed code that is taken: the payment goes on, with the code on the cart', async () => {
    const answer = pendingAnswer()
    const m = await cartWithALine()
    void m.applyDiscountCode('SOMMER10', SPONSOR)
    await tick()
    const settling = m.settleDiscountCode(SPONSOR, { budgetMs: 5 })
    answer(TAKEN)
    await expect(settling).resolves.toEqual({})
    expect(m.getCart(SPONSOR)?.discountCode).toBe('SOMMER10')
  })

  it('the page\'s own code refused while a payment waits for it: nothing is told — the purchase goes on', async () => {
    const answer = pendingAnswer()
    const m = await cartWithALine({ discountCode: 'GAVE' })
    const settling = m.settleDiscountCode(SPONSOR, { budgetMs: 1000 })
    await tick()
    answer({ executed: false, message: 'COUPON_EXPIRED' })
    await expect(settling).resolves.toEqual({})
    expect(m.getCart(SPONSOR)?.discountCode).toBeUndefined()
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

describe('the code a campaign gives the sponsor (hooks: the facade answers them from the bootstrap)', () => {
  /** What the page's campaign gives each sponsor now — a reference; `undefined` for a sponsor: cannot tell. */
  let campaign: { id: number; refs: Record<number, string | null | undefined> }
  /** Whether each sponsor's ways to pay take codes; absent: yes. `undefined`: cannot tell yet. */
  let allowed: Record<number, boolean | undefined>
  const hooks = {
    campaignDiscount: (sponsorId: number) => {
      const ref = campaign.refs[sponsorId]
      return ref ? { ref, campaignId: campaign.id } : undefined
    },
    campaignDiscountNow: (sponsorId: number, campaignId: number) =>
      campaignId === campaign.id ? campaign.refs[sponsorId] : null,
    discountAllowed: (sponsorId: number) => (sponsorId in allowed ? allowed[sponsorId] : true),
  }
  /** Commerce's answer to an ApplyDiscount by campaign (the last one repeats): taken puts that campaign's code on the server cart. */
  function campaignAnswers(...answers: Array<{ executed: boolean; message: string } | Error | null>) {
    let i = 0
    gql.applyCampaignDiscount.mockImplementation(async (_cartId: string, campaignId: number) => {
      order.push(`ApplyDiscount(campaign ${campaignId})`)
      const answer = answers[Math.min(i++, answers.length - 1)]!
      if (answer instanceof Error) throw answer
      if (answer?.executed) {
        serverCode = null
        serverCampaign = campaignId
      }
      return answer
    })
  }

  beforeEach(() => {
    campaign = { id: 5, refs: { [SPONSOR]: 'ref-a' } }
    allowed = {}
    gql.deleteAppliedDiscount.mockImplementation(async () => (order.push('DeleteAppliedDiscount'), (serverCode = null), { executed: true, message: '' }))
    gql.deleteCartDiscount.mockImplementation(async () => {
      order.push('DeleteAppliedDiscount(cart)')
      serverCode = null
      serverCampaign = null
      return { executed: true, message: '' }
    })
  })

  it('goes on the cart by campaign — the page never sees the code — and the cart remembers the campaign and reference it follows', async () => {
    page()
    campaignAnswers(TAKEN)
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    expect(order).toEqual(['CreateCart', 'AddItem', 'ApplyDiscount(campaign 5)', 'GetCart+code'])
    expect(gql.applyCampaignDiscount).toHaveBeenCalledWith('cart-1', 5, OPTS)
    expect(gql.applyDiscount).not.toHaveBeenCalled()
    expect(m.getCart(SPONSOR)).toMatchObject({ discountSource: 'CAMPAIGN', discountCampaignId: 5, discountRef: 'ref-a' })
    expect(m.getCart(SPONSOR)).not.toHaveProperty('discountCode')
    expect(m.hasDiscountCode(SPONSOR)).toBe(true)
    expect(m.discountCodeForSponsor(SPONSOR)).toBeUndefined()
    expect(m.discountSourceForSponsor(SPONSOR)).toBe('CAMPAIGN')
    // Kept with the cart, for the next page of the visit.
    expect(new CartManager('').getCart(SPONSOR)).toMatchObject({ discountSource: 'CAMPAIGN', discountCampaignId: 5, discountRef: 'ref-a' })
  })

  it('while it goes on, nobody is shown a code: discountBusy says none', async () => {
    page()
    let answer!: (v: typeof TAKEN) => void
    gql.applyCampaignDiscount.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const m = new CartManager('', hooks)
    addJumper(m)
    await m.waitForCartMutations(SPONSOR)
    await tick()
    expect(m.discountBusy(SPONSOR)).toEqual({ kind: 'applying', code: '', sponsorId: SPONSOR, asked: false })
    serverCampaign = 5
    answer(TAKEN)
    await idle(m)
    expect(m.discountBusy()).toBeUndefined()
  })

  it('the page\'s own code wins over it, and is nobody\'s campaign', async () => {
    page({ discountCode: 'SIDE' })
    applyAnswers(TAKEN)
    campaignAnswers(TAKEN)
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    expect(gql.applyDiscount).toHaveBeenCalledWith('cart-1', 'SIDE', OPTS)
    expect(gql.applyCampaignDiscount).not.toHaveBeenCalled()
    expect(m.getCart(SPONSOR)).not.toHaveProperty('discountCampaignId')
  })

  it('a new reference (the dashboard set the code again): off, and the campaign\'s on again — one piece of work, whatever else settles the cart meanwhile', async () => {
    page()
    campaignAnswers(TAKEN)
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    order = []

    campaign.refs[SPONSOR] = 'ref-b'
    m.ensureDiscountCodes()
    m.ensureDiscountCodes()
    void m.settleDiscountCode(SPONSOR)
    await idle(m)
    expect(order).toEqual(['DeleteAppliedDiscount(cart)', 'ApplyDiscount(campaign 5)', 'GetCart+code'])
    expect(gql.deleteCartDiscount).toHaveBeenCalledWith('cart-1', OPTS)
    expect(m.getCart(SPONSOR)).toMatchObject({ discountSource: 'CAMPAIGN', discountCampaignId: 5, discountRef: 'ref-b' })
  })

  it('the campaign gives none any more: it comes off, and the lines are read again', async () => {
    page()
    campaignAnswers(TAKEN)
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    order = []

    campaign.refs[SPONSOR] = null
    m.ensureDiscountCodes()
    await idle(m)
    // Read as a cart without a code: no code is in play any more.
    expect(order).toEqual(['DeleteAppliedDiscount(cart)', 'GetCart'])
    expect(m.hasDiscountCode(SPONSOR)).toBe(false)
    expect(m.getCart(SPONSOR)).not.toHaveProperty('discountSource')
    expect(m.getCart(SPONSOR)).not.toHaveProperty('discountRef')
  })

  it('a cart that carries the campaign\'s code by its text (put on before references): swapped for the campaign\'s by reference', async () => {
    page()
    campaignAnswers(TAKEN)
    localStorage.setItem(
      cartStorageKey(''),
      JSON.stringify({
        [SPONSOR]: {
          sponsorId: SPONSOR,
          currency: 'NOK',
          cartId: 'cart-9',
          discountCode: 'GAVE',
          discountCampaignId: 5,
          items: [{ id: 'li_1', productId: 146, quantity: 1, unitPrice: 100, currency: 'NOK', name: 'Item', brand: 'Brand', imageUrl: '', cartItemId: 'srv-1' }],
        },
      }),
    )
    serverCode = 'GAVE'
    const m = new CartManager('', hooks)
    m.ensureDiscountCodes()
    await idle(m)
    expect(order).toEqual(['DeleteAppliedDiscount', 'ApplyDiscount(campaign 5)', 'GetCart+code'])
    expect(gql.deleteAppliedDiscount).toHaveBeenCalledWith('cart-9', 'GAVE', OPTS)
    expect(m.getCart(SPONSOR)).toMatchObject({ discountSource: 'CAMPAIGN', discountRef: 'ref-a' })
    expect(m.getCart(SPONSOR)).not.toHaveProperty('discountCode')
  })

  it('cannot be told (no bootstrap yet, another connection): nothing comes off', async () => {
    page()
    campaignAnswers(TAKEN)
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    order = []

    campaign.refs[SPONSOR] = undefined
    m.ensureDiscountCodes()
    await m.settleDiscountCode(SPONSOR)
    await idle(m)
    expect(order).toEqual([])
    expect(m.getCart(SPONSOR)?.discountRef).toBe('ref-a')
  })

  it('the server cart says another code: it is not the campaign\'s any more', async () => {
    page()
    campaignAnswers(TAKEN)
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    serverCode = 'ANNEN'
    serverCampaign = null
    await m.refreshFromServer(SPONSOR)
    expect(m.getCart(SPONSOR)).toMatchObject({ discountCode: 'ANNEN' })
    expect(m.getCart(SPONSOR)).not.toHaveProperty('discountCampaignId')
    expect(m.getCart(SPONSOR)).not.toHaveProperty('discountSource')
  })

  it('the server cart says a campaign\'s code the SDK did not put on: kept as it is, never taken off by the SDK', async () => {
    page({ discountCode: 'SIDE' })
    applyAnswers({ executed: false, message: 'COUPON_OTHER_APPLIED' })
    campaign.refs = {}
    serverCampaign = 7
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    await m.refreshFromServer(SPONSOR)
    m.ensureDiscountCodes()
    await idle(m)
    expect(gql.applyDiscount).toHaveBeenCalledTimes(1)
    expect(m.getCart(SPONSOR)).toMatchObject({ discountSource: 'CAMPAIGN' })
    expect(m.getCart(SPONSOR)).not.toHaveProperty('discountCampaignId')
    expect(m.hasDiscountCode(SPONSOR)).toBe(true)
    expect(gql.deleteCartDiscount).not.toHaveBeenCalled()
  })

  it('removeDiscountCode takes a campaign\'s code off without naming it', async () => {
    page()
    campaignAnswers(TAKEN)
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    order = []

    const removal = await m.removeDiscountCode(SPONSOR)
    expect(removal).toMatchObject({ removed: true, carts: [{ sponsorId: SPONSOR, code: '', source: 'CAMPAIGN', status: 'removed' }] })
    expect(order).toEqual(['DeleteAppliedDiscount(cart)', 'GetCart'])
    expect(m.hasDiscountCode(SPONSOR)).toBe(false)
    // Nothing goes on again this page load.
    m.ensureDiscountCodes()
    await idle(m)
    expect(gql.applyCampaignDiscount).toHaveBeenCalledTimes(1)
  })

  it('refused (the campaign gives no code there): asked once for that reference, in silence', async () => {
    page()
    campaignAnswers({ executed: false, message: 'COUPON_NOT_FOUND' })
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    plusOne(m)
    await idle(m)
    await m.settleDiscountCode(SPONSOR)
    expect(gql.applyCampaignDiscount).toHaveBeenCalledTimes(1)
    expect(m.getCart(SPONSOR)?.discountRefusal).toEqual({ code: '', ref: 'ref-a', reason: 'COUPON_NOT_FOUND' })
    expect(m.hasDiscountCode(SPONSOR)).toBe(false)

    // A new reference is a new code: asked.
    campaign.refs[SPONSOR] = 'ref-b'
    m.ensureDiscountCodes()
    await idle(m)
    expect(gql.applyCampaignDiscount).toHaveBeenCalledTimes(2)
  })

  it('a gateway that does not take a campaign: no code, and not asked again on this page load', async () => {
    page()
    campaignAnswers(null)
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    expect(gql.applyCampaignDiscount).toHaveBeenCalledTimes(1)
    expect(m.hasDiscountCode(SPONSOR)).toBe(false)
  })

  it('another sponsor\'s cart is not given it', async () => {
    page()
    campaignAnswers(TAKEN)
    campaign.refs = { 99: 'ref-a' }
    const m = new CartManager('', hooks)
    addJumper(m)
    await idle(m)
    expect(gql.applyCampaignDiscount).not.toHaveBeenCalled()
    expect(order).toEqual(['CreateCart', 'AddItem'])
  })

  describe('a brand none of whose ways to pay takes codes', () => {
    it('gets neither the campaign\'s code nor the page\'s own — and its cart is read as without codes', async () => {
      page()
      campaignAnswers(TAKEN)
      allowed = { [SPONSOR]: false }
      const m = new CartManager('', hooks)
      addJumper(m)
      await idle(m)
      await m.settleDiscountCode(SPONSOR)
      await m.refreshFromServer(SPONSOR)
      expect(order).toEqual(['CreateCart', 'AddItem', 'GetCart'])
      expect(m.discountGiftExpected(SPONSOR)).toBe(false)

      Configuration.reset()
      page({ discountCode: 'SIDE' })
      applyAnswers(TAKEN)
      m.ensureDiscountCodes()
      await m.settleDiscountCode(SPONSOR)
      await idle(m)
      expect(gql.applyDiscount).not.toHaveBeenCalled()
      expect(gql.applyCampaignDiscount).not.toHaveBeenCalled()
    })

    it('a code the shopper types is still asked (Commerce answers for it)', async () => {
      page()
      applyAnswers(TAKEN)
      allowed = { [SPONSOR]: false }
      const m = new CartManager('', hooks)
      addJumper(m)
      await idle(m)
      await expect(m.applyDiscountCode('EGEN', SPONSOR)).resolves.toMatchObject({ status: 'applied' })
      expect(gql.applyDiscount).toHaveBeenCalledWith('cart-1', 'EGEN', OPTS)
    })

    it('not known yet (no bootstrap): the page\'s code waits — and goes on once it is known', async () => {
      page({ discountCode: 'SIDE' })
      applyAnswers(TAKEN)
      campaign.refs = {}
      allowed = { [SPONSOR]: undefined }
      const m = new CartManager('', hooks)
      addJumper(m)
      await idle(m)
      m.ensureDiscountCodes()
      await idle(m)
      expect(gql.applyDiscount).not.toHaveBeenCalled()

      allowed = { [SPONSOR]: true }
      m.ensureDiscountCodes()
      await idle(m)
      expect(gql.applyDiscount).toHaveBeenCalledWith('cart-1', 'SIDE', OPTS)
    })
  })
})
