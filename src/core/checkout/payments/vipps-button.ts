/**
 * Vipps MobilePay's own button, the way the design guidelines ask for it.
 *
 * Vipps publishes a web component (`<vipps-mobilepay-button>`) that draws
 * the on-brand button and nothing else: it does not start the payment, we
 * do, on its click. Using it means no logo of ours to keep in step with the
 * brand rules (ePayment checklist, "Follow the design guidelines",
 * 2026-10-06). The script is loaded once, on demand, from Vipps' CDN; when
 * it does not arrive in time — blocked, offline — callers draw the plain
 * orange button they always had.
 */
export const VIPPS_BUTTON_SCRIPT = 'https://cdn.vippsmobilepay.com/js/button/button.js'
export const VIPPS_BUTTON_TAG = 'vipps-mobilepay-button'

let pending: Promise<boolean> | null = null

/**
 * Resolves true once Vipps' button element is defined, false when its script
 * failed to load (or, with `timeoutMs`, did not answer in time). Callers draw
 * their own button meanwhile and swap it for Vipps' when this resolves — the
 * CDN takes a few seconds on a slow line, and nobody should wait for it.
 */
export function ensureVippsButton(timeoutMs = 0): Promise<boolean> {
  if (typeof document === 'undefined' || typeof customElements === 'undefined') {
    return Promise.resolve(false)
  }
  if (customElements.get(VIPPS_BUTTON_TAG)) return Promise.resolve(true)
  if (!pending) {
    pending = new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(ok)
      }
      const timer = timeoutMs > 0 ? setTimeout(() => done(false), timeoutMs) : undefined
      customElements.whenDefined(VIPPS_BUTTON_TAG).then(
        () => done(true),
        () => done(false),
      )
      if (!document.querySelector(`script[src="${VIPPS_BUTTON_SCRIPT}"]`)) {
        const script = document.createElement('script')
        script.async = true
        script.src = VIPPS_BUTTON_SCRIPT
        script.onerror = () => done(false)
        document.head.appendChild(script)
      }
    })
    // A load that failed is not remembered: the next caller tries again.
    void pending.then((ok) => {
      if (!ok) pending = null
    })
  }
  return pending
}

/** The attributes of the official button as Vio uses it (React hosts spread these). */
export function vippsButtonAttributes(
  verb: 'buy' | 'pay' | 'express' | 'continue' = 'buy',
  opts: { stretched?: boolean; compact?: boolean; language?: string } = {},
): Record<string, string> {
  return {
    brand: 'vipps',
    language: opts.language ?? 'no',
    verb,
    variant: 'primary',
    rounded: 'true',
    stretched: opts.stretched === false ? 'false' : 'true',
    ...(opts.compact ? { compact: 'true' } : {}),
  }
}
