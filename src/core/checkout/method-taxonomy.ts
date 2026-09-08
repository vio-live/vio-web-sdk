/**
 * What kind of thing each payment method is — in ONE place.
 *
 * This exists because the answer used to be spelled out by hand wherever it
 * was needed: `methodEnabled` was reimplemented in three components with three
 * slightly different signatures, and the list `kustom | qliro | walley`
 * appeared in five separate places in the checkout alone plus the product
 * page. Adding a method meant remembering all of them.
 *
 * Nobody remembered. On 2026-09-08 the same omission produced two separate
 * defects: the cart footer had no button at all for a channel offering only an
 * embedded checkout, and the product page had no buy button for the same
 * reason — the same mistake, twice, in two files. A code review the same day
 * named this as the mechanism.
 *
 * So: adding a payment method should mean editing this file, and the type
 * checker should find the rest.
 */

/** Backend names arrive as "Apple Pay", "Qliro", "STRIPE" — compare letters. */
export function normalizeMethodName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
}

/**
 * Methods whose provider runs the whole purchase inside its own widget:
 * address, shipping, email AND payment.
 *
 * Two consequences follow, and both were defects before this list existed:
 * they have no branded express button, so a page offering only these needs a
 * generic "go to checkout" CTA; and our delivery-address form is pointless
 * when every offered method is one of them.
 */
export const EMBEDDED_METHODS = ['kustom', 'qliro', 'walley'] as const

/**
 * Methods that collect the shipping address themselves. The embedded ones do,
 * and so does Vipps inside its own flow — it just isn't embedded in our page.
 */
export const COLLECTS_OWN_ADDRESS = [...EMBEDDED_METHODS, 'vipps'] as const

/** Runs inside its own widget in our page (no branded express button). */
export const isEmbeddedMethod = (name: string): boolean =>
  (EMBEDDED_METHODS as readonly string[]).includes(normalizeMethodName(name))

/** Asks the shopper for their address itself, so our form would ask twice. */
export const collectsOwnAddress = (name: string): boolean =>
  (COLLECTS_OWN_ADDRESS as readonly string[]).includes(normalizeMethodName(name))

/**
 * Is `name` among the methods the channel offers?
 *
 * `available === null` means "we do not know" — either not asked yet or the
 * lookup failed — and answers `true` for everything, so a backend blip shows
 * too many methods rather than none and nobody is blocked from paying. The
 * caller decides whether "do not know" should render a spinner instead; see
 * `paymentMethodsResolved` in vio-checkout.
 *
 * Several names match if any of them does: some call sites pass both spellings
 * of a method (`'apple-pay'`, `'applepay'`).
 */
export function isMethodEnabled(
  available: string[] | null,
  ...names: string[]
): boolean {
  if (available === null) return true
  return available.some((m) =>
    names.some((n) => normalizeMethodName(m) === normalizeMethodName(n)),
  )
}

/**
 * Do ALL the offered methods collect the address themselves?
 *
 * "All", not "any": with Klarna alongside Qliro the form is still needed, so
 * it must come back. Answers false when the list is unknown or empty — that is
 * not a positive answer, and hiding the form on a guess would strand a shopper
 * whose method does need it.
 */
export function everyMethodCollectsAddress(available: string[] | null): boolean {
  return (
    Array.isArray(available) &&
    available.length > 0 &&
    available.every(collectsOwnAddress)
  )
}
