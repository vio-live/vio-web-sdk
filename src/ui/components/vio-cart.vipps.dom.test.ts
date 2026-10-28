// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, unmountAll, settle } from '../test-harness.js'
import { Vio } from '../../core/client.js'

/**
 * The cart's Vipps button opens the checkout with Vipps preselected — the
 * standard path, with our address form and delivery — and never starts
 * Express from the cart, even when the brand has it on (2026-10-28).
 */

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

describe('vio-cart — Vipps', () => {
  it('opens the checkout with Vipps preselected; no Express, no hand-over to Vipps', async () => {
    vi.spyOn(Vio.checkout, 'getAvailablePaymentMethods').mockResolvedValue([{ name: 'Vipps' }] as any)
    const express = vi.spyOn(Vio.checkout, 'startVippsExpress').mockResolvedValue({ payment_url: 'https://x' } as any)
    const plain = vi.spyOn(Vio.checkout, 'startVippsPayment').mockResolvedValue({ payment_url: 'https://x' } as any)
    vi.spyOn(Vio.checkout, 'getVippsExpressEnabled').mockResolvedValue(true)
    const el = await mount<HTMLElement & Record<string, any>>('vio-cart')
    el.carts = new Map([
      [5, { sponsorId: 5, currency: 'NOK', items: [{ id: 'i1', productId: 1, name: 'Genser', quantity: 1, unitPrice: 699, currency: 'NOK' }] }],
    ])
    el.itemCount = 1
    el.availableMethods = ['Vipps']
    el.open = true
    await settle(el)
    const opened = vi.fn()
    document.addEventListener('vio:checkout-open', opened)
    el.shadowRoot!.querySelector<HTMLButtonElement>('.vipps-btn')!.click()
    for (let i = 0; i < 3; i++) await settle(el)
    document.removeEventListener('vio:checkout-open', opened)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened.mock.calls[0]![0].detail).toMatchObject({ sponsorId: 5, paymentMethod: 'vipps', express: false })
    expect(express).not.toHaveBeenCalled()
    expect(plain).not.toHaveBeenCalled()
    expect(document.querySelector('.vio-redirect-overlay')).toBeNull()
  })
})
