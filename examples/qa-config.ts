/**
 * The QA page's URL, read: what `Vio.init` gets and what the page paints.
 * Pure — no DOM, no SDK — so it is tested on its own (qa-config.test.ts);
 * `main.ts` uses it. The parameters are documented at the top of `main.ts`.
 */
import type { VioConfig } from '../src/core/configuration'

export type QaEnv = 'testing' | 'production' | 'development'

/** The `VITE_*` variables the page reads (from `.env.local`). */
export interface QaEnvVars {
  VITE_VIO_API_KEY?: string
  VITE_VIO_API_BASE?: string
  VITE_VIO_GRAPHQL_BASE?: string
  VITE_VIO_STRIPE_PK?: string
}

export interface QaConfig {
  /** '' when neither the URL nor `.env.local` gives one. */
  apiKey: string
  env: QaEnv
  campaignId?: number
  /** A code of the page's own (`Vio.init({ discountCode })`): the override; without it, the campaign's. */
  discountCode?: string
  /** `true` / `false` as the URL said it; `undefined` when it did not (the SDK's default). */
  discountField?: boolean
  /** The products to paint instead of the channel's; `[]` when not given. */
  productIds: number[]
  /** The code the URL carries for the SDK to read itself (`?vio_discount=`), to say it on the page. */
  urlDiscountCode?: string
  /** What `Vio.init` gets; `null` without a key. */
  init: VioConfig | null
}

const ENVS: readonly QaEnv[] = ['testing', 'production', 'development']

function positiveInt(value: string | null | undefined): number | undefined {
  const n = Number(String(value ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : undefined
}

const text = (value: string | null | undefined): string | undefined => value?.trim() || undefined

export function readQaConfig(search: string, vars: QaEnvVars = {}): QaConfig {
  const q = new URLSearchParams(search)
  const env = ENVS.find((e) => e === q.get('env')) ?? 'testing'
  const apiKey = text(q.get('apiKey')) ?? text(vars.VITE_VIO_API_KEY) ?? ''
  const campaignId = positiveInt(q.get('campaignId'))
  const discountCode = text(q.get('discountCode'))
  const field = q.get('discountField')
  const discountField = field === 'true' ? true : field === 'false' ? false : undefined
  const productIds = (q.get('productIds') ?? '')
    .split(',')
    .map((s) => positiveInt(s))
    .filter((n): n is number => n !== undefined)
  // The dev proxies of vite.config.ts go to QA: never with production.
  const apiBase = env !== 'production' ? text(vars.VITE_VIO_API_BASE) : undefined
  const graphQLBase = env !== 'production' ? text(vars.VITE_VIO_GRAPHQL_BASE) : undefined
  const stripePublishableKey = text(vars.VITE_VIO_STRIPE_PK)

  const init: VioConfig | null = apiKey
    ? {
        apiKey,
        environment: env,
        ...(campaignId ? { campaignId } : {}),
        ...(discountCode ? { discountCode } : {}),
        ...(discountField !== undefined ? { discountField } : {}),
        ...(apiBase ? { apiBase } : {}),
        ...(graphQLBase ? { graphQLBase } : {}),
        ...(stripePublishableKey ? { stripePublishableKey } : {}),
      }
    : null

  return {
    apiKey,
    env,
    ...(campaignId ? { campaignId } : {}),
    ...(discountCode ? { discountCode } : {}),
    ...(discountField !== undefined ? { discountField } : {}),
    productIds,
    ...(text(q.get('vio_discount')) ? { urlDiscountCode: text(q.get('vio_discount')) } : {}),
    init,
  }
}

/**
 * The status line: env, campaign, which code (and from where), the field.
 * `campaignRef` is what the bootstrap's campaign gives the brand shown —
 * only a reference (`discount.ref` of its sponsor block, set in the
 * dashboard): the code itself never reaches the page. Left out before the
 * bootstrap; `null` when the campaign gives none. The page's own
 * (`discountCode`, `?vio_discount=`) wins over it, as in the SDK.
 */
export function describeQaConfig(c: QaConfig, campaignRef?: string | null): string {
  return [
    `env ${c.env}`,
    c.campaignId ? `campaña ${c.campaignId}` : 'sin campaña (la de la surface)',
    c.discountCode
      ? `código ${c.discountCode} (config)`
      : c.urlDiscountCode
        ? `código ${c.urlDiscountCode} (?vio_discount)`
        : campaignRef === undefined
          ? 'código: el de la campaña'
          : campaignRef
            ? `código de la campaña (ref ${campaignRef}; el código no llega a la página)`
            : 'sin código (la campaña no da ninguno)',
    c.discountField === undefined ? 'campo: por defecto' : `campo: ${c.discountField ? 'sí' : 'no'}`,
  ].join(' · ')
}
