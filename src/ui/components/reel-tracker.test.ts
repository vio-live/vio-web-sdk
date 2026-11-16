import { describe, expect, it } from 'vitest'
import { ReelTracker, type ReelEventFields, type ReelVideoEvent, type ReelVideoRef } from './reel-tracker.js'

/** The rules of the `video_*` events (ADR-0043), without a browser. */

const A: ReelVideoRef = { id: 'influencer', index: 0 }
const B: ReelVideoRef = { id: 'spray', index: 1 }

function setup(heartbeatSeconds?: number) {
  const out: Array<[ReelVideoEvent, string, ReelEventFields]> = []
  const t = new ReelTracker((name, video, fields) => out.push([name, video.id, fields]), { heartbeatSeconds })
  /** Plays `video` from `from` to `to` in steps of `step` seconds. */
  const run = (video: ReelVideoRef, from: number, to: number, duration: number, step = 0.25) => {
    for (let s = from; s <= to + 1e-9; s += step) t.time(video, Math.round(s * 1000) / 1000, duration)
  }
  return { t, out, run, names: () => out.map(([n, id, f]) => [n, id, f.videoPercent ?? f.watchSeconds ?? f.autoplay ?? null]) }
}

describe('ReelTracker', () => {
  it('video_start once per video, with autoplay; a resume does not start again', () => {
    const { t, names } = setup()
    t.play(A, { autoplay: true })
    t.pause(A)
    t.play(A)
    t.play(B)
    expect(names()).toEqual([
      ['video_start', 'influencer', true],
      ['video_start', 'spray', false],
    ])
  })

  it('25/50/75 once each, in order, and the end; watch time reported on pause', () => {
    const { t, run, names } = setup()
    t.play(A)
    run(A, 0, 12, 12)
    t.pause(A)
    expect(names()).toEqual([
      ['video_start', 'influencer', false],
      ['video_progress', 'influencer', 25],
      ['video_progress', 'influencer', 50],
      ['video_progress', 'influencer', 75],
      ['video_complete', 'influencer', 100],
      ['video_watch', 'influencer', 12],
    ])
  })

  it('the loop wrapping counts as the end (and fills the marks it skipped); the second lap watches but reports no new marks', () => {
    const { t, run, names } = setup()
    t.play(A)
    run(A, 0, 11.5, 12, 0.5) // reaches the last tenth, never the last 0.25 s
    t.time(A, 0.2, 12) // wrapped
    run(A, 0.5, 4, 12, 0.5)
    t.pause(A)
    expect(names().filter(([n]) => n === 'video_complete')).toEqual([['video_complete', 'influencer', 100]])
    expect(names().filter(([n]) => n === 'video_progress')).toHaveLength(3)
    const watch = names().find(([n]) => n === 'video_watch')!
    expect(watch[2]).toBeCloseTo(11.5 + 0.3 + 3.5, 1)
  })

  it('a seek (a jump of more than 2.5 s) is not watching', () => {
    const { t, run, out } = setup()
    t.play(A)
    run(A, 0, 2, 30)
    t.time(A, 20, 30) // the reader dragged forward
    run(A, 20.25, 22, 30)
    t.pause(A)
    // 0 → 2 and 20 → 22: the jump from 2 to 20 is not counted
    expect(out.filter(([n]) => n === 'video_watch').map(([, , f]) => f.watchSeconds)).toEqual([4])
  })

  it('switching video reports the first one; time updates of a video that is not playing are ignored', () => {
    const { t, run, out } = setup()
    t.play(A)
    run(A, 0, 3, 30)
    t.play(B) // swipe
    run(A, 3, 6, 30) // a late update of A: ignored
    run(B, 0, 2, 30)
    t.flush()
    expect(out.filter(([n]) => n === 'video_watch').map(([, id, f]) => [id, f.watchSeconds])).toEqual([
      ['influencer', 3],
      ['spray', 2],
    ])
  })

  it('every heartbeat of play a watch goes out; flush sends the rest; under half a second waits', () => {
    const { t, run, out } = setup(5)
    t.play(A)
    run(A, 0, 11.25, 60)
    expect(out.filter(([n]) => n === 'video_watch').map(([, , f]) => f.watchSeconds)).toEqual([5, 5])
    t.flush()
    expect(out.filter(([n]) => n === 'video_watch').map(([, , f]) => f.watchSeconds)).toEqual([5, 5, 1.3])
    run(A, 11.25, 11.5, 60) // the time keeps going after a flush: the first update only anchors
    t.flush()
    expect(out.filter(([n]) => n === 'video_watch')).toHaveLength(3)
  })

  it('video_unmute once per video', () => {
    const { t, names } = setup()
    t.unmute(A)
    t.unmute(A)
    t.unmute(B)
    expect(names()).toEqual([
      ['video_unmute', 'influencer', null],
      ['video_unmute', 'spray', null],
    ])
  })
})
