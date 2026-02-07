import WebSocket from 'ws'

import { type Probe, type ScopedProbe, type ProbeEvent } from '../core/types.js'

type CreateProbeOptions = {
	url: string // e.g. 'ws://localhost:9876' or 'wss://fisgon.example.workers.dev'
	env?: string // DO instance name, e.g. 'staging', 'pr-123'. Default: 'default'
}

const NOOP_SCOPED: ScopedProbe = {
	active: false,
	sessionId: null,
	emit() {},
}

export function createProbe(options: CreateProbeOptions): Probe {
	let ws: WebSocket | null = null
	// Multiple sessions can be active concurrently — track all of them
	const activeSessions = new Set<string>()
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null

	const envName = options.env ?? 'default'

	function getWsUrl() {
		const base = options.url.replace(/\/$/, '')
		return `${base}/agents/fisgon/${envName}?role=server-probe`
	}

	function connect() {
		try {
			ws = new WebSocket(getWsUrl())

			ws.on('open', () => {
				// Wait for session-status from agent
			})

			ws.on('message', (data: WebSocket.RawData) => {
				try {
					const msg = JSON.parse(data.toString())
					if (msg.type === 'session-status' && Array.isArray(msg.sessions)) {
						// Full list of active sessions
						activeSessions.clear()
						for (const s of msg.sessions as Array<{ id: string; status: string }>) {
							if (s.status === 'active') {
								activeSessions.add(s.id)
							}
						}
					}
				} catch {
					// Ignore malformed messages
				}
			})

			ws.on('close', () => {
				activeSessions.clear()
				ws = null
				reconnectTimer = setTimeout(connect, 2000)
			})

			ws.on('error', () => {
				ws?.close()
			})
		} catch {
			reconnectTimer = setTimeout(connect, 5000)
		}
	}

	connect()

	return {
		get active() {
			return activeSessions.size > 0
		},

		fromRequest(request) {
			if (activeSessions.size === 0 || !ws) return NOOP_SCOPED

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

			const wsRef = ws
			return {
				active: true,
				sessionId,
				emit(event: Omit<ProbeEvent, 'sessionId'>) {
					if (wsRef?.readyState !== WebSocket.OPEN) return
					const fullEvent: ProbeEvent = { ...event, sessionId }
					wsRef.send(JSON.stringify({ type: 'event', event: fullEvent }))
				},
			}
		},

		disconnect() {
			if (reconnectTimer) clearTimeout(reconnectTimer)
			ws?.close()
			ws = null
			activeSessions.clear()
		},
	}
}

function parseCookie(header: string, name: string): string | null {
	const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
	return match ? match[1] : null
}
