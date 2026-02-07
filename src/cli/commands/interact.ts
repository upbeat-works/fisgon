import { Command } from 'commander'

import { type AgentResponse, type InteractCommand } from '../../core/types.js'
import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'

export const interactCommand = new Command('interact')
	.description('Interact with the browser: type, click, or select')
	.argument('<action>', 'Action: type, click, or select')
	.argument('<selector>', 'CSS selector')
	.argument('[value]', 'Value (for type and select)')
	.action(async (action: string, selector: string, value?: string) => {
		const session = getRunningSession()
		if (!session) {
			console.error('No running Fisgon session. Run `fisgon start` first.')
			process.exit(1)
		}

		let command: InteractCommand
		switch (action) {
			case 'type':
				if (!value) {
					console.error('Value is required for type action')
					process.exit(1)
				}
				command = { action: 'type', selector, value }
				break
			case 'click':
				command = { action: 'click', selector }
				break
			case 'select':
				if (!value) {
					console.error('Value is required for select action')
					process.exit(1)
				}
				command = { action: 'select', selector, value }
				break
			default:
				console.error(`Unknown action: ${action}. Use type, click, or select.`)
				process.exit(1)
		}

		try {
			const conn = await connectToAgent({
				port: session.port,
				agent: session.agent,
				env: session.env,
				sessionId: session.sessionId,
			})
			const result = await conn.request<AgentResponse & { success: boolean }>({
				type: 'interact',
				sessionId: session.sessionId,
				command,
			})

			if (result.type === 'interact-result' && result.success) {
				console.log('OK')
			}

			conn.close()
		} catch (err) {
			console.error('Interact failed:', err)
			process.exit(1)
		}
	})
