import { Command } from 'commander'

import { type AgentResponse, type Tick } from '../../core/types.js'
import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'

export const tickCommand = new Command('tick')
	.description('Wait for the next tick and print its events')
	.option('-t, --timeout <ms>', 'Timeout in milliseconds', '30000')
	.action(async (options: { timeout: string }) => {
		const session = getRunningSession()
		if (!session) {
			console.error('No running Fisgon session. Run `fisgon start` first.')
			process.exit(1)
		}

		const timeout = parseInt(options.timeout, 10)

		try {
			const conn = await connectToAgent({
				port: session.port,
				agent: session.agent,
				env: session.env,
				sessionId: session.sessionId,
			})
			const result = await conn.request<AgentResponse & { tick: Tick }>(
				{
					type: 'tick',
					sessionId: session.sessionId,
					timeout,
				},
				timeout + 5000,
			)

			if (result.type === 'tick-complete') {
				const tick = result.tick
				console.log(
					`Tick #${tick.id} (${tick.duration}ms, ${tick.events.length} events):`,
				)
				for (const event of tick.events) {
					console.log(
						`  ${event.source}:${event.type}`,
						JSON.stringify(event.data),
					)
				}
			}

			conn.close()
		} catch (err) {
			console.error('Tick failed:', err)
			process.exit(1)
		}
	})
