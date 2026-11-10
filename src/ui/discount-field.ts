/**
 * The «Rabattkode» field of the cart and of the checkout's summary: where the
 * shopper types the brand's discount code, sees it applied, and takes it off.
 * Shown wherever discount codes are on for the page (`discountFieldEnabled`);
 * `Vio.init({ discountField: false })` hides it.
 *
 * One state for whoever puts a code on the cart: the field's own «Bruk» and
 * the page's own code (`discountCode`, `?vio_discount=`) go through the same
 * call, so a code being applied by the page shows as being checked here too.
 *
 * - empty: an input and «Bruk»;
 * - checking: Commerce asks the brand's shop, one to three seconds — the
 *   field waits («Sjekker…»), nothing else in the cart does, and a second
 *   tap sends nothing;
 * - applied: the code, and «Fjern»;
 * - refused: the field again, with why (`couponReasonText`).
 *
 * A code the PAGE asked for and Commerce refused says nothing here: the
 * shopper typed nothing.
 */
import { css, html, nothing } from 'lit'
import { Vio } from '../core/client.js'
import { Configuration } from '../core/configuration.js'
import { DISCOUNT_CODE_MAX_LENGTH, rememberedDiscountCode } from '../core/cart/discount-code.js'
import { DISCOUNT_TEXT, couponReasonText } from './discount-texts.js'

/**
 * Whether the field is drawn. The page says (`discountField: true` /
 * `false`); when it does not, the field shows wherever the page has a
 * discount code of its own — `discountCode` in its config, or the
 * `?vio_discount=` its link carried — because codes are on there. A page
 * with neither is the one it always was: no field.
 */
export function discountFieldEnabled(): boolean {
  try {
    if (!Configuration.isInitialized) return false
    const config = Configuration.get()
    if (typeof config.discountField === 'boolean') return config.discountField
    return !!(config.discountCode ?? rememberedDiscountCode())
  } catch {
    return false
  }
}

export interface DiscountFieldOptions {
  /** The element the field is drawn in: asked to draw again when the field's state changes. */
  host: { requestUpdate: () => void }
  /** The sponsors whose carts the field is about: every cart in the drawer, the checkout's one. */
  sponsorIds: () => number[]
  /** `true` when the host already redraws on every cart change (the cart drawer). */
  followsCart?: boolean
}

export class DiscountField {
  /** What the shopper has typed. */
  private value = ''
  /** Why the last code was refused (or could not be taken off), until the next keystroke or attempt. */
  private error: string | null = null
  /** This field's own call is in flight (before the cart says so). */
  private working: 'applying' | 'removing' | null = null

  constructor(private readonly opts: DiscountFieldOptions) {}

  /** Follow the cart: a code going on or coming off (here, in the other field, or by the page itself) redraws the field. */
  connect(): void {
    if (this.opts.followsCart) return
    Vio.cart.addEventListener('change', this.onCartChange)
  }

  disconnect(): void {
    Vio.cart.removeEventListener('change', this.onCartChange)
  }

  private onCartChange = (): void => {
    if (discountFieldEnabled()) this.opts.host.requestUpdate()
  }

  /** The code the carts this field is about carry (the first one that does). */
  private appliedCode(sponsorIds: number[]): string | undefined {
    for (const id of sponsorIds) {
      const code = Vio.cart.discountCodeForSponsor(id)
      if (code) return code
    }
    return undefined
  }

  /** A code is being put on one of these carts, or taken off it, right now — by this field or by anyone else. */
  private busy(sponsorIds: number[]): { kind: 'applying' | 'removing'; code?: string } | undefined {
    for (const id of sponsorIds) {
      const call = Vio.cart.discountBusy(id)
      if (call) return call
    }
    return this.working ? { kind: this.working } : undefined
  }

  private redraw(): void {
    this.opts.host.requestUpdate()
  }

  private onInput = (e: Event): void => {
    this.value = (e.target as HTMLInputElement).value
    if (this.error) this.error = null
    this.redraw()
  }

  private onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault()
    const sponsorIds = this.opts.sponsorIds()
    const code = this.value.trim()
    // Nothing typed, or a code is already being checked: a second tap sends nothing.
    if (!code || sponsorIds.length === 0 || this.busy(sponsorIds)) return
    this.working = 'applying'
    this.error = null
    this.redraw()
    try {
      let applied = false
      let refusal: string | null = null
      for (const id of sponsorIds) {
        const result = await Vio.cart.applyDiscountCode(code, id)
        if (result.status === 'applied') applied = true
        else if (result.status === 'refused') refusal ??= couponReasonText(result.reason)
        else refusal ??= DISCOUNT_TEXT.couponUnavailable
      }
      if (applied) this.value = ''
      else this.error = refusal ?? DISCOUNT_TEXT.couponRefused
    } catch {
      this.error = DISCOUNT_TEXT.couponUnavailable
    } finally {
      this.working = null
      this.redraw()
    }
  }

  private onRemove = async (): Promise<void> => {
    const sponsorIds = this.opts.sponsorIds()
    if (sponsorIds.length === 0 || this.busy(sponsorIds)) return
    this.working = 'removing'
    this.error = null
    this.redraw()
    try {
      let failed = false
      for (const id of sponsorIds) {
        if (!Vio.cart.discountCodeForSponsor(id)) continue
        const result = await Vio.cart.removeDiscountCode(id)
        if (!result.removed && result.carts.length > 0) failed = true
      }
      if (failed) this.error = DISCOUNT_TEXT.fieldRemoveFailed
    } catch {
      this.error = DISCOUNT_TEXT.fieldRemoveFailed
    } finally {
      this.working = null
      this.redraw()
    }
  }

  /** The field, or nothing where discount codes are not on (or there is no cart to put a code on). */
  render() {
    if (!discountFieldEnabled()) return nothing
    const sponsorIds = this.opts.sponsorIds()
    if (sponsorIds.length === 0) return nothing
    const busy = this.busy(sponsorIds)
    const applied = this.appliedCode(sponsorIds)
    const error = this.error ? html`<p class="discount-error" part="discount-error" role="alert">${this.error}</p>` : nothing

    if (applied && busy?.kind !== 'applying') {
      const removing = busy?.kind === 'removing'
      return html`
        <div class="discount-field is-applied" part="discount-field">
          <span class="discount-applied">
            <span class="discount-label">${DISCOUNT_TEXT.fieldLabel}</span>
            <span class="discount-code" part="discount-code">${applied}</span>
          </span>
          <button
            type="button"
            class="discount-remove"
            part="discount-remove"
            data-vio-cta="discount_remove"
            data-vio-cta-label=${DISCOUNT_TEXT.fieldRemove}
            aria-label=${DISCOUNT_TEXT.fieldRemoveLabel}
            ?disabled=${removing}
            @click=${this.onRemove}
          >
            ${removing ? DISCOUNT_TEXT.fieldRemoving : DISCOUNT_TEXT.fieldRemove}
          </button>
        </div>
        ${error}
      `
    }

    const applying = busy?.kind === 'applying'
    // A code the page itself is putting on the cart shows as the one being checked.
    const shown = applying && !this.value ? (busy?.code ?? '') : this.value
    return html`
      <form class="discount-field" part="discount-field" novalidate @submit=${this.onSubmit}>
        <label class="vh" for="vio-discount-code">${DISCOUNT_TEXT.fieldLabel}</label>
        <input
          id="vio-discount-code"
          class="discount-input"
          part="discount-input"
          type="text"
          name="vio-discount-code"
          placeholder=${DISCOUNT_TEXT.fieldLabel}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          maxlength=${DISCOUNT_CODE_MAX_LENGTH}
          .value=${shown}
          ?disabled=${applying}
          aria-invalid=${this.error ? 'true' : 'false'}
          @input=${this.onInput}
        />
        <button
          type="submit"
          class="discount-apply"
          part="discount-apply"
          data-vio-cta="discount_apply"
          ?disabled=${applying || !this.value.trim()}
          aria-busy=${applying ? 'true' : 'false'}
        >
          ${applying ? DISCOUNT_TEXT.fieldApplying : DISCOUNT_TEXT.fieldApply}
        </button>
      </form>
      ${error}
    `
  }
}

/** The field's styles; add to the component's own (with `discountStyles`, for `.vh`). */
export const discountFieldStyles = css`
  .discount-field {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 var(--vio-space-md, 16px);
  }
  .discount-input {
    flex: 1;
    min-width: 0;
    height: 40px;
    box-sizing: border-box;
    padding: 0 12px;
    border: 1px solid var(--vio-color-border, #e5e5e5);
    border-radius: var(--vio-radius-md, 4px);
    background: var(--vio-color-surface, #fff);
    color: inherit;
    font-family: inherit;
    /* 16px: a phone does not zoom into the field. */
    font-size: 16px;
    outline: none;
  }
  .discount-input:focus { border-color: var(--vio-color-text, #0a0a0a); }
  .discount-input[aria-invalid='true'] { border-color: var(--vio-color-accent, #c14a3b); }
  .discount-input:disabled { opacity: 0.6; }
  .discount-apply,
  .discount-remove {
    height: 40px;
    padding: 0 16px;
    border: 1px solid var(--vio-color-text, #0a0a0a);
    border-radius: var(--vio-radius-md, 4px);
    background: transparent;
    color: var(--vio-color-text, #0a0a0a);
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .discount-apply:disabled,
  .discount-remove:disabled { opacity: 0.45; cursor: not-allowed; }
  .discount-field.is-applied { justify-content: space-between; }
  .discount-applied { display: flex; flex-direction: column; min-width: 0; font-size: 14px; }
  .discount-label { font-size: 12px; color: var(--vio-color-text-secondary, #666); }
  .discount-code { font-weight: 600; overflow-wrap: anywhere; }
  .discount-error {
    margin: calc(var(--vio-space-md, 16px) * -0.5) 0 var(--vio-space-md, 16px);
    font-size: 12px;
    line-height: 1.35;
    color: var(--vio-color-accent, #c14a3b);
  }
`
