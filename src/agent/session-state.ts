// SQLite-backed session state. The Agent's in-memory state is minimal —
// sessions, events, and ticks live in SQLite for persistence and queryability.

export type SessionRow = {
	id: string
	status: string // 'active' | 'stopping' | 'stopped'
	browser_mode: string // 'local' | 'remote'
	config: string // JSON
	created_at: number
	updated_at: number
}

export type EventRow = {
	id: number
	session_id: string
	tick_id: number | null
	source: string
	type: string
	timestamp: number
	data: string // JSON
}

export type TickRow = {
	id: number
	session_id: string
	started_at: number
	duration: number
}

// Broadcasted to all connected clients (CLI, server probes) via onStateUpdate.
// Server probes use activeSessionIds to know which cookies to match.
export type AgentState = {
	activeSessionIds: string[]
}

export const initialAgentState: AgentState = {
	activeSessionIds: [],
}
