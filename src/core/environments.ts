/**
 * The hosts of each Vio environment. On its own (no imports) so the tiny
 * `./preload` entry can know them without pulling in the SDK.
 */

export type Environment = 'development' | 'testing' | 'production'

export interface EnvironmentUrls {
  apiBase: string
  graphQLBase: string
  eventsBase: string
  /**
   * Where campaigns publishes each surface's snapshot (config + products,
   * every ~90 s): `<snapshotBase><sha256(apiKey)[:32]>.<platform>.js`.
   */
  snapshotBase: string
}

export const ENVIRONMENT_URLS: Record<Environment, EnvironmentUrls> = {
  // The Vio Backend development environment was removed on 2026-09-16; its REST
  // and events hosts now point at staging (Commerce GraphQL dev is unaffected).
  development: {
    apiBase: 'https://api-staging.vio.live',
    graphQLBase: 'https://graph-ql-dev.vio.live',
    eventsBase: 'https://events-staging.vio.live',
    snapshotBase: 'https://container.vio.live/reachu-uploads-qa/snapshots/',
  },
  // No separate staging GraphQL deployment yet — shares dev's.
  testing: {
    apiBase: 'https://api-staging.vio.live',
    graphQLBase: 'https://graph-ql-dev.vio.live',
    eventsBase: 'https://events-staging.vio.live',
    snapshotBase: 'https://container.vio.live/reachu-uploads-qa/snapshots/',
  },
  production: {
    apiBase: 'https://api.vio.live',
    graphQLBase: 'https://graph-ql.vio.live',
    eventsBase: 'https://events.vio.live',
    snapshotBase: 'https://container.vio.live/reachu-uploads-production/snapshots/',
  },
}
