// ── ProbeEvent ──────────────────────────────────────────────────
// The universal unit of information. Every producer emits these.

export type ProbeEvent = {
  sessionId: string
  source: string    // 'sql' | 'fetch' | 'nav' | custom
  type: string      // 'insert' | 'request' | 'response' | ...
  timestamp: number // ms since tick start (relative)
  data: unknown
}

// ── Tick ────────────────────────────────────────────────────────
// Groups events by silence.

export type Tick = {
  id: number
  sessionId: string
  startedAt: number  // absolute timestamp
  duration: number   // ms from first event to silence
  events: ProbeEvent[]
}

// ── Action / Envelope ──────────────────────────────────────────

export type Action = {
  id: string              // unique, injected as data-fisgon="id"
  elementType: string     // 'form' | 'a' | 'button'
  textContent: string     // visible text (trimmed, truncated)
}

// ── InteractCommand ────────────────────────────────────────────

export type InteractCommand =
  | { action: 'type'; selector: string; value: string }
  | { action: 'click'; selector: string }
  | { action: 'select'; selector: string; value: string }

// ── Probe types ────────────────────────────────────────────────

export type ScopedProbe = {
  active: boolean
  sessionId: string | null
  emit(event: Omit<ProbeEvent, 'sessionId'>): void
}

export type Probe = {
  active: boolean
  fromRequest(request: Request | { headers: { cookie?: string; get?(name: string): string | null } }): ScopedProbe
  disconnect(): void
}

// ── Config ─────────────────────────────────────────────────────

export type FetchProbeConfig = {
  match: string[] // glob patterns against pathname
}

export type ProbesConfig = {
  fetch?: FetchProbeConfig
  navigation?: boolean
}

export type IdentityConfig = Record<string, { email: string; password: string }>

export type TickConfig = {
  silenceMs?: number // default 500
  maxMs?: number     // default 30000
}

export type BrowserMode = 'local' | 'remote'

export type FisgonConfig = {
  url: string
  agent?: string          // remote agent URL, e.g. 'wss://fisgon.example.workers.dev'
  identity?: IdentityConfig
  loginUrl?: string
  probes?: ProbesConfig
  tick?: TickConfig
  port?: number           // default 9876 (local mode only)
  browserMode?: BrowserMode // default 'local'
}

// ── Agent protocol messages ────────────────────────────────────

export type AgentMessage =
  // From probes → agent
  | { type: 'event'; event: ProbeEvent }
  // From CLI → agent (session-scoped commands include sessionId)
  | { type: 'start-session'; config: FisgonConfig; browserMode?: BrowserMode }
  | { type: 'stop'; sessionId: string }
  | { type: 'navigate'; sessionId: string; url: string; as?: string }
  | { type: 'actions'; sessionId: string }
  | { type: 'open'; sessionId: string; actionId: string }
  | { type: 'interact'; sessionId: string; command: InteractCommand }
  | { type: 'tick'; sessionId: string; timeout?: number }
  | { type: 'events'; sessionId: string }
  | { type: 'list-sessions' }

// From agent → clients
export type AgentResponse =
  | { type: 'session-status'; sessions: Array<{ id: string; status: string }> }
  | { type: 'session-started'; sessionId: string }
  | { type: 'session-stopped' }
  | { type: 'tick-complete'; tick: Tick }
  | { type: 'actions-result'; actions: Action[] }
  | { type: 'open-result'; html: string }
  | { type: 'navigate-result'; tick: Tick }
  | { type: 'interact-result'; success: boolean }
  | { type: 'events-result'; events: ProbeEvent[] }
  | { type: 'sessions-list'; sessions: Array<{ id: string; status: string; browserMode: string; createdAt: number }> }
  | { type: 'error'; message: string }
