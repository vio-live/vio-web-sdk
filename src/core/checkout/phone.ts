/**
 * The shopper's mobile number, as the checkout form asks for it (Mote &
 * Livsstil, 2026-10-28): Norwegian, eight digits, with or without +47 / 0047,
 * spaces and dashes allowed. The courier texts it; the order carries it as
 * `phone` + `phone_code` on the shipping and billing address.
 */

/** Calling code sent as `phone_code` (shopcart's own Vipps mapping uses the same, no plus). */
export const NORWAY_PHONE_CODE = '47'

/** The eight national digits, or null when it is not a Norwegian mobile number. */
export function normalizeNorwegianMobile(raw: unknown): string | null {
  let digits = String(raw ?? '').replace(/[\s\-().]/g, '')
  if (digits.startsWith('+47')) digits = digits.slice(3)
  else if (digits.startsWith('0047')) digits = digits.slice(4)
  return /^\d{8}$/.test(digits) ? digits : null
}

/** Whether the form's number is usable. */
export function isValidNorwegianMobile(raw: unknown): boolean {
  return normalizeNorwegianMobile(raw) !== null
}
