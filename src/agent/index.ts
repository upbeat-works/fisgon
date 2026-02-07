import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents'

import { TickDetector } from '../core/tick-detector.js'
import {
	type ProbeEvent,
	type Tick,
	type AgentMessage,
	type AgentResponse,
	type FisgonConfig,
	type Action,
	type InteractCommand,
	type BrowserMode,
} from '../core/types.js'

import { type BrowserCommand, type BrowserResult } from './browser-bridge.js'
import { type AgentState, type SessionRow, type EventRow, type TickRow, initialAgentState } from './session-state.js'

type ConnectionState = {
	role: 'cli' | 'browser-probe' | 'server-probe'
	sessionId: string | null
	connectedAt: number
}

type SessionRuntime = {
	tickDetector: TickDetector
	cliConnection: Connection | null
	browserMode: BrowserMode
	pendingBrowserCallbacks: Map<string, {
		resolve: (data: unknown) => void
		reject: (error: Error) => void
	}>
	browserCommandId: number
	pendingTickResolvers: Array<(tick: Tick) => void>
}

export class FisgonAgent extends Agent<Cloudflare.Env, AgentState> {
	initialState: AgentState = { ...initialAgentState }

	// Per-session in-memory runtime (not persisted — rebuilt on connect)
	private sessions = new Map<string, SessionRuntime>()

	private dbInitialized = false

	// ── Database setup ──────────────────────────────────────────

	private initDb() {
		if (this.dbInitialized) return
		this.sql`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL DEFAULT 'active',
				browser_mode TEXT NOT NULL DEFAULT 'local',
				config TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`
		this.sql`
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				tick_id INTEGER,
				source TEXT NOT NULL,
				type TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				data TEXT
			)
		`
		this.sql`
			CREATE TABLE IF NOT EXISTS ticks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				duration INTEGER NOT NULL
			)
		`
		this.sql`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`
		this.sql`CREATE INDEX IF NOT EXISTS idx_events_tick ON events(tick_id)`
		this.sql`CREATE INDEX IF NOT EXISTS idx_ticks_session ON ticks(session_id)`
		this.dbInitialized = true
	}

	// ── Connection lifecycle ────────────────────────────────────

	async onConnect(connection: Connection, ctx: ConnectionContext) {
		this.initDb()

		const url = new URL(ctx.request.url)
		const role = (url.searchParams.get('role') ?? 'cli') as ConnectionState['role']
		const sessionId = url.searchParams.get('sessionId')

		connection.setState({
			role,
			sessionId,
			connectedAt: Date.now(),
		} satisfies ConnectionState)

		if (role === 'server-probe') {
			// Send list of active sessions so the probe knows what cookies to look for
			const activeSessions = this.sql<SessionRow>`
				SELECT id, status FROM sessions WHERE status = 'active'
			`
			this.send(connection, {
				type: 'session-status',
				sessions: activeSessions.map((s) => ({ id: s.id, status: s.status })),
			})
		}

		if (role === 'cli' && sessionId) {
			// Associate this CLI connection with its session runtime
			const runtime = this.sessions.get(sessionId)
			if (runtime) {
				runtime.cliConnection = connection
			}
		}
	}

	async onClose(connection: Connection) {
		const connState = connection.state as ConnectionState | undefined
		if (connState?.role === 'cli' && connState.sessionId) {
			const runtime = this.sessions.get(connState.sessionId)
			if (runtime?.cliConnection?.id === connection.id) {
				runtime.cliConnection = null
			}
		}
	}

	async onMessage(connection: Connection, message: WSMessage) {
		this.initDb()

		const text = typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer)
		let msg: (AgentMessage & { requestId?: string }) | (BrowserResult & { commandId?: string })

		try {
			msg = JSON.parse(text)
		} catch {
			this.send(connection, { type: 'error', message: 'Invalid JSON' })
			return
		}

		// Handle browser results from CLI (local mode)
		if ('commandId' in msg && msg.type === 'browser-result') {
			this.handleBrowserResult(msg as BrowserResult & { commandId: string }, connection)
			return
		}

		const agentMsg = msg as AgentMessage & { requestId?: string }
		const requestId = agentMsg.requestId

		switch (agentMsg.type) {
			case 'event':
				this.ingestEvent(agentMsg.event)
				break

			case 'start-session':
				this.startSession(agentMsg.config, agentMsg.browserMode ?? 'local', connection, requestId)
				break

			case 'stop':
				await this.stopSession(agentMsg.sessionId, connection, requestId)
				break

			case 'navigate':
				await this.handleNavigate(agentMsg.sessionId, agentMsg.url, agentMsg.as, connection, requestId)
				break

			case 'actions':
				await this.handleActions(agentMsg.sessionId, connection, requestId)
				break

			case 'open':
				await this.handleOpen(agentMsg.sessionId, agentMsg.actionId, connection, requestId)
				break

			case 'interact':
				await this.handleInteract(agentMsg.sessionId, agentMsg.command, connection, requestId)
				break

			case 'tick':
				await this.handleWaitForTick(agentMsg.sessionId, agentMsg.timeout, connection, requestId)
				break

			case 'events':
				this.handleGetEvents(agentMsg.sessionId, connection, requestId)
				break

			case 'list-sessions':
				this.handleListSessions(connection, requestId)
				break

			default:
				this.send(connection, { type: 'error', message: `Unknown message type: ${(agentMsg as { type: string }).type}` })
		}
	}

	// ── Event ingestion ─────────────────────────────────────────

	private ingestEvent(event: ProbeEvent) {
		const runtime = this.sessions.get(event.sessionId)
		if (!runtime) return

		// Verify session is active in DB
		const [session] = this.sql<SessionRow>`
			SELECT status FROM sessions WHERE id = ${event.sessionId}
		`
		if (!session || session.status !== 'active') return

		// Store event in SQLite (tick_id null until tick completes)
		this.sql`
			INSERT INTO events (session_id, source, type, timestamp, data)
			VALUES (${event.sessionId}, ${event.source}, ${event.type}, ${event.timestamp}, ${JSON.stringify(event.data)})
		`

		runtime.tickDetector.ingest(event)
	}

	private handleTickComplete(sessionId: string, tick: Tick) {
		// Create tick in DB
		this.sql`
			INSERT INTO ticks (session_id, started_at, duration)
			VALUES (${sessionId}, ${tick.startedAt}, ${tick.duration})
		`

		// Get the tick ID
		const [tickRow] = this.sql<TickRow>`
			SELECT id FROM ticks WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT 1
		`
		const tickId = tickRow.id

		// Update tick ID with the actual DB-assigned ID
		tick.id = tickId

		// Associate buffered events with this tick
		this.sql`
			UPDATE events SET tick_id = ${tickId}
			WHERE session_id = ${sessionId} AND tick_id IS NULL
		`

		// Resolve pending tick waiters
		const runtime = this.sessions.get(sessionId)
		if (runtime) {
			for (const resolve of runtime.pendingTickResolvers) {
				resolve(tick)
			}
			runtime.pendingTickResolvers = []
		}

		// Notify CLI for this session
		this.broadcastToSession(sessionId, { type: 'tick-complete', tick })
	}

	// ── Session lifecycle ───────────────────────────────────────

	private startSession(config: FisgonConfig, browserMode: BrowserMode, connection: Connection, requestId?: string) {
		const sessionId = crypto.randomUUID()
		const now = Date.now()

		// Insert into SQLite
		this.sql`
			INSERT INTO sessions (id, status, browser_mode, config, created_at, updated_at)
			VALUES (${sessionId}, 'active', ${browserMode}, ${JSON.stringify(config)}, ${now}, ${now})
		`

		// Create in-memory runtime
		const runtime: SessionRuntime = {
			tickDetector: new TickDetector({
				silenceMs: config.tick?.silenceMs,
				maxMs: config.tick?.maxMs,
				onTick: (tick) => this.handleTickComplete(sessionId, tick),
			}),
			cliConnection: connection,
			browserMode,
			pendingBrowserCallbacks: new Map(),
			browserCommandId: 0,
			pendingTickResolvers: [],
		}
		runtime.tickDetector.setSession(sessionId)
		this.sessions.set(sessionId, runtime)

		// Update connection state with session ID
		connection.setState({
			...(connection.state as ConnectionState),
			sessionId,
		})

		// Update broadcast state
		this.setState({ activeSessions: this.sessions.size })

		// Notify server probes of new active session
		this.broadcastToRole('server-probe', {
			type: 'session-status',
			sessions: [{ id: sessionId, status: 'active' }],
		})

		this.sendWithRequestId(connection, { type: 'session-started', sessionId }, requestId)
	}

	private async stopSession(sessionId: string, connection: Connection, requestId?: string) {
		const runtime = this.sessions.get(sessionId)
		if (!runtime) {
			this.send(connection, { type: 'error', message: `Session not found: ${sessionId}` })
			return
		}

		// Update DB
		this.sql`
			UPDATE sessions SET status = 'stopped', updated_at = ${Date.now()}
			WHERE id = ${sessionId}
		`

		// Close browser
		if (runtime.browserMode === 'local' && runtime.cliConnection) {
			try {
				await this.sendBrowserCommand(runtime, { type: 'browser-close' })
			} catch {
				// Browser might already be closed
			}
		}
		// TODO: close Browser Rendering browser for remote mode

		// Cleanup runtime
		runtime.tickDetector.reset()
		this.sessions.delete(sessionId)

		this.setState({ activeSessions: this.sessions.size })

		// Notify server probes
		this.broadcastToRole('server-probe', {
			type: 'session-status',
			sessions: this.getActiveSessionsList(),
		})

		this.sendWithRequestId(connection, { type: 'session-stopped' }, requestId)
	}

	// ── Command handlers ────────────────────────────────────────

	private getRuntime(sessionId: string, connection: Connection): SessionRuntime | null {
		const runtime = this.sessions.get(sessionId)
		if (!runtime) {
			this.send(connection, { type: 'error', message: `Session not found: ${sessionId}` })
			return null
		}
		return runtime
	}

	private async handleNavigate(sessionId: string, url: string, asIdentity: string | undefined, connection: Connection, requestId?: string) {
		const runtime = this.getRuntime(sessionId, connection)
		if (!runtime) return

		const [session] = this.sql<SessionRow>`SELECT config FROM sessions WHERE id = ${sessionId}`
		const config: FisgonConfig = JSON.parse(session.config)

		try {
			// If --as is provided, log in first
			if (asIdentity && config.identity && config.loginUrl) {
				const creds = config.identity[asIdentity]
				if (!creds) {
					this.send(connection, { type: 'error', message: `Unknown identity: ${asIdentity}` })
					return
				}

				await this.sendBrowserCommand(runtime, { type: 'browser-navigate', url: config.loginUrl })
				const actions = await this.sendBrowserCommand(runtime, { type: 'browser-actions' }) as Action[]
				const loginForm = actions.find((a) => a.elementType === 'form')

				if (loginForm) {
					await this.sendBrowserCommand(runtime, { type: 'browser-open', actionId: loginForm.id })
					const sel = `[data-fisgon='${loginForm.id}']`
					await this.sendBrowserCommand(runtime, {
						type: 'browser-interact',
						command: { action: 'type', selector: `${sel} input[name='email'], ${sel} input[type='email']`, value: creds.email },
					})
					await this.sendBrowserCommand(runtime, {
						type: 'browser-interact',
						command: { action: 'type', selector: `${sel} input[name='password'], ${sel} input[type='password']`, value: creds.password },
					})
					await this.sendBrowserCommand(runtime, {
						type: 'browser-interact',
						command: { action: 'click', selector: `${sel} button[type='submit'], ${sel} input[type='submit']` },
					})

					await this.waitForTick(runtime, 10000)
				}
			}

			await this.sendBrowserCommand(runtime, { type: 'browser-navigate', url })
			const tick = await this.waitForTick(runtime, 10000)

			this.sendWithRequestId(connection, { type: 'navigate-result', tick }, requestId)
		} catch (err) {
			this.send(connection, { type: 'error', message: `Navigate failed: ${err}` })
		}
	}

	private async handleActions(sessionId: string, connection: Connection, requestId?: string) {
		const runtime = this.getRuntime(sessionId, connection)
		if (!runtime) return

		try {
			const actions = await this.sendBrowserCommand(runtime, { type: 'browser-actions' }) as Action[]
			this.sendWithRequestId(connection, { type: 'actions-result', actions }, requestId)
		} catch (err) {
			this.send(connection, { type: 'error', message: `Actions failed: ${err}` })
		}
	}

	private async handleOpen(sessionId: string, actionId: string, connection: Connection, requestId?: string) {
		const runtime = this.getRuntime(sessionId, connection)
		if (!runtime) return

		try {
			const html = await this.sendBrowserCommand(runtime, { type: 'browser-open', actionId }) as string
			this.sendWithRequestId(connection, { type: 'open-result', html }, requestId)
		} catch (err) {
			this.send(connection, { type: 'error', message: `Open failed: ${err}` })
		}
	}

	private async handleInteract(sessionId: string, command: InteractCommand, connection: Connection, requestId?: string) {
		const runtime = this.getRuntime(sessionId, connection)
		if (!runtime) return

		try {
			await this.sendBrowserCommand(runtime, { type: 'browser-interact', command })
			this.sendWithRequestId(connection, { type: 'interact-result', success: true }, requestId)
		} catch (err) {
			this.send(connection, { type: 'error', message: `Interact failed: ${err}` })
		}
	}

	private async handleWaitForTick(sessionId: string, timeout: number | undefined, connection: Connection, requestId?: string) {
		const runtime = this.getRuntime(sessionId, connection)
		if (!runtime) return

		try {
			const tick = await this.waitForTick(runtime, timeout ?? 30000)
			this.sendWithRequestId(connection, { type: 'tick-complete', tick }, requestId)
		} catch (err) {
			this.send(connection, { type: 'error', message: `Tick timeout: ${err}` })
		}
	}

	private handleGetEvents(sessionId: string, connection: Connection, requestId?: string) {
		const events = this.sql<EventRow>`
			SELECT source, type, timestamp, data FROM events
			WHERE session_id = ${sessionId}
			ORDER BY timestamp ASC
		`

		const probeEvents: ProbeEvent[] = events.map((e) => ({
			sessionId,
			source: e.source,
			type: e.type,
			timestamp: e.timestamp,
			data: JSON.parse(e.data),
		}))

		this.sendWithRequestId(connection, { type: 'events-result', events: probeEvents }, requestId)
	}

	private handleListSessions(connection: Connection, requestId?: string) {
		const sessions = this.sql<SessionRow>`
			SELECT id, status, browser_mode, created_at FROM sessions
			ORDER BY created_at DESC
		`

		this.sendWithRequestId(connection, {
			type: 'sessions-list',
			sessions: sessions.map((s) => ({
				id: s.id,
				status: s.status,
				browserMode: s.browser_mode,
				createdAt: s.created_at,
			})),
		}, requestId)
	}

	// ── Browser command delegation ──────────────────────────────

	private handleBrowserResult(msg: BrowserResult & { commandId: string }, connection: Connection) {
		// Find which session this CLI connection belongs to
		const connState = connection.state as ConnectionState | undefined
		const sessionId = connState?.sessionId
		if (!sessionId) return

		const runtime = this.sessions.get(sessionId)
		if (!runtime) return

		const cb = runtime.pendingBrowserCallbacks.get(msg.commandId)
		if (!cb) return

		runtime.pendingBrowserCallbacks.delete(msg.commandId)
		if (msg.success) {
			cb.resolve(msg.data)
		} else {
			cb.reject(new Error(msg.error))
		}
	}

	private sendBrowserCommand(runtime: SessionRuntime, command: BrowserCommand): Promise<unknown> {
		if (runtime.browserMode === 'remote') {
			// TODO: Execute via Browser Rendering API
			return Promise.reject(new Error('Remote browser mode not yet implemented'))
		}

		// Local mode: forward to CLI connection
		return new Promise((resolve, reject) => {
			if (!runtime.cliConnection) {
				reject(new Error('No CLI connection — browser not available'))
				return
			}

			const commandId = String(++runtime.browserCommandId)
			runtime.pendingBrowserCallbacks.set(commandId, { resolve, reject })

			runtime.cliConnection.send(JSON.stringify({ ...command, commandId }))

			setTimeout(() => {
				if (runtime.pendingBrowserCallbacks.has(commandId)) {
					runtime.pendingBrowserCallbacks.delete(commandId)
					reject(new Error('Browser command timed out'))
				}
			}, 30000)
		})
	}

	private waitForTick(runtime: SessionRuntime, timeoutMs: number): Promise<Tick> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = runtime.pendingTickResolvers.indexOf(resolve)
				if (idx !== -1) runtime.pendingTickResolvers.splice(idx, 1)
				reject(new Error('Tick timed out'))
			}, timeoutMs)

			runtime.pendingTickResolvers.push((tick) => {
				clearTimeout(timer)
				resolve(tick)
			})
		})
	}

	// ── Helpers ─────────────────────────────────────────────────

	private getActiveSessionsList(): Array<{ id: string; status: string }> {
		return this.sql<SessionRow>`SELECT id, status FROM sessions WHERE status = 'active'`
			.map((s) => ({ id: s.id, status: s.status }))
	}

	private send(connection: Connection, message: AgentResponse) {
		connection.send(JSON.stringify(message))
	}

	private sendWithRequestId(connection: Connection, message: AgentResponse, requestId?: string) {
		connection.send(JSON.stringify(requestId ? { ...message, requestId } : message))
	}

	private broadcastToSession(sessionId: string, message: AgentResponse) {
		const runtime = this.sessions.get(sessionId)
		if (runtime?.cliConnection) {
			runtime.cliConnection.send(JSON.stringify(message))
		}
	}

	private broadcastToRole(role: string, message: AgentResponse) {
		const payload = JSON.stringify(message)
		for (const connection of this.getConnections()) {
			const connState = connection.state as ConnectionState | undefined
			if (connState?.role === role) {
				connection.send(payload)
			}
		}
	}
}
