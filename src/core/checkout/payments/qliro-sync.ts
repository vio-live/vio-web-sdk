/**
 * Qliro's browser-side protocol (`q1`).
 *
 * The embedded widget publishes a `q1` object on the window and calls a
 * globally-defined `q1Ready` once it has rendered. Everything the customer
 * does inside the iframe — picking a shipping method, changing their address,
 * having a payment declined — is only observable through these listeners.
 * Without them the widget is a black box: the customer can change the
 * shipping and our own summary keeps showing the old total.
 *
 * Two rules from Qliro's documentation shape this module:
 *
 * 1. **Lock before touching the backend.** Otherwise the customer can
 *    complete the purchase while the order is still being synchronized.
 * 2. **Compare before unlocking.** Otherwise a second change interrupts the
 *    synchronization of the first.
 *
 * We compare on `MerchantUpdateVersion`, the token Qliro echoes back through
 * `onOrderUpdated`, rather than on totals. Totals cannot be the test here: in
 * the modes where Qliro owns the shipping amount our total and Qliro's
 * legitimately differ, and the customer would sit locked out of a checkout
 * that is in fact up to date.
 */

import { executeCartGraphQL, type CartQueryOptions } from '../../api/cart-queries.js'

export const SYNC_PAYMENT_QLIRO_MUTATION = `
mutation SyncPaymentQliro($checkoutId: String!) {
  Payment {
    SyncPaymentQliro(checkout_id: $checkoutId) {
      order_id
      update_version
      total_price
    }
  }
}
`

export interface QliroSyncResult {
  order_id: string
  /** Token to wait for in `onOrderUpdated` before unlocking. */
  update_version: string
  total_price: number
}

export async function syncPaymentQliro(
  checkoutId: string,
  options?: CartQueryOptions,
): Promise<QliroSyncResult | null> {
  const json = await executeCartGraphQL(SYNC_PAYMENT_QLIRO_MUTATION, { checkoutId }, options)
  return (json?.data?.Payment?.SyncPaymentQliro as QliroSyncResult) ?? null
}

/** The slice of Qliro's `q1` this module uses. */
export interface Q1 {
  lock(): void
  unlock(): void
  onCheckoutLoaded(cb: () => void): void
  onOrderUpdated(cb: (order: any) => void): void
  onShippingMethodChanged(cb: (shipping: any) => void): void
  onShippingPriceChanged(cb: (price: number, totalPrice: number) => void): void
  onCustomerInfoChanged(cb: (customer: any) => void): void
  onPaymentMethodChanged(cb: (paymentMethod: any) => void): void
  onPaymentDeclined(cb: (reason: string, message?: string) => void): void
  onSessionExpired(cb: () => void): void
}

export type QliroEvent =
  | { type: 'loaded' }
  | { type: 'shipping-changed'; shipping: any }
  | { type: 'shipping-price-changed'; price: number; totalPrice: number }
  | { type: 'customer-changed'; customer: any }
  | { type: 'payment-method-changed'; paymentMethod: any }
  | { type: 'payment-declined'; reason: string; message?: string }
  | { type: 'session-expired' }
  | { type: 'sync-failed'; error: unknown }

export interface QliroListenerOptions {
  checkoutId: string
  /** Forwarded to the gateway call (sponsor key, endpoint…). */
  queryOptions?: CartQueryOptions
  /** Everything the customer does inside the iframe, for the host UI. */
  onEvent?: (event: QliroEvent) => void
  /**
   * Safety valve. If Qliro never answers a lock with `onOrderUpdated` the
   * customer would be locked out of paying entirely, so the lock is released
   * anyway after this long. Being briefly out of sync is recoverable; a
   * checkout that cannot be completed is not.
   */
  unlockTimeoutMs?: number
}

const DEFAULT_UNLOCK_TIMEOUT_MS = 15_000

export interface QliroController {
  /**
   * Push the current cart onto the Qliro order, holding the widget locked
   * throughout. Resolves once Qliro confirms it is showing this version, or
   * once the safety timeout releases the lock.
   */
  sync(): Promise<QliroSyncResult | null>
  /** Remove the listeners and release any lock still held. */
  destroy(): void
}

/**
 * Register the listeners and return a handle to synchronize the order.
 *
 * Must be called BEFORE the Qliro snippet is injected: the widget invokes
 * `window.q1Ready` once, as it finishes rendering, and never again.
 */
export function installQliroListeners(options: QliroListenerOptions): QliroController {
  const { checkoutId, queryOptions, onEvent } = options
  const unlockTimeoutMs = options.unlockTimeoutMs ?? DEFAULT_UNLOCK_TIMEOUT_MS
  const win = globalThis as any

  let q1: Q1 | null = null
  let destroyed = false
  /** `onOrderUpdated` starts a sync, so it is registered on first lock only. */
  let orderUpdatedRegistered = false
  /**
   * The synchronization in flight.
   *
   * Armed BEFORE the server call, not after. Qliro can push `onOrderUpdated`
   * the instant the PUT lands — before our own `await` continuation runs — and
   * an echo that arrives with no waiter registered is an echo lost, leaving
   * the customer locked out until the safety timeout. So echoes seen since
   * the lock are recorded, and matched against the version once we know it.
   */
  let pending: {
    version: string | null
    echoes: Array<string | null>
    resolve: () => void
    timer: any
  } | null = null

  const emit = (event: QliroEvent): void => {
    try {
      onEvent?.(event)
    } catch {
      /* a host listener must never break the checkout */
    }
  }

  const settle = (): void => {
    if (!pending) return
    clearTimeout(pending.timer)
    const { resolve } = pending
    pending = null
    try {
      q1?.unlock()
    } catch {
      /* the widget may already be gone */
    }
    resolve()
  }

  /**
   * Does an echo acknowledge the version we are waiting for?
   *
   * An echo with no version at all counts: orders created before
   * `MerchantUpdateVersion` existed still report updates, and an update is an
   * update. An echo naming a DIFFERENT version does not — that is someone
   * else's synchronization, or an older one of ours.
   */
  const acknowledges = (echo: string | null, version: string | null): boolean => {
    // Our version is not known until the server answers. An echo that arrives
    // before that is kept, not accepted: accepting it would unlock on a stale
    // update that happens to land in the same window.
    if (version === null) return false
    return !echo || echo === version
  }

  /** Settle if anything seen since the lock already acknowledged the version. */
  const settleIfAcknowledged = (): void => {
    if (!pending) return
    if (pending.echoes.some((echo) => acknowledges(echo, pending!.version))) {
      settle()
    }
  }

  const previousQ1Ready = win.q1Ready
  win.q1Ready = (instance: Q1) => {
    // Another q1Ready may already be installed on the page (a second widget,
    // or the host's own). Chain rather than clobber.
    try {
      previousQ1Ready?.(instance)
    } catch {
      /* not ours to fix */
    }
    if (destroyed) return
    q1 = instance

    instance.onCheckoutLoaded(() => emit({ type: 'loaded' }))

    // NOT registered here. Qliro's own words: "onOrderUpdated() — Requires
    // q1.lock() to have been called first. Initiates the order sync process
    // towards the checkout front end." Registering it is not passive: it puts
    // the widget INTO a synchronization it then waits to complete. Registered
    // at ready, with no lock and no update coming, the widget sits on a
    // loading panel and polls its orders endpoint forever — observed on a live
    // page as a request storm and a checkout that never advanced.
    //
    // So it is registered lazily, inside `sync()`, right after the lock — the
    // order their documentation actually describes.

    // Qliro owns the shipping choice: it is made inside the widget, and Qliro
    // writes the resulting line onto the order itself. These are reported so
    // the host summary can show the same total the customer is looking at —
    // not to overrule the choice.
    instance.onShippingMethodChanged((shipping: any) =>
      emit({ type: 'shipping-changed', shipping }),
    )
    instance.onShippingPriceChanged((price: number, totalPrice: number) =>
      emit({ type: 'shipping-price-changed', price, totalPrice }),
    )
    instance.onCustomerInfoChanged((customer: any) =>
      emit({ type: 'customer-changed', customer }),
    )
    instance.onPaymentMethodChanged((paymentMethod: any) =>
      emit({ type: 'payment-method-changed', paymentMethod }),
    )
    instance.onPaymentDeclined((reason: string, message?: string) =>
      emit({ type: 'payment-declined', reason, message }),
    )

    // A checkout session lasts 90 minutes; the order itself lasts 48 hours.
    // Updating the order mints a new session, which is exactly what `sync`
    // does — so the recovery from an expired session is a sync.
    instance.onSessionExpired(() => {
      emit({ type: 'session-expired' })
      void controller.sync()
    })
  }

  const controller: QliroController = {
    async sync(): Promise<QliroSyncResult | null> {
      if (destroyed) return null
      // A synchronization already in flight owns the lock; releasing it here
      // would let the customer pay against a half-updated order.
      if (pending) settle()

      // Qliro's first rule: lock before touching our server, so the customer
      // cannot complete the purchase mid-synchronization.
      try {
        q1?.lock()
        // Only now, and only once: see the note where the other listeners are
        // registered. Registering this one starts a synchronization, so it
        // must not exist before there is one.
        if (q1 && !orderUpdatedRegistered) {
          orderUpdatedRegistered = true
          q1.onOrderUpdated((order: any) => {
            if (!pending) return
            const echoed: string | null =
              order?.merchantUpdateVersion ?? order?.MerchantUpdateVersion ?? null
            pending.echoes.push(echoed)
            settleIfAcknowledged()
          })
        }
      } catch {
        /* no widget yet — the sync still has to reach the server */
      }
      // Armed before the call so an echo that races the response is caught.
      const settled = new Promise<void>((resolve) => {
        pending = {
          version: null,
          echoes: [],
          resolve,
          timer: setTimeout(settle, unlockTimeoutMs),
        }
      })

      let result: QliroSyncResult | null = null
      try {
        result = await syncPaymentQliro(checkoutId, queryOptions)
      } catch (error) {
        emit({ type: 'sync-failed', error })
        settle()
        await settled
        return null
      }
      if (destroyed || !result?.update_version || !q1) {
        settle()
        await settled
        return result
      }
      // Qliro's second rule: unlock only once the orders match.
      if (pending) {
        pending.version = result.update_version
        settleIfAcknowledged()
      }
      await settled
      return result
    },

    destroy(): void {
      destroyed = true
      settle()
      if (win.q1Ready) win.q1Ready = previousQ1Ready
      q1 = null
    },
  }

  return controller
}
