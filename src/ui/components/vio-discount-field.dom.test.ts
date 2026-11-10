// @vitest-environment jsdom
/**
 * The «Rabattkode» field of the cart and of the checkout's summary: the
 * shopper types the brand's code and sees what came of it BEFORE paying —
 * taken (the code, «Fjern», the discount and the new total) or not (why, and
 * the cart as it was) — and takes it off. Commerce asks the brand's shop
 * about a code — one to three seconds — so the field waits while the rest of
 * the cart does not, and a second tap sends nothing.
 *
 * It shows wherever discount codes are on for the page (a `discountCode`, a
 * `?vio_discount=` link, or `discountField: true`); `discountField: false`
 * hides it; a page that says nothing about codes has none.
 *
 * Who is told: a code TYPED here always has its answer said. The PAGE's own
 * code, which nobody typed, shows only once it is taken — refused, the field
 * says nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { Configuration } from '../../core/configuration.js'
import { VioCheckout } from './vio-checkout.js'
import { syncDiscountParam, type DiscountCodeResult } from '../../core/cart/discount-code.js'

const SPONSOR = 5
const CREAM = { id: 'c', productId: 100, sponsorId: SPONSOR, brand: 'Faves', name: 'Krem', quantity: 1, unitPrice: 349, currency: 'NOK', imageUrl: '' }
const MASK = { id: 'm', productId: 421306, sponsorId: SPONSOR, brand: 'Faves', name: 'Face mask', quantity: 1, unitPrice: 52, discount: 52, currency: 'NOK', imageUrl: '' }

type El = HTMLElement & Record<string, any>

const applied = (code: string): DiscountCodeResult => ({ status: 'applied', code, carts: [{ sponsorId: SPONSOR, status: 'applied' }] })
const refusedWith = (code: string, reason?: string): DiscountCodeResult =>
  ({ status: 'refused', code, ...(reason ? { reason } : {}), carts: [{ sponsorId: SPONSOR, status: 'refused' }] }) as DiscountCodeResult

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** What the cart manager says about the code of the sponsor's cart, as the test sets it. */
let cartCode: string | undefined
/** The discount call in flight; `asked`: by name (a field, the host's call) — `false`: the page's own code, by itself. */
let busy: { kind: 'applying' | 'removing'; code: string; sponsorId: number; asked: boolean } | undefined
let apply: ReturnType<typeof vi.fn>
let remove: ReturnType<typeof vi.fn>

const page = (config: Record<string, unknown> = { discountField: true }) => Configuration.init({ apiKey: 'surface-key', ...config } as never)

beforeEach(() => {
  cartCode = undefined
  busy = undefined
  apply = vi.fn(async (code: string) => applied(code))
  remove = vi.fn(async () => ({ removed: true, carts: [{ sponsorId: SPONSOR, code: 'KODE', status: 'removed' }] }))
  vi.spyOn(Vio.cart, 'applyDiscountCode').mockImplementation(apply as never)
  vi.spyOn(Vio.cart, 'removeDiscountCode').mockImplementation(remove as never)
  vi.spyOn(Vio.cart, 'discountCodeForSponsor').mockImplementation(() => cartCode)
  vi.spyOn(Vio.cart, 'discountBusy').mockImplementation(() => busy)
  vi.spyOn(Vio.cart, 'refreshFromServer').mockResolvedValue(undefined as any)
  vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }] as any)
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  unmountAll()
  ;(Vio.checkout as any).state = null
  Configuration.reset()
  // Whatever code a test's link named is forgotten.
  syncDiscountParam('?vio_discount=')
  vi.restoreAllMocks()
})

async function cart(items: Array<Record<string, unknown>> = [CREAM]): Promise<El> {
  const el = await mount<El>('vio-cart')
  el.carts = new Map([[SPONSOR, { sponsorId: SPONSOR, currency: 'NOK', items, ...(cartCode ? { discountCode: cartCode } : {}) }]])
  el.itemCount = items.length
  el.availableMethods = ['Vipps']
  el.open = true
  await settle(el)
  return el
}

const field = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLElement>('.discount-field')
const input = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLInputElement>('.discount-input')!
const applyButton = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLButtonElement>('.discount-apply')!
const removeButton = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLButtonElement>('.discount-remove')!
const errorText = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLElement>('.discount-error')?.textContent?.trim()
const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim()

async function type(el: El, value: string) {
  const box = input(el)
  box.value = value
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await settle(el)
}
/** The cart says `change`, as it does when a code goes on or comes off. */
async function cartChanged(el: El) {
  Vio.cart.dispatchEvent(new CustomEvent('change', { detail: { cartsBySponsor: el.carts ?? new Map(), itemCount: 1 } }))
  await settle(el)
}

describe('where the field shows', () => {
  it('a page that says nothing about discount codes has no field — not even with a code on the cart, whose «Rabatt» row still shows', async () => {
    page({})
    cartCode = 'gratis_face_mask'
    const el = await cart([CREAM, MASK])
    expect(field(el)).toBeNull()
    expect(text(el.shadowRoot!.querySelector('.discount-row'))).toBe('Rabatt (gratis_face_mask) −52 Kr')
  })

  it('no field before Vio.init either', async () => {
    const el = await cart()
    expect(field(el)).toBeNull()
  })

  it('a page that names its code (discountCode) has codes on: the field shows without being asked for', async () => {
    page({ discountCode: 'gratis_face_mask' })
    const el = await cart()
    expect(field(el)?.tagName).toBe('FORM')
    expect(input(el).value).toBe('')
    expect(el.shadowRoot!.querySelector('.footer')!.firstElementChild).toBe(field(el))
  })

  it('so does a page whose link carried ?vio_discount=', async () => {
    syncDiscountParam('?vio_discount=FRA-LENKE')
    page({})
    const el = await cart()
    expect(field(el)?.tagName).toBe('FORM')
  })

  it('discountField: false hides it, whatever code the page has — the discount itself still shows', async () => {
    syncDiscountParam('?vio_discount=FRA-LENKE')
    page({ discountCode: 'gratis_face_mask', discountField: false })
    cartCode = 'gratis_face_mask'
    const el = await cart([CREAM, MASK])
    expect(field(el)).toBeNull()
    expect(text(el.shadowRoot!.querySelector('.discount-row'))).toBe('Rabatt (gratis_face_mask) −52 Kr')
  })

  it('discountField: true on a page with no code of its own: an input named «Rabattkode» and «Bruk», over the totals and the buttons that pay', async () => {
    page()
    const el = await cart()
    expect(field(el)?.tagName).toBe('FORM')
    expect(input(el).placeholder).toBe('Rabattkode')
    expect(text(el.shadowRoot!.querySelector('label[for="vio-discount-code"]'))).toBe('Rabattkode')
    expect(text(applyButton(el))).toBe('Bruk')
    // Nothing typed: nothing to send.
    expect(applyButton(el).disabled).toBe(true)
    expect(el.shadowRoot!.querySelector('.footer')!.firstElementChild).toBe(field(el))
    // Marked for button tracking, like every button of the cart.
    expect(applyButton(el).getAttribute('data-vio-cta')).toBe('discount_apply')
  })

  describe('a code the CAMPAIGN gives (the bootstrap, set in the dashboard per sponsor)', () => {
    const facade = Vio as unknown as { cachedBootstrap: unknown }
    let kept: unknown
    beforeEach(() => {
      kept = facade.cachedBootstrap
      facade.cachedBootstrap = {
        campaign: { id: 5, name: 'Jul' },
        campaigns: [
          {
            id: 5,
            name: 'Jul',
            status: 'active',
            primarySponsor: { id: SPONSOR, name: 'Faves', discountCode: 'gratis_face_mask', commerce: { apiKey: 'k', channelId: '1' } },
          },
        ],
      }
    })
    afterEach(() => {
      facade.cachedBootstrap = kept
    })

    it('does not turn the field on: on the cart, only its «Rabatt» row and «Gratis» show — as the page\'s own code does', async () => {
      page({ campaignId: 5 })
      cartCode = 'gratis_face_mask'
      const el = await cart([CREAM, MASK])
      expect(field(el)).toBeNull()
      expect(text(el.shadowRoot!.querySelector('.discount-row'))).toBe('Rabatt (gratis_face_mask) −52 Kr')
      expect(el.shadowRoot!.textContent).toContain('Gratis')
    })

    it('with discountField: true the field shows it once taken — the code and «Fjern»', async () => {
      page({ campaignId: 5, discountField: true })
      cartCode = 'gratis_face_mask'
      const el = await cart([CREAM, MASK])
      expect(text(el.shadowRoot!.querySelector('.discount-code'))).toBe('gratis_face_mask')
      expect(text(removeButton(el))).toBe('Fjern')
    })
  })
})

describe('typing a code', () => {
  beforeEach(() => page())

  it('«Bruk» sends it for the cart\'s sponsor; taken: the field shows the code and «Fjern»', async () => {
    const el = await cart()
    await type(el, '  SOMMER10 ')
    expect(applyButton(el).disabled).toBe(false)
    applyButton(el).click()
    await settle(el)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('SOMMER10', SPONSOR)

    // The cart says the code is on it.
    cartCode = 'SOMMER10'
    await cartChanged(el)
    expect(field(el)?.classList.contains('is-applied')).toBe(true)
    expect(text(el.shadowRoot!.querySelector('.discount-code'))).toBe('SOMMER10')
    expect(text(removeButton(el))).toBe('Fjern')
    expect(removeButton(el).getAttribute('aria-label')).toBe('Fjern rabattkoden')
    expect(removeButton(el).getAttribute('data-vio-cta')).toBe('discount_remove')
    // The code never rides along as the button's tracked label.
    expect(removeButton(el).getAttribute('data-vio-cta-label')).toBe('Fjern')
    expect(errorText(el)).toBeUndefined()
  })

  it('Enter in the field sends it too', async () => {
    const el = await cart()
    await type(el, 'SOMMER10')
    field(el)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle(el)
    expect(apply).toHaveBeenCalledWith('SOMMER10', SPONSOR)
  })

  it('while the brand\'s shop is asked: the field waits («Sjekker…»), a second tap sends nothing, and the cart goes on', async () => {
    const answer = deferred<DiscountCodeResult>()
    apply.mockImplementation(() => answer.promise)
    const adjust = vi.spyOn(Vio.cart, 'adjustQuantity').mockImplementation(() => {})
    const el = await cart()
    await type(el, 'SOMMER10')
    applyButton(el).click()
    await settle(el)

    expect(text(applyButton(el))).toBe('Sjekker…')
    expect(applyButton(el).disabled).toBe(true)
    expect(applyButton(el).getAttribute('aria-busy')).toBe('true')
    expect(input(el).disabled).toBe(true)
    expect(input(el).value).toBe('SOMMER10')
    applyButton(el).click()
    field(el)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle(el)
    expect(apply).toHaveBeenCalledTimes(1)

    // Nothing else in the cart waits for it.
    const plus = el.shadowRoot!.querySelector<HTMLButtonElement>('[data-vio-cta="quantity_plus"]')!
    expect(plus.disabled).toBe(false)
    plus.click()
    expect(adjust).toHaveBeenCalledWith('c', SPONSOR, 1)
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('.checkout-btn')!.disabled).toBe(false)

    cartCode = 'SOMMER10'
    answer.resolve(applied('SOMMER10'))
    await settle(el)
    await settle(el)
    expect(field(el)?.classList.contains('is-applied')).toBe(true)
  })

  it('refused: the field again, with why — one sentence per reason, never Commerce\'s own words', async () => {
    const said: Record<string, string> = {
      COUPON_NOT_FOUND: 'Rabattkoden finnes ikke.',
      COUPON_EXPIRED: 'Rabattkoden er ikke lenger gyldig.',
      COUPON_USAGE_LIMIT: 'Rabattkoden er brukt opp.',
      COUPON_NOT_SUPPORTED: 'Rabattkoden kan ikke brukes her.',
      COUPON_MIN_AMOUNT: 'Handlekurven er under minstebeløpet for rabattkoden.',
      COUPON_OTHER_APPLIED: 'Du har allerede en rabattkode. Fjern den først.',
      COUPON_UNAVAILABLE: 'Vi kunne ikke sjekke rabattkoden akkurat nå. Prøv igjen.',
    }
    const el = await cart()
    for (const [reason, sentence] of Object.entries(said)) {
      apply.mockResolvedValueOnce(refusedWith('FEIL', reason))
      await type(el, 'FEIL')
      applyButton(el).click()
      await settle(el)
      await settle(el)
      expect(errorText(el), reason).toBe(sentence)
      expect(el.shadowRoot!.querySelector('.discount-error')!.getAttribute('role')).toBe('alert')
      // The code stays in the field, to be corrected; the field is marked.
      expect(input(el).value).toBe('FEIL')
      expect(input(el).getAttribute('aria-invalid')).toBe('true')
      expect(input(el).disabled).toBe(false)
    }
  })

  it('refused: nothing is applied — the lines, «Sum» and the buttons that pay are as they were', async () => {
    const el = await cart()
    const before = text(el.shadowRoot!.querySelector('.subtotal-row'))
    apply.mockResolvedValueOnce(refusedWith('FEIL', 'COUPON_EXPIRED'))
    await type(el, 'FEIL')
    applyButton(el).click()
    await settle(el)
    await settle(el)
    expect(errorText(el)).toBe('Rabattkoden er ikke lenger gyldig.')
    expect(field(el)?.classList.contains('is-applied')).toBe(false)
    expect(text(el.shadowRoot!.querySelector('.subtotal-row'))).toBe(before)
    expect(el.shadowRoot!.querySelector('.discount-row, .cart-notice, .line-list-price')).toBeNull()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('.checkout-btn')!.disabled).toBe(false)
  })

  it('a refusal in words the SDK does not know, or something that is not a code: the generic sentence', async () => {
    const el = await cart()
    apply.mockResolvedValueOnce(refusedWith('FEIL'))
    await type(el, 'FEIL')
    applyButton(el).click()
    await settle(el)
    await settle(el)
    expect(errorText(el)).toBe('Rabattkoden kunne ikke brukes.')
  })

  it('it could not be asked (network, timeout): try again — and typing clears what was said', async () => {
    const el = await cart()
    apply.mockResolvedValueOnce({ status: 'failed', code: 'KODE', carts: [{ sponsorId: SPONSOR, status: 'failed' }] })
    await type(el, 'KODE')
    applyButton(el).click()
    await settle(el)
    await settle(el)
    expect(errorText(el)).toBe('Vi kunne ikke sjekke rabattkoden akkurat nå. Prøv igjen.')

    apply.mockRejectedValueOnce(new Error('offline'))
    applyButton(el).click()
    await settle(el)
    await settle(el)
    expect(errorText(el)).toBe('Vi kunne ikke sjekke rabattkoden akkurat nå. Prøv igjen.')

    await type(el, 'KODE2')
    expect(errorText(el)).toBeUndefined()
    expect(input(el).getAttribute('aria-invalid')).toBe('false')
  })
})

describe('a code on the cart', () => {
  beforeEach(() => page())

  it('«Fjern» takes it off the sponsor\'s cart; while it does, «Fjerner…», once', async () => {
    cartCode = 'SOMMER10'
    const answer = deferred<unknown>()
    remove.mockImplementation(() => answer.promise)
    const el = await cart()
    removeButton(el).click()
    await settle(el)
    expect(remove).toHaveBeenCalledWith(SPONSOR)
    expect(text(removeButton(el))).toBe('Fjerner…')
    expect(removeButton(el).disabled).toBe(true)
    removeButton(el).click()
    expect(remove).toHaveBeenCalledTimes(1)

    cartCode = undefined
    answer.resolve({ removed: true, carts: [{ sponsorId: SPONSOR, code: 'SOMMER10', status: 'removed' }] })
    await settle(el)
    await settle(el)
    // Back to an empty field.
    expect(field(el)?.tagName).toBe('FORM')
    expect(input(el).value).toBe('')
  })

  it('it could not be taken off: it stays, and the field says so', async () => {
    cartCode = 'SOMMER10'
    remove.mockResolvedValueOnce({ removed: false, carts: [{ sponsorId: SPONSOR, code: 'SOMMER10', status: 'failed' }] })
    const el = await cart()
    removeButton(el).click()
    await settle(el)
    await settle(el)
    expect(field(el)?.classList.contains('is-applied')).toBe(true)
    expect(errorText(el)).toBe('Rabattkoden kunne ikke fjernes. Prøv igjen.')
  })
})

describe('the page\'s own code (discountCode) — nobody typed it', () => {
  const pageCode = { kind: 'applying' as const, code: 'gratis_face_mask', sponsorId: SPONSOR, asked: false }

  it('while it is being put on the cart the field stays as it is: empty, ready for a code, no «Sjekker…»', async () => {
    page({ discountCode: 'gratis_face_mask' })
    busy = pageCode
    const el = await cart()
    expect(field(el)?.tagName).toBe('FORM')
    expect(input(el).value).toBe('')
    expect(input(el).disabled).toBe(false)
    expect(text(applyButton(el))).toBe('Bruk')
    expect(applyButton(el).getAttribute('aria-busy')).toBe('false')

    // Taken: the code and «Fjern», as if it had been typed.
    busy = undefined
    cartCode = 'gratis_face_mask'
    await cartChanged(el)
    expect(field(el)?.classList.contains('is-applied')).toBe(true)
    expect(text(el.shadowRoot!.querySelector('.discount-code'))).toBe('gratis_face_mask')
    expect(text(removeButton(el))).toBe('Fjern')
    expect(errorText(el)).toBeUndefined()
  })

  it('refused (the coupon is over): nothing was shown and nothing is said — the code never appears, the cart sells at its prices', async () => {
    page({ discountCode: 'gratis_face_mask' })
    busy = pageCode
    const el = await cart()
    const seen = () => el.shadowRoot!.querySelector('.footer')!.textContent ?? ''
    expect(seen()).not.toContain('gratis_face_mask')
    busy = undefined
    await cartChanged(el)
    expect(field(el)?.tagName).toBe('FORM')
    expect(input(el).value).toBe('')
    expect(input(el).getAttribute('aria-invalid')).toBe('false')
    expect(errorText(el)).toBeUndefined()
    expect(seen()).not.toContain('gratis_face_mask')
    expect(el.shadowRoot!.querySelector('.cart-notice, .discount-row')).toBeNull()
    expect(el.shadowRoot!.querySelector<HTMLButtonElement>('.checkout-btn')!.disabled).toBe(false)
  })

  it('a code typed while the page\'s own is being asked is sent — and what comes of it is said', async () => {
    page({ discountCode: 'gratis_face_mask' })
    busy = pageCode
    apply.mockResolvedValueOnce(refusedWith('MIN-KODE', 'COUPON_NOT_FOUND'))
    const el = await cart()
    await type(el, 'MIN-KODE')
    expect(applyButton(el).disabled).toBe(false)
    applyButton(el).click()
    await settle(el)
    await settle(el)
    expect(apply).toHaveBeenCalledWith('MIN-KODE', SPONSOR)
    expect(errorText(el)).toBe('Rabattkoden finnes ikke.')
  })

  it('typed while the page\'s own went on the cart: «remove it first» stays said, under the code that is on', async () => {
    page({ discountCode: 'gratis_face_mask' })
    busy = pageCode
    const answer = deferred<DiscountCodeResult>()
    apply.mockImplementation(() => answer.promise)
    const el = await cart()
    await type(el, 'MIN-KODE')
    applyButton(el).click()
    await settle(el)
    // The shopper's own code is being checked: that one is shown.
    expect(text(applyButton(el))).toBe('Sjekker…')
    expect(input(el).value).toBe('MIN-KODE')

    busy = undefined
    cartCode = 'gratis_face_mask'
    answer.resolve(refusedWith('MIN-KODE', 'COUPON_OTHER_APPLIED'))
    await settle(el)
    await settle(el)
    expect(text(el.shadowRoot!.querySelector('.discount-code'))).toBe('gratis_face_mask')
    expect(errorText(el)).toBe('Du har allerede en rabattkode. Fjern den først.')
  })

  it('with discountField: false nothing of it is on screen, taken or refused', async () => {
    page({ discountCode: 'gratis_face_mask', discountField: false })
    busy = pageCode
    const el = await cart()
    expect(field(el)).toBeNull()
    busy = undefined
    await cartChanged(el)
    expect(field(el)).toBeNull()
    expect(el.shadowRoot!.querySelector('.discount-error, .cart-notice, .discount-row')).toBeNull()
  })
})

describe('a code asked for elsewhere (the other field, the host\'s own call)', () => {
  it('shows here as the one being checked', async () => {
    page()
    busy = { kind: 'applying', code: 'SOMMER10', sponsorId: SPONSOR, asked: true }
    const el = await cart()
    expect(input(el).value).toBe('SOMMER10')
    expect(input(el).disabled).toBe(true)
    expect(text(applyButton(el))).toBe('Sjekker…')
    // …and a tap here sends nothing meanwhile.
    field(el)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle(el)
    expect(apply).not.toHaveBeenCalled()
  })

  it('a code coming off the cart by itself (refused at a payment) shows as being taken off', async () => {
    page()
    cartCode = 'SOMMER10'
    busy = { kind: 'removing', code: 'SOMMER10', sponsorId: SPONSOR, asked: false }
    const el = await cart()
    expect(text(removeButton(el))).toBe('Fjerner…')
    expect(removeButton(el).disabled).toBe(true)
  })

  it('«not taken» is no longer said once that very code is on the cart after all', async () => {
    page()
    apply.mockResolvedValueOnce({ status: 'failed', code: 'KODE', carts: [{ sponsorId: SPONSOR, status: 'failed' }] })
    const el = await cart()
    await type(el, 'KODE')
    applyButton(el).click()
    await settle(el)
    await settle(el)
    expect(errorText(el)).toBe('Vi kunne ikke sjekke rabattkoden akkurat nå. Prøv igjen.')
    cartCode = 'KODE'
    await cartChanged(el)
    expect(text(el.shadowRoot!.querySelector('.discount-code'))).toBe('KODE')
    expect(errorText(el)).toBeUndefined()
  })
})

describe('the checkout\'s summary', () => {
  const manager = Vio.checkout as any

  async function checkout(): Promise<El> {
    const proto = VioCheckout.prototype as any
    for (const m of ['refreshApplePay', 'refreshKlarna', 'loadAvailableShippings']) vi.spyOn(proto, m).mockResolvedValue(undefined)
    vi.spyOn(manager, 'items', 'get').mockReturnValue([CREAM])
    vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
    vi.spyOn(manager, 'getVippsExpressEnabled').mockResolvedValue(false)
    vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
    vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
      manager.state = { sponsorId: args[0], session: 1, subtotal: 349, currency: 'NOK' }
      manager.emit()
      return manager.state
    })
    const el = await mount<El>('vio-checkout')
    manager.open(SPONSOR)
    el.show()
    for (let i = 0; i < 6; i++) await settle(el)
    return el
  }

  it('no field on a page that says nothing about discount codes, nor with discountField: false', async () => {
    page({})
    expect(field(await checkout())).toBeNull()
    unmountAll()
    page({ discountCode: 'gratis_face_mask', discountField: false })
    expect(field(await checkout())).toBeNull()
  })

  it('a page that names its code shows the field here too, without being asked for', async () => {
    page({ discountCode: 'gratis_face_mask' })
    const el = await checkout()
    expect(field(el)?.closest('.order-summary')).not.toBeNull()
  })

  it('the field sits between the lines and «Sum», for the cart this checkout pays', async () => {
    page()
    const el = await checkout()
    expect(field(el)?.closest('.order-summary')).not.toBeNull()
    expect(field(el)!.nextElementSibling?.textContent).toContain('Sum')
    await type(el, 'SOMMER10')
    applyButton(el).click()
    await settle(el)
    expect(apply).toHaveBeenCalledWith('SOMMER10', SPONSOR)
  })

  it('it follows the cart: a code that goes on elsewhere (the cart\'s own field, the page) shows here, with «Fjern»', async () => {
    page()
    const el = await checkout()
    expect(field(el)?.tagName).toBe('FORM')
    cartCode = 'SOMMER10'
    await cartChanged(el)
    expect(text(el.shadowRoot!.querySelector('.discount-code'))).toBe('SOMMER10')
    removeButton(el).click()
    await settle(el)
    expect(remove).toHaveBeenCalledWith(SPONSOR)
  })
})
