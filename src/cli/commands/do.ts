import { Command } from 'commander'

import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'

export const doCommand = new Command('do')
	.description('Perform a browser task using the LLM agent')
	.argument('<instruction>', 'Free-form instruction for the agent')
	.action(async (instruction: string) => {
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
			const result = await conn.call<{ result: string }>(
				'performTask',
				[session.sessionId, instruction],
				{ timeout: 120000 },
			)

			console.log(result.result)

			conn.close()
		} catch (err) {
			console.error('Task failed:', err)
			process.exit(1)
		}
	})
