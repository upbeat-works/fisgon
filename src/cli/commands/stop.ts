import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
			await conn.call('stopSession', [session.sessionId])
			console.log('Session stopped')
			conn.close()
		} catch (err) {
			console.error('Failed to stop session:', err)
			process.exit(1)
		}

		// Kill the start process (local mode only).
		// SIGTERM triggers the start command's cleanup handler which kills
		// the wrangler process tree and browser.
		if (session.pid && !session.agent) {
			try {
				process.kill(session.pid, 'SIGTERM')
			} catch {
				// Process may already be dead
			}
		}

		// Also kill wrangler directly in case the start process is already gone
		if (session.wranglerPid && !session.agent) {
			try {
				// Kill the process group to get all wrangler children
				process.kill(-session.wranglerPid, 'SIGTERM')
			} catch {
				try {
					process.kill(session.wranglerPid, 'SIGTERM')
				} catch {
					// Already dead
				}
			}
		}

		// Clean up session file
		try { unlinkSync(join(tmpdir(), 'fisgon.json')) } catch { /* may not exist */ }
	})
