import { Command } from 'commander'

import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'

export const stopCommand = new Command('stop')
	.description('Stop the current Fisgon session')
	.action(async () => {
		const session = getRunningSession()
		if (!session) {
			console.error('No running Fisgon session found')
			process.exit(1)
		}

		try {
			const conn = await connectToAgent({
				port: session.port,
				agent: session.agent,
				env: session.env,
				sessionId: session.sessionId,
			})
			await conn.request({
				type: 'stop',
				sessionId: session.sessionId,
			})
			console.log('Session stopped')
			conn.close()
		} catch (err) {
			console.error('Failed to stop session:', err)
			process.exit(1)
		}

		// Kill the start process (local mode only)
		if (session.pid && !session.agent) {
			try {
				process.kill(session.pid, 'SIGTERM')
			} catch {
				// Process may already be dead
			}
		}
	})
