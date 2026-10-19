/**
 * What the commerce gateway may not know yet.
 *
 * The SDK ships ahead of the gateway more than once a quarter: a selection
 * (`buyer_ref`, 2026-10-19), an argument (`origin` on the cart lines,
 * `attribution` on the checkout — ADR-0035 phase B). A gateway that does not
 * have the field refuses the WHOLE operation at validation — before anything
 * runs, with no `data` — so each such operation is sent again without the
 * field, once, and the answer remembered for the page load. An operation that
 * DID run and failed is never repeated: for a mutation that would be a second
 * charge, a second line in the cart.
 *
 * One mechanism for all of them, so the next field costs a token here and a
 * call to `withGatewayFeature`, not a new copy of the retry.
 */

export type GatewayFeature = 'buyer_ref' | 'line_origin' | 'checkout_attribution'

/**
 * What the gateway's validation error names when it does not know the
 * feature: the field or argument, and the input types the SDK declares for
 * it (a variable of an unknown type fails on the TYPE's name). The type
 * names are the ones `vio-live/graphql` `feat/atribucion-en-la-orden`
 * defines; a rename there makes the SDK fall back to the legacy shape — and
 * say so in the console — until it is updated here.
 */
const FEATURE_TOKENS: Readonly<Record<GatewayFeature, readonly string[]>> = {
  buyer_ref: ['buyer_ref'],
  line_origin: ['origin', 'LineOriginInput'],
  checkout_attribution: ['attribution', 'CheckoutAttributionInput', 'EntryContextInput'],
}

/** What a gateway says of a field, argument or type it does not have. */
const UNKNOWN_PATTERN =
  /cannot query field|unknown field|unknown argument|unknown type|is not defined by type|not defined by type|field "[^"]+" is not defined/i

const refused = new Set<GatewayFeature>()
const warned = new Set<GatewayFeature>()

/** Whether this page load still expects the gateway to know `feature` (false once it refused it). */
export function gatewayHas(feature: GatewayFeature): boolean {
  return !refused.has(feature)
}

/** Forget what this page load learned (tests). One feature, or all of them. */
export function resetGatewayFeatures(feature?: GatewayFeature): void {
  if (feature) {
    refused.delete(feature)
    warned.delete(feature)
    return
  }
  refused.clear()
  warned.clear()
}

/** What `executeCartGraphQL` attaches to the error it throws. */
export interface GraphQLErrorInfo {
  hasData: boolean
  errors: Array<{ message?: string }>
}

/** The messages an error carries: its own and the envelope's, when it has one. */
function messagesOf(err: unknown): string[] {
  if (!err || typeof err !== 'object') return []
  const { message, graphql } = err as { message?: unknown; graphql?: Partial<GraphQLErrorInfo> }
  return [message, ...(graphql?.errors ?? []).map((e) => e?.message)].filter(
    (m): m is string => typeof m === 'string',
  )
}

function ranSomething(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return (err as { graphql?: Partial<GraphQLErrorInfo> }).graphql?.hasData === true
}

/**
 * True when `err` is the gateway refusing something it does not know, named
 * `token` (`Cannot query field "buyer_ref" on type …`, `Unknown argument
 * "origin" on field …`, `Unknown type "LineOriginInput"`, `Field "origin" is
 * not defined by type "LineItemInput"`): a validation error, with no `data`
 * because nothing ran — safe to send again without it, a mutation included.
 * Anything that ran (data present) or any other message is not.
 */
export function isUnknownTokenError(err: unknown, token: string): boolean {
  if (ranSomething(err)) return false
  return messagesOf(err).some((m) => m.includes(`"${token}"`) && UNKNOWN_PATTERN.test(m))
}

/** `isUnknownTokenError` for any of the names a feature goes by. */
export function isUnknownFeatureError(err: unknown, feature: GatewayFeature): boolean {
  return FEATURE_TOKENS[feature].some((token) => isUnknownTokenError(err, token))
}

/**
 * Runs `request(true)` (the operation with the feature); when the gateway
 * does not know it, `request(false)` (without it) — and from then on, for
 * this page load, straight to the latter. Said once in the console: a
 * gateway behind the SDK is worth knowing about, and so is a renamed type.
 */
export async function withGatewayFeature<T>(
  feature: GatewayFeature,
  request: (supported: boolean) => Promise<T>,
): Promise<T> {
  if (!gatewayHas(feature)) return request(false)
  try {
    return await request(true)
  } catch (err) {
    if (!isUnknownFeatureError(err, feature)) throw err
    refused.add(feature)
    if (!warned.has(feature) && typeof console !== 'undefined') {
      warned.add(feature)
      console.warn(
        `[Vio] the commerce gateway does not know "${FEATURE_TOKENS[feature][0]}" (${feature}) yet — sent without it on this page load:`,
        messagesOf(err)[0] ?? '',
      )
    }
    return request(false)
  }
}
