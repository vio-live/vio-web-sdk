/**
 * Internal traffic (ADR-0041 §5): a browser of Vio's own people — Angelo,
 * Michael, the agents, a tester — marks itself so its visits never count.
 *
 * Opening ANY page that runs the SDK with `?vio_internal=1` marks the browser
 * (`localStorage`, `vio.internal.v1`); `?vio_internal=0` clears the mark.
 * While marked, every analytics event carries `client.internal: true` and the
 * collector's reads leave it out. A host can do the same from code with
 * `Vio.analytics.setInternal(true | false)`.
 *
 * The mark is the tester's own explicit choice, not a tracking identifier: it
 * is written even before consent (`requireConsent`), like a preference.
 *
 * Pure like `client-context.ts`: takes the globals it reads (defaults to the
 * real ones) and never throws — in-app browsers and sandboxed frames throw on
 * `localStorage` access, and then the page simply is not marked.
 */

import type { StorageLike } from './client-context.js'

/** Where the browser remembers it is internal (per origin, across sessions). */
export const INTERNAL_KEY = 'vio.internal.v1'
/** The URL parameter that marks (`1`) or clears (`0`) the browser. */
export const INTERNAL_PARAM = 'vio_internal'

export interface InternalEnvironment {
  location?: { search?: unknown } | null
  /** The persistent memory; `null` = none (SSR, blocked, in-app browser). */
  storage?: StorageLike | null
}

export function defaultInternalEnvironment(): InternalEnvironment {
  return {
    location: typeof location !== 'undefined' ? location : null,
    storage: localStorageOrNull(),
  }
}

/**
 * Whether this browser is internal: the URL's `vio_internal` decides (and is
 * remembered) when it is `1` or `0`; otherwise what is remembered. Any other
 * value of the parameter is ignored.
 */
export function resolveInternal(env: InternalEnvironment = defaultInternalEnvironment()): boolean {
  const param = internalParam(env.location?.search)
  if (param !== undefined) {
    writeInternal(param, env.storage)
    return param
  }
  return readInternal(env.storage)
}

/** What the browser remembers (`false` without storage). */
export function readInternal(storage: StorageLike | null | undefined = defaultInternalEnvironment().storage): boolean {
  try {
    return storage?.getItem(INTERNAL_KEY) === '1'
  } catch {
    return false
  }
}

/** Remember (or forget) the mark. Never throws. */
export function writeInternal(
  internal: boolean,
  storage: StorageLike | null | undefined = defaultInternalEnvironment().storage,
): void {
  try {
    if (internal) storage?.setItem(INTERNAL_KEY, '1')
    else storage?.removeItem?.(INTERNAL_KEY)
  } catch {
    /* private mode / blocked / in-app browser — the mark lives for this page only */
  }
}

/** `true` / `false` for `vio_internal=1` / `0` in a query string; `undefined` otherwise. */
export function internalParam(search: unknown): boolean | undefined {
  try {
    const value = new URLSearchParams(typeof search === 'string' ? search : '').get(INTERNAL_PARAM)?.trim()
    if (value === '1') return true
    if (value === '0') return false
  } catch {
    /* malformed */
  }
  return undefined
}

function localStorageOrNull(): StorageLike | null {
  try {
    // `window.localStorage` (the same object in a browser): the one the rest of analytics uses.
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null // a sandboxed frame / in-app browser throws on access
  }
}
