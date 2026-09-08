import { describe, it, expect } from 'vitest'

/**
 * The livelock, reduced to its shape.
 *
 * `autoSelectSoleMethod` asks the manager to select the only method. If the
 * selection does not stick, the state change reloads the method list, which
 * calls it again — and each pass remounts the provider's widget. Observed on
 * a live page as hundreds of requests to Qliro's orders endpoint.
 *
 * The guard makes the attempt idempotent per opening, so a selection that
 * never sticks costs one attempt instead of an unbounded loop.
 */
class Loop {
  attempted = false
  selections = 0
  constructor(
    private readonly guarded: boolean,
    /** false models `selectPaymentMethod` not taking effect. */
    private readonly selectionSticks: boolean,
  ) {}
  private method: string | null = null

  autoSelect(depth = 0): void {
    if (depth > 50) return // stand-in for "runs forever"
    if (this.guarded) {
      if (this.attempted) return
      this.attempted = true
    }
    if (this.method) return
    this.selections++
    if (this.selectionSticks) this.method = 'qliro'
    // The state change that a selection triggers reloads the list, which is
    // what calls back into here.
    this.autoSelect(depth + 1)
  }
}

describe('auto-select must not livelock', () => {
  it('selects once when the selection sticks', () => {
    const l = new Loop(true, true)
    l.autoSelect()
    expect(l.selections).toBe(1)
  })

  it('selects ONCE even when the selection never sticks', () => {
    const l = new Loop(true, false)
    l.autoSelect()
    expect(l.selections).toBe(1)
  })

  it('without the guard it spins — this is what shipped and broke', () => {
    const l = new Loop(false, false)
    l.autoSelect()
    expect(l.selections).toBeGreaterThan(10)
  })

  it('a fresh opening may attempt again', () => {
    const l = new Loop(true, false)
    l.autoSelect()
    l.attempted = false // what closing the overlay does
    l.autoSelect()
    expect(l.selections).toBe(2)
  })
})
