/**
 * Vio REST API client — talks to `api-dev.vio.live` (or override).
 *
 * Endpoints (mirrors the iOS SDK's surface):
 *   GET  /v2/mobile/config                                bootstrap (sponsors + market)
 *   GET  /v2/mobile/campaigns/:id/components              placement components (TBD)
 *   POST /v2/mobile/campaigns/:id/cart-intent             cross-device cart-intent (TBD)
 *
 * Auth: `X-API-Key: <apiKey>` header (the top-level Vio apiKey).
 *
 * Note: until the backend exposes a dedicated `/v2/web/*` surface we
 * reuse the `/v2/mobile/*` paths — the apiKey identifies the client_app
 * and the response shape is platform-agnostic enough.
 */

import type { BootstrapResponse, PlacementComponent } from '../types.js'

export interface VioApiOptions {
  /** REST API base URL, e.g. `https://api-dev.vio.live`. */
  apiBase: string
  /** Top-level Vio apiKey for this client app. */
  apiKey: string
}

export class VioApi {
  private readonly apiBase: string
  private readonly apiKey: string

  constructor(options: VioApiOptions) {
    if (!options.apiBase) throw new Error('[VioApi] apiBase is required')
    if (!options.apiKey) throw new Error('[VioApi] apiKey is required')
    this.apiBase = options.apiBase.replace(/\/+$/, '')
    this.apiKey = options.apiKey
  }

  /**
   * Bootstrap — fetches client app config (sponsors with commerce keys,
   * default market, campaign id). Called once at SDK init.
   */
  async bootstrap(): Promise<BootstrapResponse> {
    return this.get<BootstrapResponse>('/v2/mobile/config')
  }

  /**
   * Get placement components for a campaign. Used by the carousel auto-fetch
   * mode (`<vio-product-carousel campaign-id="36" location="news-favorites">`).
   */
  async getComponents(campaignId: number | string): Promise<PlacementComponent[]> {
    const path = `/v2/mobile/campaigns/${encodeURIComponent(String(campaignId))}/components`
    const res = await this.get<{ components: PlacementComponent[] } | PlacementComponent[]>(path)
    return Array.isArray(res) ? res : (res?.components ?? [])
  }

  // MARK: - HTTP plumbing

  private async get<T>(path: string): Promise<T> {
    const url = `${this.apiBase}${path}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-Key': this.apiKey,
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      throw new VioApiError(res.status, await safeText(res), `GET ${path}`)
    }
    return (await res.json()) as T
  }
}

export class VioApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly endpoint: string,
  ) {
    super(`[VioApi] ${endpoint} → HTTP ${status}: ${body.slice(0, 200)}`)
    this.name = 'VioApiError'
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

export function createVioApi(options: VioApiOptions): VioApi {
  return new VioApi(options)
}
