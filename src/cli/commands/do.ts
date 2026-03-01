import { Command } from 'commander'

import { type StepLog } from '../../agent/llm-driver.js'
import { type TaskFile, readTaskFile, writeTaskFile, listTasks, collectParams } from '../../core/task-file.js'
import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'
import { replayTask } from '../task-runner.js'

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
	.option('--save-task <name>', 'Distill and save the successful run as a replayable task')
	.action(async (instruction: string, opts: { saveTask?: string }) => {
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

			// Auto-match saved tasks before going to the LLM
			let remainingInstruction: string | null = instruction
			const taskNames = listTasks(process.cwd())

			if (taskNames.length > 0) {
				// Build catalog of name + description
				const catalog: Array<{ name: string; description: string }> = []
				for (const name of taskNames) {
					const task = readTaskFile(process.cwd(), name)
					if (task) {
						catalog.push({ name: task.name, description: task.description })
					}
				}

				if (catalog.length > 0) {
					console.log('Matching instruction against saved tasks...')
					const match = await conn.call<{ tasks: string[] | null; remaining: string | null }>(
						'matchTasks',
						[instruction, catalog],
						{ timeout: 60000 },
					)

					if (match.tasks && match.tasks.length > 0) {
						let replayFailed = false

						for (const taskName of match.tasks) {
							const task = readTaskFile(process.cwd(), taskName)
							if (!task) {
								console.log(`Task "${taskName}" not found, falling back to LLM.`)
								replayFailed = true
								break
							}

							console.log(`Replaying task "${taskName}"...`)
							const result = await replayTask(
								conn,
								session.sessionId,
								task,
								{},
								{ fallback: false, verbose: true },
							)

							if (!result.success) {
								console.log(`Replay failed: ${result.error}`)
								console.log('Falling back to LLM...')
								console.log()
								replayFailed = true
								break
							}

							console.log(`Task "${taskName}" replayed successfully.`)
						}

						if (replayFailed) {
							// Fall back to full LLM with original instruction
							remainingInstruction = instruction
						} else {
							remainingInstruction = match.remaining
						}
					}
				}
			}

			// If there's remaining work (or no tasks matched), use the LLM
			if (remainingInstruction) {
				// Collect step logs for potential distillation
				const stepLogs: StepLog[] = []

				// Listen for step logs while the task runs
				conn.client.addEventListener('message', (event: MessageEvent) => {
					try {
						const msg = JSON.parse(String(event.data))
						if (msg.type === 'task-step') {
							stepLogs.push(msg)
							console.log(formatStepLog(msg))
						}
					} catch {
						// Ignore
					}
				})

				const result = await conn.call<{ result: string }>(
					'performTask',
					[session.sessionId, remainingInstruction],
					{ timeout: 300000 },
				)

				console.log()
				console.log(result.result)

				// If --save-task, distill and save
				if (opts.saveTask) {
					console.log()
					console.log(`Distilling task "${opts.saveTask}"...`)

					// Get current URL for validation context
					let currentUrl = ''
					try {
						const { events } = await conn.call<{ events: Array<{ source: string; data: unknown }> }>(
							'getEvents',
							[session.sessionId],
							{ timeout: 10000 },
						)
						const navEvents = events.filter((e) => e.source === 'nav')
						const lastNav = navEvents[navEvents.length - 1]
						if (lastNav) {
							const data = lastNav.data as Record<string, unknown>
							currentUrl = String(data.url ?? data.pathname ?? '')
						}
					} catch {
						// Proceed without URL
					}

					const existingParams = collectParams(process.cwd())
					const distilled = await conn.call<{ task: TaskFile }>(
						'distillTask',
						[session.sessionId, stepLogs, instruction, currentUrl, existingParams],
						{ timeout: 120000 },
					)

					distilled.task.name = opts.saveTask
					writeTaskFile(process.cwd(), distilled.task)
					console.log(`Task saved to .fisgon/tasks/${opts.saveTask}.yaml`)
				}
			} else {
				console.log('All tasks replayed successfully — no LLM needed.')
			}

			conn.close()
		} catch (err) {
			console.error('Task failed:', err)
			process.exit(1)
		}
	})
