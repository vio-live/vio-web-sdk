/**
 * What the shopper reads when a payment cannot be STARTED.
 *
 * Until 2026-10-09 the gateway's own text went straight to the screen:
 * "Kunne ikke starte Vipps-betaling: Payment Vipps not initialize: [vipps]
 * amount must be a positive integer in minor units, got 0" (a cart emptied
 * from another tab), or "Kunne ikke laste betaling: Payment Stripe not intent
 * execute: : Cannot read properties of undefined (reading 'id')". The known
 * causes map to a short Norwegian sentence that says what to do; anything
 * else gets a generic one. The raw text is for `console.warn`, never the
 * panel.
 *
 * Return-flow messages ("Betalingen ble avbrutt eller feilet…", the
 * unverified-return text) are not this: they are already written for the
 * shopper and stay where they are.
 */

/** The cart has no lines: the gateway refuses a zero amount. */
export const EMPTY_CART_MESSAGE = 'Handlekurven er tom. Legg til et produkt og prøv igjen.'
/** A newer checkout replaced this one — the cart changed in another tab. */
export const CART_CHANGED_MESSAGE =
  'Handlekurven ble endret i en annen fane. Last siden på nytt og prøv igjen.'
/** This cart was already paid for. */
export const CART_PAID_MESSAGE = 'Denne handlekurven er allerede betalt. Start en ny handlekurv.'
/** Everything else. */
export const PAYMENT_START_FAILED_MESSAGE =
  'Betalingen kunne ikke startes. Prøv igjen, eller velg en annen betalingsmåte.'

/** The one backend message that is already written for the shopper. */
const SHIPS_APART = 'kan ikke sendes sammen'

/**
 * The sentence to show for a payment that could not start.
 *
 * `raw` is the gateway's or the backend's text, as thrown. `method` is the
 * Vio payment method the start was for (`stripe`, `vipps`, …): the texts are
 * the same for every method today, it is here so a call site says which one
 * failed and a method-specific text can be added without touching them.
 */
export function friendlyPaymentError(raw: string, method: string): string {
  void method
  const text = String(raw ?? '')
  const lower = text.toLowerCase()
  if (lower.includes('got 0') || lower.includes('amount must be a positive')) {
    return EMPTY_CART_MESSAGE
  }
  if (lower.includes('replaced by a newer') || text.includes('CHECKOUT_SUPERSEDED')) {
    return CART_CHANGED_MESSAGE
  }
  if (lower.includes('already been paid') || text.includes('CART_ALREADY_PAID')) {
    return CART_PAID_MESSAGE
  }
  if (text.includes(SHIPS_APART)) return norwegianSentence(text)
  return PAYMENT_START_FAILED_MESSAGE
}

/**
 * The Norwegian sentence inside a gateway message, without the technical
 * prefix in front of it ("Payment Vipps not initialize: Produktene …").
 */
function norwegianSentence(text: string): string {
  const at = text.indexOf(SHIPS_APART)
  const prefixEnd = text.lastIndexOf(': ', at)
  return (prefixEnd === -1 ? text : text.slice(prefixEnd + 2)).trim()
}

/** A thrown value as text — what the call sites used to build the message from. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
