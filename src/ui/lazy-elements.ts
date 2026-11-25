/**
 * The heavy elements in a second step.
 *
 * `<vio-product-detail>`, `<vio-cart>` and `<vio-checkout>` are most of the
 * UI's code, and none of them is visible when the page opens. So `./ui`
 * defines the cards at once and loads these three a moment later: when the
 * browser is idle, or at once when the page needs one of them. Nothing done
 * meanwhile is lost:
 *
 * - `show()` / `close()` called on one of them that is already in the
 *   document are kept and replayed, in order, once it is defined;
 * - a card's `vio:product-click` that a not-yet-defined
 *   `<vio-product-detail>` would have opened on is replayed to it;
 * - properties set on them before that are kept by Lit (it re-applies an
 *   element's own properties when it upgrades).
 *
 * `loadVioElements()` loads them now and resolves with their classes — what a
 * host awaits before calling a method on an element it has just created.
 */

export interface HeavyElementClasses {
  VioProductDetail: CustomElementConstructor
  VioCart: CustomElementConstructor
  VioCheckout: CustomElementConstructor
}

export const HEAVY_TAGS = {
  'vio-product-detail': 'VioProductDetail',
  'vio-cart': 'VioCart',
  'vio-checkout': 'VioCheckout',
} as const satisfies Record<string, keyof HeavyElementClasses>

type HeavyTag = keyof typeof HEAVY_TAGS
const TAGS = Object.keys(HEAVY_TAGS) as HeavyTag[]
const SELECTOR = TAGS.join(',')
/** The methods hosts call on these elements (their whole public API). */
const METHODS = ['show', 'close'] as const
/** How long the idle wait may last before loading anyway. */
export const LAZY_IDLE_TIMEOUT_MS = 1500

type Shim = ((...args: unknown[]) => void) & { __vioShim?: true }

interface LazyState {
  loader: (() => Promise<HeavyElementClasses>) | null
  loading: Promise<HeavyElementClasses> | null
  scheduled: boolean
  queue: Array<{ el: Element; method: string; args: unknown[] }>
  shimmed: Set<Element>
  observer: MutationObserver | null
  pendingClick: Event | null
  clickListener: ((e: Event) => void) | null
}

function state(): LazyState {
  const g = globalThis as { __VIO_LAZY_ELEMENTS__?: LazyState }
  if (!g.__VIO_LAZY_ELEMENTS__) {
    g.__VIO_LAZY_ELEMENTS__ = {
      loader: null,
      loading: null,
      scheduled: false,
      queue: [],
      shimmed: new Set(),
      observer: null,
      pendingClick: null,
      clickListener: null,
    }
  }
  return g.__VIO_LAZY_ELEMENTS__
}

function hasRegistry(): boolean {
  return (
    typeof customElements !== 'undefined' &&
    typeof customElements.get === 'function' &&
    typeof customElements.define === 'function'
  )
}

function allDefined(): boolean {
  return TAGS.every((tag) => !!customElements.get(tag))
}

/** Define the three heavy elements now (skipping any already defined), then replay what waited. */
export function defineHeavyElements(classes: HeavyElementClasses): void {
  if (!hasRegistry()) return
  const s = state()
  // The stand-ins go first: an own `show` would hide the class's method for good.
  for (const el of s.shimmed) {
    for (const m of METHODS) {
      const own = Object.getOwnPropertyDescriptor(el, m)
      if (own && (own.value as Shim | undefined)?.__vioShim) delete (el as unknown as Record<string, unknown>)[m]
    }
  }
  s.shimmed.clear()
  s.observer?.disconnect()
  s.observer = null
  for (const tag of TAGS) {
    if (!customElements.get(tag)) customElements.define(tag, classes[HEAVY_TAGS[tag]])
  }
  if (s.clickListener && typeof document !== 'undefined') {
    document.removeEventListener('vio:product-click', s.clickListener)
  }
  s.clickListener = null
  // Replay, in the order the page asked.
  for (const call of s.queue.splice(0)) {
    try {
      customElements.upgrade(call.el)
      const fn = (call.el as unknown as Record<string, unknown>)[call.method]
      if (typeof fn === 'function') fn.apply(call.el, call.args)
    } catch (err) {
      if (typeof console !== 'undefined') console.warn(`[Vio] ${call.method}() replay failed:`, err)
    }
  }
  const click = s.pendingClick
  s.pendingClick = null
  if (click && typeof document !== 'undefined') {
    for (const el of Array.from(document.querySelectorAll('vio-product-detail'))) {
      try {
        ;(el as unknown as { replayProductClick?: (e: Event) => void }).replayProductClick?.(click)
      } catch {
        /* the detail decides; a failure there is its own */
      }
    }
  }
}

/** Load the heavy elements now (once) and define them. */
export function loadHeavyElements(): Promise<HeavyElementClasses> {
  const s = state()
  if (s.loading) return s.loading
  const loader = s.loader
  if (!loader || !hasRegistry()) return Promise.reject(new Error('[Vio] the UI is not registered (import @vio-live/web-sdk/ui)'))
  s.loading = loader().then(
    (classes) => {
      defineHeavyElements(classes)
      return classes
    },
    (err) => {
      // A failed download (offline, a deploy in between) is tried again on the next need.
      s.loading = null
      if (typeof console !== 'undefined') console.warn('[Vio] loading the cart/checkout/detail failed:', err)
      throw err
    },
  )
  return s.loading
}

function demand(): void {
  void loadHeavyElements().catch(() => undefined)
}

/** A stand-in `show` / `close` on an element that is not defined yet: kept, and the load starts. */
function shim(el: Element): void {
  const s = state()
  if (s.shimmed.has(el) || customElements.get(el.localName)) return
  for (const m of METHODS) {
    if (typeof (el as unknown as Record<string, unknown>)[m] === 'function') continue
    const fn: Shim = (...args: unknown[]) => {
      s.queue.push({ el, method: m, args })
      demand()
    }
    fn.__vioShim = true
    Object.defineProperty(el, m, { value: fn, configurable: true, writable: true, enumerable: false })
  }
  s.shimmed.add(el)
}

function shimWithin(root: ParentNode | Element): void {
  if ((root as Element).localName && (root as Element).localName in HEAVY_TAGS) shim(root as Element)
  if (typeof (root as ParentNode).querySelectorAll === 'function') {
    for (const el of Array.from((root as ParentNode).querySelectorAll(SELECTOR))) shim(el)
  }
}

/**
 * Register the heavy elements lazily: stand-ins for what is (or comes) in
 * the document, the cards' clicks kept for the detail, and the download when
 * the browser is idle — or at once, on the first need.
 */
export function registerHeavyElementsLazily(loader: () => Promise<HeavyElementClasses>): void {
  if (!hasRegistry()) return
  const s = state()
  if (!s.loader) s.loader = loader
  if (allDefined() || s.loading) return
  if (typeof document === 'undefined') return
  try {
    shimWithin(document)
    if (!s.observer && typeof MutationObserver !== 'undefined') {
      s.observer = new MutationObserver((records) => {
        for (const r of records) r.addedNodes.forEach((n) => n.nodeType === 1 && shimWithin(n as Element))
      })
      s.observer.observe(document.documentElement, { childList: true, subtree: true })
    }
    if (!s.clickListener) {
      s.clickListener = (e: Event) => {
        if (customElements.get('vio-product-detail')) return
        if (!document.querySelector('vio-product-detail')) return
        s.pendingClick = e
        demand()
      }
      document.addEventListener('vio:product-click', s.clickListener)
    }
  } catch {
    // Without stand-ins the elements still come; only an early call could miss.
  }
  if (s.scheduled) return
  s.scheduled = true
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
  if (typeof idle === 'function') idle(demand, { timeout: LAZY_IDLE_TIMEOUT_MS })
  else setTimeout(demand, 200)
}

/** Tests only. */
export function resetLazyElements(): void {
  const s = state()
  s.observer?.disconnect()
  if (s.clickListener && typeof document !== 'undefined') document.removeEventListener('vio:product-click', s.clickListener)
  delete (globalThis as { __VIO_LAZY_ELEMENTS__?: LazyState }).__VIO_LAZY_ELEMENTS__
}
