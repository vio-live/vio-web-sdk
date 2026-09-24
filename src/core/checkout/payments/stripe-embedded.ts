/**
 * Stripe on our own page — the Payment Element, no redirect.
 *
 * The older web flow minted a Stripe Payment Link and sent the shopper to a
 * page hosted by Stripe. This one keeps them here (Angelo, 2026-09-24):
 *
 *   1. Vio Commerce creates a PaymentIntent for the checkout
 *      (`Payment { CreatePaymentIntentStripe }`) and answers with its client
 *      secret AND the publishable key of the account that minted it — the
 *      seller's when they brought both keys, ours otherwise. The two are
 *      halves of one account: the browser confirms with the key what the
 *      server minted with the secret one.
 *   2. Stripe's Payment Element is mounted in a LIGHT-DOM container, the way
 *      the other embedded widgets are. Card fields are Stripe's own iframes,
 *      so card data never touches this SDK or our servers.
 *   3. `confirm()` pays. A 3-D Secure challenge opens in Stripe's own modal
 *      over the page: `redirect: 'if_required'` keeps the shopper here for
 *      cards, and still redirects for a method that has no other way.
 *   4. The Commerce order is NOT born here. Stripe's `payment_intent.succeeded`
 *      webhook creates it, verified server-side; the checkout is polled for
 *      its status afterwards, exactly as the redirect return does.
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'
import { loadStripeJs } from './apple-pay.js'

/** What the backend hands over to pay a checkout on our page. */
export interface StripeIntent {
  /** `pi_..._secret_...`: what the browser confirms. */
  client_secret: string
  /** The key of the SAME account that minted the secret. */
  publishable_key: string
  customer?: string
}

export const CREATE_PAYMENT_INTENT_STRIPE_MUTATION = `
mutation CreatePaymentIntentStripe($checkoutId: String!) {
  Payment {
    CreatePaymentIntentStripe(checkout_id: $checkoutId) {
      client_secret
      publishable_key
      customer
    }
  }
}
`

export async function createStripeIntent(
  checkoutId: string,
  options?: CartQueryOptions,
): Promise<StripeIntent | null> {
  const json = await executeCartGraphQL(
    CREATE_PAYMENT_INTENT_STRIPE_MUTATION,
    { checkoutId },
    options,
  )
  return (json?.data?.Payment?.CreatePaymentIntentStripe as StripeIntent) ?? null
}

/** What `confirm()` answers. The browser's word is never the order. */
export type StripeConfirmOutcome =
  | { status: 'succeeded'; paymentIntentId?: string }
  /** Authorised but not settled yet, or Stripe redirected and will return. */
  | { status: 'pending'; paymentIntentId?: string }
  | { status: 'failed'; message?: string; code?: string }

export interface StripeElementHandle {
  confirm(): Promise<StripeConfirmOutcome>
  unmount(): void
}

export interface MountStripeOptions {
  /** Where Stripe sends the shopper back when a method insists on leaving. */
  returnUrl: string
  theme?: { accent?: string; radiusMd?: string }
  /**
   * Stripe has PAINTED the form. `mount()` resolves long before that — up to
   * ten seconds on a cold cache (QA, 2026-09-24) — and until then the panel
   * is an empty box, so the caller keeps its "loading" state until this.
   */
  onReady?: () => void
  /** Stripe could not load the form at all. */
  onLoadError?: (message: string) => void
}

/** Stripe's own words for "the money is in". */
const SETTLED = new Set(['succeeded'])
const IN_FLIGHT = new Set(['processing', 'requires_capture'])

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Mount the Payment Element. The container must live in the LIGHT DOM:
 * Stripe's iframes need a document-level element, and a shadow root hides
 * them from it.
 */
export async function mountStripeElement(
  container: HTMLElement,
  intent: StripeIntent,
  options: MountStripeOptions,
): Promise<StripeElementHandle> {
  if (!intent?.client_secret || !intent.publishable_key) {
    throw new Error('[Stripe] the payment is missing its client secret or publishable key')
  }
  await loadStripeJs()
  const Stripe = (globalThis as any).Stripe
  if (typeof Stripe !== 'function') {
    throw new Error('[Stripe] stripe.js loaded but window.Stripe is missing')
  }
  const stripe = Stripe(intent.publishable_key)
  const appearance: Record<string, unknown> = { theme: 'stripe' }
  const variables: Record<string, string> = {}
  if (options.theme?.accent) variables.colorPrimary = options.theme.accent
  if (options.theme?.radiusMd) variables.borderRadius = options.theme.radiusMd
  if (Object.keys(variables).length > 0) appearance.variables = variables

  const elements = stripe.elements({ clientSecret: intent.client_secret, appearance })
  const element = elements.create('payment', { layout: 'tabs' })
  if (options.onReady) element.on('ready', () => options.onReady?.())
  if (options.onLoadError) {
    element.on('loaderror', (event: any) =>
      options.onLoadError?.(String(event?.error?.message ?? 'Stripe could not load the form')),
    )
  }
  container.innerHTML = ''
  element.mount(container)

  let confirming = false
  return {
    async confirm(): Promise<StripeConfirmOutcome> {
      // A shopper can press twice; Stripe would refuse the second one while
      // the first is in flight.
      if (confirming) return { status: 'pending' }
      confirming = true
      try {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: options.returnUrl },
          redirect: 'if_required',
        })
        if (result?.error) {
          return {
            status: 'failed',
            message: String(result.error.message ?? ''),
            code: String(result.error.code ?? ''),
          }
        }
        const paymentIntent = result?.paymentIntent
        const status = String(paymentIntent?.status ?? '')
        if (SETTLED.has(status)) return { status: 'succeeded', paymentIntentId: paymentIntent?.id }
        if (IN_FLIGHT.has(status)) return { status: 'pending', paymentIntentId: paymentIntent?.id }
        // requires_payment_method / requires_action / canceled: not paid.
        return { status: 'failed', code: status }
      } finally {
        confirming = false
      }
    },
    unmount(): void {
      try {
        element.unmount()
      } catch {
        /* already gone */
      }
    },
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
