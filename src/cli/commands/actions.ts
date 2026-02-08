import { Command } from 'commander'

import { type Action } from '../../core/types.js'
import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'

export const actionsCommand = new Command('actions')
	.description('List available actions on the current page')
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
			const result = await conn.call<{ actions: Action[] }>(
				'getActions',
				[session.sessionId],
			)

			console.log(JSON.stringify(result.actions, null, 2))

			conn.close()
		} catch (err) {
			console.error('Actions failed:', err)
			process.exit(1)
		}
	})
