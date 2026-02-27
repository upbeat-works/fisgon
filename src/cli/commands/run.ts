import { type ChildProcess } from 'node:child_process'

import { Command } from 'commander'

import { readTaskFile, readCaseFile, listTasks, listCases } from '../../core/task-file.js'
import { launchBrowser, type BrowserSession } from '../browser-setup.js'
import { loadConfig } from '../config.js'
import { connectToAgent, type AgentConnection } from '../connection.js'
import { getRunningSession } from '../session-file.js'
import { replayTask } from '../task-runner.js'
import { startWrangler } from '../wrangler.js'

export const runCommand = new Command('run')
	.description('Replay a saved task or test case')
	.argument('<name>', 'Task or test case name')
	.option('--fallback', 'Fall back to LLM if a step fails')
	.option('--verbose', 'Print each step as it executes')
	.option('--headless', 'Run browser without visible window')
	.option('--list', 'List all saved tasks and cases')
	.option('-p, --port <port>', 'Agent port (local mode)', '9876')
	.action(async (name: string, opts: { fallback?: boolean; verbose?: boolean; headless?: boolean; list?: boolean; port: string }) => {
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

		const config = await loadConfig()
		if (!config) {
			console.error('No fisgon.config.ts found in current directory')
			process.exit(1)
		}

		let wrangler: ChildProcess | null = null
		let conn: AgentConnection | null = null
		let browserSession: BrowserSession | null = null

		const cleanup = async () => {
			await browserSession?.cleanup()
			conn?.close()
			wrangler?.kill()
		}

		process.on('SIGINT', () => void cleanup().then(() => process.exit(0)))
		process.on('SIGTERM', () => void cleanup().then(() => process.exit(0)))

		try {
			// 1. Connect to an existing session or start wrangler ourselves
			const existingSession = getRunningSession()
			const agentUrl = config.agent
			const isRemote = !!agentUrl
			const port = config.port ?? parseInt(opts.port, 10)

			let sessionId: string

			if (existingSession) {
				// Reuse existing wrangler/session — just connect
				if (opts.verbose) console.log('Using existing Fisgon session...')
				conn = await connectToAgent({
					port: existingSession.port,
					agent: existingSession.agent,
					env: existingSession.env,
					sessionId: existingSession.sessionId,
				})
				sessionId = existingSession.sessionId
			} else {
				// No existing session — start wrangler and create a new session
				if (!isRemote) {
					if (opts.verbose) console.log('Starting Fisgon agent...')
					wrangler = await startWrangler({ port, wrangler: config.wrangler })
					if (opts.verbose) console.log(`Agent running on port ${port}`)
					// Give wrangler a moment to be fully ready
					await new Promise((r) => setTimeout(r, 1000))
				}

				conn = await connectToAgent({
					port: isRemote ? undefined : port,
					agent: agentUrl,
					env: 'default',
				})

				const startResult = await conn.call<{ sessionId: string }>(
					'startSession',
					[config, 'local'],
				)
				sessionId = startResult.sessionId
				if (opts.verbose) console.log(`Session started: ${sessionId}`)

				// Reconnect with sessionId
				conn.close()
				conn = await connectToAgent({
					port: isRemote ? undefined : port,
					agent: agentUrl,
					env: 'default',
					sessionId,
				})
			}

			// 2. Launch browser
			const headless = !!opts.headless
			if (opts.verbose) console.log(`Launching browser (${headless ? 'headless' : 'headed'})...`)
			browserSession = await launchBrowser(config, sessionId, { headless })
			if (opts.verbose) console.log('Browser ready')

			// 3. Navigate to app URL
			await browserSession.page.goto(config.url, { waitUntil: 'networkidle' })

			// 4. Run tasks
			const task = readTaskFile(process.cwd(), name)
			if (task) {
				console.log(`Running task: ${task.name}`)
				if (task.description) console.log(`  ${task.description}`)
				console.log()

				const result = await replayTask(
					conn,
					sessionId,
					task,
					{},
					{ fallback: opts.fallback, verbose: opts.verbose ?? true, page: browserSession.page },
				)

				console.log()
				if (result.success) {
					console.log('Task completed successfully.')
				} else {
					console.error(`Task failed: ${result.error}`)
					await cleanup()
					process.exit(1)
				}

				await cleanup()
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
						await cleanup()
						process.exit(1)
					}

					console.log(`[${i + 1}/${testCase.tasks.length}] ${taskName}`)

					const result = await replayTask(
						conn,
						sessionId,
						taskFile,
						{},
						{ fallback: opts.fallback, verbose: opts.verbose ?? true, page: browserSession.page },
					)

					if (!result.success) {
						console.error(`Task "${taskName}" failed: ${result.error}`)
						await cleanup()
						process.exit(1)
					}

					console.log(`  done.`)
					console.log()
				}

				console.log('All tasks completed successfully.')
				await cleanup()
				return
			}

			console.error(`No task or case named "${name}" found.`)
			console.error('Use `fisgon run --list` to see available tasks and cases.')
			await cleanup()
			process.exit(1)
		} catch (err) {
			console.error('Run failed:', err)
			await cleanup()
			process.exit(1)
		}
	})
