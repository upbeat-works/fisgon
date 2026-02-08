import { AgentClient } from 'agents/client'

import { type AgentState } from '../agent/session-state.js'
import { type Probe, type ScopedProbe, type ProbeEvent } from '../core/types.js'
import { parseSQL } from './sql-parser.js'

type CreateProbeOptions = {
	url: string // e.g. 'ws://localhost:9876' or 'wss://fisgon.example.workers.dev'
	env?: string // DO instance name, e.g. 'staging', 'pr-123'. Default: 'default'
}

const NOOP_SCOPED: ScopedProbe = {
	active: false,
	sessionId: null,
	emit() {},
	fromSQL() {},
}

export function createProbe(options: CreateProbeOptions): Probe {
	const activeSessions = new Set<string>()

	const parsedUrl = new URL(options.url)
	const host = parsedUrl.host
	const protocol = parsedUrl.protocol === 'wss:' ? 'wss' : 'ws'
	const envName = options.env ?? 'default'

	const client = new AgentClient<AgentState>({
		agent: 'fisgon',
		name: envName,
		host,
		protocol: protocol as 'ws' | 'wss',
		query: { role: 'server-probe' },
		onStateUpdate(state) {
			// Agent broadcasts activeSessionIds whenever sessions start/stop
			activeSessions.clear()
			for (const id of state.activeSessionIds) {
				activeSessions.add(id)
			}
		},
	})

	return {
		get active() {
			return activeSessions.size > 0
		},

		fromRequest(request) {
			if (activeSessions.size === 0) return NOOP_SCOPED

			// Read the fisgon cookie from the request
			let cookieHeader: string | null = null

			if (request instanceof Request) {
				cookieHeader = request.headers.get('cookie')
			} else if (request.headers) {
				if (typeof request.headers.get === 'function') {
					cookieHeader = request.headers.get('cookie')
				} else {
					cookieHeader =
						(request.headers as { cookie?: string }).cookie ?? null
				}
			}

			if (!cookieHeader) return NOOP_SCOPED

			const sessionId = parseCookie(cookieHeader, 'fisgon')
			if (!sessionId || !activeSessions.has(sessionId)) return NOOP_SCOPED

			return {
				active: true,
				sessionId,
				emit(event: Omit<ProbeEvent, 'sessionId'>) {
					const fullEvent: ProbeEvent = { ...event, sessionId }
					// Use RPC to push events to the agent
					client.call('emitEvent', [fullEvent]).catch(() => {
						// Silently drop if the call fails
					})
				},
				fromSQL(query: string, _params?: unknown[]) {
					const parsed = parseSQL(query)
					const fullEvent: ProbeEvent = {
						sessionId,
						source: 'sql',
						type: parsed.operation,
						timestamp: Date.now(),
						data: { table: parsed.table },
					}
					client.call('emitEvent', [fullEvent]).catch(() => {
						// Silently drop if the call fails
					})
				},
			}
		},

		disconnect() {
			client.close()
			activeSessions.clear()
		},
	}
}

function parseCookie(header: string, name: string): string | null {
	const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
	return match ? match[1] : null
}
