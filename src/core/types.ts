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
  fromSQL(query: string, params?: unknown[]): void
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

