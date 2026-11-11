/**
 * The discount code of a cart, end to end: the real facade, cart and
 * checkout managers against a fake commerce gateway that keeps the contract —
 * one code per cart; the same code again is fine, another one is refused; a
 * refusal says why with a stable word; a code can give a product away
 * (`gifts`) and every line is answered with what the code takes off it; the
 * code is checked again when a payment is started. `fetch` is stubbed:
 * bootstrap, surface and the commerce GraphQL.
 *
 * A code is validated before paying: the page's own goes on in silence (and
 * is refused in silence), a typed one always answers whoever typed it — a
 * payment tapped while it is still being checked does not leave without it.
 *
 * The case it is written for (Faves): the brand's coupon `gratis_face_mask`,
 * applied by the page (`Vio.init({ discountCode })`), minimum purchase 10 kr,
 * gives one face mask (product 421306, 52 kr) away.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Configuration } from './configuration.js'
import { resetGatewayFeatures } from './api/gateway-features.js'
import { DISCOUNT_SETTLE_BUDGET_MS } from './checkout/checkout-manager.js'
import { resetCheckoutSponsorMemory } from './sponsor-identity.js'
import type { BootstrapResponse, Sponsor } from './types.js'

let Vio: typeof import('./client.js').Vio

const FAVES = 7
const faves: Sponsor = { id: FAVES, name: 'Faves', commerce: { apiKey: 'key-484', channelId: '484' } }
const boot = (): BootstrapResponse => ({
  campaign: { id: 4, name: 'Faves høst' },
  primarySponsor: faves,
  campaigns: [{ id: 4, name: 'Faves høst', status: 'active', isDefault: true, primarySponsor: faves, slots: [] }],
})

/** Another brand, in campaign 5 with the first, on its own channel. */
const TINT = 8
const tint: Sponsor = { id: TINT, name: 'Tint', commerce: { apiKey: 'key-490', channelId: '490' } }
/** The brand whose cart a channel key sells for. */
const sponsorOfKey = (key: string) => (key === 'key-490' ? TINT : FAVES)
/**
 * What Vio's dashboard says per campaign and sponsor (`campaignId:sponsorId`
 * → the code). The bootstrap never carries the code: `discount: { ref }` on
 * every sponsor block (`null` where the dashboard names none, or the brand's
 * ways to pay take no code), `discountCode: null` always.
 */
let dashboard: Record<string, string>
/** The brands' ways to pay, as the bootstrap lists them: `discountMethods` per brand (absent: `['vipps']`; `null`: not sent). */
let discountMethodsOf: Record<number, string[] | null>
let paymentMethodsOf: Record<number, string[] | undefined>
/** The references the dashboard gave each code, per campaign and sponsor (a new one each time the code is set). */
let refs: Map<string, string>
const refOf = (campaignId: number, sponsorId: number, code: string) => {
  const key = `${campaignId}:${sponsorId}=${code}`
  if (!refs.has(key)) refs.set(key, `r${refs.size + 1}`)
  return refs.get(key)!
}
const coded = (s: Sponsor, campaignId: number): Sponsor => {
  const code = dashboard[`${campaignId}:${s.id}`]
  const discountMethods = s.id in discountMethodsOf ? (discountMethodsOf[s.id] ?? null) : ['vipps']
  const paymentMethods = paymentMethodsOf[s.id] ?? ['vipps', 'klarna']
  return {
    ...s,
    discountCode: null,
    discount: code && (discountMethods === null || discountMethods.length > 0) ? { ref: refOf(campaignId, s.id, code) } : null,
    commerce: { ...s.commerce, paymentMethods, ...(discountMethods !== null ? { discountMethods } : {}) },
  }
}
/** The surface with the campaigns' discounts: 4 (the default, the first brand) and 5 (that brand, and Tint as a secondary). */
const campaignBoot = (): BootstrapResponse => ({
  campaign: { id: 4, name: 'Autumn' },
  primarySponsor: coded(faves, 4),
  campaigns: [
    { id: 4, name: 'Autumn', status: 'active', isDefault: true, primarySponsor: coded(faves, 4), slots: [] },
    { id: 5, name: 'Winter', status: 'active', primarySponsor: coded(faves, 5), secondarySponsors: [coded(tint, 5)], slots: [] },
  ],
})
/** What `GET /v2/mobile/config` answers in this test. */
let bootstrap: () => BootstrapResponse

/** Product ids and their list prices. */
const CREAM = 100
const TINY = 101
const MASK = 421306
const LIPSTICK = 200
const PRICE: Record<number, number> = { [CREAM]: 349, [TINY]: 5, [MASK]: 52, [LIPSTICK]: 199 }
const GIFT_CODE = 'gratis_face_mask'
/** The brand's coupons: a gift with a minimum purchase, and ten per cent on everything. */
const CODES: Record<string, { percentage: number; products?: number[]; gifts?: number[]; minAmount?: number }> = {
  [GIFT_CODE]: { percentage: 100, products: [MASK], gifts: [MASK], minAmount: 10 },
  TI: { percentage: 10 },
  TINT20: { percentage: 20 },
}

interface FakeLine {
  id: string
  product_id: number
  quantity: number
}

let session: Map<string, string>
/** The channel key each backend cart was created with. */
let cartKeys: Map<string, string>
/** Every commerce GraphQL call: its operation, the key it carried, its variables and its query. */
let calls: Array<{ op: string; key: string; variables: Record<string, any>; query: string }>
/** Never reset: the facade is one per page, and it remembers checkouts it announced by id. */
let cartSeq = 0
let carts: Map<string, FakeLine[]>
/** The code each backend cart carries. */
let cartCodes: Map<string, string>
/** The campaign whose code a backend cart carries (applied by campaign): its text is never sent back. */
let cartCampaigns: Map<string, number>
/** What each CreatePaymentVipps charged: the cart's lines less what its code takes off them. */
let charged: number[]
/** How the gateway and the brand's shop behave in this test. */
let gateway: {
  /** ApplyDiscount fails as a call (shopcart down). */
  applyThrows: boolean
  /** DeleteAppliedDiscount fails as a call. */
  removeThrows: boolean
  /** The brand's coupons that are over. */
  expired: Set<string>
  /** Products this channel cannot sell (an AddItem of them fails). */
  unavailable: Set<number>
  /** The gateway knows `discount_code` / `discount_source` on the cart, `gifts` on ApplyDiscount. */
  knowsCartDiscountCode: boolean
  knowsDiscountSource: boolean
  knowsGifts: boolean
  /** The gateway takes `campaign_id` on ApplyDiscount, and DeleteAppliedDiscount without a code. */
  knowsCampaign: boolean
  /** When set, ApplyDiscount answers only once this is resolved (the brand's shop is slow). */
  applyGate: Promise<void> | null
  /** CreatePaymentVipps fails for a reason that has nothing to do with the discount. */
  vippsDown: boolean
}

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

const priceOf = (productId: number) => PRICE[productId] ?? 100
const ruleOf = (cartId: string) => CODES[cartCodes.get(cartId) ?? '']

/** What the cart's code takes off a line: its amount, all units, taxes included. */
function discountOf(cartId: string, l: FakeLine): number {
  const rule = ruleOf(cartId)
  if (!rule) return 0
  if (rule.products && !rule.products.includes(l.product_id)) return 0
  return (priceOf(l.product_id) * l.quantity * rule.percentage) / 100
}

/** The lines a code does not give away, summed: what its minimum is measured against. */
const paidTotal = (cartId: string, code: string) =>
  (carts.get(cartId) ?? [])
    .filter((l) => !(CODES[code]?.gifts ?? []).includes(l.product_id))
    .reduce((sum, l) => sum + priceOf(l.product_id) * l.quantity, 0)

const totalOf = (cartId: string) =>
  (carts.get(cartId) ?? []).reduce((sum, l) => sum + priceOf(l.product_id) * l.quantity - discountOf(cartId, l), 0)

function cartBody(cartId: string, query = '') {
  return {
    cart_id: cartId,
    currency: 'NOK',
    shipping_country: 'NO',
    ...(query.includes('discount_code') ? { discount_code: cartCampaigns.has(cartId) ? null : (cartCodes.get(cartId) ?? null) } : {}),
    ...(query.includes('discount_source')
      ? { discount_source: !cartCodes.has(cartId) ? null : cartCampaigns.has(cartId) ? 'CAMPAIGN' : 'CODE' }
      : {}),
    line_items: (carts.get(cartId) ?? []).map((l) => ({
      id: l.id,
      product_id: l.product_id,
      title: `P${l.product_id}`,
      quantity: l.quantity,
      price: {
        amount: priceOf(l.product_id) * 0.8,
        amount_incl_taxes: priceOf(l.product_id),
        currency_code: 'NOK',
        discount: discountOf(cartId, l),
      },
    })),
  }
}

/** Why the brand's shop would not take (or keep) `code` on this cart; null when it does. */
function refusal(cartId: string, code: string): string | null {
  const rule = CODES[code]
  if (!rule) return 'COUPON_NOT_FOUND'
  if (gateway.expired.has(code)) return 'COUPON_EXPIRED'
  if (rule.minAmount !== undefined && paidTotal(cartId, code) < rule.minAmount) return 'COUPON_MIN_AMOUNT'
  return null
}

async function graphql(body: { query: string; variables: Record<string, any> }, key: string): Promise<Response> {
  const op = /(?:mutation|query)\s+(\w+)/.exec(body.query)?.[1] ?? '?'
  calls.push({ op, key, variables: body.variables, query: body.query })
  const v = body.variables
  switch (op) {
    case 'CreateCart': {
      const id = `cart-${++cartSeq}`
      carts.set(id, [])
      cartKeys.set(id, key)
      return json({ data: { Cart: { CreateCart: cartBody(id) } } })
    }
    case 'AddItem': {
      const lines = carts.get(v.cartId) ?? []
      for (const li of v.lineItems) {
        if (gateway.unavailable.has(li.product_id)) {
          return json({ data: { Cart: { AddItem: null } }, errors: [{ message: 'Product not available on this channel', path: ['Cart', 'AddItem'] }] })
        }
        const found = lines.find((l) => l.product_id === li.product_id)
        if (found) found.quantity += li.quantity
        else lines.push({ id: `${v.cartId}-l${li.product_id}`, product_id: li.product_id, quantity: li.quantity })
      }
      carts.set(v.cartId, lines)
      return json({ data: { Cart: { AddItem: cartBody(v.cartId) } } })
    }
    case 'UpdateItem': {
      const line = (carts.get(v.cartId) ?? []).find((l) => l.id === v.cartItemId)
      if (line && typeof v.qty === 'number') line.quantity = v.qty
      return json({ data: { Cart: { UpdateItem: cartBody(v.cartId) } } })
    }
    case 'DeleteItem': {
      carts.set(v.cartId, (carts.get(v.cartId) ?? []).filter((l) => l.id !== v.cartItemId))
      return json({ data: { Cart: { DeleteItem: cartBody(v.cartId) } } })
    }
    case 'GetCart': {
      // Each field the gateway does not know is an error of its own, as GraphQL validation answers.
      const unknown = [
        ...(body.query.includes('discount_code') && !gateway.knowsCartDiscountCode ? ['discount_code'] : []),
        ...(body.query.includes('discount_source') && !gateway.knowsDiscountSource ? ['discount_source'] : []),
      ]
      if (unknown.length) {
        return json({ errors: unknown.map((f) => ({ message: `Cannot query field "${f}" on type "GetCartDTO".` })) }, 400)
      }
      return json({ data: { Cart: { GetCart: cartBody(v.cartId, body.query) } } })
    }
    case 'ApplyCampaignDiscount':
    case 'ApplyDiscount': {
      if (body.query.includes('campaign_id') && !gateway.knowsCampaign) {
        return json(
          {
            errors: [
              { message: 'Unknown argument "campaign_id" on field "DiscountsMutations.ApplyDiscount".' },
              { message: 'Field "ApplyDiscount" argument "code" of type "String!" is required, but it was not provided.' },
            ],
          },
          400,
        )
      }
      if (body.query.includes('gifts') && !gateway.knowsGifts) {
        return json({ errors: [{ message: 'Cannot query field "gifts" on type "ApplyDiscountDTO".' }] }, 400)
      }
      if (gateway.applyGate) await gateway.applyGate
      if (gateway.applyThrows) return json({ errors: [{ message: 'shopcart is down' }] }, 502)
      // By campaign: the code the dashboard gives the cart's brand there; none answers as an unknown code.
      const byCampaign = v.campaignId !== undefined
      const code: string | undefined = byCampaign ? dashboard[`${v.campaignId}:${sponsorOfKey(cartKeys.get(v.cartId) ?? '')}`] : v.code
      const current = cartCodes.get(v.cartId)
      const why = !code ? 'COUPON_NOT_FOUND' : current && current !== code ? 'COUPON_OTHER_APPLIED' : refusal(v.cartId, code)
      if (why) return json({ data: { Discounts: { ApplyDiscount: { executed: false, message: why } } } })
      cartCodes.set(v.cartId, code!)
      if (byCampaign) cartCampaigns.set(v.cartId, v.campaignId)
      else cartCampaigns.delete(v.cartId)
      const gifts = (CODES[code!]!.gifts ?? []).map((product_id) => ({ product_id, variant_id: null, quantity: 1 }))
      return json({
        data: { Discounts: { ApplyDiscount: { executed: true, message: '', ...(body.query.includes('gifts') ? { gifts } : {}) } } },
      })
    }
    case 'DeleteCartDiscount':
    case 'DeleteAppliedDiscount': {
      if (v.code === undefined && !gateway.knowsCampaign) {
        return json({ errors: [{ message: 'Field "DeleteAppliedDiscount" argument "code" of type "String!" is required, but it was not provided.' }] }, 400)
      }
      if (gateway.removeThrows) return json({ errors: [{ message: 'shopcart is down' }] }, 502)
      // Without a code: whatever the cart carries.
      const had = cartCodes.has(v.cartId) && (v.code === undefined || cartCodes.get(v.cartId) === v.code)
      if (had) {
        cartCodes.delete(v.cartId)
        cartCampaigns.delete(v.cartId)
      }
      return json({ data: { Discounts: { DeleteAppliedDiscount: { executed: had, message: had ? '' : 'COUPON_NOT_APPLIED' } } } })
    }
    case 'CreateCheckout':
      return json({ data: { Checkout: { CreateCheckout: { id: `co-${v.cartId}`, status: 'open' } } } })
    case 'UpdateCheckout':
      return json({ data: { Checkout: { UpdateCheckout: { id: v.checkoutId, status: 'open' } } } })
    case 'CreatePaymentVipps': {
      if (gateway.vippsDown) {
        return json({ data: { Payment: { CreatePaymentVipps: null } }, errors: [{ message: 'Payment Vipps not initialize: 503', path: ['Payment', 'CreatePaymentVipps'] }] })
      }
      const cartId = String(v.checkoutId).replace(/^co-/, '')
      const code = cartCodes.get(cartId)
      // The code is checked again right before charging, and a gift has its own rules.
      const why =
        (code ? refusal(cartId, code) : null) ??
        ((carts.get(cartId) ?? []).some((l) => l.quantity > 1 && discountOf(cartId, l) >= priceOf(l.product_id) * l.quantity)
          ? 'GIFT_MAX_ONE_UNIT'
          : totalOf(cartId) <= 0
            ? 'CHECKOUT_AMOUNT_ZERO'
            : null)
      if (why) {
        // As the gateway answers it: HTTP 400, the code in `extensions.code` and at the end of the text.
        return json(
          { errors: [{ message: `Payment Vipps not initialize: the payment was refused [${why}]`, extensions: { code: why } }] },
          400,
        )
      }
      charged.push(totalOf(cartId))
      return json({ data: { Payment: { CreatePaymentVipps: { payment_url: 'https://vipps.test/pay', reference: 'r-1', express: v.express === true } } } })
    }
    default:
      return json({ data: {} })
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** The page's elements that name a campaign (`vio-campaign`), as `document.querySelectorAll` finds them. */
let pageElements: Array<{ getAttribute: (name: string) => string | null }>
/** The facade's `visibilitychange` listener (it refreshes a bootstrap older than five minutes). */
let visibilityListeners: Array<() => void>

beforeAll(async () => {
  delete (globalThis as { __VIO_FACADE__?: unknown }).__VIO_FACADE__
  ;({ Vio } = await import('./client.js'))
})

beforeEach(() => {
  calls = []
  carts = new Map()
  cartCodes = new Map()
  cartCampaigns = new Map()
  cartKeys = new Map()
  refs = new Map()
  discountMethodsOf = {}
  paymentMethodsOf = {}
  charged = []
  session = new Map()
  gateway = {
    applyThrows: false,
    removeThrows: false,
    expired: new Set(),
    unavailable: new Set(),
    knowsCartDiscountCode: true,
    knowsDiscountSource: true,
    knowsGifts: true,
    knowsCampaign: true,
    applyGate: null,
    vippsDown: false,
  }
  resetGatewayFeatures()
  dashboard = {}
  bootstrap = boot
  pageElements = []
  visibilityListeners = []
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    if (url.includes('/v2/mobile/config')) return json(bootstrap())
    if (url.endsWith('/v2/mobile/surface')) return json({ surface: { id: 1, name: 'S', privacyMode: 'standard' } })
    if (init?.body && String(init.body).includes('"query"')) {
      return graphql(JSON.parse(String(init.body)), String(init.headers?.Authorization ?? ''))
    }
    return json({ error: 'not found' }, 404)
  })
  vi.stubGlobal('document', {
    referrer: '',
    dispatchEvent: () => true,
    querySelectorAll: () => pageElements,
    visibilityState: 'visible',
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'visibilitychange') visibilityListeners.push(fn)
    },
  })
  // The facade installs its visibilitychange listener once per page: on this test's document.
  ;(Vio as unknown as { visibilityHooked: boolean }).visibilityHooked = false
  vi.stubGlobal('location', { href: 'https://host.example/a', pathname: '/a', search: '', host: 'host.example' })
  vi.stubGlobal('localStorage', undefined)
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  })
  resetCheckoutSponsorMemory()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Configuration.reset()
  resetGatewayFeatures()
})

/** One connection per test: its own cart manager, so a code asked for in one test is not the next one's. */
let keySeq = 0

async function ready(config: Record<string, unknown> = {}) {
  Vio.init({ apiKey: `surface-key-${++keySeq}`, environment: 'testing', ...config } as never)
  Vio.cart.clearAllCarts()
  // A checkout left open by another test is not this one's.
  Vio.checkout.close()
  await Vio.bootstrap()
  await flush()
}

const add = (productId: number, quantity = 1) =>
  Vio.cart.addManual({
    productId,
    sponsorId: FAVES,
    brand: 'Faves',
    name: `P${productId}`,
    unitPrice: priceOf(productId),
    currency: 'NOK',
    imageUrl: '',
    quantity,
    origin: { campaignId: 4, slot: 'article-1' },
  })

const ops = () => calls.map((c) => c.op)
const count = (op: string) => ops().filter((o) => o === op).length
const cartIdNow = () => Vio.cart.getCart(FAVES)?.cartId ?? ''
const linesNow = () => (Vio.cart.getCart(FAVES)?.items ?? []).map((i) => `${i.productId}×${i.quantity}`)
const serverLines = () => (carts.get(cartIdNow()) ?? []).map((l) => `${l.product_id}×${l.quantity}`)
const lineOf = (productId: number) => Vio.cart.getCart(FAVES)?.items.find((i) => i.productId === productId)
/** Until nothing of the cart is in flight: its mutations, a discount call and what follows it. */
async function idle() {
  for (let quiet = 0; quiet < 5; ) {
    await Vio.cart.waitForCartMutations(FAVES)
    await flush()
    quiet = Vio.cart.discountBusy() ? 0 : quiet + 1
  }
}
const before = (first: string, second: string) => {
  const a = ops().indexOf(first)
  const b = ops().lastIndexOf(second)
  return a !== -1 && b !== -1 && a < b
}

describe('Vio.applyDiscountCode / Vio.removeDiscountCode — a "discount code" field', () => {
  it('puts the code on the backend cart with the cart\'s channel key, and reads the cart again with its code', async () => {
    await ready()
    add(CREAM)
    await idle()
    calls = []

    const result = await Vio.applyDiscountCode('TI')

    expect(result).toMatchObject({ status: 'applied', code: 'TI', carts: [{ sponsorId: FAVES, status: 'applied', answer: { executed: true } }] })
    expect(ops()).toEqual(['ApplyDiscount', 'GetCart'])
    expect(calls[0]).toMatchObject({ key: 'key-484', variables: { cartId: cartIdNow(), code: 'TI' } })
    expect(calls[1]!.query).toContain('discount_code')
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
    expect(cartCodes.get(cartIdNow())).toBe('TI')
  })

  it('a code the brand\'s shop does not know, and a second code on a cart that has one: refused with the reason, cart untouched', async () => {
    await ready()
    add(CREAM)
    await idle()

    await expect(Vio.applyDiscountCode('FINNESIKKE')).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_NOT_FOUND' })
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()

    await Vio.applyDiscountCode('TI')
    await expect(Vio.applyDiscountCode(GIFT_CODE)).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_OTHER_APPLIED' })
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
    expect(cartCodes.get(cartIdNow())).toBe('TI')
    expect(linesNow()).toEqual([`${CREAM}×1`])
  })

  it('removeDiscountCode takes it off, and the cart is read as a cart without a code', async () => {
    await ready()
    add(CREAM)
    await idle()
    await Vio.applyDiscountCode('TI')
    calls = []

    await expect(Vio.removeDiscountCode()).resolves.toMatchObject({ removed: true, carts: [{ sponsorId: FAVES, code: 'TI', status: 'removed' }] })

    expect(ops()).toEqual(['DeleteAppliedDiscount', 'GetCart'])
    expect(calls[0]).toMatchObject({ key: 'key-484', variables: { cartId: cartIdNow(), code: 'TI' } })
    expect(calls[1]!.query).not.toContain('discount_code')
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(cartCodes.has(cartIdNow())).toBe(false)
  })

  it('a gateway without the cart\'s discount_code and without gifts: the code still goes on, the old documents are sent', async () => {
    gateway.knowsCartDiscountCode = false
    gateway.knowsDiscountSource = false
    gateway.knowsGifts = false
    await ready()
    add(CREAM)
    await idle()
    calls = []

    await expect(Vio.applyDiscountCode('TI')).resolves.toMatchObject({ status: 'applied' })

    expect(ops()).toEqual(['ApplyDiscount', 'ApplyDiscount', 'GetCart', 'GetCart', 'GetCart'])
    expect(calls[1]!.query).not.toContain('gifts')
    expect(calls[2]!.query).toContain('discount_source')
    expect(calls[3]!.query).toContain('discount_code')
    expect(calls[3]!.query).not.toContain('discount_source')
    expect(calls[4]!.query).not.toContain('discount_code')
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
  })

  it('a typed gift code brings its gift too, and taking the code off takes the gift out again', async () => {
    await ready()
    add(CREAM)
    await idle()

    await expect(Vio.applyDiscountCode(GIFT_CODE)).resolves.toMatchObject({ status: 'applied' })
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])

    await Vio.removeDiscountCode()
    await idle()
    expect(linesNow()).toEqual([`${CREAM}×1`])
    expect(serverLines()).toEqual([`${CREAM}×1`])
  })
})

describe('Vio.init({ discountCode }) — the page\'s code, without the shopper typing it', () => {
  it('the cart gets a line; then the code goes on, with the cart\'s channel key, and its gift is put in the cart', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()

    expect(ops()).toEqual(['CreateCart', 'AddItem', 'ApplyDiscount', 'AddItem', 'GetCart'])
    expect(calls[2]).toMatchObject({ key: 'key-484', variables: { cartId: cartIdNow(), code: GIFT_CODE } })
    // The gift: one unit of the product the code names, on the same cart and key.
    expect(calls[3]).toMatchObject({
      key: 'key-484',
      variables: { cartId: cartIdNow(), lineItems: [{ product_id: MASK, quantity: 1, variant_id: null }] },
    })
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe(GIFT_CODE)
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    expect(Vio.cart.getCart(FAVES)?.gifts).toEqual([{ productId: MASK, added: true }])

    // More lines afterwards: nothing about the code is asked again, and the gift is not added twice.
    calls = []
    add(CREAM)
    await idle()
    expect(ops()).toEqual(['AddItem'])
    expect(linesNow()).toEqual([`${CREAM}×2`, `${MASK}×1`])
  })

  it('what the cart costs: the gift keeps its list price and its discount, and the totals are what is paid', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()

    expect(lineOf(MASK)).toMatchObject({ unitPrice: 52, quantity: 1, discount: 52 })
    expect(lineOf(CREAM)).not.toHaveProperty('discount')
    expect(Vio.cart.subtotalForSponsor(FAVES)).toBe(401)
    expect(Vio.cart.discountForSponsor(FAVES)).toBe(52)
    expect(Vio.cart.totalForSponsor(FAVES)).toBe(349)
    expect(Vio.checkout.open(FAVES)).toMatchObject({ subtotal: 401, discount: 52 })
    Vio.checkout.close()
  })

  it('a percentage on the whole cart: every line says its share, and a tap on + keeps the totals right', async () => {
    await ready({ discountCode: 'TI' })
    add(CREAM)
    add(TINY)
    await idle()
    expect(lineOf(CREAM)).toMatchObject({ unitPrice: 349, discount: 34.9 })
    expect(lineOf(TINY)).toMatchObject({ unitPrice: 5, discount: 0.5 })
    expect(Vio.cart.totalForSponsor(FAVES)).toBe(318.6)

    Vio.cart.adjustQuantity(lineOf(CREAM)!.id, FAVES, +1)
    // At once, before the server answers: two creams, twice the amount off.
    expect(Vio.cart.totalForSponsor(FAVES)).toBe(632.7)
    await idle()
    expect(lineOf(CREAM)).toMatchObject({ quantity: 2, discount: 69.8 })
    expect(Vio.cart.totalForSponsor(FAVES)).toBe(632.7)
  })

  it('the shopper takes the gift out: it stays out for that cart', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    Vio.cart.removeItem(lineOf(MASK)!.id, FAVES)
    await idle()
    add(CREAM)
    await idle()
    await Vio.cart.refreshFromServer(FAVES)
    await idle()

    expect(linesNow()).toEqual([`${CREAM}×2`])
    expect(serverLines()).toEqual([`${CREAM}×2`])
    expect(count('ApplyDiscount')).toBe(1)
    expect(Vio.cart.getCart(FAVES)?.gifts).toEqual([{ productId: MASK, added: true, declined: true }])
  })

  it('the last line to pay for goes: the gift goes with it — a cart of the gift alone cannot be paid for', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    const cartId = cartIdNow()

    Vio.cart.removeItem(lineOf(CREAM)!.id, FAVES)
    // At once, not after the server answered: the shopper never sees a cart of the gift alone.
    expect(Vio.cart.getCart(FAVES)).toBeUndefined()
    await idle()
    expect(carts.get(cartId)).toEqual([])

    // The next cart starts over: code, then gift.
    add(CREAM)
    await idle()
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])
  })

  it('a gift the shopper put in the cart themselves is theirs: it is not added twice, nor taken out', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(MASK)
    add(CREAM)
    await idle()
    expect(linesNow()).toEqual([`${MASK}×1`, `${CREAM}×1`])
    expect(count('AddItem')).toBe(2)

    Vio.cart.removeItem(lineOf(CREAM)!.id, FAVES)
    await idle()
    expect(linesNow()).toEqual([`${MASK}×1`])
  })

  it('the gift cannot be added (not sold on this channel): the purchase goes on without it, and it is not tried again', async () => {
    gateway.unavailable.add(MASK)
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    add(CREAM)
    await idle()

    expect(linesNow()).toEqual([`${CREAM}×2`])
    expect(calls.filter((c) => c.op === 'AddItem' && c.variables.lineItems[0].product_id === MASK)).toHaveLength(1)
    await Vio.checkout.startVippsExpress(FAVES)
    expect(charged).toEqual([698])
  })

  it('a cart below the coupon\'s minimum: asked, refused, and asked again when the cart holds more', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(TINY)
    await idle()
    expect(count('ApplyDiscount')).toBe(1)
    expect(linesNow()).toEqual([`${TINY}×1`])
    await Vio.cart.refreshFromServer(FAVES)
    await idle()
    expect(count('ApplyDiscount')).toBe(1)

    add(TINY)
    await idle()
    expect(count('ApplyDiscount')).toBe(2)
    expect(linesNow()).toEqual([`${TINY}×2`, `${MASK}×1`])
  })

  it('the coupon is over in the brand\'s shop (COUPON_EXPIRED): nothing on screen, nothing asked twice, and the article keeps selling', async () => {
    gateway.expired.add(GIFT_CODE)
    const cartErrors = vi.fn()
    await ready({ discountCode: GIFT_CODE })
    Vio.cart.addEventListener('error', cartErrors)
    add(CREAM)
    await idle()
    add(CREAM)
    await idle()
    await Vio.cart.refreshFromServer(FAVES)
    const started = await Vio.checkout.startVippsExpress(FAVES)
    await idle()

    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(count('ApplyDiscount')).toBe(1)
    expect(charged).toEqual([698])
    expect(linesNow()).toEqual([`${CREAM}×2`])
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    // No `vio:cart-error`, no error event: a line in the console is all.
    expect(cartErrors).not.toHaveBeenCalled()
    Vio.cart.removeEventListener('error', cartErrors)
    // …and a later page load with the same cart does not ask the brand's shop again.
    expect(Vio.cart.getCart(FAVES)?.discountRefusal).toEqual({ code: GIFT_CODE, reason: 'COUPON_EXPIRED' })
    calls = []
    Vio.cart.ensureDiscountCodes()
    await idle()
    expect(ops()).toEqual([])
  })

  it('the server cart no longer carries the code (GetCart says so): the gift the SDK put in for it goes out, it would be paid for', async () => {
    await ready({ discountCode: 'FINNESIKKE' })
    add(CREAM)
    await idle()
    await Vio.applyDiscountCode(GIFT_CODE)
    await idle()
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])

    // Taken off behind this tab's back (the brand's shop, support, another device).
    cartCodes.delete(cartIdNow())
    await Vio.cart.refreshFromServer(FAVES)
    await idle()

    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(Vio.cart.getCart(FAVES)).not.toHaveProperty('gifts')
    expect(linesNow()).toEqual([`${CREAM}×1`])
    expect(serverLines()).toEqual([`${CREAM}×1`])
  })

  it('a code Commerce does not know: asked once, and the purchase goes on', async () => {
    await ready({ discountCode: 'FINNESIKKE' })
    add(CREAM)
    await idle()
    await Vio.checkout.startVippsExpress(FAVES)
    expect(count('ApplyDiscount')).toBe(1)
    expect(charged).toEqual([349])
  })

  it('discountGiftExpected: a configured gift code promises a gift before it is settled, then stops once the gift is in', async () => {
    await ready({ discountCode: GIFT_CODE })
    // No cart yet (an empty-cart Express is about to create one): the gift is coming.
    expect(Vio.cart.discountGiftExpected(FAVES)).toBe(true)
    add(CREAM)
    await idle()
    // The gift is in the cart now: nothing more to add, nothing to announce.
    expect(linesNow()).toContain(`${MASK}×1`)
    expect(Vio.cart.discountGiftExpected(FAVES)).toBe(false)
  })

  it('discountGiftExpected: a plain percentage code, or no code at all, never promises a gift', async () => {
    await ready({ discountCode: 'TI' })
    add(CREAM)
    await idle()
    expect(Vio.cart.discountGiftExpected(FAVES)).toBe(false)

    await ready()
    add(CREAM)
    await idle()
    expect(Vio.cart.discountGiftExpected(FAVES)).toBe(false)
  })

  it('the carts the page opens with are asked at init, without a tap', async () => {
    const key = `surface-key-${++keySeq}`
    Vio.init({ apiKey: key, environment: 'testing' } as never)
    Vio.cart.clearAllCarts()
    Vio.checkout.close()
    await Vio.bootstrap()
    add(CREAM)
    await idle()
    calls = []

    // The next page of the visit names a code of its own: asked once its bootstrap says the brand's ways to pay take codes.
    Vio.init({ apiKey: key, environment: 'testing', discountCode: 'TI' } as never)
    await idle()
    expect(ops()).toEqual([])
    await Vio.bootstrap()
    await idle()

    expect(ops()).toEqual(['ApplyDiscount', 'GetCart'])
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
  })
})

describe('paying with a discount code on the cart', () => {
  it('Vipps Express straight from the product (add, then pay): code and gift are on the cart before the checkout and the payment exist', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    const started = await Vio.checkout.startVippsExpress(FAVES)

    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(count('ApplyDiscount')).toBe(1)
    expect(ops().indexOf('ApplyDiscount')).toBeLessThan(ops().indexOf('CreateCheckout'))
    // The gift's AddItem (the second one) comes before the checkout too.
    expect(ops().lastIndexOf('AddItem')).toBeLessThan(ops().indexOf('CreateCheckout'))
    expect(before('CreateCheckout', 'CreatePaymentVipps')).toBe(true)
    expect(serverLines()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    // What Vipps charges: the cream — the mask is the gift.
    expect(charged).toEqual([349])
  })

  it('a checkout built from the cart (createCheckout): the code first', async () => {
    await ready({ discountCode: 'TI' })
    add(CREAM)
    await Vio.checkout.createCheckout(FAVES)
    expect(before('ApplyDiscount', 'CreateCheckout')).toBe(true)
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
  })

  it('ApplyDiscount fails as a call: the purchase goes on without the discount, asked twice at most', async () => {
    gateway.applyThrows = true
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    const started = await Vio.checkout.startVippsExpress(FAVES)

    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(charged).toEqual([349])
    expect(count('ApplyDiscount')).toBeLessThanOrEqual(2)
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(linesNow()).toEqual([`${CREAM}×1`])
  })

  it('the brand\'s shop is slow: the payment waits for the page\'s code and its gift — past the old budget — then pays discounted', async () => {
    await ready({ discountCode: GIFT_CODE })
    let open!: () => void
    gateway.applyGate = new Promise<void>((resolve) => (open = resolve))
    add(CREAM)
    let started: unknown
    const starting = Vio.checkout.startVippsExpress(FAVES).then((res) => (started = res))

    // The brand's shop has not answered: nothing is built on the cart yet — the gift is still coming.
    await flush()
    await flush()
    expect(started).toBeUndefined()
    expect(count('CreateCheckout')).toBe(0)
    expect(serverLines()).toEqual([`${CREAM}×1`])

    // It answers: the code and its gift go on the cart, then the discounted payment — the gift is never lost.
    open()
    gateway.applyGate = null
    await starting
    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(serverLines()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    expect(cartCodes.get(cartIdNow())).toBe(GIFT_CODE)
    // What Vipps charges: the cream — the mask is the gift.
    expect(charged).toEqual([349])
  })

  it('the gift is in the cart before the payment is attempted: a payment that fails for another reason leaves it there', async () => {
    await ready({ discountCode: GIFT_CODE })
    gateway.vippsDown = true
    add(CREAM)
    await expect(Vio.checkout.startVippsExpress(FAVES)).rejects.toThrow(/503/)
    await idle()

    // The gift went in while the payment was being prepared; the 503 does not take it out.
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    expect(serverLines()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe(GIFT_CODE)
  })

  it('a page with no discount code waits for nothing: the payment starts at once, no ApplyDiscount', async () => {
    await ready()
    add(CREAM)
    await idle()
    calls = []
    await expect(Vio.checkout.startVippsExpress(FAVES)).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(ops()).not.toContain('ApplyDiscount')
    expect(charged).toEqual([349])
  })

  it('a code the shopper typed is waited for, however long the brand\'s shop takes', async () => {
    await ready()
    add(CREAM)
    await idle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let open!: () => void
    gateway.applyGate = new Promise<void>((resolve) => (open = resolve))
    const applying = Vio.applyDiscountCode('TI')
    const starting = Vio.checkout.startVippsExpress(FAVES)

    await vi.advanceTimersByTimeAsync(DISCOUNT_SETTLE_BUDGET_MS * 3)
    expect(count('CreateCheckout')).toBe(0)
    open()
    await vi.advanceTimersByTimeAsync(50)
    await expect(applying).resolves.toMatchObject({ status: 'applied' })
    await expect(starting).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(charged).toEqual([349 * 0.9])
  })

  it('the coupon ended after it went on the cart (COUPON_EXPIRED when the payment is started): the code and its gift come off, and the next attempt pays', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    gateway.expired.add(GIFT_CODE)

    await expect(Vio.checkout.startVippsExpress(FAVES)).rejects.toThrow(/COUPON_EXPIRED/)
    await idle()

    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(cartCodes.has(cartIdNow())).toBe(false)
    expect(linesNow()).toEqual([`${CREAM}×1`])
    expect(serverLines()).toEqual([`${CREAM}×1`])
    // Not asked for again on this cart, by a tap or by the page.
    const asked = count('ApplyDiscount')
    await expect(Vio.checkout.startVippsExpress(FAVES)).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(count('ApplyDiscount')).toBe(asked)
    expect(charged).toEqual([349])
  })

  it('the cart fell under the coupon\'s minimum (COUPON_MIN_AMOUNT when the payment is started): code and gift come off — and come back when the cart holds enough again', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(TINY, 2)
    await idle()
    expect(linesNow()).toEqual([`${TINY}×2`, `${MASK}×1`])
    // One of the two goes: 5 kr is under the 10 kr the coupon asks for.
    Vio.cart.adjustQuantity(lineOf(TINY)!.id, FAVES, -1)
    await idle()

    await expect(Vio.checkout.startVippsExpress(FAVES)).rejects.toThrow(/COUPON_MIN_AMOUNT/)
    await idle()
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBeUndefined()
    expect(linesNow()).toEqual([`${TINY}×1`])
    expect(serverLines()).toEqual([`${TINY}×1`])
    // Asked for nothing more with the cart as it is…
    const asked = count('ApplyDiscount')
    await Vio.cart.refreshFromServer(FAVES)
    await expect(Vio.checkout.startVippsExpress(FAVES)).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(count('ApplyDiscount')).toBe(asked)
    expect(charged).toEqual([5])

    // …and again when the cart holds more.
    Vio.cart.adjustQuantity(lineOf(TINY)!.id, FAVES, +1)
    await idle()
    expect(count('ApplyDiscount')).toBe(asked + 1)
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe(GIFT_CODE)
    expect(linesNow()).toEqual([`${TINY}×2`, `${MASK}×1`])
  })

  it('a gift line with two units (GIFT_MAX_ONE_UNIT): the payment does not start, and the cart is read again', async () => {
    await ready({ discountCode: GIFT_CODE })
    add(MASK, 2)
    add(CREAM)
    await idle()
    calls = []

    await expect(Vio.checkout.startVippsExpress(FAVES)).rejects.toThrow(/GIFT_MAX_ONE_UNIT/)
    await idle()

    expect(charged).toEqual([])
    // The code is fine: it stays; the cart is the server's again.
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe(GIFT_CODE)
    expect(ops().lastIndexOf('GetCart')).toBeGreaterThan(ops().indexOf('CreatePaymentVipps'))
    expect(count('DeleteAppliedDiscount')).toBe(0)
  })
})

describe('a code the shopper typed, still being checked when they tap to pay', () => {
  /** The brand's shop answers when the test says. */
  function slowShop() {
    let open!: () => void
    gateway.applyGate = new Promise<void>((resolve) => (open = resolve))
    return () => {
      gateway.applyGate = null
      open()
    }
  }

  it('not taken: no payment is started — the shopper reads why first — and the next tap pays for the cart as it is', async () => {
    await ready()
    add(CREAM)
    await idle()
    const answer = slowShop()
    const typed = Vio.applyDiscountCode('FINNESIKKE', FAVES)
    await flush()
    let outcome: unknown = 'waiting'
    const starting = Vio.checkout.startVippsExpress(FAVES)
    void starting.then(
      (res) => (outcome = res),
      (err) => (outcome = err),
    )
    await flush()
    await flush()
    // Nothing is built on the cart while its code is being checked.
    expect(outcome).toBe('waiting')
    expect(count('CreateCheckout')).toBe(0)

    answer()
    await expect(typed).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_NOT_FOUND' })
    await expect(starting).rejects.toThrow(/no payment started \[COUPON_NOT_FOUND\]$/)
    await idle()
    expect(count('CreateCheckout')).toBe(0)
    expect(count('CreatePaymentVipps')).toBe(0)
    expect(charged).toEqual([])
    expect(linesNow()).toEqual([`${CREAM}×1`])

    await expect(Vio.checkout.startVippsExpress(FAVES)).resolves.toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(charged).toEqual([349])
    // The refused code is not asked for again behind the shopper's back.
    expect(count('ApplyDiscount')).toBe(1)
  })

  it(`taken: the payment waits for it — well past the ${DISCOUNT_SETTLE_BUDGET_MS} ms a page's own code gets — and charges what the code leaves`, async () => {
    await ready()
    add(CREAM)
    await idle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const answer = slowShop()
    void Vio.applyDiscountCode('TI', FAVES)
    let started: unknown
    void Vio.checkout.startVippsExpress(FAVES).then((res) => (started = res))

    await vi.advanceTimersByTimeAsync(DISCOUNT_SETTLE_BUDGET_MS * 3)
    expect(started).toBeUndefined()
    expect(count('CreateCheckout')).toBe(0)

    answer()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(before('ApplyDiscount', 'CreateCheckout')).toBe(true)
    expect(charged).toHaveLength(1)
    expect(charged[0]).toBeCloseTo(314.1)
  })

  it('refused because the page\'s own code is on the cart: that code stays, and the next tap pays with it', async () => {
    await ready({ discountCode: 'TI' })
    add(CREAM)
    await idle()
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')
    const answer = slowShop()
    const typed = Vio.applyDiscountCode(GIFT_CODE, FAVES)
    await flush()
    const starting = Vio.checkout.startVippsExpress(FAVES)
    const refusedStart = expect(starting).rejects.toThrow(/\[COUPON_OTHER_APPLIED\]$/)
    answer()
    await expect(typed).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_OTHER_APPLIED' })
    await refusedStart
    await idle()
    expect(count('DeleteAppliedDiscount')).toBe(0)
    expect(Vio.cart.getCart(FAVES)?.discountCode).toBe('TI')

    await Vio.checkout.startVippsExpress(FAVES)
    expect(charged).toHaveLength(1)
    expect(charged[0]).toBeCloseTo(314.1)
  })
})

describe('?vio_discount= in the URL', () => {
  it('is the page\'s code when the config names none — and stays for the tab', async () => {
    vi.stubGlobal('location', { href: 'https://host.example/a?vio_discount=TI', pathname: '/a', search: '?vio_discount=TI', host: 'host.example' })
    await ready()
    add(CREAM)
    await idle()
    expect(calls.find((c) => c.op === 'ApplyDiscount')?.variables).toMatchObject({ code: 'TI' })

    // The next page of the visit has no parameter: the tab remembers.
    vi.stubGlobal('location', { href: 'https://host.example/b', pathname: '/b', search: '', host: 'host.example' })
    await ready()
    add(CREAM)
    await idle()
    expect(calls.filter((c) => c.op === 'ApplyDiscount').map((c) => c.variables.code)).toEqual(['TI', 'TI'])
  })

  it('the config\'s code wins over it', async () => {
    vi.stubGlobal('location', { href: 'https://host.example/a?vio_discount=TI', pathname: '/a', search: '?vio_discount=TI', host: 'host.example' })
    await ready({ discountCode: GIFT_CODE })
    add(CREAM)
    await idle()
    expect(calls.find((c) => c.op === 'ApplyDiscount')?.variables).toMatchObject({ code: GIFT_CODE })
  })
})

describe('a page without discount codes', () => {
  it('adds, reads and checks out with the calls it always made — none about discounts', async () => {
    await ready()
    add(CREAM)
    await Vio.cart.waitForCartMutations(FAVES)
    await Vio.cart.refreshFromServer(FAVES)
    await Vio.checkout.createCheckout(FAVES)
    await idle()

    expect(ops()).toEqual(['CreateCart', 'AddItem', 'GetCart', 'GetCart', 'CreateCheckout', 'UpdateCheckout'])
    for (const call of calls) expect(call.query).not.toMatch(/ApplyDiscount|DeleteAppliedDiscount/)
    expect(calls.filter((c) => c.op === 'GetCart').every((c) => !c.query.includes('discount_code'))).toBe(true)
    expect(Vio.cart.getCart(FAVES)).not.toHaveProperty('discountCode')
    expect(Vio.cart.getCart(FAVES)).not.toHaveProperty('gifts')
  })

  it('pays with Vipps Express with the calls it always made', async () => {
    await ready()
    add(CREAM)
    await Vio.checkout.startVippsExpress(FAVES)
    await idle()
    expect(ops()).toEqual(['CreateCart', 'AddItem', 'GetCart', 'CreateCheckout', 'UpdateCheckout', 'CreatePaymentVipps'])
    expect(charged).toEqual([349])
  })
})

// ── The campaign's code: set in Vio's dashboard, on the campaign, per sponsor ──

describe('the campaign\'s code — set in the dashboard per campaign and brand, applied by reference: the page never sees it', () => {
  const T0 = new Date('2026-11-10T10:00:00Z').getTime()
  let clock = T0

  beforeEach(() => {
    bootstrap = campaignBoot
    vi.useFakeTimers({ toFake: ['Date'] })
    clock = T0
    vi.setSystemTime(clock)
  })

  /** A line of `productId` added on a page of `campaignId`, for `sponsorId`'s cart. */
  const addFrom = (productId: number, campaignId: number, sponsorId = FAVES) =>
    Vio.cart.addManual({
      productId,
      sponsorId,
      brand: sponsorId === FAVES ? 'Brand A' : 'Brand B',
      name: `P${productId}`,
      unitPrice: priceOf(productId),
      currency: 'NOK',
      imageUrl: '',
      origin: { campaignId, slot: 'article-1' },
    })
  /** Until nothing of either brand's cart is in flight. */
  async function idleBoth() {
    for (let quiet = 0; quiet < 5; ) {
      await Vio.cart.waitForCartMutations(FAVES)
      await Vio.cart.waitForCartMutations(TINT)
      await flush()
      quiet = Vio.cart.discountBusy() ? 0 : quiet + 1
    }
  }
  /** The tab comes back after six minutes: the bootstrap is fetched again — what the dashboard says now. */
  async function tabBack() {
    clock += 6 * 60_000
    vi.setSystemTime(clock)
    for (const fn of visibilityListeners) fn()
    await flush()
    await idleBoth()
  }
  /** What each ApplyDiscount asked for: `campaign N`, or the code. */
  const applied = () =>
    calls.filter((c) => c.op === 'ApplyDiscount' || c.op === 'ApplyCampaignDiscount').map((c) => (c.variables.campaignId !== undefined ? `campaign ${c.variables.campaignId}` : c.variables.code))
  const cart = () => Vio.cart.getCart(FAVES)
  /** The calls by operation, a campaign's apply and removal named as such. */
  const opsNamed = () => ops().map((o) => (o === 'ApplyCampaignDiscount' ? 'ApplyDiscount(campaign)' : o === 'DeleteCartDiscount' ? 'DeleteAppliedDiscount(cart)' : o))

  it('a page of the campaign: the brand\'s code goes on its cart by itself — by campaign — with its gift', async () => {
    dashboard = { '5:7': GIFT_CODE }
    await ready({ campaignId: 5 })
    expect(Configuration.get()).not.toHaveProperty('discountCode')
    addFrom(CREAM, 5)
    await idle()

    expect(opsNamed()).toEqual(['CreateCart', 'AddItem', 'ApplyDiscount(campaign)', 'AddItem', 'GetCart'])
    expect(calls[2]).toMatchObject({ key: 'key-484', variables: { cartId: cartIdNow(), campaignId: 5 } })
    expect(calls[2]!.variables).not.toHaveProperty('code')
    expect(cartCodes.get(cartIdNow())).toBe(GIFT_CODE)
    expect(cart()).toMatchObject({ discountSource: 'CAMPAIGN', discountCampaignId: 5, gifts: [{ productId: MASK, added: true }] })
    expect(linesNow()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    expect(Vio.cart.totalForSponsor(FAVES)).toBe(349)
  })

  it('the code is never on the page: not in the bootstrap, the calls, the cart, nor what the cart says', async () => {
    dashboard = { '5:7': 'TI' }
    await ready({ campaignId: 5 })
    addFrom(CREAM, 5)
    await idle()

    expect(JSON.stringify(campaignBoot())).not.toContain('"TI"')
    expect(calls.every((c) => !JSON.stringify(c.variables).includes('"TI"'))).toBe(true)
    expect(JSON.stringify(cart())).not.toContain('"TI"')
    expect(cart()).not.toHaveProperty('discountCode')
    expect(Vio.cart.discountCodeForSponsor(FAVES)).toBeUndefined()
    expect(Vio.cart.hasDiscountCode(FAVES)).toBe(true)
    expect(Vio.cart.discountSourceForSponsor(FAVES)).toBe('CAMPAIGN')
    // What it takes off is shown as any discount: the cream is 10 % off.
    expect(lineOf(CREAM)).toMatchObject({ discount: 34.9 })
  })

  it('the discount of THAT campaign: the page\'s campaign gives its own, a page without one the default campaign\'s, an element\'s vio-campaign first', async () => {
    dashboard = { '4:7': 'TI', '5:7': GIFT_CODE }
    await ready()
    addFrom(CREAM, 4)
    await idle()
    expect(applied()).toEqual(['campaign 4'])
    expect(cart()?.discountCampaignId).toBe(4)

    calls = []
    await ready({ campaignId: 5 })
    addFrom(CREAM, 5)
    await idle()
    expect(applied()).toEqual(['campaign 5'])

    // Vio.init says 4, but the page's element says 5: the element's campaign is the page's.
    calls = []
    pageElements = [{ getAttribute: (name) => (name === 'vio-campaign' ? '5' : null) }]
    await ready({ campaignId: 4 })
    addFrom(CREAM, 5)
    await idle()
    expect(applied()).toEqual(['campaign 5'])
    expect(cart()?.discountCampaignId).toBe(5)
  })

  it('only that brand\'s cart: another brand of the campaign without a code gets none — with its own, its own', async () => {
    dashboard = { '5:7': 'TI' }
    await ready({ campaignId: 5 })
    addFrom(CREAM, 5)
    addFrom(LIPSTICK, 5, TINT)
    await idleBoth()
    const otherCart = Vio.cart.getCart(TINT)?.cartId
    expect(calls.filter((c) => c.op === 'ApplyCampaignDiscount').map((c) => c.variables.cartId)).toEqual([cartIdNow()])
    expect(Vio.cart.hasDiscountCode(TINT)).toBe(false)
    // The other brand's cart is read as it always was: its GetCarts do not even ask about a code.
    expect(calls.filter((c) => c.op === 'GetCart' && c.variables.cartId === otherCart).every((c) => !c.query.includes('discount_code'))).toBe(true)

    calls = []
    dashboard = { '5:7': 'TI', '5:8': 'TINT20' }
    await ready({ campaignId: 5 })
    addFrom(CREAM, 5)
    addFrom(LIPSTICK, 5, TINT)
    await idleBoth()
    const asked = calls.filter((c) => c.op === 'ApplyCampaignDiscount')
    expect(asked.map((c) => [c.key, c.variables.campaignId])).toEqual(
      expect.arrayContaining([
        ['key-484', 5],
        ['key-490', 5],
      ]),
    )
    expect(asked).toHaveLength(2)
    expect(cartCodes.get(Vio.cart.getCart(TINT)!.cartId!)).toBe('TINT20')
    expect(cartCodes.get(cartIdNow())).toBe('TI')
  })

  it('the page\'s own code is the override, for every cart: Vio.init({ discountCode }) or ?vio_discount=', async () => {
    dashboard = { '5:7': GIFT_CODE }
    await ready({ campaignId: 5, discountCode: 'TI' })
    addFrom(CREAM, 5)
    await idle()
    expect(applied()).toEqual(['TI'])
    // The page's own code is not the campaign's: no campaign to follow, and it shows.
    expect(cart()).not.toHaveProperty('discountCampaignId')
    expect(cart()).toMatchObject({ discountCode: 'TI' })

    calls = []
    vi.stubGlobal('location', { href: 'https://host.example/a?vio_discount=TI', pathname: '/a', search: '?vio_discount=TI', host: 'host.example' })
    await ready({ campaignId: 5 })
    addFrom(CREAM, 5)
    await idle()
    expect(applied()).toEqual(['TI'])
  })

  it('refused (the code is unknown in the brand\'s shop): asked once, in silence, and the purchase goes on at its prices', async () => {
    dashboard = { '5:7': 'UNKNOWN_CODE' }
    await ready({ campaignId: 5 })
    addFrom(CREAM, 5)
    await idle()
    await Vio.checkout.startVippsExpress(FAVES)
    expect(applied()).toEqual(['campaign 5'])
    expect(charged).toEqual([349])
    expect(Vio.cart.hasDiscountCode(FAVES)).toBe(false)
  })

  it('a gateway that does not take a campaign: asked once, no code, nothing more asked on this page load — and the purchase goes on', async () => {
    gateway.knowsCampaign = false
    dashboard = { '5:7': 'TI' }
    await ready({ campaignId: 5 })
    addFrom(CREAM, 5)
    await idle()
    addFrom(LIPSTICK, 5)
    await idle()
    await Vio.checkout.startVippsExpress(FAVES)
    expect(count('ApplyCampaignDiscount')).toBe(1)
    expect(Vio.cart.hasDiscountCode(FAVES)).toBe(false)
    expect(charged).toEqual([548])
  })

  it('paying: the campaign\'s code and its gift are on the cart before the checkout and the payment — waited for, as the page\'s own', async () => {
    dashboard = { '5:7': GIFT_CODE }
    await ready({ campaignId: 5 })
    let open!: () => void
    gateway.applyGate = new Promise<void>((resolve) => (open = resolve))
    addFrom(CREAM, 5)
    expect(Vio.cart.discountGiftExpected(FAVES)).toBe(true)
    let started: unknown
    const starting = Vio.checkout.startVippsExpress(FAVES).then((res) => (started = res))
    await flush()
    await flush()
    expect(started).toBeUndefined()
    expect(count('CreateCheckout')).toBe(0)

    open()
    gateway.applyGate = null
    await starting
    expect(started).toMatchObject({ payment_url: 'https://vipps.test/pay' })
    expect(ops().indexOf('ApplyCampaignDiscount')).toBeLessThan(ops().indexOf('CreateCheckout'))
    expect(ops().lastIndexOf('AddItem')).toBeLessThan(ops().indexOf('CreateCheckout'))
    expect(serverLines()).toEqual([`${CREAM}×1`, `${MASK}×1`])
    expect(charged).toEqual([349])
  })

  it('a brand with no code in the page\'s campaign promises no gift and waits for nothing', async () => {
    dashboard = { '5:7': GIFT_CODE }
    await ready({ campaignId: 5 })
    expect(Vio.cart.discountGiftExpected(TINT)).toBe(false)
    addFrom(LIPSTICK, 5, TINT)
    await Vio.checkout.startVippsExpress(TINT)
    expect(applied()).toEqual([])
    expect(ops()).toEqual(['CreateCart', 'AddItem', 'GetCart', 'CreateCheckout', 'UpdateCheckout', 'CreatePaymentVipps'])
  })

  describe('a brand none of whose ways to pay takes codes', () => {
    it('discountMethods empty: neither the campaign\'s code nor the page\'s own — the calls it always made', async () => {
      dashboard = { '5:7': 'TI' }
      discountMethodsOf = { [FAVES]: [] }
      for (const config of [{ campaignId: 5 }, { campaignId: 5, discountCode: 'TI' }]) {
        calls = []
        await ready(config)
        addFrom(CREAM, 5)
        await idle()
        await Vio.checkout.startVippsExpress(FAVES)
        expect(ops()).toEqual(['CreateCart', 'AddItem', 'GetCart', 'CreateCheckout', 'UpdateCheckout', 'CreatePaymentVipps'])
        expect(Vio.cart.discountGiftExpected(FAVES)).toBe(false)
        Vio.checkout.close()
      }
    })

    it('a bootstrap without discountMethods: paid with Vipps takes codes, without Vipps none', async () => {
      dashboard = { '5:7': 'TI' }
      discountMethodsOf = { [FAVES]: null }
      paymentMethodsOf = { [FAVES]: ['klarna', 'apple_pay'] }
      await ready({ campaignId: 5, discountCode: 'TI' })
      addFrom(CREAM, 5)
      await idle()
      expect(applied()).toEqual([])

      paymentMethodsOf = { [FAVES]: ['klarna', 'vipps'] }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      expect(applied()).toEqual(['campaign 5'])
    })

    it('a code the shopper types is still asked: Commerce answers for it', async () => {
      discountMethodsOf = { [FAVES]: [] }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      await expect(Vio.applyDiscountCode('TI')).resolves.toMatchObject({ status: 'applied' })
      expect(cart()).toMatchObject({ discountCode: 'TI' })
    })
  })

  it('the page\'s own code waits for the bootstrap (it says whether the brand takes codes), then goes on — even when no campaign gives one', async () => {
    const key = `surface-key-${++keySeq}`
    Vio.init({ apiKey: key, environment: 'testing' } as never)
    Vio.cart.clearAllCarts()
    Vio.checkout.close()
    await Vio.bootstrap()
    addFrom(CREAM, 5)
    await idle()
    calls = []

    Vio.init({ apiKey: key, environment: 'testing', discountCode: 'TI' } as never)
    await idle()
    expect(ops()).toEqual([])

    await Vio.bootstrap()
    await idle()
    expect(ops()).toEqual(['ApplyDiscount', 'GetCart'])
    expect(cart()).toMatchObject({ discountCode: 'TI' })
  })

  describe('dynamic: the cart follows what the dashboard says now', () => {
    it('the code changes (a new reference): at the next bootstrap the old one comes off with its gift — without naming it — and the campaign\'s goes on again', async () => {
      dashboard = { '5:7': GIFT_CODE }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      const cartId = cartIdNow()
      const before = cart()?.discountRef
      expect(cartCodes.get(cartId)).toBe(GIFT_CODE)
      calls = []

      dashboard = { '5:7': 'TI' }
      await tabBack()

      expect(opsNamed()).toEqual(['DeleteAppliedDiscount(cart)', 'DeleteItem', 'ApplyDiscount(campaign)', 'GetCart'])
      expect(calls[0]).toMatchObject({ key: 'key-484', variables: { cartId } })
      expect(calls[0]!.variables).not.toHaveProperty('code')
      expect(calls[2]).toMatchObject({ key: 'key-484', variables: { cartId, campaignId: 5 } })
      expect(cartCodes.get(cartId)).toBe('TI')
      expect(cart()).toMatchObject({ cartId, discountSource: 'CAMPAIGN', discountCampaignId: 5 })
      expect(cart()?.discountRef).not.toBe(before)
      expect(cart()).not.toHaveProperty('gifts')
      // The gift went with its code; the cream is 10 % off now.
      expect(linesNow()).toEqual([`${CREAM}×1`])
      expect(serverLines()).toEqual([`${CREAM}×1`])
      expect(lineOf(CREAM)).toMatchObject({ discount: 34.9 })
      expect(Vio.cart.totalForSponsor(FAVES)).toBe(314.1)
    })

    it('the code is removed (null): it comes off with its gift, and the lines are read again at their prices', async () => {
      dashboard = { '5:7': GIFT_CODE }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      calls = []

      dashboard = {}
      await tabBack()

      expect(opsNamed()).toEqual(['DeleteAppliedDiscount(cart)', 'DeleteItem', 'GetCart'])
      expect(cartCodes.has(cartIdNow())).toBe(false)
      expect(Vio.cart.hasDiscountCode(FAVES)).toBe(false)
      expect(cart()).not.toHaveProperty('discountCampaignId')
      expect(cart()).not.toHaveProperty('discountSource')
      expect(linesNow()).toEqual([`${CREAM}×1`])
      expect(Vio.cart.discountForSponsor(FAVES)).toBe(0)
      // Without a code, every way to pay is back: the next payment charges the list price.
      await Vio.checkout.startVippsExpress(FAVES)
      expect(charged).toEqual([349])
      expect(applied()).toEqual([])
    })

    it('the brand loses its last way to pay that takes codes (the bootstrap sends no discount): the campaign\'s code comes off', async () => {
      dashboard = { '5:7': 'TI' }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      calls = []

      discountMethodsOf = { [FAVES]: [] }
      await tabBack()
      expect(opsNamed()).toEqual(['DeleteAppliedDiscount(cart)', 'GetCart'])
      expect(Vio.cart.hasDiscountCode(FAVES)).toBe(false)
    })

    it('a campaign that stops being the page\'s and the brand\'s (gone from the bootstrap): its code comes off', async () => {
      dashboard = { '5:7': 'TI' }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      calls = []

      bootstrap = () => ({ ...campaignBoot(), campaigns: campaignBoot().campaigns!.filter((c) => c.id !== 5) })
      await tabBack()

      expect(opsNamed()).toEqual(['DeleteAppliedDiscount(cart)', 'GetCart'])
      expect(Vio.cart.hasDiscountCode(FAVES)).toBe(false)
    })

    it('the campaign gives a code mid-visit: the cart that had none gets it at the refresh', async () => {
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      expect(applied()).toEqual([])
      calls = []

      dashboard = { '5:7': 'TI' }
      await tabBack()
      expect(opsNamed()).toEqual(['ApplyDiscount(campaign)', 'GetCart'])
      expect(cart()).toMatchObject({ discountSource: 'CAMPAIGN', discountCampaignId: 5 })
    })

    it('a refresh that changes nothing asks nothing', async () => {
      dashboard = { '5:7': GIFT_CODE }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      calls = []

      await tabBack()
      expect(ops()).toEqual([])
      expect(cart()).toMatchObject({ discountSource: 'CAMPAIGN' })
    })

    it('a code the shopper typed is theirs: the dashboard changing the campaign\'s does not touch it', async () => {
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      await expect(Vio.applyDiscountCode('TI')).resolves.toMatchObject({ status: 'applied' })
      expect(cart()).not.toHaveProperty('discountCampaignId')
      calls = []

      dashboard = { '5:7': GIFT_CODE }
      await tabBack()
      expect(ops()).toEqual([])
      expect(cart()?.discountCode).toBe('TI')
    })

    it('a code the shopper types while the campaign\'s is on: refused as a second code — the campaign\'s stays', async () => {
      dashboard = { '5:7': 'TI' }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      await expect(Vio.applyDiscountCode('TINT20', FAVES)).resolves.toMatchObject({ status: 'refused', reason: 'COUPON_OTHER_APPLIED' })
      expect(cart()).toMatchObject({ discountSource: 'CAMPAIGN', discountCampaignId: 5 })
      expect(cartCodes.get(cartIdNow())).toBe('TI')
    })

    it('the page\'s own code is not the campaign\'s to take off', async () => {
      dashboard = { '5:7': GIFT_CODE }
      await ready({ campaignId: 5, discountCode: 'TI' })
      addFrom(CREAM, 5)
      await idle()
      calls = []

      dashboard = {}
      await tabBack()
      expect(ops()).toEqual([])
      expect(cart()?.discountCode).toBe('TI')
    })

    it('Commerce says the cart carries no code any more: the cart is read again, and the new one goes on', async () => {
      dashboard = { '5:7': 'TI' }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      // Something else took it off the server cart.
      cartCodes.delete(cartIdNow())
      cartCampaigns.delete(cartIdNow())
      calls = []

      dashboard = { '5:7': GIFT_CODE }
      await tabBack()
      expect(opsNamed()).toEqual(['DeleteAppliedDiscount(cart)', 'GetCart', 'ApplyDiscount(campaign)', 'AddItem', 'GetCart'])
      expect(cart()).toMatchObject({ discountSource: 'CAMPAIGN', discountCampaignId: 5 })
      expect(cartCodes.get(cartIdNow())).toBe(GIFT_CODE)
    })

    it('a code that could not be taken off stays — and is not tried again on every change of the cart', async () => {
      dashboard = { '5:7': 'TI' }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      gateway.removeThrows = true
      calls = []

      dashboard = { '5:7': GIFT_CODE }
      await tabBack()
      addFrom(CREAM, 5)
      await idle()
      await Vio.checkout.startVippsExpress(FAVES)
      expect(count('DeleteCartDiscount')).toBe(1)
      expect(applied()).toEqual([])
      expect(cartCodes.get(cartIdNow())).toBe('TI')
      // The purchase goes on with the code the cart has.
      expect(charged).toEqual([628.2])
    })

    it('a later page of the visit (the dashboard changed meanwhile): the cart it opens with is put right when its bootstrap arrives', async () => {
      const key = `surface-key-${++keySeq}`
      dashboard = { '5:7': GIFT_CODE }
      Vio.init({ apiKey: key, environment: 'testing', campaignId: 5 } as never)
      Vio.cart.clearAllCarts()
      Vio.checkout.close()
      await Vio.bootstrap()
      addFrom(CREAM, 5)
      await idle()
      calls = []

      // The next page: the same surface, the code now changed in the dashboard.
      dashboard = { '5:7': 'TI' }
      Vio.init({ apiKey: key, environment: 'testing' } as never)
      await Vio.bootstrap()
      await idle()

      expect(opsNamed()).toEqual(['DeleteAppliedDiscount(cart)', 'DeleteItem', 'ApplyDiscount(campaign)', 'GetCart'])
      expect(cart()).toMatchObject({ discountSource: 'CAMPAIGN', discountCampaignId: 5 })
      expect(cartCodes.get(cartIdNow())).toBe('TI')
    })

    it('a later page with a code of its own, while the campaigns give theirs: the cart it opens with is asked once — the page\'s', async () => {
      const key = `surface-key-${++keySeq}`
      Vio.init({ apiKey: key, environment: 'testing', campaignId: 5 } as never)
      Vio.cart.clearAllCarts()
      Vio.checkout.close()
      await Vio.bootstrap()
      addFrom(CREAM, 5)
      await idle()
      expect(applied()).toEqual([])
      calls = []

      dashboard = { '5:7': GIFT_CODE }
      Vio.init({ apiKey: key, environment: 'testing', campaignId: 5, discountCode: 'TI' } as never)
      await Vio.bootstrap()
      await idle()

      expect(ops()).toEqual(['ApplyDiscount', 'GetCart'])
      expect(cart()).toMatchObject({ discountCode: 'TI' })
      expect(cart()).not.toHaveProperty('discountCampaignId')
    })

    it('the dashboard changed it while the shopper pays: the payment is built on the new code', async () => {
      dashboard = { '5:7': GIFT_CODE }
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await idle()
      calls = []

      dashboard = { '5:7': 'TI' }
      clock += 6 * 60_000
      vi.setSystemTime(clock)
      for (const fn of visibilityListeners) fn()
      await Vio.checkout.startVippsExpress(FAVES)

      expect(before('ApplyCampaignDiscount', 'CreateCheckout')).toBe(true)
      expect(cartCodes.get(cartIdNow())).toBe('TI')
      expect(charged).toEqual([314.1])
    })
  })

  it('no discount in the bootstrap (null everywhere, or a Commerce that predates the field) nor on the page: the calls it always made', async () => {
    for (const make of [campaignBoot, boot]) {
      bootstrap = make
      calls = []
      await ready({ campaignId: 5 })
      addFrom(CREAM, 5)
      await Vio.cart.waitForCartMutations(FAVES)
      await Vio.cart.refreshFromServer(FAVES)
      await Vio.checkout.createCheckout(FAVES)
      await idle()
      await tabBack()

      expect(ops()).toEqual(['CreateCart', 'AddItem', 'GetCart', 'GetCart', 'CreateCheckout', 'UpdateCheckout'])
      expect(calls.filter((c) => c.op === 'GetCart').every((c) => !c.query.includes('discount_code'))).toBe(true)
      expect(Vio.cart.discountGiftExpected(FAVES)).toBe(false)
      Vio.checkout.close()
    }
  })

  it('a bootstrap that still sends a code\'s text on the old field: not read — no code goes on', async () => {
    dashboard = {}
    bootstrap = () => {
      const b = campaignBoot()
      b.campaigns![1]!.primarySponsor = { ...b.campaigns![1]!.primarySponsor!, discountCode: 'TI', discount: null }
      return b
    }
    await ready({ campaignId: 5 })
    addFrom(CREAM, 5)
    await idle()
    expect(applied()).toEqual([])
    expect(ops()).toEqual(['CreateCart', 'AddItem'])
  })
})
