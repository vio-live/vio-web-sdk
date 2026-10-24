/**
 * A `localStorage` for tests that need one.
 *
 * Node 25+ defines a global `localStorage` getter that answers `undefined`
 * unless the process runs with `--localstorage-file`, and vitest's jsdom
 * environment does not replace a global that already exists — so under that
 * Node `typeof localStorage` is `'undefined'` inside a jsdom test and the
 * cart manager never persists (nor can a test call `localStorage.clear()`).
 * Installs a Map-backed Storage in that case; keeps the real one otherwise.
 */
export function ensureLocalStorage(): Storage {
  const existing = (globalThis as { localStorage?: Storage }).localStorage
  if (existing) return existing
  const store = new Map<string, string>()
  const shim: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true })
  return shim
}
