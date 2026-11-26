/**
 * The payment logos under the buy button: what the shopper can pay with once
 * inside the checkout, said before they go in.
 *
 * Only for Kustom, for now. Kustom's embedded checkout is one generic button
 * from the outside («Kjøp nå», «Til kassen») and Klarna, Vipps, cards and the
 * wallets on the inside; its own footer carries these logos, under its buy
 * button. A shopper who has not opened it cannot tell. The other ways to pay
 * need no such strip: each has its own branded button.
 *
 * Which logos: the ones Kustom's checkout shows in Norway, in its order
 * (`KUSTOM_PAYMENT_MARKS`). Kustom does not tell a page which methods a
 * merchant has switched on without its own script and a domain registered in
 * the merchant's Portal (Kustom Elements), so the list is the SDK's. Hidden
 * with `--vio-payment-marks-display: none` (theme: `paymentMarksDisplay`).
 *
 * The artwork is Kustom's own — the payment method icons and the badge of its
 * partner marketing toolkit (docs.kustom.co → Partners → «Using Kustom and
 * payment method logos») — inline, so the strip costs no request and needs
 * no image host in a page's CSP. The block between the `generated:art` marks
 * is those files as they came — whitespace collapsed, coordinates to two
 * decimals. To refresh it, take the new files and replace the paths; do not
 * redraw them.
 */
import { css, html, type TemplateResult } from 'lit'
import { normalizeMethodName } from '../core/checkout/method-taxonomy.js'

/** A logo the strip can show. */
export type PaymentMark = 'klarna' | 'vipps' | 'visa' | 'mastercard' | 'apple-pay' | 'google-pay'

/** What Kustom's checkout takes in Norway, in the order its own footer shows them. */
export const KUSTOM_PAYMENT_MARKS: readonly PaymentMark[] = [
  'klarna',
  'vipps',
  'visa',
  'mastercard',
  'apple-pay',
  'google-pay',
]

/** What the strip is, read out. */
export const PAYMENT_MARKS_LABEL = 'Betalingsmåter i kassen'

/**
 * The logos for a brand whose ways to pay are `available` (the names Commerce
 * offers — «Kustom», «Vipps»…): Kustom's when Kustom is among them, none
 * otherwise. `null` is "not known yet": none, rather than logos that may be
 * taken back a moment later.
 */
export function paymentMarksFor(available: ReadonlyArray<string> | null | undefined): readonly PaymentMark[] {
  if (!Array.isArray(available)) return []
  return available.some((name) => normalizeMethodName(name) === 'kustom') ? KUSTOM_PAYMENT_MARKS : []
}

// <generated:art>
const MARK_ART: Record<PaymentMark, TemplateResult> = {
  klarna: html`<svg class="payment-mark" part="payment-mark" viewBox="0 0 120 80" fill="none" role="img" aria-label="Klarna"><rect width="120" height="80" rx="4" fill="#FFA8CD"/><path d="M92.57 46.19C90.71 46.19 89.26 44.65 89.26 42.79C89.26 40.92 90.71 39.38 92.57 39.38C94.43 39.38 95.88 40.92 95.88 42.79C95.88 44.65 94.43 46.19 92.57 46.19ZM91.64 49.79C93.23 49.79 95.25 49.19 96.37 46.82L96.48 46.88C95.99 48.17 95.99 48.94 95.99 49.13V49.43H99.98V36.14H95.99V36.44C95.99 36.64 95.99 37.41 96.48 38.7L96.37 38.75C95.25 36.39 93.23 35.78 91.64 35.78C87.84 35.78 85.16 38.81 85.16 42.79C85.16 46.77 87.84 49.79 91.64 49.79ZM78.21 35.78C76.41 35.78 74.99 36.42 73.84 38.75L73.73 38.7C74.22 37.41 74.22 36.64 74.22 36.44V36.14H70.23V49.43H74.33V42.43C74.33 40.59 75.4 39.44 77.12 39.44C78.84 39.44 79.69 40.43 79.69 42.4V49.43H83.79V40.97C83.79 37.95 81.44 35.78 78.21 35.78ZM64.29 38.75L64.18 38.7C64.68 37.41 64.68 36.64 64.68 36.44V36.14H60.68V49.43H64.79L64.81 43.03C64.81 41.17 65.8 40.04 67.41 40.04C67.85 40.04 68.2 40.1 68.61 40.21V36.14C66.81 35.76 65.2 36.44 64.29 38.75ZM51.25 46.19C49.39 46.19 47.94 44.65 47.94 42.79C47.94 40.92 49.39 39.38 51.25 39.38C53.11 39.38 54.56 40.92 54.56 42.79C54.56 44.65 53.11 46.19 51.25 46.19ZM50.32 49.79C51.91 49.79 53.93 49.19 55.05 46.82L55.16 46.88C54.67 48.17 54.67 48.94 54.67 49.13V49.43H58.66V36.14H54.67V36.44C54.67 36.64 54.67 37.41 55.16 38.7L55.05 38.75C53.93 36.39 51.91 35.78 50.32 35.78C46.52 35.78 43.84 38.81 43.84 42.79C43.84 46.77 46.52 49.79 50.32 49.79ZM38.12 49.43H42.22V30.21H38.12V49.43ZM35.11 30.21H30.93C30.93 33.64 28.82 36.72 25.62 38.92L24.37 39.79V30.21H20.02V49.43H24.37V39.9L31.56 49.43H36.86L29.94 40.32C33.09 38.04 35.14 34.49 35.11 30.21Z" fill="#0B051D"/></svg>`,
  vipps: html`<svg class="payment-mark framed" part="payment-mark" viewBox="0 0 120 80" fill="none" role="img" aria-label="Vipps"><rect width="120" height="80" rx="4" fill="white"/><path d="M25.39 30.59L28.68 40.19L31.9 30.59H35.7L30.03 44.83H27.2L21.52 30.59H25.39Z" fill="#FF5B24"/><path d="M44.27 42.58C46.66 42.58 48.01 41.42 49.3 39.74C50.01 38.84 50.91 38.65 51.56 39.16C52.2 39.68 52.27 40.64 51.56 41.55C49.69 44 47.3 45.48 44.27 45.48C40.99 45.48 38.09 43.67 36.09 40.52C35.51 39.68 35.64 38.78 36.28 38.32C36.93 37.87 37.89 38.07 38.47 38.97C39.89 41.1 41.83 42.58 44.27 42.58ZM48.72 34.65C48.72 35.81 47.82 36.58 46.79 36.58C45.76 36.58 44.85 35.81 44.85 34.65C44.85 33.49 45.76 32.72 46.79 32.72C47.82 32.72 48.72 33.56 48.72 34.65Z" fill="#FF5B24"/><path d="M57.81 30.59V32.52C58.78 31.17 60.26 30.2 62.45 30.2C65.22 30.2 68.44 32.52 68.44 37.49C68.44 42.71 65.35 45.22 62.13 45.22C60.45 45.22 58.9 44.58 57.74 42.96V49.8H54.26V30.59H57.81ZM57.81 37.68C57.81 40.58 59.48 42.13 61.35 42.13C63.16 42.13 64.96 40.71 64.96 37.68C64.96 34.72 63.16 33.3 61.35 33.3C59.55 33.3 57.81 34.65 57.81 37.68Z" fill="#FF5B24"/><path d="M74.56 30.59V32.52C75.53 31.17 77.01 30.2 79.21 30.2C81.98 30.2 85.2 32.52 85.2 37.49C85.2 42.71 82.11 45.22 78.88 45.22C77.21 45.22 75.66 44.58 74.5 42.96V49.8H71.02V30.59H74.56ZM74.56 37.68C74.56 40.58 76.24 42.13 78.11 42.13C79.91 42.13 81.72 40.71 81.72 37.68C81.72 34.72 79.91 33.3 78.11 33.3C76.24 33.3 74.56 34.65 74.56 37.68Z" fill="#FF5B24"/><path d="M92.61 30.2C95.51 30.2 97.57 31.56 98.47 34.91L95.32 35.42C95.25 33.75 94.22 33.17 92.67 33.17C91.51 33.17 90.61 33.68 90.61 34.52C90.61 35.17 91.06 35.81 92.42 36.07L94.8 36.52C97.12 36.97 98.41 38.52 98.41 40.58C98.41 43.67 95.64 45.22 93 45.22C90.23 45.22 87.13 43.8 86.68 40.32L89.84 39.81C90.03 41.61 91.13 42.26 92.93 42.26C94.29 42.26 95.19 41.74 95.19 40.9C95.19 40.13 94.74 39.55 93.25 39.29L91.06 38.9C88.74 38.45 87.33 36.84 87.33 34.78C87.39 31.56 90.29 30.2 92.61 30.2Z" fill="#FF5B24"/></svg>`,
  visa: html`<svg class="payment-mark framed" part="payment-mark" viewBox="0 0 120 80" fill="none" role="img" aria-label="Visa"><rect width="120" height="80" rx="4" fill="white"/><path fill-rule="evenodd" clip-rule="evenodd" d="M86.67 44.94L90.32 35.06L92.38 44.94H86.67ZM100.95 52.84L95.81 27.16H88.74C86.35 27.16 85.77 29.08 85.77 29.08L76.19 52.84H82.89L84.23 49.02H92.39L93.15 52.84H100.95Z" fill="#1434CB"/><path fill-rule="evenodd" clip-rule="evenodd" d="M77.19 33.57L78.1 28.24C78.1 28.24 75.29 27.16 72.36 27.16C69.2 27.16 61.7 28.56 61.7 35.37C61.7 41.78 70.51 41.86 70.51 45.23C70.51 48.59 62.6 47.99 60 45.87L59.05 51.44C59.05 51.44 61.89 52.84 66.24 52.84C70.59 52.84 77.15 50.55 77.15 44.35C77.15 37.9 68.26 37.3 68.26 34.49C68.26 31.69 74.46 32.05 77.19 33.57Z" fill="#1434CB"/><path fill-rule="evenodd" clip-rule="evenodd" d="M54.65 52.84H47.62L52.01 27.16H59.05L54.65 52.84Z" fill="#1434CB"/><path fill-rule="evenodd" clip-rule="evenodd" d="M42.31 27.16L35.92 44.82L35.17 41.02L35.17 41.02L32.91 29.47C32.91 29.47 32.64 27.16 29.73 27.16H19.17L19.05 27.6C19.05 27.6 22.28 28.27 26.06 30.53L31.88 52.84H38.86L49.52 27.16H42.31Z" fill="#1434CB"/></svg>`,
  mastercard: html`<svg class="payment-mark framed" part="payment-mark" viewBox="0 0 120 80" fill="none" role="img" aria-label="Mastercard"><rect width="120" height="80" rx="4" fill="white"/><path fill-rule="evenodd" clip-rule="evenodd" d="M97.53 54.66V53.74H97.29L97.01 54.37L96.74 53.74H96.5V54.66H96.67V53.96L96.93 54.56H97.1L97.36 53.96V54.66H97.53ZM96.01 54.66V53.89H96.32V53.74H95.54V53.89H95.84V54.66H96.01Z" fill="#F79E1B"/><path fill-rule="evenodd" clip-rule="evenodd" d="M49.65 58.59H70.35V21.4H49.65V58.59Z" fill="#FF5F00"/><path fill-rule="evenodd" clip-rule="evenodd" d="M98.27 40C98.27 53.06 87.68 63.65 74.62 63.65C69.1 63.65 64.02 61.76 60 58.6C65.5 54.26 69.03 47.54 69.03 40C69.03 32.46 65.5 25.74 60 21.4C64.02 18.24 69.1 16.35 74.62 16.35C87.68 16.35 98.27 26.94 98.27 40Z" fill="#F79E1B"/><path fill-rule="evenodd" clip-rule="evenodd" d="M50.97 40C50.97 32.46 54.5 25.74 60 21.4C55.98 18.24 50.9 16.35 45.38 16.35C32.32 16.35 21.73 26.94 21.73 40C21.73 53.06 32.32 63.65 45.38 63.65C50.9 63.65 55.98 61.76 60 58.6C54.5 54.26 50.97 47.54 50.97 40Z" fill="#EB001B"/></svg>`,
  "apple-pay": html`<svg class="payment-mark" part="payment-mark" viewBox="0 0 120 80" fill="none" role="img" aria-label="Apple Pay"><g clip-path="url(#vio-pm-apple-pay)"><rect x="1.375" y="1.375" width="117.25" height="77.25" rx="6.625" fill="white"/><path d="M55.55 22.9C61.1 22.9 64.97 26.73 64.97 32.3C64.97 37.89 61.02 41.73 55.41 41.73H49.27V51.51H44.83V22.9L55.55 22.9ZM49.27 38.01H54.36C58.23 38.01 60.43 35.93 60.43 32.32C60.43 28.71 58.23 26.65 54.38 26.65H49.27V38.01Z" fill="black"/><path d="M66.13 45.58C66.13 41.93 68.92 39.69 73.88 39.42L79.59 39.08V37.47C79.59 35.15 78.02 33.77 75.4 33.77C72.93 33.77 71.38 34.96 71 36.82H66.96C67.2 33.05 70.41 30.28 75.56 30.28C80.62 30.28 83.85 32.95 83.85 37.14V51.51H79.74V48.08H79.65C78.44 50.4 75.8 51.86 73.06 51.86C68.98 51.86 66.13 49.33 66.13 45.58ZM79.59 43.7V42.05L74.45 42.37C71.9 42.55 70.45 43.68 70.45 45.46C70.45 47.28 71.95 48.47 74.25 48.47C77.25 48.47 79.59 46.41 79.59 43.7Z" fill="black"/><path d="M87.72 59.18V55.71C88.04 55.79 88.75 55.79 89.11 55.79C91.09 55.79 92.16 54.96 92.81 52.81C92.81 52.77 93.19 51.55 93.19 51.53L85.66 30.65H90.3L95.57 47.62H95.65L100.92 30.65H105.44L97.63 52.6C95.85 57.65 93.79 59.28 89.46 59.28C89.11 59.28 88.04 59.24 87.72 59.18Z" fill="black"/><path d="M31.74 25.7C32.81 24.36 33.53 22.56 33.34 20.72C31.77 20.8 29.86 21.76 28.76 23.1C27.76 24.24 26.88 26.12 27.11 27.88C28.87 28.03 30.63 27 31.74 25.7Z" fill="black"/><path d="M33.32 28.22C30.77 28.07 28.6 29.67 27.38 29.67C26.16 29.67 24.29 28.3 22.27 28.33C19.64 28.37 17.2 29.86 15.87 32.22C13.12 36.95 15.14 43.96 17.81 47.82C19.11 49.72 20.67 51.82 22.73 51.74C24.67 51.67 25.43 50.48 27.8 50.48C30.16 50.48 30.84 51.74 32.9 51.71C35.04 51.67 36.37 49.8 37.67 47.89C39.15 45.72 39.76 43.62 39.8 43.51C39.76 43.47 35.68 41.91 35.65 37.22C35.61 33.29 38.85 31.42 39 31.31C37.17 28.6 34.31 28.3 33.32 28.22Z" fill="black"/><rect x="1.375" y="1.375" width="117.25" height="77.25" rx="6.625" stroke="black" stroke-width="2.75"/></g><defs><clipPath id="vio-pm-apple-pay"><rect width="120" height="80" rx="4" fill="white"/></clipPath></defs></svg>`,
  "google-pay": html`<svg class="payment-mark framed" part="payment-mark" viewBox="0 0 120 80" fill="none" role="img" aria-label="Google Pay"><rect width="120" height="80" rx="4" fill="white"/><path d="M57.54 27V35.98H63.08C64.4 35.98 65.49 35.54 66.36 34.65C67.24 33.76 67.69 32.71 67.69 31.49C67.69 30.29 67.24 29.25 66.36 28.36C65.49 27.45 64.4 26.99 63.08 26.99H57.54V27ZM57.54 39.14V49.56H54.23V23.84H63.01C65.24 23.84 67.13 24.58 68.69 26.06C70.28 27.55 71.07 29.36 71.07 31.49C71.07 33.67 70.28 35.49 68.69 36.95C67.16 38.41 65.26 39.14 63.01 39.14H57.54V39.14ZM74.41 44.17C74.41 45.03 74.78 45.75 75.51 46.33C76.24 46.9 77.1 47.19 78.08 47.19C79.47 47.19 80.71 46.67 81.8 45.65C82.9 44.61 83.44 43.4 83.44 42.02C82.41 41.2 80.97 40.8 79.12 40.8C77.78 40.8 76.66 41.12 75.76 41.77C74.86 42.41 74.41 43.21 74.41 44.17ZM78.69 31.38C81.14 31.38 83.07 32.03 84.49 33.34C85.9 34.64 86.61 36.44 86.61 38.71V49.56H83.44V47.12H83.3C81.93 49.13 80.11 50.14 77.83 50.14C75.89 50.14 74.26 49.56 72.96 48.41C71.65 47.26 71 45.82 71 44.1C71 42.28 71.69 40.83 73.06 39.75C74.44 38.67 76.28 38.14 78.59 38.14C80.55 38.14 82.17 38.49 83.44 39.21V38.46C83.44 37.31 82.98 36.33 82.07 35.53C81.2 34.74 80.05 34.31 78.87 34.33C77.02 34.33 75.56 35.1 74.48 36.66L71.57 34.83C73.18 32.53 75.55 31.38 78.69 31.38ZM104.77 31.96L93.73 57.32H90.31L94.41 48.45L87.15 31.96H90.74L96 44.6H96.07L101.17 31.95L104.77 31.96Z" fill="#3C4043"/><path d="M44.17 36.89C44.17 35.85 44.08 34.85 43.92 33.89H29.96V39.58H37.95C37.62 41.42 36.56 43.04 35 44.08V47.77H39.77C42.56 45.2 44.17 41.39 44.17 36.89Z" fill="#4285F4"/><path d="M29.96 51.34C33.96 51.34 37.32 50.03 39.77 47.77L35 44.08C33.67 44.97 31.96 45.49 29.96 45.49C26.1 45.49 22.82 42.89 21.65 39.39H16.74V43.2C19.25 48.19 24.37 51.34 29.96 51.34" fill="#34A853"/><path d="M21.65 39.39C21.04 37.55 21.04 35.56 21.65 33.73V29.92H16.74C15.7 31.98 15.16 34.25 15.16 36.56C15.16 38.94 15.73 41.2 16.74 43.19L21.65 39.39V39.39Z" fill="#FABB05"/><path d="M29.96 27.63C32.14 27.63 34.1 28.37 35.64 29.84V29.85L39.86 25.63C37.3 23.24 33.96 21.78 29.96 21.78C24.37 21.78 19.26 24.93 16.74 29.92L21.66 33.73C22.83 30.23 26.1 27.63 29.96 27.63" fill="#E94235"/></svg>`,
}

/** Kustom's wordmark, from its badge: the letters alone, in the strip's own colour. */
const KUSTOM_WORDMARK = html`<svg class="payment-marks-provider" part="payment-marks-provider" viewBox="173 176 2018 334" fill="currentColor" role="img" aria-label="Kustom"><path d="M752.76,401.11c-.36,8.91-7.87,15.85-16.77,15.49-8.41-.34-15.15-7.08-15.48-15.49v-141.5h-130.13v158.92c0,60.08,32.81,91.07,87.1,91.07,36.59,0,63.86-12.82,78.93-32.66v24.89h126.56v-242.22h-130.11v141.5h-.09Z"/><path d="M1023.01,333.75c0-7.77,5.51-11.15,14.98-11.15s17.01,6.29,17.01,18.91h113.09c0-36.82-22.01-90.1-135.49-90.1-79.98,0-130.49,30.99-130.49,79.92,0,101.75,147.1,63.46,147.1,95.93,0,7.26-6.01,11.15-15.46,11.15-10.98,0-18.04-7.77-18.04-19.38h-116.12c1.52,61.05,55.01,90.6,134.98,90.6,69.49,0,141-15.49,141-82.83,0-93.98-152.61-60.55-152.61-93.01l.04-.03Z"/><path d="M491.92,348.78l84.05-93.52-104-78.49-91.2,109.52v-96.43h-133.24v94.49h-73.8v116.78h73.8v100.78h133.24v-95.46c33.82,27.15,52.76,58.64,59.94,95.46h145c-11.26-59.09-42.01-109.98-93.76-153.09l-.04-.04Z"/><path d="M1345.23,201h-130.69v58.64h-37.43v81.87h37.43v65.4c0,63.96,37.42,94.96,113.24,94.96h68.18v-97.87h-37.93c-6.7.37-12.43-4.76-12.8-11.46-.02-.37-.02-.75-.01-1.12v-49.9h50.74v-81.87h-50.77v-58.64h.04Z"/><path d="M1565.04,403.26c-12.34.12-22.44-9.79-22.56-22.13,0-.3,0-.6,0-.89-.02-12.32,9.95-22.32,22.27-22.34,12.32-.02,22.32,9.96,22.33,22.28v.06c.26,12.45-9.61,22.75-22.05,23.03M1564.53,251.37c-90.2,0-153.19,52.31-153.19,128.38s60.45,129.83,152.69,129.83,153.73-52.31,153.73-129.83-61.99-128.38-153.19-128.38h-.04Z"/><path d="M2096.91,251.37c-29.66,0-61.81,7.53-79.43,36.19-14.43-23.69-38.71-36.19-68.64-36.19-36.18,0-64.14,11.61-82.5,40v-31.77h-127.07v242.26h129.13v-133.71c.66-8.91,8.41-15.6,17.32-14.94,7.99.59,14.35,6.95,14.94,14.94v133.71h128.11v-133.71c.62-8.91,8.34-15.63,17.25-15.02,8.05.56,14.45,6.97,15.01,15.02v133.71h129.63v-160.35c0-53.79-37.93-90.1-93.76-90.1v-.05Z"/></svg>`
// </generated:art>

/**
 * The strip for a brand whose ways to pay are `available`, or nothing when
 * it has none to show (see `paymentMarksFor`). It goes under the buy buttons
 * of the product detail and of the cart.
 */
export function renderPaymentMarks(available: ReadonlyArray<string> | null | undefined): TemplateResult | '' {
  const marks = paymentMarksFor(available)
  if (marks.length === 0) return ''
  return html`<div class="payment-marks" part="payment-marks" role="group" aria-label=${PAYMENT_MARKS_LABEL}>
    <ul class="payment-marks-list">
      ${marks.map((mark) => html`<li data-mark=${mark}>${MARK_ART[mark]}</li>`)}
    </ul>
    ${KUSTOM_WORDMARK}
  </div>`
}

/** Styles of the strip; add to the component's own. */
export const paymentMarksStyles = css`
  .payment-marks {
    display: var(--vio-payment-marks-display, flex);
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin: 14px 0 6px;
    color: var(--vio-payment-marks-color, #161616);
  }
  .payment-marks-list {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .payment-marks-list li {
    display: block;
    margin: 0;
    padding: 0;
    line-height: 0;
  }
  .payment-mark {
    display: block;
    height: var(--vio-payment-mark-height, 24px);
    width: auto;
    aspect-ratio: 3 / 2;
    border-radius: 4px;
  }
  /* A white logo on a white page: a hairline says where it ends. */
  .payment-mark.framed {
    outline: 1px solid var(--vio-payment-mark-border, rgba(0, 0, 0, 0.14));
    outline-offset: -1px;
  }
  .payment-marks-provider {
    display: block;
    height: 14px;
    width: auto;
    aspect-ratio: 2018 / 334;
  }
`
