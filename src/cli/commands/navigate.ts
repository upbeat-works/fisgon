import { Command } from 'commander'

import { type Tick } from '../../core/types.js'
import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'

export const navigateCommand = new Command('navigate')
	.description('Navigate the browser to a URL')
	.argument('<url>', 'URL to navigate to')
	.option('--as <identity>', 'Log in as this identity first')
	.action(async (url: string, options: { as?: string }) => {
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
			const result = await conn.call<{ tick: Tick }>(
				'navigate',
				[session.sessionId, url, options.as],
				{ timeout: 60000 },
			)

			console.log(`Navigated to ${url}`)
			console.log(
				`Tick #${result.tick.id}: ${result.tick.events.length} events (${result.tick.duration}ms)`,
			)
			for (const event of result.tick.events) {
				console.log(
					`  ${event.source}:${event.type}`,
					JSON.stringify(event.data),
				)
			}

			conn.close()
		} catch (err) {
			console.error('Navigate failed:', err)
			process.exit(1)
		}
	})
