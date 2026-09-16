// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'

/**
 * Angelo, 2026-09-16: when the products in the cart share no shipping class,
 * the purchase is blocked. Before, the checkout let it through: Qliro charged
 * no shipping, or a rate that did not fit every product.
 *
 * The component knows it from two answers: the rates the cart's products
 * share (empty) and the rates each line has on its own (some). A cart where
 * no line has rates is digital, or refused by shopcart itself.
 */
const manager = Vio.checkout as any
const BLOCKED = 'Produktene i handlekurven kan ikke sendes sammen'

const line = (id: string, rates: string[]) => ({
  id,
  productId: id,
  name: `Produkt ${id}`,
  brand: 'Bohus',
  quantity: 1,
  unitPrice: 1000,
  currency: 'NOK',
  availableShippings: rates.map((r) => ({ id: r })),
})
const EXPRESS_ONLY = line('a', ['sc-express'])
const STANDARD_ONLY = line('b', ['sc-standard'])
const DIGITAL = line('d', [])
const STANDARD = {
  id: 'sc-standard',
  supplierId: '7',
  method: 'Standard',
  name: 'Standard',
  price: 19900,
  priceMajor: 199,
  currency: 'NOK',
}

let mountSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  const proto = VioCheckout.prototype as any
  for (const m of ['loadAvailablePaymentMethods', 'refreshApplePay', 'refreshKlarna']) {
    vi.spyOn(proto, m).mockResolvedValue(undefined)
  }
  vi.spyOn(manager, 'updateShippingsBySupplier').mockResolvedValue(null)
  mountSpy = vi.spyOn(manager, 'mountQliroCheckout').mockImplementation(async (...args: unknown[]) => {
    ;(args[0] as HTMLElement).innerHTML = '<iframe></iframe>'
    return { order_id: 'QLIRO-1', html_snippet: '' }
  })
})

afterEach(() => {
  unmountAll()
  manager.state = null
  manager.shippingsResolved = false
  vi.restoreAllMocks()
})

/** What the backend answers for the rates the cart's products share. */
function sharedRates(list: unknown[], { resolved = true } = {}) {
  return vi.spyOn(manager, 'fetchAvailableShippings').mockImplementation(async () => {
    manager.shippingsResolved = resolved
    return list
  })
}

async function cycles(el: HTMLElement, n = 6) {
  for (let i = 0; i < n; i++) await settle(el)
}

async function openCheckout(items: unknown[], method = 'qliro', extra: Record<string, unknown> = {}) {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  Object.assign(el, {
    items,
    availableMethods: ['Qliro', 'Stripe'],
    paymentMethodsResolved: true,
    checkoutState: { sponsorId: 5, currency: 'NOK', subtotal: 2000, paymentMethod: method },
    ...extra,
    open: true,
  })
  await cycles(el)
  return el
}

const qliroOnScreen = (el: HTMLElement) =>
  el.querySelector('#vio-qliro-checkout-container iframe') !== null

describe('vio-checkout — products that cannot ship together', () => {
  it('blocks the purchase, says why, and never creates a Qliro order', async () => {
    sharedRates([])
    const el = await openCheckout([EXPRESS_ONLY, STANDARD_ONLY])
    expect(shadowText(el)).toContain(BLOCKED)
    expect(mountSpy).not.toHaveBeenCalled()
    expect(qliroOnScreen(el)).toBe(false)
  })

  it('offers no pay button for the other methods either', async () => {
    sharedRates([])
    const el = await openCheckout([EXPRESS_ONLY, STANDARD_ONLY], 'stripe')
    expect(shadowText(el)).toContain(BLOCKED)
    expect(el.shadowRoot?.querySelector('.complete-cta')).toBeNull()
    // And a call that slips through does nothing.
    await el.onPay('stripe')
    expect(el.paymentError).toBeNull()
  })

  it('takes down a widget mounted before the answer came', async () => {
    // A list from before is on screen, so the widget mounts straight away.
    const el = await openCheckout([EXPRESS_ONLY, STANDARD_ONLY], 'qliro', {
      availableShippingsList: [STANDARD],
      selectedShipping: STANDARD.id,
    })
    expect(qliroOnScreen(el)).toBe(true)

    sharedRates([])
    await el.loadAvailableShippings()
    await cycles(el)

    expect(qliroOnScreen(el)).toBe(false)
    expect(shadowText(el)).toContain(BLOCKED)
  })

  it('forgets the block when the checkout closes', async () => {
    sharedRates([])
    const el = await openCheckout([EXPRESS_ONLY, STANDARD_ONLY])
    expect(el.shippingBlocked).toBe(true)
    manager.state = null
    manager.emit()
    await cycles(el)
    expect(el.shippingBlocked).toBe(false)
  })
})

describe('vio-checkout — carts that can pay', () => {
  it('waits for the shipping answer before creating a Qliro order', async () => {
    let answer!: (list: unknown[]) => void
    vi.spyOn(manager, 'fetchAvailableShippings').mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = (list) => {
            manager.shippingsResolved = true
            resolve(list)
          }
        }),
    )
    const el = await openCheckout([line('a', ['sc-standard']), line('b', ['sc-standard'])])
    expect(mountSpy).not.toHaveBeenCalled()

    answer([STANDARD])
    await cycles(el)

    expect(mountSpy).toHaveBeenCalledTimes(1)
    expect(shadowText(el)).not.toContain(BLOCKED)
  })

  it('lets a cart of digital products pay, with no shipping', async () => {
    sharedRates([])
    const el = await openCheckout([DIGITAL])
    expect(shadowText(el)).not.toContain(BLOCKED)
    expect(mountSpy).toHaveBeenCalledTimes(1)
  })

  it('blocks nothing when the shipping lookup fails', async () => {
    sharedRates([], { resolved: false })
    const el = await openCheckout([EXPRESS_ONLY, STANDARD_ONLY])
    expect(shadowText(el)).not.toContain(BLOCKED)
    expect(mountSpy).toHaveBeenCalledTimes(1)
  })

  it('pays normally when the products share a class', async () => {
    sharedRates([STANDARD])
    const el = await openCheckout([line('a', ['sc-standard']), line('b', ['sc-standard', 'sc-express'])])
    expect(shadowText(el)).not.toContain(BLOCKED)
    expect(el.availableShippingsList).toEqual([STANDARD])
    expect(mountSpy).toHaveBeenCalledTimes(1)
  })
})
