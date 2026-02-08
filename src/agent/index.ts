import { Agent, callable, getCurrentAgent, type Connection, type WSMessage } from 'agents'

import { TickDetector } from '../core/tick-detector.js'
import {
	type ProbeEvent,
	type Tick,
	type FisgonConfig,
	type IdentityConfig,
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
	identity: IdentityConfig | null
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

	async onConnect(connection: Connection) {
		this.initDb()

		const { request } = getCurrentAgent()
		const url = new URL(request!.url)
		const role = (url.searchParams.get('role') ?? 'cli') as ConnectionState['role']
		const sessionId = url.searchParams.get('sessionId')

		connection.setState({
			role,
			sessionId,
			connectedAt: Date.now(),
		} satisfies ConnectionState)

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

	// onMessage handles raw messages that aren't RPC:
	// - Events from browser probes (PartySocket)
	// - Browser command results from CLI
	// RPC messages (from AgentClient) are routed to @callable methods by the base class.
	async onMessage(connection: Connection, message: WSMessage) {
		this.initDb()

		const text = typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer)
		let msg: Record<string, unknown>

		try {
			msg = JSON.parse(text)
		} catch {
			return
		}

		// Browser result from CLI (local mode)
		if (msg.type === 'browser-result' && typeof msg.commandId === 'string') {
			this.handleBrowserResult(msg as unknown as BrowserResult & { commandId: string }, connection)
			return
		}

		// Event from browser probe
		if (msg.type === 'event' && msg.event) {
			this.ingestEvent(msg.event as ProbeEvent)
			return
		}
	}

	// ── RPC methods (called by AgentClient.call) ────────────────

	@callable()
	startSession(config: FisgonConfig, browserMode: BrowserMode, identity?: IdentityConfig): { sessionId: string } {
		this.initDb()

		const { connection } = getCurrentAgent()
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
			cliConnection: connection ?? null,
			browserMode,
			identity: identity ?? config.identity ?? null,
			pendingBrowserCallbacks: new Map(),
			browserCommandId: 0,
			pendingTickResolvers: [],
		}
		runtime.tickDetector.setSession(sessionId)
		this.sessions.set(sessionId, runtime)

		// Update connection state with session ID
		if (connection) {
			connection.setState({
				...(connection.state as ConnectionState),
				sessionId,
			})
		}

		// Broadcast active session IDs to all clients (server probes use onStateUpdate)
		this.broadcastState()

		return { sessionId }
	}

	@callable()
	async stopSession(sessionId: string): Promise<void> {
		this.initDb()

		const runtime = this.requireRuntime(sessionId)

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

		// Cleanup runtime
		runtime.tickDetector.reset()
		this.sessions.delete(sessionId)

		this.broadcastState()
	}

	@callable()
	async navigate(sessionId: string, url: string, asIdentity?: string): Promise<{ tick: Tick }> {
		this.initDb()

		const runtime = this.requireRuntime(sessionId)

		const [session] = this.sql<SessionRow>`SELECT config FROM sessions WHERE id = ${sessionId}`
		const config: FisgonConfig = JSON.parse(session.config)

		// If --as is provided, log in first
		// Session-level identity takes precedence over config-level identity
		const identityMap = runtime.identity ?? config.identity
		if (asIdentity && identityMap && config.loginUrl) {
			const creds = identityMap[asIdentity]
			if (!creds) {
				throw new Error(`Unknown identity: ${asIdentity}`)
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

		return { tick }
	}

	@callable()
	async getActions(sessionId: string): Promise<{ actions: Action[] }> {
		this.initDb()

		const runtime = this.requireRuntime(sessionId)
		const actions = await this.sendBrowserCommand(runtime, { type: 'browser-actions' }) as Action[]
		return { actions }
	}

	@callable()
	async openAction(sessionId: string, actionId: string): Promise<{ html: string }> {
		this.initDb()

		const runtime = this.requireRuntime(sessionId)
		const html = await this.sendBrowserCommand(runtime, { type: 'browser-open', actionId }) as string
		return { html }
	}

	@callable()
	async interact(sessionId: string, command: InteractCommand): Promise<void> {
		this.initDb()

		const runtime = this.requireRuntime(sessionId)
		await this.sendBrowserCommand(runtime, { type: 'browser-interact', command })
	}

	@callable()
	async waitForNextTick(sessionId: string, timeout?: number): Promise<{ tick: Tick }> {
		this.initDb()

		const runtime = this.requireRuntime(sessionId)
		const tick = await this.waitForTick(runtime, timeout ?? 30000)
		return { tick }
	}

	@callable()
	getEvents(sessionId: string): { events: ProbeEvent[] } {
		this.initDb()

		const events = this.sql<EventRow>`
			SELECT source, type, timestamp, data FROM events
			WHERE session_id = ${sessionId}
			ORDER BY timestamp ASC
		`

		return {
			events: events.map((e) => ({
				sessionId,
				source: e.source,
				type: e.type,
				timestamp: e.timestamp,
				data: JSON.parse(e.data),
			})),
		}
	}

	@callable()
	listSessions(): { sessions: Array<{ id: string; status: string; browserMode: string; createdAt: number }> } {
		this.initDb()

		const sessions = this.sql<SessionRow>`
			SELECT id, status, browser_mode, created_at FROM sessions
			ORDER BY created_at DESC
		`

		return {
			sessions: sessions.map((s) => ({
				id: s.id,
				status: s.status,
				browserMode: s.browser_mode,
				createdAt: s.created_at,
			})),
		}
	}

	@callable()
	emitEvent(event: ProbeEvent): void {
		this.initDb()
		this.ingestEvent(event)
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

	private requireRuntime(sessionId: string): SessionRuntime {
		const runtime = this.sessions.get(sessionId)
		if (!runtime) {
			throw new Error(`Session not found: ${sessionId}`)
		}
		return runtime
	}

	private broadcastState() {
		this.setState({
			activeSessionIds: [...this.sessions.keys()],
		})
	}
}
