/**
 * Checkout types — multi-sponsor compatible.
 *
 * Each checkout is scoped to a single sponsor (one transaction = one
 * merchant, same as iOS multi-sponsor model). Multiple sponsors → multiple
 * sequential checkouts.
 */

export type PaymentMethod = 'apple-pay' | 'klarna' | 'vipps' | 'card' | 'stripe' | 'kustom' | 'qliro'

export interface CheckoutAddress {
  firstName: string
  lastName: string
  email: string
  address: string
  postalCode: string
  city: string
  country?: string
}

export interface CheckoutState {
  /** Sponsor id whose cart is being checked out. */
  sponsorId: number
  /** Remote checkout id from Vio Commerce (set after CreateCheckout). */
  remoteId?: string
  /** Snapshot of the delivery address. */
  address?: CheckoutAddress
  /** Selected payment method. */
  paymentMethod?: PaymentMethod
  /** Subtotal at open time (numeric). */
  subtotal: number
  /** Currency code. */
  currency: string
  /** Backend checkout id (Vio Commerce CreateCheckout). */
  checkoutId?: string
  /** Full backend checkout payload (untyped upstream). */
  checkout?: unknown
  /** Klarna Payments session id (native GraphQL flow). */
  sessionId?: string
  /** Klarna Payments client token (native GraphQL flow). */
  clientToken?: string
}
