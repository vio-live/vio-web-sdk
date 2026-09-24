// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Stripe pays on OUR page (Angelo, 2026-09-24).
 *
 * The web flow used to mint a Payment Link and send the shopper to a page
 * hosted by Stripe — Alan (QA, 2026-09-22) found that was the only Stripe
 * there was. The native flow mounts Stripe's Payment Element here instead,
 * and the channel's own toggles say which one it offers (`mode` in the
 * method's config: `native` or `link`).
 *
 * What these tests pin down:
 *
 * - a PaymentIntent is minted when the shopper ASKS for the payment step,
 *   never while they type — and exactly once;
 * - Stripe's answer to the browser is not an order: the receipt appears only
 *   once the checkout itself says it was paid, which is the webhook's doing.
 *   Until then the shopper is told it is still processing and keeps the cart;
 * - a refused card keeps the Element, with Stripe's own words;
 * - a purchase that changes under a mounted Element takes it down;
 * - `link` channels keep the redirect they had.
 */
const SPONSOR = 5
const manager = Vio.checkout as any
const CHECKOUT_ID = 'chk_99'

const FULL_FORM = {
  firstName: 'Kari', lastName: 'Nordmann', email: 'kari@example.no',
  address: 'Storgata 12B', postalCode: '0194', city: 'Oslo',
}

/** The real waits total ~20s; the behaviour under test is the same at 0. */
const REAL_DELAYS = (VioCheckout as any).RETURN_VERIFY_DELAYS_MS

let confirm: ReturnType<typeof vi.fn>
let unmount: ReturnType<typeof vi.fn>
/** A mount whose "ready" is held back, the way a slow Stripe behaves. */
let holdReady = false
let pendingReady: (() => void) | null = null

beforeEach(() => {
  holdReady = false
  pendingReady = null
  ;(VioCheckout as any).RETURN_VERIFY_DELAYS_MS = [0, 0, 0]
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(proto, 'loadAvailableShippings').mockImplementation(async function (this: any) {
    this.shippingsReadyFor = this.embedSession()
  })
  vi.spyOn(manager, 'resumeKlarnaReturn').mockResolvedValue(undefined)
  vi.spyOn(Vio.cart, 'getAllCarts').mockReturnValue(new Map([[SPONSOR, {} as any]]))
  vi.spyOn(manager, 'open').mockImplementation((...args: unknown[]) => {
    manager.state = { sponsorId: args[0], session: 1, subtotal: 4999, currency: 'NOK' }
    manager.emit()
    return manager.state
  })
  vi.spyOn(manager, 'updateShippingsBySupplier').mockResolvedValue(undefined)
  confirm = vi.fn().mockResolvedValue({ status: 'succeeded', paymentIntentId: 'pi_1' })
  unmount = vi.fn()
  vi.spyOn(manager, 'mountStripeCheckout').mockImplementation(async (...args: unknown[]) => {
    ;(args[0] as HTMLElement).innerHTML = '<div class="stripe-element"></div>'
    // Stripe paints after mount() resolves and says so itself.
    const cbs = args[3] as { onReady?: () => void } | undefined
    if (!holdReady) cbs?.onReady?.()
    else pendingReady = () => cbs?.onReady?.()
    return {
      handle: { confirm, unmount },
      intent: { client_secret: 'pi_1_secret_x', publishable_key: 'pk_test' },
      checkoutId: CHECKOUT_ID,
    }
  })
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  ;(VioCheckout as any).RETURN_VERIFY_DELAYS_MS = REAL_DELAYS
  unmountAll()
  manager.state = null
  vi.restoreAllMocks()
})

async function renderCycles(el: HTMLElement, n = 5) {
  for (let i = 0; i < n; i++) await settle(el)
}

/** Opens a Stripe-only checkout, with the flow this channel offers. */
async function openStripe(mode: 'native' | 'link', form?: Record<string, string>) {
  vi.spyOn(manager, 'getStripeMode').mockResolvedValue(mode)
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  manager.open(SPONSOR)
  el.show()
  await renderCycles(el)
  el.availableMethods = ['Stripe']
  el.paymentMethodsResolved = true
  el.stripeMode = mode
  if (form) el.form = { ...form }
  el.autoSelectSoleMethod()
  await renderCycles(el)
  return el
}

const button = (el: HTMLElement, label: string) =>
  [...(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.payment-btn') ?? [])].find((b) =>
    [b.textContent ?? '', ...[...b.querySelectorAll('img')].map((i) => i.alt)]
      .join(' ')
      .toLowerCase()
      .includes(label),
  )

describe('Stripe native: the Payment Element on our page', () => {
  it('mints nothing while the form is empty, and exactly one Element when asked', async () => {
    const el = await openStripe('native')
    expect(el.checkoutState?.paymentMethod).toBe('stripe')
    expect(shadowText(el)).toContain('Leveringsadresse')
    // The request button is there, but there is nothing to pay for yet.
    expect(button(el, 'gå til betaling')?.disabled).toBe(true)
    expect(manager.mountStripeCheckout).not.toHaveBeenCalled()

    el.form = { ...FULL_FORM }
    await renderCycles(el)
    button(el, 'gå til betaling')!.click()
    await renderCycles(el)

    expect(manager.mountStripeCheckout).toHaveBeenCalledTimes(1)
    expect(el.querySelector('#vio-stripe-checkout-container')).toBeTruthy()
    // Further renders must not mint a second intent for the same checkout.
    await renderCycles(el)
    expect(manager.mountStripeCheckout).toHaveBeenCalledTimes(1)
  })

  it('does not offer to pay an Element Stripe has not painted yet', async () => {
    holdReady = true
    const el = await openStripe('native', FULL_FORM)
    button(el, 'gå til betaling')!.click()
    await renderCycles(el)
    // Mounted, but blank on screen: paying now would press a form nobody sees.
    expect(el.stripeMounted).toBe(true)
    expect(shadowText(el)).toContain('Laster betaling')
    expect(button(el, 'betal')?.disabled).toBe(true)

    pendingReady!()
    await renderCycles(el)
    expect(shadowText(el)).not.toContain('Laster betaling')
    expect(button(el, 'betal')?.disabled).toBe(false)
  })

  it('shows the receipt only once the checkout itself says it was paid', async () => {
    vi.spyOn(manager, 'getCheckout').mockResolvedValue({ status: 'paid' })
    const clear = vi.spyOn(Vio.cart, 'clearSponsorCart').mockImplementation(() => {})
    const el = await openStripe('native', FULL_FORM)
    // A real cart pays for shipping too.
    el.availableShippingsList = [{ id: 's1', name: 'Express', price: 30000, priceMajor: 300 }]
    el.selectedShipping = 's1'
    await renderCycles(el)
    button(el, 'gå til betaling')!.click()
    await renderCycles(el)

    button(el, 'betal')!.click()
    await renderCycles(el)

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(manager.getCheckout).toHaveBeenCalledWith(CHECKOUT_ID, SPONSOR)
    expect(el.orderConfirmed).toBe(true)
    expect(el.confirmedMethod).toBe('stripe')
    expect(clear).toHaveBeenCalledWith(SPONSOR)
    // The receipt prints what Stripe charged — shipping included, not the
    // bare subtotal (QA, 2026-09-24: 949 kr paid, 649 kr on the receipt).
    expect(el.confirmedOrder.total).toBe(4999 + 300)
  })

  it('a charge whose order has not landed is "processing", and the cart is kept', async () => {
    // The pointer is written when the intent is CREATED, so a checkout that
    // carries one has not necessarily been paid: only the status may say so.
    vi.spyOn(manager, 'getCheckout').mockResolvedValue({
      status: 'pending',
      origin_payment_id: 'pi_1_secret_x',
    })
    const clear = vi.spyOn(Vio.cart, 'clearSponsorCart').mockImplementation(() => {})
    const el = await openStripe('native', FULL_FORM)
    button(el, 'gå til betaling')!.click()
    await renderCycles(el)
    button(el, 'betal')!.click()
    await renderCycles(el)

    expect(el.orderConfirmed).toBeFalsy()
    expect(clear).not.toHaveBeenCalled()
    expect(el.paymentNotice).toContain('behandles fortsatt')
  })

  it('a refused card keeps the Element, with Stripe’s own words', async () => {
    confirm.mockResolvedValue({ status: 'failed', message: 'Kortet ble avvist.', code: 'card_declined' })
    const getCheckout = vi.spyOn(manager, 'getCheckout').mockResolvedValue({ status: 'pending' })
    const el = await openStripe('native', FULL_FORM)
    button(el, 'gå til betaling')!.click()
    await renderCycles(el)
    button(el, 'betal')!.click()
    await renderCycles(el)

    expect(el.paymentError).toBe('Kortet ble avvist.')
    expect(getCheckout).not.toHaveBeenCalled()
    // Still payable: the same Element, no second intent.
    expect(el.querySelector('#vio-stripe-checkout-container')).toBeTruthy()
    expect(button(el, 'betal')).toBeTruthy()
    expect(manager.mountStripeCheckout).toHaveBeenCalledTimes(1)
  })

  it('a purchase that changes under a mounted Element takes it down', async () => {
    const el = await openStripe('native', FULL_FORM)
    button(el, 'gå til betaling')!.click()
    await renderCycles(el)
    expect(el.querySelector('#vio-stripe-checkout-container')).toBeTruthy()

    el.items = [{ productId: 7, variantId: null, quantity: 2, title: 'Stol', price: 999 } as any]
    await renderCycles(el)

    expect(el.querySelector('#vio-stripe-checkout-container')).toBeFalsy()
    expect(shadowText(el)).toContain('Bestillingen ble endret')
    expect(button(el, 'oppdater betaling')).toBeTruthy()
  })
})

describe('the wallets belong to whoever shows them', () => {
  /** Opens a channel with several methods, with the flow it offers. */
  async function openChannel(mode: 'native' | 'link', methods: string[]) {
    vi.spyOn(manager, 'getStripeMode').mockResolvedValue(mode)
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.open(SPONSOR)
    el.show()
    await renderCycles(el)
    el.availableMethods = methods
    el.paymentMethodsResolved = true
    el.stripeMode = mode
    el.applePayAvailable = true
    el.autoSelectSoleMethod()
    await renderCycles(el)
    return el
  }

  it('native Stripe hides our Apple Pay tile — the Element shows that wallet itself', async () => {
    const el = await openChannel('native', ['Stripe', 'Apple Pay', 'Qliro'])
    expect(shadowText(el)).toContain('Velg betalingsmåte')
    expect(button(el, 'apple pay')).toBeFalsy()
    // The methods that are ours to run are untouched.
    expect(button(el, 'qliro')).toBeTruthy()
    expect(button(el, 'stripe')).toBeTruthy()
  })

  it('a hosted-page Stripe keeps our Apple Pay: nothing else offers that wallet', async () => {
    const el = await openChannel('link', ['Stripe', 'Apple Pay'])
    expect(button(el, 'apple pay')).toBeTruthy()
  })

  it('Stripe and Apple Pay alone: with the Element there is one method, so no choice to make', async () => {
    const el = await openChannel('native', ['Stripe', 'Apple Pay'])
    expect(el.checkoutState?.paymentMethod).toBe('stripe')
    expect(shadowText(el)).not.toContain('Velg betalingsmåte')
  })
})

describe('Stripe link: the hosted page it always was', () => {
  it('redirects instead of mounting anything', async () => {
    const start = vi.spyOn(manager, 'startStripePayment').mockResolvedValue(undefined)
    const el = await openStripe('link', FULL_FORM)
    expect(button(el, 'med stripe')).toBeTruthy()
    button(el, 'med stripe')!.click()
    await renderCycles(el)

    expect(start).toHaveBeenCalledTimes(1)
    expect(manager.mountStripeCheckout).not.toHaveBeenCalled()
  })
})

describe('coming back from Stripe', () => {
  it('a checkout that only carries a pointer is not a payment', async () => {
    vi.spyOn(manager, 'getCheckout').mockResolvedValue({
      status: 'pending',
      origin_payment_id: 'pi_1_secret_x',
    })
    const clear = vi.spyOn(Vio.cart, 'clearSponsorCart').mockImplementation(() => {})
    window.history.replaceState(
      {},
      '',
      `/?vio_payment=success&vio_method=stripe&vio_sponsor=${SPONSOR}&checkout_id=${CHECKOUT_ID}`,
    )
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    await renderCycles(el, 8)

    expect(el.orderConfirmed).toBeFalsy()
    expect(clear).not.toHaveBeenCalled()
    expect(el.paymentNotice).toContain('behandles fortsatt')
  })
})
