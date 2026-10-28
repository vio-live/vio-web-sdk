/**
 * `localStorage` / `sessionStorage` that never throws and never blocks.
 *
 * In-app browsers (Facebook, Instagram, Snapchat…), private modes and
 * sandboxed iframes break storage in different ways: the property itself can
 * throw (`SecurityError`, even `typeof localStorage` does), it can be `null`,
 * or a write can fail (quota of 0). Any of those used to escape from the cart,
 * the customer session id or the market's currency — and an add to cart or a
 * checkout failed with it (Mote & Livsstil, 2026-10-28: mostly mobile, mostly
 * in-app traffic).
 *
 * Here a failure falls back to this page's memory: a value written while the
 * storage refuses is read back from memory for the rest of the page (the cart
 * survives a re-render, the customer session id stays the same), and it is
 * simply not shared with other tabs or the next visit.
 */

export type StorageKind = 'local' | 'session'

const memory: Record<StorageKind, Map<string, string>> = {
  local: new Map(),
  session: new Map(),
}

/** The browser's storage of that kind, or null when there is none or touching it throws. */
function area(kind: StorageKind): Storage | null {
  try {
    const s = (globalThis as Record<string, unknown>)[kind === 'local' ? 'localStorage' : 'sessionStorage'] as
      | Storage
      | null
      | undefined
    return s && typeof s.getItem === 'function' ? s : null
  } catch {
    return null
  }
}

/** The value, or null. A value this page could only keep in memory wins. */
export function storageGet(kind: StorageKind, key: string): string | null {
  const kept = memory[kind]
  if (kept.has(key)) return kept.get(key) ?? null
  try {
    return area(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}

/**
 * Write; true when the browser's storage took it, false when it did not —
 * then it lives in this page's memory, unless `opts.memory` is false (a
 * caller that already keeps the value in memory itself, like the cart).
 */
export function storageSet(kind: StorageKind, key: string, value: string, opts: { memory?: boolean } = {}): boolean {
  try {
    const s = area(kind)
    if (s) {
      s.setItem(key, value)
      memory[kind].delete(key)
      return true
    }
  } catch {
    /* blocked or full: memory below */
  }
  if (opts.memory !== false) memory[kind].set(key, value)
  return false
}

/** Remove from both the browser's storage and this page's memory. Never throws. */
export function storageRemove(kind: StorageKind, key: string): void {
  memory[kind].delete(key)
  try {
    area(kind)?.removeItem(key)
  } catch {
    /* nothing to do */
  }
}

/** Tests only: forget what was kept in memory. */
export function resetStorageMemory(): void {
  memory.local.clear()
  memory.session.clear()
}
