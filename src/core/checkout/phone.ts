/**
 * The shopper's mobile number, as the checkout form asks for it (Mote &
 * Livsstil, 2026-10-28). Any market's number: an explicit `+`/`00` prefix
 * names the calling code; without one, the shipping country does (else the
 * page's). The order carries it as `phone` (national digits) + `phone_code`
 * (calling code, no plus — shopcart's own Vipps mapping uses the same) on
 * the shipping and billing address.
 *
 * Required only for the checkout's standard Vipps payment, where shopcart no
 * longer asks Vipps for the shopper's profile; optional for every other method.
 */

/** Calling code per ISO country (the markets a Vio page sells to, and their neighbours). */
const CALLING_CODES: Record<string, string> = {
  NO: '47', SE: '46', DK: '45', FI: '358', IS: '354', DE: '49', GB: '44', UK: '44', IE: '353',
  NL: '31', BE: '32', FR: '33', ES: '34', PT: '351', IT: '39', AT: '43', CH: '41', PL: '48',
  EE: '372', LV: '371', LT: '370', CZ: '420', SK: '421', HU: '36', US: '1', CA: '1',
}

/** Every known code, longest first (so `358` is tried before `35`). */
const KNOWN_CODES = [...new Set(Object.values(CALLING_CODES))].sort((a, b) => b.length - a.length)

/** National number length per calling code: [min, max] digits (mobile). Others: 6–12. */
const NATIONAL_LENGTH: Record<string, [number, number]> = {
  '47': [8, 8], '45': [8, 8], '46': [7, 9], '358': [6, 10], '49': [10, 11], '44': [10, 10], '1': [10, 10],
}

export interface ParsedPhone {
  /** National digits, without trunk 0. */
  phone: string
  /** Calling code, digits only. */
  phone_code: string
}

/** The calling code of a country (ISO-2), or null when unknown. */
export function callingCodeFor(country: unknown): string | null {
  return CALLING_CODES[String(country ?? '').trim().toUpperCase()] ?? null
}

/**
 * Split a typed number into national digits + calling code, or null when it
 * is not a usable mobile number. `country` is the shipping country (ISO-2),
 * used when the number carries no `+`/`00` prefix.
 */
export function parsePhone(raw: unknown, country?: unknown): ParsedPhone | null {
  const typed = String(raw ?? '').trim().replace(/[\s\-().]/g, '')
  if (!typed) return null
  let code: string | null = null
  let national: string
  if (/^(\+|00)/.test(typed)) {
    const digits = typed.replace(/^(\+|00)/, '')
    if (!/^\d+$/.test(digits)) return null
    code = KNOWN_CODES.find((c) => digits.startsWith(c)) ?? null
    if (!code) return null
    national = digits.slice(code.length)
  } else {
    if (!/^\d+$/.test(typed)) return null
    code = callingCodeFor(country)
    if (!code) return null
    national = typed
  }
  // The trunk 0 of national dialling (SE 070…, DE 0151…, GB 07…) is not part of the number.
  if (national.startsWith('0') && code !== '47' && code !== '45') national = national.slice(1)
  const [min, max] = NATIONAL_LENGTH[code] ?? [6, 12]
  if (national.length < min || national.length > max) return null
  return { phone: national, phone_code: code }
}

/** Whether the typed number is usable for that shipping country. */
export function isValidPhone(raw: unknown, country?: unknown): boolean {
  return parsePhone(raw, country) !== null
}
