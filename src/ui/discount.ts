/**
 * How a discount code shows in the cart, the checkout's summary and the
 * receipt — shared, so the three say the same thing the same way:
 *
 * - a line the code takes something off: its list price struck through, then
 *   what it costs — «Gratis» when the code gives it away;
 * - a «Rabatt» row with what the code takes off, between «Sum» (the list
 *   prices) and «Totalt» (what is paid), so the rows add up.
 *
 * A line without a discount is printed exactly as before.
 */
import { css, html } from 'lit'
import { formatPrice } from '../core/types.js'
import { isGiftLine, lineDiscount, lineListTotal, lineNetTotal } from '../core/cart/discount.js'
import { DISCOUNT_TEXT, discountRowLabel } from './discount-texts.js'

/** The part of a line its price is drawn from. */
export interface PricedLine {
  unitPrice: number
  quantity: number
  discount?: number
  currency?: string
}

/**
 * The price of a line. Without a discount: `unitPrice × quantity`, as it
 * always was (a plain string). With one: the list price struck through (said
 * «Ordinær pris …» to a screen reader) and what the line costs — «Gratis»
 * for a gift.
 */
export function renderLinePrice(line: PricedLine, fallbackCurrency?: string) {
  const currency = line.currency || fallbackCurrency
  if (!(lineDiscount(line) > 0)) return formatPrice(line.unitPrice * line.quantity, currency)
  const list = formatPrice(lineListTotal(line), currency)
  const net = isGiftLine(line) ? DISCOUNT_TEXT.free : formatPrice(lineNetTotal(line), currency)
  return html`<span class="list-price" part="line-list-price"><span class="vh">${DISCOUNT_TEXT.listPrice} </span><s>${list}</s></span>
    <span class="net-price" part="line-net-price">${net}</span>`
}

/** What a «Rabatt» row says: its label (with the code, when known) and its amount, as a minus. */
export function discountRow(amount: number, currency?: string, code?: string | null): { label: string; value: string } {
  return { label: discountRowLabel(code), value: `−${formatPrice(amount, currency)}` }
}

/**
 * With a discount code on the cart, only the ways to pay that take discounts
 * can pay (Vipps, for now). Commerce works out the discounted amount for
 * those; the others work theirs out of the list prices, so they would show —
 * and charge — a total Commerce did not. Their buttons stay where they are,
 * off (`?disabled` + `data-discount-off`, styled by `vippsOnlyStyles`), with
 * a note under them; when the code comes off they are back. A method name is
 * the backend's (`Vipps`, `Apple Pay`) or the SDK's (`vipps`, `apple-pay`):
 * letters only, any case.
 */
export function isVippsMethod(method: string | null | undefined): boolean {
  return methodLetters(method) === 'vipps'
}

function methodLetters(method: unknown): string {
  return String(method ?? '').toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * A cart carries a discount code: its own (shown), or its campaign's
 * (`discountSource: 'CAMPAIGN'` — never shown, nor known to the page).
 */
export function cartCarriesDiscount(cart: { discountCode?: string; discountSource?: string } | null | undefined): boolean {
  return !!cart && (!!cart.discountCode || cart.discountSource === 'CAMPAIGN')
}

/** A way to pay as Commerce offers it (`Vio.checkout.getAvailablePaymentMethods`): its name and its config. */
export interface OfferedMethod {
  name?: string | null
  config?: ReadonlyArray<{ name?: string | null; value?: unknown } | null> | null
}

/**
 * Whether a way to pay takes a discount code: what its own config says
 * (`discounts`: `true` / `false`, as Commerce offers it); for a method whose
 * config does not say — or before the list is known — Vipps does and the
 * others do not.
 */
export function methodTakesDiscounts(method: string | null | undefined, offered?: ReadonlyArray<OfferedMethod> | null): boolean {
  const id = methodLetters(method)
  const found = Array.isArray(offered) ? offered.find((m) => methodLetters(m?.name) === id) : undefined
  const configs: NonNullable<OfferedMethod['config']> = Array.isArray(found?.config) ? found!.config! : []
  const flag = configs.find((c) => c?.name === 'discounts')?.value
  if (flag === true || flag === 'true') return true
  if (flag === false || flag === 'false') return false
  return isVippsMethod(method)
}

/** The note under the ways to pay that a discount code turned off. */
export function renderVippsOnlyNote() {
  return html`<p class="vipps-only-note" part="vipps-only-note" role="note">${DISCOUNT_TEXT.vippsOnly}</p>`
}

/**
 * None of the ways to pay on offer takes the discount on the cart: instead
 * of a row of buttons that are all off, it says so and offers «Fjern» — the
 * discount comes off and every way to pay is back. `failed`: the last
 * attempt to take it off did not.
 */
export function renderDiscountDeadEnd(opts: { removing: boolean; failed?: boolean; onRemove: () => void }) {
  return html`<div class="discount-dead-end" part="discount-dead-end" role="note">
    <p class="vipps-only-note">${DISCOUNT_TEXT.noDiscountMethod}</p>
    <button
      type="button"
      class="discount-dead-end-remove"
      part="discount-dead-end-remove"
      data-vio-cta="discount_remove"
      data-vio-cta-label=${DISCOUNT_TEXT.fieldRemove}
      aria-label=${DISCOUNT_TEXT.discountRemoveLabel}
      ?disabled=${opts.removing}
      @click=${opts.onRemove}
    >
      ${opts.removing ? DISCOUNT_TEXT.fieldRemoving : DISCOUNT_TEXT.fieldRemove}
    </button>
    ${opts.failed ? html`<p class="discount-error" role="alert">${DISCOUNT_TEXT.fieldRemoveFailed}</p>` : ''}
  </div>`
}

/** A way to pay a discount code turned off, and its note; add to the component's styles. */
export const vippsOnlyStyles = css`
  [data-discount-off] {
    opacity: 0.4 !important;
    cursor: not-allowed !important;
    filter: grayscale(1);
  }
  .vipps-only-note {
    margin: 8px 0;
    font-size: 13px;
    line-height: 1.35;
    color: var(--vio-color-text-secondary, #666);
    text-align: center;
  }
  .discount-dead-end {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    margin: 8px 0;
  }
  .discount-dead-end-remove {
    height: 40px;
    padding: 0 16px;
    border: 1px solid var(--vio-color-text, #0a0a0a);
    border-radius: var(--vio-radius-md, 4px);
    background: transparent;
    color: var(--vio-color-text, #0a0a0a);
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .discount-dead-end-remove:disabled { opacity: 0.45; cursor: not-allowed; }
  .discount-dead-end .discount-error {
    margin: 0;
    font-size: 12px;
    color: var(--vio-color-accent, #c14a3b);
  }
`

/** Styles of the pieces above; add to the component's own. */
export const discountStyles = css`
  .list-price {
    margin-right: 6px;
    font-weight: 400;
    color: var(--vio-color-text-tertiary, #999);
    white-space: nowrap;
  }
  .list-price s { text-decoration: line-through; }
  .net-price { white-space: nowrap; }
  /* Read out, not shown. */
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
`
