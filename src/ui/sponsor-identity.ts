/**
 * The sponsor's (brand's) name and logo in the elements — one resolver
 * (`Vio.sponsorIdentity`, see core/sponsor-identity.ts) and one way to draw it:
 * the logo with the name as its `alt`, or the name as text when there is no
 * logo — or when the logo fails to load.
 */

import { html, nothing, type TemplateResult } from 'lit'
import { Vio } from '../core/client.js'
import { Configuration } from '../core/configuration.js'
import {
  checkoutSponsorOf,
  sponsorIdentityFrom,
  type CheckoutSponsor,
  type SponsorIdentity,
} from '../core/sponsor-identity.js'

/**
 * `Vio.sponsorIdentity(sponsorId, { checkoutId })`; on a facade from an older
 * bundle that predates it (the facade is shared on `globalThis`), the same
 * rule over its bootstrap. `null` when nothing names it; never throws.
 */
export function resolveSponsorIdentity(
  sponsorId: number | string | null | undefined,
  checkoutId?: string | null,
): SponsorIdentity | null {
  try {
    if (typeof Vio.sponsorIdentity === 'function') return Vio.sponsorIdentity(sponsorId, { checkoutId })
    return sponsorIdentityFrom(Vio.bootstrapCache, sponsorId)
  } catch {
    return null
  }
}

/** `{ sponsor }` for an event detail — the `{ id, name, logoUrl }` of the sponsor — or `{}` when it cannot be named. */
export function sponsorDetail(
  sponsorId: number | string | null | undefined,
  checkoutId?: string | null,
): { sponsor?: CheckoutSponsor } {
  const sponsor = checkoutSponsorOf(resolveSponsorIdentity(sponsorId, checkoutId))
  return sponsor ? { sponsor } : {}
}

/** Logos that failed to load on this page: shown as the name from then on. */
const failedLogos = new Set<string>()

/** The logo to draw for an identity: its URL, unless it is missing or failed to load here. */
export function usableLogo(identity: Pick<SponsorIdentity, 'logoUrl'> | null | undefined): string | null {
  const url = identity?.logoUrl
  return url && !failedLogos.has(url) ? url : null
}

/**
 * The sponsor as a mark: `<img class=logoClass alt=name>` when it has a logo
 * that loads, else `<span class=nameClass>name</span>`, else nothing. A logo
 * that fails to load is remembered as failed and the host re-renders with the
 * name.
 */
export function renderSponsorMark(
  host: { requestUpdate(): void },
  identity: Pick<SponsorIdentity, 'name' | 'logoUrl'> | null | undefined,
  classes: { logo: string; name: string },
): TemplateResult | typeof nothing {
  if (!identity) return nothing
  const logo = usableLogo(identity)
  if (logo) {
    return html`<img
      class=${classes.logo}
      src=${logo}
      alt=${identity.name}
      decoding="async"
      @error=${() => {
        failedLogos.add(logo)
        host.requestUpdate()
      }}
    />`
  }
  return identity.name ? html`<span class=${classes.name}>${identity.name}</span>` : nothing
}

/** How long a return waits for `Vio.init()` before it stops waiting for the bootstrap. */
const INIT_WAIT_MS = 10_000

/**
 * Resolves once the bootstrap is cached — waiting for `Vio.init()` (up to
 * 10 s) and then joining (or starting) `Vio.bootstrap()`, which is deduped.
 * `false` when it could not be had; never throws. For a confirmation that
 * must name the sponsor once the bootstrap lands (a redirect return).
 */
export async function whenBootstrapped(): Promise<boolean> {
  try {
    if (Vio.bootstrapCache) return true
    if (!Configuration.isInitialized) await Configuration.whenReady(INIT_WAIT_MS)
    if (!Configuration.isInitialized || typeof Vio.bootstrap !== 'function') return false
    await Vio.bootstrap()
    return !!Vio.bootstrapCache
  } catch {
    return false
  }
}

/** For tests: forget the logos that failed. */
export function resetFailedLogos(): void {
  failedLogos.clear()
}
