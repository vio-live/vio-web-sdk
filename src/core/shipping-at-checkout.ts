/**
 * Ways to pay whose own widget picks the delivery, and its price, inside the
 * checkout: Kustom (with the brand's Shipping Assistant, or our rates offered
 * in the widget). The checkout already waits for the widget's pick before it
 * names a shipping price (`vio-checkout` › `shippingInEffect`); a brand paid
 * only like this has no shipping price to show before the checkout either.
 */
export const WIDGET_SHIPPING_METHODS: readonly string[] = ['kustom']

/** A payment method's slug as the bootstrap lists it, letters only, lower case. */
function methodLetters(method: unknown): string {
  return typeof method === 'string' ? method.toLowerCase().replace(/[^a-z]/g, '') : ''
}

/**
 * Whether a brand's selling block (`sponsor.commerce` of the bootstrap) has
 * its delivery picked inside the checkout: every way to pay it lists is one
 * whose widget picks the delivery (`WIDGET_SHIPPING_METHODS`). A rate of the
 * brand's in Vio is then only a placeholder (Boots, 2026-11-25: 1 kr so that
 * hosts do not read it as free shipping), never a price to show.
 *
 * No block, or no listed methods: no — the brand's rates are the price.
 */
export function shippingPickedAtCheckout(commerce: unknown): boolean {
  if (!commerce || typeof commerce !== 'object') return false
  const { paymentMethods } = commerce as { paymentMethods?: unknown }
  if (!Array.isArray(paymentMethods) || paymentMethods.length === 0) return false
  return paymentMethods.every((m) => WIDGET_SHIPPING_METHODS.includes(methodLetters(m)))
}
