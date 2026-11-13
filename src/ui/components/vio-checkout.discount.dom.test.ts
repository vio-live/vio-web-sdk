// @vitest-environment jsdom
/**
 * The checkout and a discount code.
 *
 * What is paid: the summary's «Sum» stays the lines at their list prices, a
 * «Rabatt» row says what the code takes off them, and «Totalt» and «Betal …
 * med Vipps» are the difference, plus the shipping.
 *
 * How it shows: a line the code takes something off has its list price
 * struck through and then what it costs — «Gratis» for a gift. A cart of the
 * gift alone cannot be paid for, and the summary says why. A payment Commerce
 * refuses because of the code says why too. And the receipt after Vipps is
 * read from the checkout that was paid: its lines, its «Rabatt», its total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

const SPONSOR = 5
const manager = Vio.checkout as any
const RATE = { id: 'p', supplierId: '9', name: 'Posten', method: 'Posten', price: 4900, priceMajor: 49, currency: 'NOK' }
const CREAM = { id: 'c', productId: 100, name: 'Krem', brand: 'Faves', quantity: 1, unitPrice: 349, currency: 'NOK' }
const MASK = { id: 'm', productId: 421306, name: 'Face mask', brand: 'Faves', quantity: 1, unitPrice: 52, discount: 52, currency: 'NOK' }

let items: any[]
let state: Record<string, unknown>

beforeEach(() => {
  items = [CREAM, MASK]
  state = { subtotal: 401, discount: 52 }
  vi.spyOn(manager, 'getOrderReference').mockResolvedValue({ orderNumber: 1, buyerRef: null })
  vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(null)
  const proto = VioCheckout.prototype as any
  for (const m of ['refreshApplePay', 'refreshKlarna']) vi.spyOn(proto, m).mockResolvedValue(undefined)
  vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
    this.availableShippingsList = [RATE]
    this.selectedShipping = RATE.id
    this.shippingsReadyFor = this.embedSession()
  })
  vi.spyOn(manager, 'items', 'get').mockImplementation(() => items)
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(manager, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }])
  vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(false)
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
  vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
  vi.spyOn(Vio.cart, 'discountCodeForSponsor').mockReturnValue('gratis_face_mask')
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], session: 1, currency: 'NOK', ...state }
    manager.emit()
    return manager.state
  })
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  unmountAll()
  document.querySelectorAll('.vio-redirect-overlay').forEach((n) => n.remove())
  manager.state = null
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

async function cycles(el: HTMLElement, n = 6) {
  for (let i = 0; i < n; i++) await settle(el)
}

async function openWithVipps() {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  el.show()
  await cycles(el)
  manager.state = { ...manager.state, paymentMethod: 'vipps' }
  manager.emit()
  await cycles(el)
  return el
}

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
const summaryRows = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.order-summary .order-row') ?? [])].map((r) => text(r))
const summaryRow = (el: HTMLElement, label: string) => summaryRows(el).find((t) => t.startsWith(label))
/** The rows' labels in order, without a code or a shipping name: «Sum», «Rabatt», «Frakt», «Totalt». */
const summaryLabels = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.order-summary .order-row > span:first-child') ?? [])].map(
    (label) => text(label).split(/[\s(–]/)[0],
  )
const summaryLines = (el: HTMLElement) => [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.order-summary .order-line') ?? [])]
const payButton = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLButtonElement>('.complete-cta')!

describe('what is paid', () => {
  it('«Sum» is the list prices; «Rabatt» what the code takes off; «Totalt» and the Vipps button the difference, plus the shipping', async () => {
    const el = await openWithVipps()
    expect(summaryRow(el, 'Sum')).toMatch(/^Sum\s*401 Kr$/)
    expect(summaryRow(el, 'Rabatt')).toMatch(/^Rabatt \(gratis_face_mask\)\s*−52 Kr$/)
    expect(summaryRow(el, 'Frakt')).toMatch(/^Frakt – Posten\s*49 Kr$/)
    expect(summaryRow(el, 'Totalt')).toMatch(/^Totalt\s*398 Kr$/)
    expect(summaryLabels(el)).toEqual(['Sum', 'Rabatt', 'Frakt', 'Totalt'])
    expect(text(payButton(el))).toBe('Betal 398 Kr med Vipps')
  })

  it('the cart changes under the open checkout (the code goes on): the summary and the button follow', async () => {
    state = { subtotal: 401 }
    items = [CREAM, { ...MASK, discount: undefined }]
    const el = await openWithVipps()
    expect(text(payButton(el))).toBe('Betal 450 Kr med Vipps')
    expect(summaryRow(el, 'Rabatt')).toBeUndefined()

    items = [CREAM, MASK]
    manager.state = { ...manager.state, discount: 52 }
    manager.emit()
    await cycles(el)
    expect(summaryRow(el, 'Rabatt')).toMatch(/−52 Kr$/)
    expect(summaryRow(el, 'Totalt')).toMatch(/^Totalt\s*398 Kr$/)
    expect(text(payButton(el))).toBe('Betal 398 Kr med Vipps')
  })

  it('without a discount the summary is the one it always was', async () => {
    state = { subtotal: 401 }
    items = [CREAM, { ...MASK, discount: undefined }]
    const el = await openWithVipps()
    expect(summaryLabels(el)).toEqual(['Sum', 'Frakt', 'Totalt'])
    expect(el.shadowRoot!.querySelector('.order-summary s, .summary-note')).toBeNull()
    expect(summaryLines(el).map((l) => text(l.querySelector('.order-line-price')))).toEqual(['349 Kr', '52 Kr'])
  })
})

describe('how a line shows in the summary', () => {
  it('the gift: its list price struck through, then «Gratis»; a percentage off: then what the line costs', async () => {
    state = { subtotal: 750, discount: 121.8 }
    items = [{ ...CREAM, quantity: 2, discount: 69.8 }, MASK]
    const el = await openWithVipps()
    const [cream, mask] = summaryLines(el)
    expect(text(cream!.querySelector('.order-line-price s'))).toBe('698 Kr')
    expect(text(cream!.querySelector('.order-line-price .net-price'))).toBe('628,20 Kr')
    expect(text(mask!.querySelector('.order-line-price s'))).toBe('52 Kr')
    expect(text(mask!.querySelector('.order-line-price .net-price'))).toBe('Gratis')
    expect(text(mask!.querySelector('.order-line-price .list-price'))).toBe('Ordinær pris 52 Kr')
  })
})

describe('a cart of a gift alone', () => {
  it('nothing to pay: the button is off, and the summary says what to do', async () => {
    state = { subtotal: 52, discount: 52 }
    items = [MASK]
    const el = await openWithVipps()
    expect(payButton(el).disabled).toBe(true)
    expect(text(el.shadowRoot!.querySelector('.summary-note'))).toBe('Legg til et produkt for å få med gaven.')
    // Asked to pay anyway (a host's own button): the same sentence, not «Handlekurven er tom».
    await el.onPay('vipps')
    expect(el.paymentError).toBe('Legg til et produkt for å få med gaven.')
  })

  it('an empty cart still says it is empty', async () => {
    state = { subtotal: 0 }
    items = []
    const el = await openWithVipps()
    await el.onPay('vipps')
    expect(el.paymentError).toBe('Handlekurven er tom.')
  })
})

describe('Commerce refuses the Vipps payment because of the discount code', () => {
  /** What `executeCartGraphQL` throws for the gateway's answer. */
  const refused = (code: string) => {
    const message = `Payment Vipps not initialize: the payment was refused [${code}]`
    return Object.assign(new Error(message), { graphql: { hasData: false, errors: [{ message, extensions: { code } }] } })
  }

  async function payAndFail(code: string) {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(manager, 'updateShippingsBySupplier').mockResolvedValue({ cart_id: 'cart-1' })
    vi.spyOn(manager, 'startVippsPayment').mockRejectedValue(refused(code))
    const el = await openWithVipps()
    el.form = { firstName: 'Kari', lastName: 'Nordmann', email: 'kari@example.no', phone: '91234567', address: 'Storgata 1', postalCode: '0155', city: 'Oslo' }
    await cycles(el)
    await el.onPay('vipps')
    await cycles(el)
    return el
  }

  it('a coupon that ended: the reason, and that the cart is ready for another try', async () => {
    const el = await payAndFail('COUPON_EXPIRED')
    expect(el.paymentError).toBe('Rabattkoden er ikke lenger gyldig. Handlekurven er oppdatert – prøv igjen.')
    expect(text(el.shadowRoot!.querySelector('.payment-error'))).toBe(el.paymentError)
  })

  it('a gift with two units, a discount that could not be worked out: their own sentences', async () => {
    expect((await payAndFail('GIFT_MAX_ONE_UNIT')).paymentError).toBe('Du kan bare få én gave per bestilling. Reduser antallet og prøv igjen.')
    unmountAll()
    manager.state = null
    expect((await payAndFail('DISCOUNT_UNAVAILABLE')).paymentError).toBe('Rabatten kunne ikke beregnes akkurat nå. Prøv igjen om litt.')
  })
})

describe('the receipt', () => {
  const CHECKOUT = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
  const paidCheckout = () => ({
    id: CHECKOUT,
    status: 'SUCCESS',
    email: 'kari@example.no',
    discount_code: 'gratis_face_mask',
    cart: {
      cart_id: 'cart-1',
      currency: 'NOK',
      line_items: [
        { id: 'li-1', product_id: 100, brand: 'Faves', title: 'Krem', quantity: 1, image: [], price: { amount_incl_taxes: 349, currency_code: 'NOK', discount: 0 }, shipping: { id: 'p', name: 'Posten' } },
        { id: 'li-2', product_id: 421306, brand: 'Faves', title: 'Face mask', quantity: 1, image: [], price: { amount_incl_taxes: 52, currency_code: 'NOK', discount: 52 }, shipping: { id: 'p', name: 'Posten' } },
      ],
    },
    totals: { currency_code: 'NOK', subtotal: 401, shipping: 49, discounts: 52, total: 398 },
  })
  const confirmLines = (el: HTMLElement) => [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.confirm-line') ?? [])]
  const confirmRow = (el: HTMLElement, label: string) =>
    [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.confirm-summary .order-row') ?? [])].map((r) => text(r)).find((t) => t.startsWith(label))

  it('after Vipps, read from the checkout that was paid: the gift «Gratis», «Rabatt (code)», and the total Vipps charged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response))
    Vio.init({ apiKey: 'test-key', environment: 'production' } as any)
    vi.spyOn(VioCheckout.prototype as any, 'loadAvailablePaymentMethods').mockResolvedValue(undefined)
    vi.spyOn(VioCheckout.prototype as any, 'prefillFormFromCheckout').mockResolvedValue(undefined)
    vi.spyOn(manager, 'getVippsStatus').mockResolvedValue({ state: 'AUTHORIZED', duplicate_of: null })
    vi.spyOn(manager, 'getCheckout').mockResolvedValue(paidCheckout())
    vi.spyOn(manager, 'getOrderNumber').mockResolvedValue(4512)
    window.history.replaceState({}, '', `/?vio_payment=success&vio_method=vipps&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT}`)

    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await cycles(el, 8)
    vi.unstubAllGlobals()

    expect(el.orderConfirmed).toBe(true)
    const [cream, mask] = confirmLines(el)
    expect(text(cream!.querySelector('.confirm-line-price'))).toBe('349 Kr')
    expect(text(mask!.querySelector('.confirm-line-price s'))).toBe('52 Kr')
    expect(text(mask!.querySelector('.confirm-line-price .net-price'))).toBe('Gratis')
    expect(confirmRow(el, 'Rabatt')).toMatch(/^Rabatt \(gratis_face_mask\)\s*−52 Kr$/)
    expect(confirmRow(el, 'Frakt')).toMatch(/^Frakt – Posten\s*49 Kr$/)
    expect(confirmRow(el, 'Totalt')).toMatch(/^Totalt\s*398 Kr$/)
    expect(shadowText(el)).toContain('#4512')
  })

  it('a purchase confirmed on the page by another method prints the lines as that method charged them — list prices, no «Rabatt»', async () => {
    const el = await openWithVipps()
    el.confirmOrder('klarna', SPONSOR, { chargedTotal: 450 })
    await cycles(el)
    expect(confirmLines(el).map((l) => text(l.querySelector('.confirm-line-price')))).toEqual(['349 Kr', '52 Kr'])
    expect(el.shadowRoot!.querySelector('.confirm-summary s')).toBeNull()
    expect(confirmRow(el, 'Rabatt')).toBeUndefined()
    expect(confirmRow(el, 'Totalt')).toMatch(/^Totalt\s*450 Kr$/)
  })
})

describe('a discount code on the cart: only Vipps', () => {
  const METHODS = [{ name: 'Vipps' }, { name: 'Stripe' }, { name: 'Kustom' }]
  async function openList(code: string | undefined) {
    vi.mocked(Vio.cart.discountCodeForSponsor).mockReturnValue(code)
    manager.getAvailablePaymentMethods.mockResolvedValue(METHODS)
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.open(SPONSOR)
    el.show()
    await cycles(el)
    return el
  }
  const choice = (el: HTMLElement, cta: string) => el.shadowRoot!.querySelector<HTMLButtonElement>(`[data-vio-cta="${cta}"]`)

  it('every other method is off, with a note; Vipps is on', async () => {
    const el = await openList('gratis_face_mask')
    for (const cta of ['select_stripe', 'select_kustom']) {
      expect(choice(el, cta)?.disabled, cta).toBe(true)
      expect(choice(el, cta)?.hasAttribute('data-discount-off'), cta).toBe(true)
    }
    expect(choice(el, 'select_vipps')?.disabled).toBe(false)
    expect(text(el.shadowRoot!.querySelector('.vipps-only-note'))).toBe('Med rabattkode kan du bare betale med Vipps.')
  })

  it('choosing another method does nothing', async () => {
    const el = await openList('gratis_face_mask')
    await el.onPay('stripe')
    await cycles(el)
    expect(manager.state.paymentMethod).toBeFalsy()
    expect(el.shadowRoot!.querySelector('[data-vio-cta="pay_stripe"]')).toBeNull()
  })

  it('a method chosen before the code went on is unchosen: back to the list, where only Vipps is on', async () => {
    const el = await openList('gratis_face_mask')
    manager.state = { ...manager.state, paymentMethod: 'stripe' }
    manager.emit()
    await cycles(el)
    expect(manager.state.paymentMethod).toBe('')
    expect(el.shadowRoot!.querySelector('[data-vio-cta="pay_stripe"]')).toBeNull()
    expect(choice(el, 'select_vipps')?.disabled).toBe(false)
  })

  it('Vipps chosen stays chosen, and pays', async () => {
    const el = await openList('gratis_face_mask')
    manager.state = { ...manager.state, paymentMethod: 'vipps' }
    manager.emit()
    await cycles(el)
    expect(manager.state.paymentMethod).toBe('vipps')
    expect(text(payButton(el))).toMatch(/med Vipps$/)
  })

  it('without a code: every method on, no note', async () => {
    const el = await openList(undefined)
    for (const cta of ['select_stripe', 'select_kustom', 'select_vipps']) {
      expect(choice(el, cta)?.disabled, cta).toBe(false)
      expect(choice(el, cta)?.hasAttribute('data-discount-off'), cta).toBe(false)
    }
    expect(el.shadowRoot!.querySelector('.vipps-only-note')).toBeNull()
  })
})

describe('the campaign\'s code on the cart (put on by reference: its code is never shown)', () => {
  beforeEach(() => {
    vi.mocked(Vio.cart.discountCodeForSponsor).mockReturnValue(undefined)
    vi.spyOn(Vio.cart, 'discountSourceForSponsor').mockReturnValue('CAMPAIGN')
  })

  it('the «Rabatt» row says what it takes off, without a code; the totals as for any code', async () => {
    const el = await openWithVipps()
    expect(summaryRow(el, 'Rabatt')).toMatch(/^Rabatt\s*−52 Kr$/)
    expect(el.shadowRoot!.textContent).not.toContain('gratis_face_mask')
    expect(summaryRow(el, 'Totalt')).toMatch(/^Totalt\s*398 Kr$/)
  })

  it('the ways to pay that take no discount are off, as with any code', async () => {
    manager.getAvailablePaymentMethods.mockResolvedValue([{ name: 'Vipps' }, { name: 'Stripe' }])
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.open(SPONSOR)
    el.show()
    await cycles(el)
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('[data-vio-cta="select_stripe"]')?.disabled).toBe(true)
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('[data-vio-cta="select_vipps"]')?.disabled).toBe(false)
  })
})

describe('which ways to pay take a discount: each method\'s own config', () => {
  /** The checkout's list of ways to pay, with `code` on the cart (`null`: none whose code is shown). */
  async function openList(methods: unknown[], code: string | null = 'KODE') {
    vi.mocked(Vio.cart.discountCodeForSponsor).mockReturnValue(code ?? undefined)
    manager.getAvailablePaymentMethods.mockResolvedValue(methods)
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.open(SPONSOR)
    el.show()
    await cycles(el)
    return el
  }
  const choice = (el: HTMLElement, cta: string) => el.shadowRoot!.querySelector<HTMLButtonElement>(`[data-vio-cta="${cta}"]`)
  const yes = [{ type: 'string', name: 'discounts', value: 'true' }]
  const no = [{ type: 'string', name: 'discounts', value: 'false' }]

  it('a method that says `discounts: true` stays on with a code; one that says false is off — whatever its name', async () => {
    const el = await openList([
      { name: 'Vipps', config: yes },
      { name: 'Kustom', config: yes },
      { name: 'Stripe', config: no },
    ])
    expect(choice(el, 'select_vipps')?.disabled).toBe(false)
    expect(choice(el, 'select_kustom')?.disabled).toBe(false)
    expect(choice(el, 'select_stripe')?.disabled).toBe(true)
    expect(el.shadowRoot!.querySelector('.discount-dead-end')).toBeNull()
  })

  it('a method whose config does not say: Vipps does, the others do not (as before)', async () => {
    const el = await openList([{ name: 'Vipps' }, { name: 'Kustom', config: [] }])
    expect(choice(el, 'select_vipps')?.disabled).toBe(false)
    expect(choice(el, 'select_kustom')?.disabled).toBe(true)
    expect(text(el.shadowRoot!.querySelector('.vipps-only-note'))).toBe('Med rabattkode kan du bare betale med Vipps.')
  })

  describe('none of the ways to pay on offer takes the code on the cart', () => {
    let remove: ReturnType<typeof vi.fn>
    beforeEach(() => {
      remove = vi.fn(async () => {
        vi.mocked(Vio.cart.discountCodeForSponsor).mockReturnValue(undefined)
        return { removed: true, carts: [{ sponsorId: SPONSOR, code: 'KODE', status: 'removed' }] }
      })
      vi.spyOn(Vio.cart, 'removeDiscountCode').mockImplementation(remove as never)
    })

    it('«Fjern» instead of a dead end: it says why, takes the code off the cart, and the ways to pay are back', async () => {
      const el = await openList([{ name: 'Stripe', config: no }, { name: 'Kustom' }])
      expect(choice(el, 'select_stripe')?.disabled).toBe(true)
      expect(choice(el, 'select_kustom')?.disabled).toBe(true)
      const deadEnd = el.shadowRoot!.querySelector<HTMLElement>('.discount-dead-end')
      expect(text(deadEnd?.querySelector('p'))).toBe('Rabatten kan ikke brukes med betalingsmåtene her. Fjern rabatten for å betale.')
      expect(el.shadowRoot!.querySelector('.vipps-only-note:not(.discount-dead-end p)')).toBeNull()
      const button = deadEnd!.querySelector<HTMLButtonElement>('.discount-dead-end-remove')!
      expect(text(button)).toBe('Fjern')

      button.click()
      await cycles(el)
      expect(remove).toHaveBeenCalledWith(SPONSOR)
      expect(el.shadowRoot!.querySelector('.discount-dead-end')).toBeNull()
      expect(choice(el, 'select_stripe')?.disabled).toBe(false)
      expect(choice(el, 'select_kustom')?.disabled).toBe(false)
    })

    it('the campaign\'s code too (no code shown): the same «Fjern»', async () => {
      vi.spyOn(Vio.cart, 'discountSourceForSponsor').mockReturnValue('CAMPAIGN')
      const el = await openList([{ name: 'Kustom' }], null)
      expect(el.shadowRoot!.querySelector('.discount-dead-end-remove')).not.toBeNull()
    })

    it('it could not be taken off: it stays, and says so', async () => {
      remove.mockImplementation(async () => ({ removed: false, carts: [{ sponsorId: SPONSOR, code: 'KODE', status: 'failed' }] }))
      const el = await openList([{ name: 'Kustom' }])
      el.shadowRoot!.querySelector<HTMLButtonElement>('.discount-dead-end-remove')!.click()
      await cycles(el)
      expect(text(el.shadowRoot!.querySelector('.discount-dead-end .discount-error'))).toBe('Rabattkoden kunne ikke fjernes. Prøv igjen.')
    })

    it('without a code on the cart: no «Fjern», every method on', async () => {
      const el = await openList([{ name: 'Kustom' }], null)
      expect(el.shadowRoot!.querySelector('.discount-dead-end')).toBeNull()
      expect(choice(el, 'select_kustom')?.disabled).toBe(false)
    })
  })
})

describe('a payment that could not start, with a code on the cart (QA 2026-11-12)', () => {
  async function payAndBreak() {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(manager, 'updateShippingsBySupplier').mockResolvedValue({ cart_id: 'cart-1' })
    vi.spyOn(manager, 'startVippsPayment').mockRejectedValue(new Error('Payment Vipps not initialize: 503 Service Unavailable'))
    const el = await openWithVipps()
    el.form = { firstName: 'Kari', lastName: 'Nordmann', email: 'kari@example.no', phone: '91234567', address: 'Storgata 1', postalCode: '0155', city: 'Oslo' }
    await cycles(el)
    await el.onPay('vipps')
    await cycles(el)
    return el
  }
  const shown = (el: HTMLElement) => text(el.shadowRoot!.querySelector('.payment-error'))

  it('only Vipps takes the code: «prøv igjen», never «velg en annen betalingsmåte»', async () => {
    const el = await payAndBreak()
    expect(shown(el)).toBe('Betalingen kunne ikke startes. Prøv igjen.')
  })

  it('another way to pay on offer takes discounts too: the hint stays', async () => {
    vi.spyOn(manager, 'getAvailablePaymentMethods').mockResolvedValue([
      { name: 'Vipps' },
      { name: 'Stripe', config: [{ name: 'discounts', value: true }] },
    ])
    const el = await payAndBreak()
    expect(shown(el)).toBe('Betalingen kunne ikke startes. Prøv igjen, eller velg en annen betalingsmåte.')
  })

  it('no code on the cart: the hint stays, as before', async () => {
    vi.mocked(Vio.cart.discountCodeForSponsor).mockReturnValue(undefined as any)
    vi.spyOn(Vio.cart, 'discountSourceForSponsor').mockReturnValue(undefined as any)
    state = { subtotal: 401 }
    items = [CREAM, { ...MASK, discount: undefined }]
    const el = await payAndBreak()
    expect(shown(el)).toBe('Betalingen kunne ikke startes. Prøv igjen, eller velg en annen betalingsmåte.')
  })
})
