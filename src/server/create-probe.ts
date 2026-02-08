import { agentFetch } from 'agents/client'

import { type Probe, type ScopedProbe, type ProbeEvent } from '../core/types.js'
import { parseSQL } from './sql-parser.js'

type CreateProbeOptions = {
	url: string // e.g. 'http://localhost:9876' or 'https://fisgon.example.workers.dev'
	env?: string // DO instance name, e.g. 'staging', 'pr-123'. Default: 'default'
}

const NOOP_SCOPED: ScopedProbe = {
	active: false,
	sessionId: null,
	emit() {},
	fromSQL() {},
}

export function createProbe(options: CreateProbeOptions): Probe {
	const parsedUrl = new URL(options.url)
	const host = parsedUrl.host
	const envName = options.env ?? 'default'

	function sendEvent(event: ProbeEvent) {
		agentFetch(
			{ agent: 'fisgon', name: envName, host },
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ type: 'ingest-event', event }),
			},
		).catch(() => {})
	}

	return {
		get active() {
			// With fetch-based probe, we're always "active" — the agent will
			// discard events for unknown sessions on its end.
			return true
		},

		fromRequest(request) {
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
			if (!sessionId) return NOOP_SCOPED

			return {
				active: true,
				sessionId,
				emit(event: Omit<ProbeEvent, 'sessionId'>) {
					sendEvent({ ...event, sessionId })
				},
				fromSQL(query: string, _params?: unknown[]) {
					const parsed = parseSQL(query)
					sendEvent({
						sessionId,
						source: 'sql',
						type: parsed.operation,
						timestamp: Date.now(),
						data: { table: parsed.table },
					})
				},
			}
		},

		disconnect() {
			// Nothing to close with fetch-based approach
		},
	}
}

function parseCookie(header: string, name: string): string | null {
	const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
	return match ? match[1] : null
}
