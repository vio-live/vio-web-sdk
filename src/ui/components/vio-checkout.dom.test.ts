// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, unmountAll, settle, shadowText } from '../test-harness.js'

/**
 * The interacting booleans in `vio-checkout`, tested on the real component.
 *
 * Everything here was previously untestable — there was no DOM environment,
 * so the only test of this logic was an abstract model that would pass even
 * if the component broke. A code review on 2026-09-08 called that out.
 */

const withState = async (state: Record<string, unknown>) => {
  const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
  for (const [k, v] of Object.entries(state)) el[k] = v
  await settle(el)
  return el
}

const CART = {
  sponsorId: 5,
  currency: 'NOK',
  subtotal: 4999,
  paymentMethod: undefined as string | undefined,
}

describe('vio-checkout — the payment step', () => {
  afterEach(() => { unmountAll(); vi.restoreAllMocks() })

  it('shows a spinner, not every button, while the method list is loading', async () => {
    // Defect of 2026-09-08: a Qliro-only channel flashed all four methods and
    // a shopper could click one the channel does not offer.
    const el = await withState({
      open: true,
      checkoutState: { ...CART },
      availableMethods: null,
      paymentMethodsResolved: false,
    })
    const text = shadowText(el)
    expect(text).toContain('Henter betalingsmåter')
    expect(el.shadowRoot?.querySelectorAll('.payment-btn').length).toBe(0)
  })

  it('filters to the offered method once the list resolves', async () => {
    const el = await withState({
      open: true,
      checkoutState: { ...CART },
      availableMethods: ['Qliro'],
      paymentMethodsResolved: true,
    })
    const labels = [...(el.shadowRoot?.querySelectorAll('.payment-btn') ?? [])]
      .map((b) => (b.textContent ?? '').trim())
    expect(labels.join(' ')).toContain('Qliro')
    expect(labels.join(' ')).not.toContain('Klarna')
    expect(labels.join(' ')).not.toContain('Walley')
  })

  it('still shows everything when the list FAILED — a blip must not block paying', async () => {
    const el = await withState({
      open: true,
      checkoutState: { ...CART },
      availableMethods: null,
      paymentMethodsResolved: true,
    })
    expect(shadowText(el)).not.toContain('Henter betalingsmåter')
    expect((el.shadowRoot?.querySelectorAll('.payment-btn').length ?? 0)).toBeGreaterThan(0)
  })

  it('skips the delivery-address form when every method collects it itself', async () => {
    // Qliro asks for the address inside its widget; asking first and then
    // hiding the form made the shopper fill it in for nothing.
    const el = await withState({
      open: true,
      checkoutState: { ...CART },
      availableMethods: ['Qliro'],
      paymentMethodsResolved: true,
    })
    expect(shadowText(el)).not.toContain('Leveringsadresse')
  })

  it('keeps the form when a method that needs it is also offered', async () => {
    const el = await withState({
      open: true,
      checkoutState: { ...CART },
      availableMethods: ['Klarna', 'Qliro'],
      paymentMethodsResolved: true,
    })
    expect(shadowText(el)).toContain('Leveringsadresse')
  })

  it('hides "Endre" when there is only one method to choose from', async () => {
    const el = await withState({
      open: true,
      checkoutState: { ...CART, paymentMethod: 'qliro' },
      availableMethods: ['Qliro'],
      paymentMethodsResolved: true,
    })
    expect(shadowText(el)).not.toContain('Endre')
  })

  it('offers "Endre" when there is a real choice', async () => {
    const el = await withState({
      open: true,
      checkoutState: { ...CART, paymentMethod: 'qliro' },
      availableMethods: ['Klarna', 'Qliro'],
      paymentMethodsResolved: true,
    })
    expect(shadowText(el)).toContain('Endre')
  })
})

describe('vio-checkout — a confirmed order keeps the screen', () => {
  afterEach(() => { unmountAll(); vi.restoreAllMocks() })

  it('shows the confirmation, not the payment step, once the order is confirmed', async () => {
    // THE defect I shipped a commit message for and no code: after paying,
    // clearing the cart re-rendered the component and the payment step took
    // the receipt's place. The customer saw "how do you want to pay" after
    // having paid — an invitation to pay twice.
    const el = await withState({
      open: true,
      checkoutState: { ...CART, subtotal: 0 },
      items: [],
      availableMethods: ['Qliro'],
      paymentMethodsResolved: true,
      orderConfirmed: true,
      confirmedMethod: 'qliro',
      confirmedOrder: { items: [], currency: 'NOK', total: 5198, orderId: '5559819' },
    })
    const text = shadowText(el)
    expect(text).toContain('Takk')
    expect(text).not.toContain('Velg betalingsmåte')
  })

  it('survives the cart being emptied, which is what happens after paying', async () => {
    const el = await withState({
      open: true,
      checkoutState: { ...CART },
      items: [{ id: 'i1' }],
      availableMethods: ['Qliro'],
      paymentMethodsResolved: true,
      orderConfirmed: true,
      confirmedMethod: 'qliro',
      confirmedOrder: { items: [], currency: 'NOK', total: 5198, orderId: '5559819' },
    })
    // Emptying the cart is a state change; the confirmation must not blink out.
    el.items = []
    el.checkoutState = { ...CART, subtotal: 0 }
    await settle(el)
    expect(shadowText(el)).toContain('Takk')
    expect(shadowText(el)).not.toContain('Velg betalingsmåte')
  })
})

describe('vio-checkout — a failed lookup must not become a retry storm', () => {
  afterEach(() => { unmountAll(); vi.restoreAllMocks() })

  it('does not refetch on every state change once the lookup has resolved', async () => {
    // `setAddress` emits on every KEYSTROKE. Before this, one failed methods
    // lookup left `availableMethods` null, and the refresh condition was
    // "availableMethods === null" — so every keypress refetched methods,
    // shippings, Apple Pay and Klarna for the rest of the session.
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    el.checkoutState = { ...CART }
    // The lookup ran and FAILED: resolved, but with nothing to show.
    el.availableMethods = null
    el.paymentMethodsResolved = true
    await settle(el)

    const spy = vi.spyOn(el as any, 'loadAvailablePaymentMethods')
    // Ten "keystrokes" on the same sponsor.
    for (let i = 0; i < 10; i++) {
      ;(el as any).boundOnCheckoutChange(
        new CustomEvent('change', { detail: { state: { ...CART } } }),
      )
    }
    await settle(el)
    expect(spy).not.toHaveBeenCalled()
  })

  it('DOES refetch when the sponsor changes — a different channel, a different answer', async () => {
    const el = await mount<HTMLElement & Record<string, any>>('vio-checkout')
    el.checkoutState = { ...CART }
    el.availableMethods = ['Qliro']
    el.paymentMethodsResolved = true
    await settle(el)

    const spy = vi.spyOn(el as any, 'loadAvailablePaymentMethods').mockResolvedValue(undefined)
    ;(el as any).boundOnCheckoutChange(
      new CustomEvent('change', { detail: { state: { ...CART, sponsorId: 9 } } }),
    )
    await settle(el)
    expect(spy).toHaveBeenCalledTimes(1)
    // …and the previous answer stops counting as resolved.
    expect(el.paymentMethodsResolved).toBe(false)
  })
})
