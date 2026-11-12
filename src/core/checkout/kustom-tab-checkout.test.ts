// @vitest-environment jsdom
/**
 * Kustom keeps one order per checkout, and this tab keeps its checkout.
 *
 * QA, 2026-11-11 (Alan, «Boots test»):
 * - every time the checkout was closed and opened again, a NEW checkout was
 *   created — so a new Kustom order, and the old one left open in the
 *   merchant's account. Reopened on the same page for the same cart, the
 *   checkout this tab already has is taken up again while it is open;
 * - the same cart in two tabs: the tab whose checkout the other one replaced
 *   must not keep asking with it (VIO-4707). Commerce now refuses it
 *   (CHECKOUT_SUPERSEDED); the dead checkout is dropped here, so the next
 *   attempt builds one of this tab's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./payments/kustom.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./payments/kustom.js')>()
  return {
    ...real,
    createPaymentKustom: vi.fn(async (vars: { checkoutId: string }) => ({
      order_id: `KCO-${vars.checkoutId}`,
      status: 'checkout_incomplete',
      html_snippet: '<div id="klarna-checkout-container"></div>',
      checkout_id: vars.checkoutId,
    })),
    syncPaymentKustom: vi.fn(),
    renderKustomSnippet: vi.fn(),
    installKustomListeners: vi.fn(() => ({ destroy() {} })),
    suspendKustom: vi.fn(),
    resumeKustom: vi.fn(),
  }
})
vi.mock('../api/cart-queries.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api/cart-queries.js')>()
  let n = 0
  return {
    ...real,
    getCartGraphQLOptions: vi.fn(async () => ({})),
    createCheckout: vi.fn(async () => ({ id: `CHK-${++n}` })),
    updateCheckout: vi.fn(async (vars: { checkoutId: string }) => ({ id: vars.checkoutId })),
    getCheckout: vi.fn(),
  }
})

import { CheckoutManager, isCheckoutSuperseded } from './checkout-manager.js'
import * as kustom from './payments/kustom.js'
import * as queries from '../api/cart-queries.js'
import { resetStorageMemory } from '../safe-storage.js'

const SPONSOR = 5
const SUPERSEDED = new Error(
  'This checkout was replaced by a newer one (the cart was opened in another tab or window); reload the page [CHECKOUT_SUPERSEDED]',
)

let cartId = 'cart-1'
function manager() {
  const cart = {
    getCart: () => ({ cartId, items: [{ productId: 1, quantity: 1, unitPrice: 409.9 }] }),
    ensureCartId: async () => cartId,
    subtotalForSponsor: () => 409.9,
    waitForCartMutations: async () => undefined,
    refreshFromServer: async () => undefined,
  }
  return new CheckoutManager(cart as never) as any
}

/** One opening of the checkout, Kustom picked, its widget mounted. */
async function openAndMount(m: any) {
  m.open(SPONSOR)
  return m.mountKustomCheckout(document.createElement('div'), SPONSOR)
}

const active = (id: string) => ({
  id,
  status: 'ACTIVE',
  buyer_accepts_purchase_conditions: true,
  buyer_accepts_terms_conditions: true,
})

beforeEach(() => {
  cartId = 'cart-1'
  sessionStorage.clear()
  resetStorageMemory()
  window.history.replaceState({}, '', '/mote/boots-article')
  vi.mocked(kustom.createPaymentKustom).mockClear()
  vi.mocked(kustom.syncPaymentKustom).mockReset()
  vi.mocked(queries.createCheckout).mockClear()
  vi.mocked(queries.getCheckout).mockReset()
})

afterEach(() => {
  sessionStorage.clear()
})

describe('reopening the checkout takes up the checkout this tab already has', () => {
  it('closed and opened again on the same page: the same checkout, so Commerce updates the same Kustom order', async () => {
    const m = manager()
    const first = await openAndMount(m)
    expect(queries.createCheckout).toHaveBeenCalledTimes(1)

    m.close()
    vi.mocked(queries.getCheckout).mockResolvedValue(active(first.checkout_id))
    const second = await openAndMount(m)

    expect(queries.createCheckout).toHaveBeenCalledTimes(1)
    expect(second.checkout_id).toBe(first.checkout_id)
    expect(kustom.createPaymentKustom).toHaveBeenLastCalledWith(
      expect.objectContaining({ checkoutId: first.checkout_id }),
      expect.anything(),
    )
  })

  it('also after a reload of the page: the tab keeps it in sessionStorage', async () => {
    const first = await openAndMount(manager())
    vi.mocked(queries.getCheckout).mockResolvedValue(active(first.checkout_id))
    const afterReload = await openAndMount(manager())
    expect(afterReload.checkout_id).toBe(first.checkout_id)
    expect(queries.createCheckout).toHaveBeenCalledTimes(1)
  })

  it('a checkout Commerce no longer has open (another tab replaced it, or it was paid) is not taken up', async () => {
    for (const status of ['INACTIVE', 'SUCCESS', 'CANCEL']) {
      sessionStorage.clear()
      const m = manager()
      const first = await openAndMount(m)
      m.close()
      vi.mocked(queries.getCheckout).mockResolvedValue({ ...active(first.checkout_id), status })
      const second = await openAndMount(m)
      expect(second.checkout_id).not.toBe(first.checkout_id)
    }
  })

  it('another page (the order returns there, and the checkout is attributed to it): a new checkout', async () => {
    const m = manager()
    const first = await openAndMount(m)
    m.close()
    window.history.replaceState({}, '', '/mote/test-article')
    vi.mocked(queries.getCheckout).mockResolvedValue(active(first.checkout_id))
    const second = await openAndMount(m)
    expect(second.checkout_id).not.toBe(first.checkout_id)
    expect(queries.getCheckout).not.toHaveBeenCalled()
  })

  it('another cart (the last one was bought): a new checkout', async () => {
    const m = manager()
    const first = await openAndMount(m)
    m.close()
    cartId = 'cart-2'
    vi.mocked(queries.getCheckout).mockResolvedValue(active(first.checkout_id))
    const second = await openAndMount(m)
    expect(second.checkout_id).not.toBe(first.checkout_id)
  })

  it('a checkout that cannot be read is nothing to resume: a new one, as before', async () => {
    const m = manager()
    const first = await openAndMount(m)
    m.close()
    vi.mocked(queries.getCheckout).mockRejectedValue(new Error('network'))
    const second = await openAndMount(m)
    expect(second.checkout_id).not.toBe(first.checkout_id)
  })
})

describe('a checkout another tab replaced', () => {
  it('VIO-4707: the sync is refused, the dead checkout dropped — the next opening builds one of this tab\'s own', async () => {
    const m = manager()
    const first = await openAndMount(m)
    vi.mocked(kustom.syncPaymentKustom).mockRejectedValue(SUPERSEDED)

    await expect(m.syncKustomOrder(SPONSOR)).rejects.toBe(SUPERSEDED)
    expect(m.state.checkoutId).toBeUndefined()

    // Picked again in this tab: a checkout of its own, never the dead one,
    // and nothing asked about the dead one either.
    const again = await m.mountKustomCheckout(document.createElement('div'), SPONSOR)
    expect(again.checkout_id).not.toBe(first.checkout_id)
    expect(queries.getCheckout).not.toHaveBeenCalled()
  })

  it('refused while creating the order: dropped the same way', async () => {
    const m = manager()
    vi.mocked(kustom.createPaymentKustom).mockRejectedValueOnce(SUPERSEDED)
    await expect(openAndMount(m)).rejects.toBe(SUPERSEDED)
    expect(m.state.checkoutId).toBeUndefined()
    expect(sessionStorage.getItem('vio.kustom.checkout.v1')).toBeNull()
  })

  it('any other failure keeps the checkout: the next attempt updates the same order', async () => {
    const m = manager()
    const first = await openAndMount(m)
    vi.mocked(kustom.syncPaymentKustom).mockRejectedValue(new Error('network'))
    await expect(m.syncKustomOrder(SPONSOR)).rejects.toThrow('network')
    expect(m.state.checkoutId).toBe(first.checkout_id)
  })

  it('a sync waits for the cart change still on its way to Commerce, with the widget suspended (QA 2026-11-12)', async () => {
    const m = manager()
    await openAndMount(m)
    let land!: () => void
    m.cartManager.waitForCartMutations = vi.fn(() => new Promise<void>((resolve) => (land = resolve)))
    vi.mocked(kustom.syncPaymentKustom).mockResolvedValue({ order_id: 'KCO-x' } as never)
    vi.mocked(kustom.suspendKustom).mockClear()
    vi.mocked(kustom.resumeKustom).mockClear()

    const syncing = m.syncKustomOrder(SPONSOR)
    await new Promise((r) => setTimeout(r, 0))
    expect(kustom.suspendKustom).toHaveBeenCalledTimes(1)
    expect(kustom.syncPaymentKustom).not.toHaveBeenCalled()
    expect(kustom.resumeKustom).not.toHaveBeenCalled()

    land()
    await syncing
    expect(kustom.syncPaymentKustom).toHaveBeenCalledTimes(1)
    expect(kustom.resumeKustom).toHaveBeenCalledTimes(1)
  })

  it('isCheckoutSuperseded reads Commerce\'s code or its sentence', () => {
    expect(isCheckoutSuperseded(SUPERSEDED)).toBe(true)
    expect(isCheckoutSuperseded(new Error('[CHECKOUT_SUPERSEDED]'))).toBe(true)
    expect(isCheckoutSuperseded({ message: 'This checkout was replaced by a newer one' })).toBe(true)
    expect(isCheckoutSuperseded(new Error('This cart has already been paid [CART_ALREADY_PAID]'))).toBe(false)
    expect(isCheckoutSuperseded(undefined)).toBe(false)
  })
})
