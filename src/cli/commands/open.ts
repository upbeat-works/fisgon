import { Command } from 'commander'

import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'

export const openCommand = new Command('open')
	.description('Open an action envelope — returns innerHTML')
	.argument('<actionId>', 'Action ID (from `fisgon actions`)')
	.action(async (actionId: string) => {
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
			const result = await conn.call<{ html: string }>(
				'openAction',
				[session.sessionId, actionId],
			)

			console.log(result.html)

			conn.close()
		} catch (err) {
			console.error('Open failed:', err)
			process.exit(1)
		}
	})
