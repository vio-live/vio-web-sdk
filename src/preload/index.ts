/**
 * `@vio-live/web-sdk/preload` — a few hundred bytes to call as early as the
 * page knows its key, before (or while) the SDK downloads:
 *
 *   import { preloadVio } from '@vio-live/web-sdk/preload'
 *   preloadVio({ apiKey, environment: 'production' })
 *
 * It starts loading the surface's snapshot from the CDN and opens the
 * connections the first paint needs. `Vio.init()` then uses that load.
 */
export { preloadVio, type PreloadOptions } from '../core/preload.js'
export { snapshotUrl, type SnapshotTarget } from '../core/snapshot.js'
