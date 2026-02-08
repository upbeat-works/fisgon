import { Command } from 'commander'

import { readTaskFile, readCaseFile, listTasks, listCases } from '../../core/task-file.js'
import { connectToAgent } from '../connection.js'
import { getRunningSession } from '../session-file.js'
import { replayTask } from '../task-runner.js'

export const runCommand = new Command('run')
	.description('Replay a saved task or test case')
	.argument('<name>', 'Task or test case name')
	.option('--fallback', 'Fall back to LLM if a step fails')
	.option('--verbose', 'Print each step as it executes')
	.option('--list', 'List all saved tasks and cases')
	.action(async (name: string, opts: { fallback?: boolean; verbose?: boolean; list?: boolean }) => {
		if (opts.list) {
			const tasks = listTasks(process.cwd())
			const cases = listCases(process.cwd())
			if (tasks.length > 0) {
				console.log('Tasks:')
				for (const t of tasks) console.log(`  ${t}`)
			}
			if (cases.length > 0) {
				console.log('Cases:')
				for (const c of cases) console.log(`  ${c}`)
			}
			if (tasks.length === 0 && cases.length === 0) {
				console.log('No saved tasks or cases. Use `fisgon do --save-task <name>` to create one.')
			}
			return
		}

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

			// Try task first, then case
			const task = readTaskFile(process.cwd(), name)
			if (task) {
				console.log(`Running task: ${task.name}`)
				if (task.description) console.log(`  ${task.description}`)
				console.log()

				const result = await replayTask(
					conn,
					session.sessionId,
					task,
					{},
					{ fallback: opts.fallback, verbose: opts.verbose ?? true },
				)

				console.log()
				if (result.success) {
					console.log('Task completed successfully.')
				} else {
					console.error(`Task failed: ${result.error}`)
					conn.close()
					process.exit(1)
				}

				conn.close()
				return
			}

			const testCase = readCaseFile(process.cwd(), name)
			if (testCase) {
				console.log(`Running case: ${testCase.name}`)
				if (testCase.description) console.log(`  ${testCase.description}`)
				console.log()

				for (let i = 0; i < testCase.tasks.length; i++) {
					const taskName = testCase.tasks[i]
					const taskFile = readTaskFile(process.cwd(), taskName)
					if (!taskFile) {
						console.error(`Task "${taskName}" not found (referenced by case "${name}")`)
						conn.close()
						process.exit(1)
					}

					console.log(`[${i + 1}/${testCase.tasks.length}] ${taskName}`)

					const result = await replayTask(
						conn,
						session.sessionId,
						taskFile,
						{},
						{ fallback: opts.fallback, verbose: opts.verbose ?? true },
					)

					if (!result.success) {
						console.error(`Task "${taskName}" failed: ${result.error}`)
						conn.close()
						process.exit(1)
					}

					console.log(`  done.`)
					console.log()
				}

				console.log('All tasks completed successfully.')
				conn.close()
				return
			}

			console.error(`No task or case named "${name}" found.`)
			console.error('Use `fisgon run --list` to see available tasks and cases.')
			conn.close()
			process.exit(1)
		} catch (err) {
			console.error('Run failed:', err)
			process.exit(1)
		}
	})
