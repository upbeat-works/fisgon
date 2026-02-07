import  { type ProbeEvent, type Tick } from './types.js'

export type TickDetectorOptions = {
  silenceMs?: number
  maxMs?: number
  onTick: (tick: Tick) => void
}

export class TickDetector {
  private silenceMs: number
  private maxMs: number
  private onTick: (tick: Tick) => void

  private currentEvents: ProbeEvent[] = []
  private silenceTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private tickCount = 0
  private sessionId: string | null = null

  constructor(options: TickDetectorOptions) {
    this.silenceMs = options.silenceMs ?? 500
    this.maxMs = options.maxMs ?? 30000
    this.onTick = options.onTick
  }

  setSession(sessionId: string | null) {
    this.sessionId = sessionId
    this.reset()
  }

  ingest(event: ProbeEvent) {
    this.currentEvents.push(event)

    // Start max timer on first event
    if (this.currentEvents.length === 1) {
      this.maxTimer = setTimeout(() => {
        this.completeTick()
      }, this.maxMs)
    }

    // Reset silence timer on every event
    this.resetSilenceTimer()
  }

  private resetSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => {
      this.completeTick()
    }, this.silenceMs)
  }

  private completeTick() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.silenceTimer = null
    this.maxTimer = null

    const events = this.currentEvents
    if (events.length === 0) return

    const tick: Tick = {
      id: this.tickCount++,
      sessionId: this.sessionId ?? '',
      startedAt: events[0].timestamp,
      duration: events[events.length - 1].timestamp - events[0].timestamp,
      events,
    }

    this.currentEvents = []
    this.onTick(tick)
  }

  get pending(): boolean {
    return this.currentEvents.length > 0
  }

  reset() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.silenceTimer = null
    this.maxTimer = null
    this.currentEvents = []
    this.tickCount = 0
  }
}
