/**
 * Mounting real LitElement components in tests.
 *
 * Before this existed the components could not be instantiated at all — there
 * was no DOM environment — so every test of them was written against a
 * stand-in model. That is why a livelock test could pass while the real
 * component still livelocked: the test never touched the component.
 *
 * Use from a file that opts into jsdom on its first line:
 *
 *     // @vitest-environment jsdom
 */

import { registerVioElements } from './elements.js'

/**
 * The `<vio-*>` tags are registered explicitly by `registerVioElements()`, not
 * by a decorator on each class — importing the component module alone leaves
 * the tag undefined and `document.createElement` returns an inert
 * HTMLUnknownElement with no shadow root. Idempotent, so calling it from every
 * test file is fine.
 */
registerVioElements()

/** Wait for Lit to flush its update queue, and anything it awaited. */
export async function settle(el?: unknown): Promise<void> {
  const pending = (el as { updateComplete?: Promise<unknown> } | undefined)?.updateComplete
  if (pending) await pending
  // Lit schedules on a microtask; a macrotask hop also lets awaited fetches
  // that already resolved run their continuations.
  await new Promise((r) => setTimeout(r, 0))
}

/**
 * Mount a custom element and return it, already rendered.
 *
 * The element is appended to the real document — connectedCallback and the
 * lifecycle hooks that react to it are the whole point of these tests.
 */
export async function mount<T extends HTMLElement>(
  tag: string,
  props: Partial<T> = {},
): Promise<T> {
  const el = document.createElement(tag) as T
  Object.assign(el, props)
  document.body.appendChild(el)
  await settle(el)
  return el
}

/** Remove everything mounted, so one test cannot leak into the next. */
export function unmountAll(): void {
  document.body.innerHTML = ''
}

/** Visible text of a component's shadow root, whitespace-collapsed. */
export function shadowText(el: HTMLElement): string {
  return (el.shadowRoot?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** Buttons rendered inside a component's shadow root, by their label. */
export function shadowButtons(el: HTMLElement, selector = 'button'): string[] {
  return [...(el.shadowRoot?.querySelectorAll(selector) ?? [])].map((b) =>
    (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}
