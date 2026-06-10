/**
 * Vio Web SDK — main entry point.
 *
 * Re-exports the headless core API (the `Vio` client, managers, types). This
 * entry is tree-shakeable and identical in surface to `@vio-live/web-sdk/core`.
 *
 * To render the `<vio-*>` web components, import the UI entry for its
 * registration side-effect — or use the React wrappers:
 *
 *   import { Vio } from '@vio-live/web-sdk'
 *   import '@vio-live/web-sdk/ui'          // registers <vio-*>
 *   // or: import { VioProductCarousel } from '@vio-live/web-sdk/react'
 *
 *   Vio.init({ apiKey, apiBase, graphqlBase, stripePublishableKey })
 */

export * from './core/index.js'
