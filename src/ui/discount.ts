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
