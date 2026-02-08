import { Command } from 'commander'

import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'

function formatStepLog(msg: { step: number; toolCalls: Array<{ name: string; args: Record<string, unknown> }>; text?: string }) {
	const parts: string[] = []
	for (const tc of msg.toolCalls) {
		const argStr = Object.entries(tc.args)
			.map(([k, v]) => {
				const s = typeof v === 'string' ? v : JSON.stringify(v)
				return `${k}=${s.length > 80 ? s.slice(0, 77) + '...' : s}`
			})
			.join(' ')
		parts.push(`${tc.name}(${argStr})`)
	}
	if (msg.text) {
		parts.push(`"${msg.text.length > 100 ? msg.text.slice(0, 97) + '...' : msg.text}"`)
	}
	return `[step ${msg.step}] ${parts.join(', ')}`
}

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

			// Listen for step logs while the task runs
			conn.client.addEventListener('message', (event: MessageEvent) => {
				try {
					const msg = JSON.parse(String(event.data))
					if (msg.type === 'task-step') {
						console.log(formatStepLog(msg))
					}
				} catch {
					// Ignore
				}
			})

			const result = await conn.call<{ result: string }>(
				'performTask',
				[session.sessionId, instruction],
				{ timeout: 300000 },
			)

			console.log()
			console.log(result.result)

			conn.close()
		} catch (err) {
			console.error('Task failed:', err)
			process.exit(1)
		}
	})
