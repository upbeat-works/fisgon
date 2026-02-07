import { Command } from 'commander'

import { type AgentResponse, type ProbeEvent } from '../../core/types.js'
import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'

export const eventsCommand = new Command('events')
	.description('View all events from the current session')
	.action(async () => {
		const session = getRunningSession()
		if (!session) {
			console.error('No running Fisgon session. Run `fisgon start` first.')
			process.exit(1)
		}

		try {
			const conn = await connectToAgent({
				port: session.port,
				agent: session.agent,
				env: session.env,
				sessionId: session.sessionId,
			})
			const result = await conn.request<
				AgentResponse & { events: ProbeEvent[] }
			>({
				type: 'events',
				sessionId: session.sessionId,
			})

			if (result.type === 'events-result') {
				if (result.events.length === 0) {
					console.log('No events yet.')
				} else {
					for (const event of result.events) {
						console.log(
							`[${event.timestamp}ms] ${event.source}:${event.type}`,
							JSON.stringify(event.data),
						)
					}
					console.log(`\nTotal: ${result.events.length} events`)
				}
			}

			conn.close()
		} catch (err) {
			console.error('Events failed:', err)
			process.exit(1)
		}
	})
