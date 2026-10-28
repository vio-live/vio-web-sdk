/**
 * Storage in in-app browsers (Mote & Livsstil, 2026-10-28): the storage
 * property that throws on access, the one that is null, the write that
 * fails. None of them may stop an add to cart or a checkout: everything
 * falls back to this page's memory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gql = vi.hoisted(() => ({
  getCartGraphQLOptions: vi.fn(async () => ({ sponsorResolved: true })),
  createCart: vi.fn(async () => ({ cart_id: 'cart-1', line_items: [] })),
  addItem: vi.fn(async () => ({
    cart_id: 'cart-1',
    currency: 'NOK',
    line_items: [{ id: 'srv-1', product_id: 9, title: 'Genser', quantity: 1, price: { amount: 699, currency_code: 'NOK' } }],
  })),
}))

vi.mock('./api/cart-queries.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...gql,
}))

import { resetStorageMemory, storageGet, storageRemove, storageSet } from './safe-storage.js'
import { getCustomerSessionId } from './api/cart-queries.js'
import { getGlobalCountryCode, getGlobalCurrency, getGlobalLocale } from './types.js'
import { CartManager } from './cart/cart-manager.js'
import { CheckoutManager } from './checkout/checkout-manager.js'

type Mode = 'throws' | 'null' | 'write-fails'

function breakStorage(mode: Mode) {
  for (const name of ['localStorage', 'sessionStorage']) {
    if (mode === 'throws') {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          throw new Error('SecurityError: The operation is insecure.')
        },
      })
    } else if (mode === 'null') {
      Object.defineProperty(globalThis, name, { configurable: true, value: null, writable: true })
    } else {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: {
          getItem: () => null,
          setItem: () => {
            throw new Error('QuotaExceededError')
          },
          removeItem: () => {},
          clear: () => {},
          key: () => null,
          length: 0,
        },
      })
    }
  }
}

const saved: Record<string, PropertyDescriptor | undefined> = {}
beforeEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  resetStorageMemory()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const d = saved[name]
    if (d) Object.defineProperty(globalThis, name, d)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  resetStorageMemory()
  vi.restoreAllMocks()
})

for (const mode of ['throws', 'null', 'write-fails'] as Mode[]) {
  describe(`storage that ${mode === 'throws' ? 'throws on access' : mode === 'null' ? 'is null' : 'refuses writes'}`, () => {
    beforeEach(() => breakStorage(mode))

    it('safe-storage never throws and keeps what this page wrote', () => {
      expect(() => storageGet('local', 'k')).not.toThrow()
      expect(storageSet('local', 'k', 'v')).toBe(false)
      expect(storageGet('local', 'k')).toBe('v')
      storageRemove('session', 'k')
      expect(storageSet('session', 'k', 'w')).toBe(false)
      expect(storageGet('session', 'k')).toBe('w')
      // A caller that keeps the value itself can ask for no memory copy.
      expect(storageSet('local', 'cart', 'x', { memory: false })).toBe(false)
      expect(storageGet('local', 'cart')).toBeNull()
    })

    it('the market defaults still answer (currency, country, locale)', () => {
      expect(getGlobalCurrency()).toBe('NOK')
      expect(getGlobalCountryCode()).toBe('NO')
      expect(getGlobalLocale()).toBe('nb-NO')
    })

    it('the customer session id is one per page — never the shared default', () => {
      const id = getCustomerSessionId()
      expect(id).not.toBe('cs_session_default')
      expect(id).toMatch(/^cs_/)
      expect(getCustomerSessionId()).toBe(id)
    })

    it('add to cart works, and the checkout opens on it', async () => {
      let cart!: CartManager
      expect(() => (cart = new CartManager())).not.toThrow()
      cart.addManual({ productId: 9, sponsorId: 5, brand: 'Careless', name: 'Genser', unitPrice: 699, currency: 'NOK', imageUrl: '', quantity: 1 })
      expect(cart.itemCount).toBe(1)
      await cart.waitForCartMutations(5)
      expect(gql.addItem).toHaveBeenCalled()
      expect(cart.getCart(5)?.cartId).toBe('cart-1')
      const checkout = new CheckoutManager(cart)
      expect(checkout.open(5)).toMatchObject({ sponsorId: 5, subtotal: 699 })
      await expect(checkout.resumeKlarnaReturn()).resolves.toBeUndefined()
    })
  })
}
