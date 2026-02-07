import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

import { Command } from 'commander'

import { type AgentResponse } from '../../core/types.js'
import {
	createBrowserHandler,
	type PlaywrightBrowser,
} from '../browser-handler.js'
import { loadConfig } from '../config.js'
import { connectToAgent } from '../connection.js'

export const startCommand = new Command('start')
	.description('Start a Fisgon test session')
	.option('-p, --port <port>', 'Agent port (local mode)', '9876')
	.option('--agent <url>', 'Remote agent URL (e.g. wss://fisgon.example.workers.dev)')
	.option('--env <name>', 'DO instance name (e.g. staging, pr-123)', 'default')
	.option('--remote', 'Use remote browser (Browser Rendering) instead of local Playwright')
	.option('--no-browser', 'Skip launching browser (browser commands will fail)')
	.action(async (options) => {
		const port = parseInt(options.port, 10)
		const config = await loadConfig()

		if (!config) {
			console.error('No fisgon.config.ts found in current directory')
			process.exit(1)
		}

		const agentUrl = options.agent ?? config.agent
		const isRemote = !!agentUrl
		const effectivePort = config.port ?? port
		const envName = options.env
		const browserMode = options.remote ? 'remote' : 'local'

		let wranglerPid: number | undefined

		// 1. In local mode, spawn wrangler dev for the agent
		if (!isRemote) {
			console.log('Starting Fisgon agent...')
			const wranglerConfigPath = resolve(
				import.meta.dirname,
				'../../wrangler.jsonc',
			)

			const wrangler = spawn(
				'npx',
				[
					'wrangler',
					'dev',
					'--config',
					wranglerConfigPath,
					'--port',
					String(effectivePort),
				],
				{
					stdio: ['pipe', 'pipe', 'pipe'],
					env: { ...process.env },
				},
			)

			wranglerPid = wrangler.pid

			try {
				await new Promise<void>((waitResolve, reject) => {
					const timeout = setTimeout(
						() => reject(new Error('Wrangler startup timed out')),
						30000,
					)

					wrangler.stderr?.on('data', (data: Buffer) => {
						if (data.toString().includes('Ready on')) {
							clearTimeout(timeout)
							waitResolve()
						}
					})

					wrangler.stdout?.on('data', (data: Buffer) => {
						if (data.toString().includes('Ready on')) {
							clearTimeout(timeout)
							waitResolve()
						}
					})

					wrangler.on('error', (err) => {
						clearTimeout(timeout)
						reject(err)
					})

					wrangler.on('exit', (code) => {
						clearTimeout(timeout)
						if (code !== 0)
							reject(new Error(`Wrangler exited with code ${code}`))
					})
				})
			} catch (err) {
				console.error('Failed to start wrangler:', err)
				process.exit(1)
			}

			console.log(`Agent running on port ${effectivePort}`)

			// Cleanup on exit
			const cleanup = () => {
				wrangler.kill()
				process.exit(0)
			}
			process.on('SIGINT', cleanup)
			process.on('SIGTERM', cleanup)
		} else {
			console.log(`Connecting to remote agent: ${agentUrl}`)
		}

		// 2. Connect to the agent
		let conn
		try {
			if (!isRemote) {
				await new Promise((r) => setTimeout(r, 1000))
			}
			conn = await connectToAgent({
				port: isRemote ? undefined : effectivePort,
				agent: agentUrl,
				env: envName,
			})
		} catch (err) {
			console.error('Failed to connect to agent:', err)
			process.exit(1)
		}

		// 3. Start session on the agent
		const startResult = await conn.request<
			AgentResponse & { sessionId: string }
		>({
			type: 'start-session',
			config,
			browserMode,
		})

		if (startResult.type !== 'session-started') {
			console.error('Failed to start session:', startResult)
			process.exit(1)
		}

		const { sessionId } = startResult
		console.log(`Session started: ${sessionId}`)

		// Reconnect with sessionId so the agent associates this CLI connection
		conn.close()
		conn = await connectToAgent({
			port: isRemote ? undefined : effectivePort,
			agent: agentUrl,
			env: envName,
			sessionId,
		})

		// 4. Launch local Playwright browser if in local browser mode
		if (browserMode === 'local' && options.browser !== false) {
			try {
				// @ts-expect-error playwright may not be installed
				const pw = (await import('playwright')) as {
					chromium: {
						launch(opts: {
							headless: boolean
						}): Promise<PlaywrightBrowser>
					}
				}
				const browser = await pw.chromium.launch({ headless: false })
				const page = await browser.newPage()
				const targetUrl = new URL(config.url)

				// Set fisgon cookie
				await page.context().addCookies([
					{
						name: 'fisgon',
						value: sessionId,
						domain: targetUrl.hostname,
						path: '/',
					},
				])

				// Register browser command handler
				const handleBrowserCommand = createBrowserHandler(conn.ws, page)
				conn.onBrowserCommand(handleBrowserCommand)

				console.log(`Browser ready at ${config.url}`)
			} catch (err) {
				console.error('Failed to launch browser:', err)
				console.log(
					'Continuing without browser — browser commands will fail',
				)
			}
		} else if (browserMode === 'remote') {
			console.log('Using remote browser (Browser Rendering)')
		}

		// Write session info so other commands can find it
		writeFileSync(
			join(tmpdir(), 'fisgon.json'),
			JSON.stringify({
				port: effectivePort,
				pid: process.pid,
				sessionId,
				agent: agentUrl,
				env: envName,
				wranglerPid,
			}),
		)

		console.log('Fisgon is running. Use other commands in a separate terminal.')
		console.log('Press Ctrl+C to stop.')
	})
