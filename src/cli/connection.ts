import WebSocket from 'ws'

import { type AgentMessage, type AgentResponse } from '../core/types.js'

const DEFAULT_PORT = 9876
const AGENT_NAME = 'fisgon'

export type AgentConnection = {
	ws: WebSocket
	send(msg: AgentMessage & { requestId?: string }): void
	request<T extends AgentResponse>(
		msg: AgentMessage,
		timeoutMs?: number,
	): Promise<T>
	onBrowserCommand(handler: (command: unknown) => void): void
	close(): void
}

type ConnectOptions = {
	port?: number
	agent?: string // full remote URL, e.g. 'wss://fisgon.example.workers.dev'
	env?: string // DO instance name, default 'default'
	sessionId?: string // for reconnecting to an existing session
}

export function getAgentUrl(options: ConnectOptions): string {
	const env = options.env ?? 'default'
	const sessionParam = options.sessionId
		? `&sessionId=${options.sessionId}`
		: ''

	if (options.agent) {
		const base = options.agent.replace(/\/$/, '')
		return `${base}/agents/${AGENT_NAME}/${env}?role=cli${sessionParam}`
	}

	const p = options.port ?? DEFAULT_PORT
	return `ws://localhost:${p}/agents/${AGENT_NAME}/${env}?role=cli${sessionParam}`
}

export function connectToAgent(
	options: ConnectOptions | number,
): Promise<AgentConnection> {
	const opts: ConnectOptions =
		typeof options === 'number' ? { port: options } : options

	return new Promise((resolve, reject) => {
		const url = getAgentUrl(opts)
		const ws = new WebSocket(url)
		let requestCounter = 0
		const pendingRequests = new Map<
			string,
			{
				resolve: (data: AgentResponse) => void
				reject: (error: Error) => void
			}
		>()
		let browserCommandHandler: ((command: unknown) => void) | null = null

		ws.on('open', () => {
			const connection: AgentConnection = {
				ws,

				send(msg) {
					ws.send(JSON.stringify(msg))
				},

				request<T extends AgentResponse>(
					msg: AgentMessage,
					timeoutMs = 60000,
				): Promise<T> {
					return new Promise((res, rej) => {
						const requestId = String(++requestCounter)
						pendingRequests.set(requestId, {
							resolve: res as (data: AgentResponse) => void,
							reject: rej,
						})

						ws.send(JSON.stringify({ ...msg, requestId }))

						setTimeout(() => {
							if (pendingRequests.has(requestId)) {
								pendingRequests.delete(requestId)
								rej(new Error('Request timed out'))
							}
						}, timeoutMs)
					})
				},

				onBrowserCommand(handler) {
					browserCommandHandler = handler
				},

				close() {
					ws.close()
				},
			}

			resolve(connection)
		})

		ws.on('message', (data: WebSocket.RawData) => {
			try {
				const msg = JSON.parse(data.toString())

				// Check if this is a browser command from the agent
				if (msg.type?.startsWith('browser-') && msg.commandId) {
					browserCommandHandler?.(msg)
					return
				}

				// Check if this is a response to a pending request
				if (msg.requestId && pendingRequests.has(msg.requestId)) {
					const pending = pendingRequests.get(msg.requestId)!
					pendingRequests.delete(msg.requestId)
					if (msg.type === 'error') {
						pending.reject(new Error(msg.message))
					} else {
						pending.resolve(msg)
					}
					return
				}
			} catch {
				// Ignore malformed messages
			}
		})

		ws.on('error', (err) => {
			reject(err)
		})

		ws.on('close', () => {
			for (const [, pending] of pendingRequests) {
				pending.reject(new Error('Connection closed'))
			}
			pendingRequests.clear()
		})
	})
}
