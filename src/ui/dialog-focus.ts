/**
 * Keyboard and focus for the SDK's dialogs — <vio-product-detail>, <vio-cart>
 * and <vio-checkout>.
 *
 * Each renders a `role="dialog"` with a close button, and until 2026-10-09
 * nothing managed focus: a keyboard user pressed Enter on a product card, the
 * detail opened, and focus stayed on the page behind — Tab never entered the
 * dialog, Escape did nothing. A QA tester could not complete a purchase by
 * keyboard.
 *
 * One instance per component, driven from its `updated()` whenever `open`
 * changed:
 *
 *   - opening remembers the element that had focus (the opener) and moves
 *     focus into the dialog: its first tabbable element, which is the close
 *     button — or the container itself (`tabindex="-1"`) when there is none;
 *   - while open, a `keydown` listener on the host closes on Escape (unless
 *     the component says it cannot close right now: a payment in flight) and
 *     keeps Tab / Shift+Tab cycling inside the dialog;
 *   - closing removes the listener and gives focus back to the opener, if it
 *     is still in the document.
 *
 * "Inside the dialog" is the COMPOSED tree: the components render into a
 * shadow root, the checkout projects the third-party widgets from its light
 * DOM through named slots (see `lightContainer` there), and Vipps' own button
 * is a web component of its own. Slots are followed into their assigned
 * elements, and open shadow roots are walked.
 *
 * Deliberately no document-level focus guard: in Vev the cart view opens on
 * top of the checkout, outside this component, and pulling focus back into
 * the checkout from there would fight that view. The trap acts only on keys
 * pressed inside the host.
 */

export interface DialogFocusOptions {
  /** The component. The keydown listener lives on it; its render root holds the dialog. */
  host: HTMLElement
  /** The dialog container (`role="dialog"`), looked up on every use — Lit re-renders it. */
  container: () => HTMLElement | null
  /** What Escape does: the component's `close()`. */
  close: () => void
  /** Answer false while the dialog must stay open (a payment in flight): Escape is then ignored. */
  canClose?: () => boolean
}

export class DialogFocus {
  private opener: Element | null = null
  private active = false

  constructor(private readonly opts: DialogFocusOptions) {}

  /**
   * Call from `updated()` when `open` changed. Lit reports `open` as changed
   * on the first render too (from undefined to its initial value): with the
   * same value twice this is a no-op, so that first call does nothing.
   */
  update(open: boolean): void {
    if (open === this.active) return
    this.active = open
    if (open) this.opened()
    else this.closed()
  }

  private opened(): void {
    this.opener = deepActiveElement()
    this.opts.host.addEventListener('keydown', this.onKeydown)
    const container = this.opts.container()
    if (container) focusInto(container)
  }

  private closed(): void {
    this.opts.host.removeEventListener('keydown', this.onKeydown)
    const opener = this.opener
    this.opener = null
    // The shopper may have moved on already (another dialog, the page): then
    // focus is theirs. Otherwise it sits on an element about to leave the
    // screen — give it back to the opener, or at least let go of it.
    const active = deepActiveElement()
    if (!active || !isWithin(active, this.opts.host)) return
    if (opener && opener.isConnected && isRestorable(opener)) {
      focusElement(opener)
    } else if (active instanceof HTMLElement) {
      active.blur()
    }
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return
    if (e.key === 'Escape' || e.key === 'Esc') {
      if (this.opts.canClose && !this.opts.canClose()) return
      e.preventDefault()
      e.stopPropagation()
      this.opts.close()
      return
    }
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return
    const container = this.opts.container()
    if (!container) return
    const items = tabbableIn(container)
    if (items.length === 0) {
      e.preventDefault()
      focusElement(container)
      return
    }
    const active = deepActiveElement()
    const index = active ? items.indexOf(active as HTMLElement) : -1
    const first = items[0]!
    const last = items[items.length - 1]!
    if (e.shiftKey) {
      // From the first element — or the container itself — back round to the last.
      if (index <= 0) {
        e.preventDefault()
        focusElement(last)
      }
    } else if (index === -1 || index === items.length - 1) {
      // From the last element — or the container itself — round to the first.
      e.preventDefault()
      focusElement(first)
    }
    // Anywhere in between, the browser's own order already stays inside.
  }
}

/**
 * The element that really has focus: `document.activeElement` stops at a
 * shadow host, this follows it down through open shadow roots.
 */
export function deepActiveElement(): Element | null {
  if (typeof document === 'undefined') return null
  let el: Element | null = document.activeElement
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
  return el
}

const TABBABLE_CANDIDATES =
  'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]'

/**
 * The elements Tab can reach inside `container`, in the order the browser
 * visits them: the composed tree, so slotted content is taken where its slot
 * is and open shadow roots are looked into.
 */
export function tabbableIn(container: Element): HTMLElement[] {
  const out: HTMLElement[] = []
  walkChildren(container, out)
  return out
}

function walkChildren(parent: Element | ShadowRoot, out: HTMLElement[]): void {
  for (const child of Array.from(parent.children)) {
    if (child instanceof HTMLSlotElement) {
      // What a slot shows is its assigned elements; its own children only
      // when nothing is assigned (fallback content).
      const assigned = child.assignedElements({ flatten: true })
      if (assigned.length > 0) {
        for (const el of assigned) visit(el, out)
        continue
      }
    }
    visit(child, out)
  }
}

function visit(el: Element, out: HTMLElement[]): void {
  if (isTabbable(el)) out.push(el)
  // A shadow root replaces the light children on screen — they only show
  // through its slots, which walkChildren follows.
  if (el.shadowRoot) walkChildren(el.shadowRoot, out)
  else walkChildren(el, out)
}

function isTabbable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.matches(TABBABLE_CANDIDATES)) return false
  const tabindex = el.getAttribute('tabindex')
  if (tabindex !== null && Number(tabindex) < 0) return false
  if (el.hasAttribute('disabled')) return false
  if (el instanceof HTMLInputElement && el.type === 'hidden') return false
  if (el.getAttribute('contenteditable') === 'false' && !el.matches('a[href], button, input, select, textarea, iframe, [tabindex]')) return false
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false
  // Not rendered (display: none somewhere up the tree). jsdom has no layout
  // and no checkVisibility: there everything counts, which is fine for tests.
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false
  return true
}

function focusInto(container: HTMLElement): void {
  const first = tabbableIn(container)[0]
  focusElement(first ?? container)
}

function focusElement(el: HTMLElement): void {
  // The dialog is a fixed panel sliding in: nothing to scroll the page for.
  el.focus({ preventScroll: true })
}

/** The opener is worth focusing again — the page's body is not. */
function isRestorable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && el !== document.body && el !== document.documentElement
}

/** Is `node` inside `ancestor` in the composed tree (through shadow roots and slots)? */
function isWithin(node: Node, ancestor: Node): boolean {
  let n: Node | null = node
  while (n) {
    if (n === ancestor) return true
    n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)
  }
  return false
}
