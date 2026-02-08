import { AgentClient, type AgentClientOptions } from 'agents/client'
import WebSocket from 'ws'

import { type AgentState } from '../agent/session-state.js'

type ConnectOptions = {
	port?: number
	agent?: string // full remote URL, e.g. 'wss://fisgon.example.workers.dev'
	env?: string // DO instance name, default 'default'
	sessionId?: string // for reconnecting to an existing session
	hasBrowser?: boolean // true for the `start` command's connection (owns the browser)
}

export type AgentConnection = {
	client: AgentClient<AgentState>
	call: AgentClient<AgentState>['call']
	onBrowserCommand(handler: (command: unknown) => void): void
	close(): void
}

const DEFAULT_PORT = 9876
const AGENT_NAME = 'fisgon'

export function connectToAgent(options: ConnectOptions): Promise<AgentConnection> {
	return new Promise((resolve, reject) => {
		const env = options.env ?? 'default'
		const host = options.agent
			? new URL(options.agent).host
			: `localhost:${options.port ?? DEFAULT_PORT}`
		const protocol = options.agent?.startsWith('wss') ? 'wss' : 'ws'

		const query: Record<string, string> = { role: 'cli' }
		if (options.sessionId) {
			query.sessionId = options.sessionId
		}
		if (options.hasBrowser) {
			query.hasBrowser = 'true'
		}

		const clientOptions: AgentClientOptions<AgentState> = {
			agent: AGENT_NAME,
			name: env,
			host,
			protocol: protocol as 'ws' | 'wss',
			query,
			// Use Node.js ws package as the WebSocket implementation
			WebSocket: WebSocket as unknown as AgentClientOptions['WebSocket'],
		}

		const client = new AgentClient<AgentState>(clientOptions)
		let browserCommandHandler: ((command: unknown) => void) | null = null

		// The underlying PartySocket handles reconnection.
		// We listen for raw messages to intercept browser commands from the agent.
		client.addEventListener('message', (event: MessageEvent) => {
			try {
				const msg = JSON.parse(String(event.data))
				if (msg.type?.startsWith('browser-') && msg.commandId) {
					browserCommandHandler?.(msg)
				}
			} catch {
				// Ignore malformed messages
			}
		})

		let settled = false

		// Wait for the agent to send identity (connection is ready).
		// PartySocket retries on transient WebSocket errors, so we don't
		// reject on individual error events — only on ready-rejection or timeout.
		client.ready
			.then(() => {
				if (settled) return
				settled = true
				const connection: AgentConnection = {
					client,
					call: client.call.bind(client),
					onBrowserCommand(handler) {
						browserCommandHandler = handler
					},
					close() {
						client.close()
					},
				}
				resolve(connection)
			})
			.catch((err) => {
				if (settled) return
				settled = true
				reject(err)
			})

		setTimeout(() => {
			if (settled) return
			settled = true
			client.close()
			reject(new Error('Connection to agent timed out'))
		}, 15000)
	})
}
