/**
 * The hand-over to a payment page (Vipps today) — what the shopper sees
 * between the tap and the provider, and what the host hears.
 *
 * The detail, the cart and the checkout close or wait while the SDK asks the
 * backend for the provider's URL; on a phone that used to be an empty
 * moment, and a second tap could start a second payment (Mote & Livsstil,
 * 2026-10-22). Now, at the tap:
 *
 *  - `vio:payment-redirect-start` — `{ method, sponsorId, source }`, on
 *    `document`, **cancelable**: a host that calls `preventDefault()` draws
 *    its own loader and the SDK draws none.
 *  - otherwise the SDK's overlay: full screen, «Åpner Vipps …», a soft fade,
 *    and it takes every tap (no double start). Styled with
 *    `--vio-redirect-bg`, `--vio-redirect-color`, `--vio-redirect-spinner`
 *    and `--vio-redirect-font`; class `vio-redirect-overlay`.
 *
 * Then exactly one of:
 *  - the page leaves for the provider — the overlay stays until it does;
 *  - `vio:payment-redirect-error` — `{ method, sponsorId, source, reason }`:
 *    the payment could not start; the overlay goes and the caller shows a
 *    usable view (the checkout with the method preselected);
 *  - `vio:payment-redirect-cancel` — `{ method, sponsorId, source, reason }`:
 *    the caller stopped without an error (`'not-started'`, e.g. Express off
 *    for that seller, so the checkout opens instead), or the shopper came
 *    back from the provider with the browser's back button (`'back'`; the
 *    page is restored from the back-forward cache with the overlay still
 *    on). A return through the provider's own cancel is the checkout's
 *    (`returnCancelled`, below).
 */

export type PaymentRedirectSource = 'detail' | 'cart' | 'checkout'

export interface PaymentRedirectDetail {
  method: string
  sponsorId?: number
  source: PaymentRedirectSource
}

export interface PaymentRedirectHandle {
  /** The payment could not start: error event, overlay removed. */
  fail(reason: string): void
  /** Stopped on purpose (another way in follows): cancel event, overlay removed. */
  abort(reason?: string): void
}

const OVERLAY_CLASS = 'vio-redirect-overlay'
const STYLE_ID = 'vio-redirect-overlay-style'

const LABEL: Record<string, string> = { vipps: 'Vipps', stripe: 'Stripe', klarna: 'Klarna' }

function emit(name: string, detail: object, cancelable = false): boolean {
  if (typeof document === 'undefined') return true
  return document.dispatchEvent(new CustomEvent(name, { detail, cancelable }))
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.${OVERLAY_CLASS} {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
  background: var(--vio-redirect-bg, rgba(255, 255, 255, 0.94));
  color: var(--vio-redirect-color, var(--vio-color-text, #0a0a0a));
  font: 600 16px/1.3 var(--vio-redirect-font, var(--vio-font-sans, -apple-system, sans-serif));
  opacity: 0; transition: opacity 0.18s ease; cursor: progress;
}
.${OVERLAY_CLASS}.is-shown { opacity: 1; }
.${OVERLAY_CLASS} .vio-redirect-spinner {
  width: 36px; height: 36px; border-radius: 50%;
  border: 3px solid rgba(0, 0, 0, 0.1); border-top-color: var(--vio-redirect-spinner, #ff5b24);
  animation: vio-redirect-spin 0.8s linear infinite;
}
@keyframes vio-redirect-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .${OVERLAY_CLASS} { transition: none; }
  .${OVERLAY_CLASS} .vio-redirect-spinner { animation: none; }
}`
  document.head.appendChild(style)
}

let current: { el: HTMLElement | null; detail: PaymentRedirectDetail; settled: boolean } | null = null

function removeOverlay(): void {
  const el = current?.el
  if (!el) return
  el.classList.remove('is-shown')
  setTimeout(() => el.remove(), 200)
  current!.el = null
}

/** Back from the provider with the browser's back button: the page comes back from the bfcache as it was left. */
function onPageShow(e: PageTransitionEvent): void {
  if (!e.persisted || !current || current.settled) return
  current.settled = true
  removeOverlay()
  emit('vio:payment-redirect-cancel', { ...current.detail, reason: 'back' })
  current = null
}

/**
 * The tap that will leave for a payment page. Emits the start event and,
 * unless the host took over, shows the overlay. Call `fail` or `abort` on the
 * handle when the page is not going to leave after all; leaving needs nothing.
 */
export function beginPaymentRedirect(detail: PaymentRedirectDetail): PaymentRedirectHandle {
  if (current && !current.settled) {
    // A second hand-over replaces the first (the first is over: same page, one payment).
    current.settled = true
    removeOverlay()
  }
  const hostTookOver = !emit('vio:payment-redirect-start', detail, true)
  const state = { el: null as HTMLElement | null, detail, settled: false }
  current = state
  if (!hostTookOver && typeof document !== 'undefined' && document.body) {
    injectStyle()
    const el = document.createElement('div')
    el.className = OVERLAY_CLASS
    el.setAttribute('role', 'status')
    el.setAttribute('aria-live', 'polite')
    const spinner = document.createElement('div')
    spinner.className = 'vio-redirect-spinner'
    spinner.setAttribute('aria-hidden', 'true')
    const text = document.createElement('div')
    text.className = 'vio-redirect-text'
    text.textContent = `Åpner ${LABEL[detail.method] ?? detail.method} …`
    el.append(spinner, text)
    // Every tap lands here and goes nowhere: no second payment.
    el.addEventListener('click', (e) => e.stopPropagation())
    document.body.appendChild(el)
    requestAnimationFrame(() => el.classList.add('is-shown'))
    state.el = el
  }
  if (typeof window !== 'undefined') window.addEventListener('pageshow', onPageShow)
  const settle = (event: string, reason: string) => {
    if (state.settled) return
    state.settled = true
    if (current === state) {
      removeOverlay()
      current = null
    } else if (state.el) {
      state.el.remove()
    }
    emit(event, { ...detail, reason })
  }
  return {
    fail: (reason) => settle('vio:payment-redirect-error', reason),
    abort: (reason = 'not-started') => settle('vio:payment-redirect-cancel', reason),
  }
}

/** The shopper came back through the provider's own cancel (the checkout's return path). */
export function returnCancelled(detail: PaymentRedirectDetail & { checkoutId?: string }): void {
  emit('vio:payment-redirect-cancel', { ...detail, reason: 'cancelled' })
}
