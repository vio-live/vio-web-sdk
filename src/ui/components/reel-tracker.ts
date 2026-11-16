/**
 * What the reader does with each video of a shoppable reel (ADR-0043) →
 * the `video_*` events of the analytics contract. No DOM: `<vio-reel>` tells
 * it what its <video> elements do and it decides what to report, so the
 * rules are tested without a browser. A host's own player (Replit) follows
 * the same rules (README «Shoppable reel»):
 *
 *   video_start     first play of the video in this page view (autoplay
 *                   counts; `autoplay` says which). Once per video.
 *   video_progress  25 / 50 / 75 % of its length reached, once per mark.
 *   video_complete  its end reached the first time — a jump from the last
 *                   tenth to the first one is the loop wrapping, and counts as
 *                   the end too (the reel loops). Once per video.
 *   video_watch     seconds actually played since the last report: the
 *                   advance of `currentTime` between time updates (a jump of
 *                   more than 2.5 s is a seek, not watching). Sent when the
 *                   video stops (pause, another video, `flush`) and every
 *                   `heartbeatSeconds` of play. Never a running total.
 *   video_unmute    the reader turned the sound on, once per video.
 */

export interface ReelVideoRef {
  /** The video's id in the experience. */
  id: string
  /** Its 0-based position in the reel. */
  index: number
}

export type ReelVideoEvent = 'video_start' | 'video_progress' | 'video_complete' | 'video_watch' | 'video_unmute'

export interface ReelEventFields {
  videoPercent?: 25 | 50 | 75 | 100
  watchSeconds?: number
  autoplay?: boolean
}

export type ReelEmit = (name: ReelVideoEvent, video: ReelVideoRef, fields: ReelEventFields) => void

export interface ReelTrackerOptions {
  /** Report the watch time every this many seconds of play (default 30). */
  heartbeatSeconds?: number
}

/** A jump of `currentTime` larger than this between two updates is a seek. */
const MAX_STEP_SECONDS = 2.5
/** Less than this is not worth an event (a flicker, a frame). */
const MIN_WATCH_SECONDS = 0.5
const MARKS = [25, 50, 75] as const

interface Playing {
  video: ReelVideoRef
  /** The last `currentTime` seen while playing; null after a pause or a jump. */
  last: number | null
}

export class ReelTracker {
  private readonly started = new Set<string>()
  private readonly marks = new Map<string, Set<number>>()
  private readonly completed = new Set<string>()
  private readonly unmuted = new Set<string>()
  /** Seconds played and not reported yet, per video. */
  private readonly pending = new Map<string, { video: ReelVideoRef; seconds: number }>()
  private playing: Playing | null = null
  private readonly heartbeat: number

  constructor(
    private readonly emit: ReelEmit,
    options: ReelTrackerOptions = {},
  ) {
    this.heartbeat = options.heartbeatSeconds ?? 30
  }

  /** The video started (or resumed) playing. */
  play(video: ReelVideoRef, { autoplay = false }: { autoplay?: boolean } = {}): void {
    if (this.playing && this.playing.video.id !== video.id) this.stop(this.playing.video)
    if (!this.playing || this.playing.video.id !== video.id) this.playing = { video, last: null }
    if (!this.started.has(video.id)) {
      this.started.add(video.id)
      this.emit('video_start', video, { autoplay })
    }
  }

  /** A time update of the playing video. Ignored for any other video. */
  time(video: ReelVideoRef, currentTime: number, duration: number): void {
    const p = this.playing
    if (!p || p.video.id !== video.id || !Number.isFinite(currentTime)) return
    const hasLength = Number.isFinite(duration) && duration > 0
    if (p.last !== null) {
      const step = currentTime - p.last
      if (step > 0 && step <= MAX_STEP_SECONDS) this.add(video, step)
      // The loop wrapped: from the last tenth back to the first one.
      else if (step < 0 && hasLength && p.last >= duration * 0.9 && currentTime <= duration * 0.1) this.complete(video)
    }
    p.last = currentTime
    if (hasLength) {
      const pct = (currentTime / duration) * 100
      for (const m of MARKS) if (pct >= m) this.mark(video, m)
      if (pct >= 99 || duration - currentTime <= 0.25) this.complete(video)
    }
    const owed = this.pending.get(video.id)
    if (owed && owed.seconds >= this.heartbeat) this.report(video.id)
  }

  /** The video paused (or stopped being the one on screen): report what it played. */
  pause(video: ReelVideoRef): void {
    if (this.playing?.video.id === video.id) this.stop(video)
  }

  /** The reader turned the sound on while this video was the one on screen. */
  unmute(video: ReelVideoRef): void {
    if (this.unmuted.has(video.id)) return
    this.unmuted.add(video.id)
    this.emit('video_unmute', video, {})
  }

  /** Report every second played and not reported yet (the page hides, the reel goes away). */
  flush(): void {
    if (this.playing) this.playing.last = null
    for (const id of [...this.pending.keys()]) this.report(id)
  }

  private stop(video: ReelVideoRef): void {
    this.report(video.id)
    if (this.playing?.video.id === video.id) this.playing = null
  }

  private add(video: ReelVideoRef, seconds: number): void {
    const owed = this.pending.get(video.id) ?? { video, seconds: 0 }
    owed.seconds += seconds
    this.pending.set(video.id, owed)
  }

  private report(id: string): void {
    const owed = this.pending.get(id)
    if (!owed || owed.seconds < MIN_WATCH_SECONDS) return
    this.pending.delete(id)
    this.emit('video_watch', owed.video, { watchSeconds: Math.min(3600, Math.round(owed.seconds * 10) / 10) })
  }

  private mark(video: ReelVideoRef, m: (typeof MARKS)[number]): void {
    const seen = this.marks.get(video.id) ?? new Set<number>()
    if (seen.has(m)) return
    seen.add(m)
    this.marks.set(video.id, seen)
    this.emit('video_progress', video, { videoPercent: m })
  }

  private complete(video: ReelVideoRef): void {
    if (this.completed.has(video.id)) return
    for (const m of MARKS) this.mark(video, m)
    this.completed.add(video.id)
    this.emit('video_complete', video, { videoPercent: 100 })
  }
}
