// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'

/**
 * `./ui` defines the cards at once and the detail, cart and checkout a moment
 * later (lazy-elements.ts) — without losing what the page did meanwhile.
 *
 * One page for the whole file, like a real one: the registry cannot forget a
 * definition, so the steps run in order.
 */

// No idle callback: the load waits for a need (or the 200 ms fallback timer, faked here).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
})

describe('the UI in two steps', () => {
  let ui: typeof import('./index.js')

  it('importing ./ui defines the cards now and leaves the heavy three for later', async () => {
    document.body.innerHTML = '<vio-cart id="cart"></vio-cart><vio-product-detail id="detail"></vio-product-detail>'
    ui = await import('./index.js')
    expect(customElements.get('vio-product')).toBeTruthy()
    expect(customElements.get('vio-product-carousel')).toBeTruthy()
    expect(customElements.get('vio-reel')).toBeTruthy()
    expect(customElements.get('vio-cart')).toBeUndefined()
    expect(customElements.get('vio-checkout')).toBeUndefined()
    expect(customElements.get('vio-product-detail')).toBeUndefined()
  })

  it('an element in the document answers show() at once (kept), and one added later too', async () => {
    const cart = document.getElementById('cart') as HTMLElement & { show: () => void; open?: boolean }
    expect(typeof cart.show).toBe('function')
    const checkout = document.createElement('vio-checkout') as HTMLElement & { show?: () => void; open?: boolean }
    document.body.appendChild(checkout)
    await Promise.resolve() // the MutationObserver's turn
    expect(typeof checkout.show).toBe('function')
    // A property the host sets before the element exists: Lit keeps it.
    ;(cart as unknown as { vippsCartPayment: string }).vippsCartPayment = 'checkout'
  })

  it('a card click before the detail exists is replayed to it once it is defined', async () => {
    const { VioProductDetail } = await import('./heavy-elements.js')
    const replay = vi.spyOn(VioProductDetail.prototype, 'replayProductClick').mockImplementation(() => {})
    const cart = document.getElementById('cart') as HTMLElement & { show: () => void; open?: boolean }
    // The page asks, in this order, before anything has loaded:
    document.dispatchEvent(
      new CustomEvent('vio:product-click', { detail: { productId: '421638', sponsorId: '1308' }, bubbles: true, composed: true }),
    )
    cart.show()
    await vi.waitFor(() => expect(customElements.get('vio-cart')).toBeTruthy())
    await vi.waitFor(() => expect(cart.open).toBe(true))
    expect(customElements.get('vio-checkout')).toBeTruthy()
    expect(customElements.get('vio-product-detail')).toBeTruthy()
    expect(replay).toHaveBeenCalledTimes(1)
    const [event] = replay.mock.calls[0] as [CustomEvent]
    expect(event.detail.productId).toBe('421638')
    // The stand-in is gone: the class's own method answers now.
    expect(Object.getOwnPropertyDescriptor(cart, 'show')).toBeUndefined()
    expect((cart as unknown as { vippsCartPayment: string }).vippsCartPayment).toBe('checkout')
    replay.mockRestore()
  })

  it('loadVioElements resolves with the classes, already defined', async () => {
    const classes = await ui.loadVioElements()
    expect(customElements.get('vio-cart')).toBe(classes.VioCart)
    expect(customElements.get('vio-checkout')).toBe(classes.VioCheckout)
    expect(customElements.get('vio-product-detail')).toBe(classes.VioProductDetail)
  })

  it('once defined, new elements are plain instances (no stand-ins)', async () => {
    const cart = document.createElement('vio-cart')
    document.body.appendChild(cart)
    await Promise.resolve()
    expect(Object.getOwnPropertyDescriptor(cart, 'show')).toBeUndefined()
    expect(typeof (cart as unknown as { show: unknown }).show).toBe('function')
  })
})
