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

// Minimal in-memory state — just tracks what's broadcasted to clients
export type AgentState = {
	activeSessions: number
}

export const initialAgentState: AgentState = {
	activeSessions: 0,
}
