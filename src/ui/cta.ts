/**
 * Button tracking for the SDK's elements: a tap on a button marked
 * `data-vio-cta="<id>"` dispatches `vio:cta-click` (bubbles, composed) from
 * the element — the host can mirror it to its own analytics — and
 * `Vio.analytics` turns it into `cta_click` (core/analytics/cta.ts).
 *
 * One listener per element, on its shadow root in the CAPTURE phase: it runs
 * before the button's own handler (before any navigation), once per tap — the
 * innermost marked element wins — and it never stops or delays the action.
 *
 * Marks on a button:
 * - `data-vio-cta`        the id (`add_to_cart`)
 * - `data-vio-cta-label`  the label to send instead of the visible text (`""` = none)
 * - `data-vio-cta-option` the option value chosen (`size`)
 * A `<summary>` counts only when it opens its `<details>`.
 */

import { ctaText, type CtaClickDetail, type CtaInput, type CtaLocation } from '../core/analytics/cta.js'

/** What an element adds to every tap: product, sponsor, attribution, layout. `null` = do not report this tap. */
export type CtaContextFn = (cta: string, button: Element | null) => Partial<CtaInput> | null

/** The visible text of a button: its own label mark, else `aria-label`, else its text. */
function labelOf(button: Element): string | undefined {
  if (button.hasAttribute('data-vio-cta-label')) return ctaText(button.getAttribute('data-vio-cta-label'))
  return ctaText(button.getAttribute('aria-label')) ?? ctaText(button.textContent)
}

/**
 * Dispatch `vio:cta-click` from `host` for button `cta` — what a marked tap
 * does, for the taps that are no click (a swipe, a key on a card). Never throws.
 */
export function emitCta(
  host: HTMLElement,
  location: CtaLocation,
  cta: string,
  contextOf: CtaContextFn,
  extra: Partial<CtaInput> = {},
  button: Element | null = null,
): void {
  try {
    const context = contextOf(cta, button)
    if (context === null) return
    const detail: CtaClickDetail = { ...context, ...stripUndefined(extra), cta, location }
    host.dispatchEvent(new CustomEvent<CtaClickDetail>('vio:cta-click', { bubbles: true, composed: true, detail }))
  } catch {
    /* tracking never breaks a tap */
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

/**
 * Report the taps on the marked buttons of `host`'s shadow root. Call after
 * `super.connectedCallback()` (the shadow root exists then); returns the
 * function that stops it (for `disconnectedCallback`).
 */
export function trackCtaClicks(
  host: HTMLElement & { renderRoot?: Element | DocumentFragment },
  location: CtaLocation,
  contextOf: CtaContextFn,
): () => void {
  const root = host.renderRoot ?? host.shadowRoot
  if (!root || typeof root.addEventListener !== 'function') return () => {}
  const onClick = (ev: Event) => {
    try {
      const button = markedButton(ev, root)
      if (!button) return
      const cta = button.getAttribute('data-vio-cta') ?? ''
      // A summary reports the opening of its fold, not the closing.
      if (button.tagName === 'SUMMARY' && (button.parentElement as HTMLDetailsElement | null)?.open) return
      const option = button.getAttribute('data-vio-cta-option')
      emitCta(
        host,
        location,
        cta,
        contextOf,
        { label: labelOf(button), ...(option !== null ? { optionValue: option } : {}) },
        button,
      )
    } catch {
      /* tracking never breaks a tap */
    }
  }
  root.addEventListener('click', onClick, { capture: true })
  return () => root.removeEventListener('click', onClick, { capture: true })
}

/** The innermost element of this shadow root on the tap's path that carries `data-vio-cta`. */
function markedButton(ev: Event, root: Element | DocumentFragment): Element | null {
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : []
  for (const node of path) {
    if (node === root) break
    if (!(node instanceof Element)) continue
    if (node.getRootNode() !== root) continue
    if (node.hasAttribute('data-vio-cta')) return node
  }
  return null
}
