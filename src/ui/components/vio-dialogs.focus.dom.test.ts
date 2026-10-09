// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'
import { VioCheckout } from './vio-checkout.js'
import { VioProductDetail } from './vio-product-detail.js'
import { deepActiveElement } from '../dialog-focus.js'

/**
 * A QA tester could not buy by keyboard (2026-10-09): Enter on a product
 * card opened the detail with focus still on the page behind, Tab never
 * entered it and Escape did nothing — the cart and the checkout the same.
 * These mount the real components: focus goes in on open, Tab stays in,
 * Escape closes (not the checkout while a payment is starting), and focus
 * comes back out to where the shopper was.
 */
const SPONSOR = 5
const manager = Vio.checkout as any

const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init }),
  )

/** A button on the page, focused — where the shopper came from. */
function opener(): HTMLButtonElement {
  const button = document.createElement('button')
  button.textContent = 'Åpne'
  document.body.appendChild(button)
  button.focus()
  return button
}

const closeButton = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLElement>('.close')!
const dialog = (el: HTMLElement) => el.shadowRoot!.querySelector<HTMLElement>('[role="dialog"]')!

async function renderCycles(el: HTMLElement, n = 3) {
  for (let i = 0; i < n; i++) await settle(el)
}

afterEach(() => {
  unmountAll()
  manager.state = null
  vi.restoreAllMocks()
})

describe('<vio-product-detail> on the keyboard', () => {
  beforeEach(() => {
    vi.spyOn(VioProductDetail.prototype as any, 'loadVippsButton').mockResolvedValue(undefined)
  })

  it('opens with focus on its close button, closes on Escape, and gives focus back to the card', async () => {
    const card = opener()
    const el = await mount<VioProductDetail>('vio-product-detail')
    el.show()
    await renderCycles(el)
    expect(el.open).toBe(true)
    expect(dialog(el).getAttribute('aria-modal')).toBe('true')
    expect(deepActiveElement()).toBe(closeButton(el))

    press(closeButton(el), 'Escape')
    await renderCycles(el)
    expect(el.open).toBe(false)
    expect(document.activeElement).toBe(card)
  })
})

describe('<vio-cart> on the keyboard', () => {
  const aCart = () =>
    new Map([
      [
        SPONSOR,
        {
          sponsorId: SPONSOR,
          sponsorName: 'Bohus',
          currency: 'NOK',
          subtotal: 4999,
          items: [
            { id: 'i1', productId: 411731, name: 'Aole spisestol', brand: 'Aole', quantity: 1, unitPrice: 4999, currency: 'NOK' },
          ],
        },
      ],
    ])

  it('opens with focus on its close button, Tab stays inside the drawer, Escape closes and focus comes back', async () => {
    const button = opener()
    const el = await mount<HTMLElement & Record<string, any>>('vio-cart')
    el.carts = aCart()
    el.itemCount = 1
    el.availableMethods = ['Qliro']
    el.show()
    await renderCycles(el)
    expect(dialog(el).getAttribute('aria-modal')).toBe('true')
    expect(deepActiveElement()).toBe(closeButton(el))

    // Shift+Tab from the close button: round to the last button, "Til kassen".
    press(closeButton(el), 'Tab', { shiftKey: true })
    expect(deepActiveElement()).toBe(el.shadowRoot!.querySelector('.checkout-btn'))
    // Tab from there: round to the close button again — never out to the page.
    press(deepActiveElement()!, 'Tab')
    expect(deepActiveElement()).toBe(closeButton(el))

    press(closeButton(el), 'Escape')
    await renderCycles(el)
    expect(el.open).toBe(false)
    expect(document.activeElement).toBe(button)
  })
})

describe('<vio-checkout> on the keyboard', () => {
  beforeEach(() => {
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
    window.history.replaceState({}, '', '/')
  })

  async function openWith(methods: string[]) {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    manager.open(SPONSOR)
    el.availableMethods = methods
    el.paymentMethodsResolved = true
    el.show()
    await renderCycles(el)
    return el
  }

  it('opens with focus on its close button; Escape waits for a payment that is starting, then closes', async () => {
    const button = opener()
    const el = await openWith(['Stripe', 'Vipps'])
    expect(el.open).toBe(true)
    expect(dialog(el).getAttribute('aria-modal')).toBe('true')
    expect(deepActiveElement()).toBe(closeButton(el))

    // Vipps is being started — the redirect is on its way. Escape must not
    // close the overlay under it.
    el.vippsLoading = true
    await renderCycles(el)
    press(closeButton(el), 'Escape')
    await renderCycles(el)
    expect(el.open).toBe(true)

    el.vippsLoading = false
    await renderCycles(el)
    press(closeButton(el), 'Escape')
    await renderCycles(el)
    expect(el.open).toBe(false)
    expect(document.activeElement).toBe(button)
  })
})
