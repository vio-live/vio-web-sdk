/**
 * Everything the SDK says to the shopper about a discount code — one place,
 * so a brand can read (and correct) all of it. Norwegian bokmål, short, in
 * the voice of the cart and the checkout.
 *
 * No DOM and no Lit here: `checkout-errors.ts` reads these too.
 */

import type { DiscountReason } from '../core/cart/discount-code.js'

export const DISCOUNT_TEXT = {
  // ── Lines and totals ──────────────────────────────────────────────────────
  /** The price of a line the code gives away. */
  free: 'Gratis',
  /** Read out before the struck-through list price of a discounted line («Ordinær pris 52 Kr»). */
  listPrice: 'Ordinær pris',
  /** The row of what the code takes off, in the cart, the checkout's summary and the receipt («Rabatt (KODE)» when the code is known). */
  discountRow: 'Rabatt',
  /** The cart's total when the shipping is not known yet (worked out in the checkout). */
  totalBeforeShipping: 'Totalt uten frakt',

  // ── A gift ────────────────────────────────────────────────────────────────
  /** A cart that holds only the gift: nothing to pay for. */
  giftOnly: 'Legg til et produkt for å få med gaven.',
  /** A gift line with more than one unit (also when Commerce refuses the payment for it). */
  giftMaxOne: 'Du kan bare få én gave per bestilling. Reduser antallet og prøv igjen.',
  /** On the «+» of a gift line, which does nothing. */
  giftMaxOneShort: 'Maks én gave per bestilling',

  // ── A payment Commerce would not start because of the discount ────────────
  /** The discount could not be worked out right now. */
  discountUnavailable: 'Rabatten kunne ikke beregnes akkurat nå. Prøv igjen om litt.',
  /** After a code that is no good any more came off the cart at the payment. */
  cartUpdated: 'Handlekurven er oppdatert – prøv igjen.',

  // ── Why a code was refused ────────────────────────────────────────────────
  couponNotFound: 'Rabattkoden finnes ikke.',
  couponExpired: 'Rabattkoden er ikke lenger gyldig.',
  couponUsageLimit: 'Rabattkoden er brukt opp.',
  couponNotSupported: 'Rabattkoden kan ikke brukes her.',
  couponMinAmount: 'Handlekurven er under minstebeløpet for rabattkoden.',
  couponOtherApplied: 'Du har allerede en rabattkode. Fjern den først.',
  couponUnavailable: 'Vi kunne ikke sjekke rabattkoden akkurat nå. Prøv igjen.',
  /** Any other refusal. */
  couponRefused: 'Rabattkoden kunne ikke brukes.',
} as const

/** The row's label: «Rabatt», or «Rabatt (KODE)» when the code is known. */
export function discountRowLabel(code?: string | null): string {
  const shown = typeof code === 'string' ? code.trim() : ''
  return shown ? `${DISCOUNT_TEXT.discountRow} (${shown})` : DISCOUNT_TEXT.discountRow
}

/**
 * Why a code was refused, for the shopper: Commerce's stable word
 * (`COUPON_EXPIRED`…) as a sentence; any other word, or none, is the generic
 * one.
 */
export function couponReasonText(reason: string | null | undefined): string {
  switch (reason) {
    case 'COUPON_NOT_FOUND':
      return DISCOUNT_TEXT.couponNotFound
    case 'COUPON_EXPIRED':
      return DISCOUNT_TEXT.couponExpired
    case 'COUPON_USAGE_LIMIT':
      return DISCOUNT_TEXT.couponUsageLimit
    case 'COUPON_NOT_SUPPORTED':
      return DISCOUNT_TEXT.couponNotSupported
    case 'COUPON_MIN_AMOUNT':
      return DISCOUNT_TEXT.couponMinAmount
    case 'COUPON_OTHER_APPLIED':
      return DISCOUNT_TEXT.couponOtherApplied
    case 'COUPON_UNAVAILABLE':
    case 'DISCOUNT_UNAVAILABLE':
      return DISCOUNT_TEXT.couponUnavailable
    default:
      return DISCOUNT_TEXT.couponRefused
  }
}

/**
 * What the shopper reads when Commerce would not start a payment because of
 * the cart's discount. A code that is no good any more has come off the cart
 * by then (`CartManager.discountRefusedAtPayment`): the sentence says why,
 * and that the cart is ready for another try.
 */
export function discountPaymentText(reason: DiscountReason): string {
  switch (reason) {
    case 'GIFT_MAX_ONE_UNIT':
      return DISCOUNT_TEXT.giftMaxOne
    case 'CHECKOUT_AMOUNT_ZERO':
      return DISCOUNT_TEXT.giftOnly
    case 'DISCOUNT_UNAVAILABLE':
      return DISCOUNT_TEXT.discountUnavailable
    case 'COUPON_UNAVAILABLE':
      return DISCOUNT_TEXT.couponUnavailable
    case 'COUPON_OTHER_APPLIED':
      return DISCOUNT_TEXT.couponOtherApplied
    default:
      return `${couponReasonText(reason)} ${DISCOUNT_TEXT.cartUpdated}`
  }
}
