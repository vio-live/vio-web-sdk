/**
 * Keeps ONE `Vio.registerSlot()` registration in step with an element's
 * `vio-slot` (ADR-0027 / ADR-0034).
 *
 * The attribute is not always there at `connectedCallback`: the React wrappers
 * set properties after the element is mounted, and a host may change the slot
 * later (the Vev editor, as the designer types). So the elements call `sync()`
 * from both `connectedCallback` and `updated()`, and `clear()` on disconnect.
 * Registering never throws into the element — a slot is attribution, not
 * rendering.
 */

import { Vio } from '../core/client.js'

export class SlotRegistration {
  private name = ''
  private release: (() => void) | null = null

  /** The slot name currently registered ('' when none). */
  get current(): string {
    return this.name
  }

  /** Register `name` (unregistering the previous one when it changed). */
  sync(name: string | null | undefined): void {
    const next = typeof name === 'string' ? name.trim() : ''
    if (next === this.name) return
    this.clear()
    if (!next) return
    try {
      this.release = Vio.registerSlot(next)
      this.name = next
    } catch {
      this.release = null
      this.name = ''
    }
  }

  /** Unregister whatever is registered. */
  clear(): void {
    try {
      this.release?.()
    } catch {
      /* never break the element */
    }
    this.release = null
    this.name = ''
  }
}
