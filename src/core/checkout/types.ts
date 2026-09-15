/**
 * Checkout types — multi-sponsor compatible.
 *
 * Each checkout is scoped to a single sponsor (one transaction = one
 * merchant, same as iOS multi-sponsor model). Multiple sponsors → multiple
 * sequential checkouts.
 */

export type PaymentMethod = 'apple-pay' | 'klarna' | 'vipps' | 'card' | 'stripe' | 'kustom' | 'qliro' | 'walley'

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
  /**
   * Which `open()` this state belongs to — a new number every time a checkout
   * is opened, kept by every later update. An embedded widget belongs to the
   * session it was mounted in: a new session means a new order.
   */
  session?: number
}
