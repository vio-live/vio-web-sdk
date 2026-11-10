/**
 * The receipt of a purchase, read from the checkout it paid (`GetCheckout`).
 *
 * A purchase confirmed on this page (Stripe's Payment Element, Klarna, Apple
 * Pay) prints the cart the shopper just paid: it is still in memory. One that
 * comes back from a payment page (Vipps, a Stripe link, an Adyen redirect)
 * has no such cart: the page reloaded on the way, or the provider's app
 * brought the shopper back in another tab, and a paid cart is cleared anyway.
 * The «Takk!» after Vipps had no lines and no shipping row (Alan, QA,
 * 2026-11-04). What every return does have is the checkout id, and the
 * checkout keeps the cart it was paid with: its lines, the shipping each line
 * was sent with, and the totals that were charged.
 *
 * Analytics reads a return's `purchase` lines the same way (Faves 4136/4139/
 * 4142: the cart of the tab was empty, or already the next purchase) — hence
 * it lives in core, not next to the receipt that first needed it.
 */

import type { CartLineItem } from '../cart/types.js'
import { cartDiscountTotal, cartNetTotal, serverLineDiscount } from '../cart/discount.js'

/** What the receipt prints, as the checkout says it. */
export interface CheckoutReceipt {
  /** The lines, each with its list price and what the discount code took off it (`discount`). */
  items: CartLineItem[]
  /** Empty when the checkout names none. */
  currency: string
  /** What was charged: items + shipping (− discounts). */
  total: number
  /** Only when the purchase had a shipping; a free one has `price: 0` («Gratis»). */
  shipping?: { name: string; price: number }
  /** Only when a discount code took something off: how much, and the code when the checkout names it. */
  discount?: { amount: number; code?: string }
  email?: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A number, or null — the gateway's floats may come as numeric strings. */
function amount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function imageOf(image: unknown): string {
  const first = Array.isArray(image) ? image[0] : image
  if (typeof first === 'string') return first.trim()
  return text((first as { url?: unknown } | null | undefined)?.url)
}

/**
 * The receipt of `checkout` (a `GetCheckout` answer), or `null` when it has
 * no lines to print. Lines read as the cart reads them (title — variant,
 * list price incl. taxes, and what the discount code took off the line); the
 * shipping row carries the lines' shipping names and the shipping total, and
 * is left out when the purchase had no shipping; the discount is what the
 * lines say (else the checkout's `totals.discounts`), with the checkout's
 * code. The total is the checkout's own (`totals.total`, already less the
 * discount); without one, the lines' net plus the shipping.
 */
export function receiptFromCheckout(checkout: unknown, sponsorId: number): CheckoutReceipt | null {
  const c = (checkout ?? {}) as Record<string, any>
  const cart = (c.cart ?? {}) as Record<string, any>
  const lines: any[] = Array.isArray(cart.line_items) ? cart.line_items : []
  if (lines.length === 0) return null
  const totals = (c.totals ?? {}) as Record<string, unknown>
  const currency = text(totals.currency_code) || text(cart.currency)

  const items = lines.map((li, index): CartLineItem => {
    const title = text(li?.title)
    const variant = text(li?.variant_title)
    const id = li?.id != null ? String(li.id) : `line-${index}`
    const unitPrice = amount(li?.price?.amount_incl_taxes) ?? amount(li?.price?.amount) ?? 0
    const quantity = Number(li?.quantity) || 0
    const discount = serverLineDiscount(li?.price?.discount, unitPrice, quantity)
    return {
      id,
      cartItemId: id,
      productId: Number(li?.product_id) || 0,
      sponsorId,
      ...(li?.variant_id != null && Number.isFinite(Number(li.variant_id)) ? { variantId: Number(li.variant_id) } : {}),
      brand: text(li?.brand),
      name: title && variant ? `${title} — ${variant}` : title || variant,
      unitPrice,
      ...(discount > 0 ? { discount } : {}),
      currency: text(li?.price?.currency_code) || currency,
      imageUrl: imageOf(li?.image),
      quantity,
    }
  })
  // What the lines cost: their list prices less what the discount code took off each.
  const itemsTotal = cartNetTotal(items)
  const lineDiscounts = cartDiscountTotal(items)
  // The lines say it per line; the checkout's own figure only when they do not.
  const discounted = lineDiscounts > 0 ? lineDiscounts : Math.max(0, amount(totals.discounts) ?? 0)
  const code = text(c.discount_code)

  const shipped = lines.map((li) => li?.shipping).filter((s) => s && typeof s === 'object')
  const names = [...new Set(shipped.map((s) => text(s.name)).filter(Boolean))]
  const shippingPrice =
    amount(totals.shipping) ??
    amount(cart.shipping) ??
    (shipped.length > 0 ? (amount(shipped[0].price?.amount_incl_taxes) ?? amount(shipped[0].price?.amount)) : null)
  const hasShipping = shipped.length > 0 || (shippingPrice ?? 0) > 0
  const shipping =
    hasShipping && shippingPrice !== null ? { name: names.join(', ') || 'Frakt', price: shippingPrice } : undefined

  const charged = amount(totals.total)
  const email = text(c.email)
  return {
    items,
    currency,
    total: charged !== null && charged > 0 ? charged : itemsTotal + (shipping?.price ?? 0),
    ...(shipping ? { shipping } : {}),
    ...(discounted > 0 ? { discount: { amount: discounted, ...(code ? { code } : {}) } } : {}),
    ...(email ? { email } : {}),
  }
}
