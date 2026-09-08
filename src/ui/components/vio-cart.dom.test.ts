// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, unmountAll, shadowButtons, settle } from '../test-harness.js'

/**
 * The first test that mounts a real component.
 *
 * It pins the defect from 2026-09-08: the cart footer was express-only, so a
 * channel offering just an embedded checkout (Kustom, Qliro, Walley) rendered
 * ZERO buttons and the shopper had no way to reach the checkout at all.
 */
describe('vio-cart — there is always a way out of the cart', () => {
  afterEach(() => { unmountAll(); vi.restoreAllMocks() })

  /** One sponsor, one line — enough for the footer to render. */
  const aCart = () =>
    new Map([
      [
        5,
        {
          sponsorId: 5,
          sponsorName: 'Bohus',
          currency: 'NOK',
          subtotal: 4999,
          items: [
            { id: 'i1', productId: 411731, title: 'Aole spisestol', quantity: 1, price: 4999 },
          ],
        },
      ],
    ])

  const withMethods = async (methods: string[] | null) => {
    const el = await mount<HTMLElement & Record<string, unknown>>('vio-cart')
    // Drive the resolved state directly: what is under test is the render
    // decision, not how the cart or the method list were fetched.
    ;(el as any).carts = aCart()
    ;(el as any).itemCount = 1
    ;(el as any).availableMethods = methods
    ;(el as any).open = true
    await settle(el)
    return el
  }

  it('renders a checkout CTA when only an embedded method is offered', async () => {
    const el = await withMethods(['Qliro'])
    const cta = el.shadowRoot?.querySelector('.checkout-btn')
    expect(cta).toBeTruthy()
  })

  it('renders it for Kustom and Walley too — none of the three has an express path', async () => {
    for (const only of [['Kustom'], ['Walley']]) {
      const el = await withMethods(only)
      expect(el.shadowRoot?.querySelector('.checkout-btn')).toBeTruthy()
      unmountAll()
    }
  })

  it('keeps it when an express method IS offered — express buttons are shortcuts', async () => {
    // Even with Klarna present, the other methods must stay reachable.
    const el = await withMethods(['Klarna', 'Qliro'])
    expect(el.shadowRoot?.querySelector('.checkout-btn')).toBeTruthy()
  })

  it('never leaves the footer with no button at all', async () => {
    // The regression, stated as the thing that must never be true again.
    for (const methods of [['Qliro'], ['Kustom'], ['Walley'], ['Klarna'], [], null]) {
      const el = await withMethods(methods as string[] | null)
      const buttons = shadowButtons(el)
      expect(buttons.length).toBeGreaterThan(0)
      unmountAll()
    }
  })
})
