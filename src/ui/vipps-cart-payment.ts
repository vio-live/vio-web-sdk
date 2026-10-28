/**
 * How the Vipps buttons of `<vio-cart>` and `<vio-product-detail>` pay a
 * cart that has (or will have) lines in it:
 *
 *  - `'express'` (default, 2026-10-29): Vipps Express for the sponsor's WHOLE
 *    cart — the app fills in name, address and delivery. The cart's black
 *    «Til kassen» button is the way into our checkout.
 *  - `'checkout'`: the behaviour of 0.31–0.34 — the cart's Vipps button, and
 *    the detail's when the cart already has lines, open our checkout with
 *    Vipps preselected (`vio:checkout-open`, the standard Vipps payment).
 *
 * The element's `vipps-cart-payment` attribute wins; else the theme's
 * `vippsCartPayment` (`--vio-vipps-cart-payment`); else `'express'`.
 */

export type VippsCartPayment = 'express' | 'checkout'

export const VIPPS_CART_PAYMENT_VAR = '--vio-vipps-cart-payment'

export function resolveVippsCartPayment(el: Element, own: string | null | undefined): VippsCartPayment {
  let fromTheme = ''
  if (!own) {
    try {
      fromTheme = typeof getComputedStyle === 'function' ? getComputedStyle(el).getPropertyValue(VIPPS_CART_PAYMENT_VAR) : ''
    } catch {
      fromTheme = ''
    }
  }
  const value = String(own || fromTheme || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
  return value === 'checkout' ? 'checkout' : 'express'
}
