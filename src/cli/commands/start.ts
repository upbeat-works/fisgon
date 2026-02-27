import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'

import { type IdentityConfig } from '../../core/types.js'
import { createBrowserHandler } from '../browser-handler.js'
import { launchBrowser } from '../browser-setup.js'
import { loadConfig } from '../config.js'
import { connectToAgent } from '../connection.js'
import { startWrangler } from '../wrangler.js'

export const startCommand = new Command('start')
	.description('Start a Fisgon test session')
	.option('-p, --port <port>', 'Agent port (local mode)', '9876')
	.option('--agent <url>', 'Remote agent URL (e.g. wss://fisgon.example.workers.dev)')
	.option('--env <name>', 'DO instance name (e.g. staging, pr-123)', 'default')
	.option('--remote', 'Use remote browser (Browser Rendering) instead of local Playwright')
	.option('--no-browser', 'Skip launching browser (browser commands will fail)')
	.option('--identity <entries...>', 'Session identity entries: name:email:password (can specify multiple)')
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

		// Parse --identity entries (format: name:email:password)
		let sessionIdentity: IdentityConfig | undefined
		if (options.identity) {
			sessionIdentity = {}
			for (const entry of options.identity as string[]) {
				const [name, email, ...passwordParts] = entry.split(':')
				const password = passwordParts.join(':')
				if (!name || !email || !password) {
					console.error(`Invalid identity format: ${entry}. Use name:email:password`)
					process.exit(1)
				}
				sessionIdentity[name] = { email, password }
			}
		}

		let wranglerPid: number | undefined

		// 1. In local mode, spawn wrangler dev for the agent
		if (!isRemote) {
			console.log('Starting Fisgon agent...')

			let wrangler
			try {
				wrangler = await startWrangler({
					port: effectivePort,
					wrangler: config.wrangler,
				})
			} catch (err) {
				console.error('Failed to start wrangler:', err)
				process.exit(1)
			}

			wranglerPid = wrangler.pid
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

		// 3. Start session on the agent via RPC
		const startResult = await conn.call<{ sessionId: string }>(
			'startSession',
			[config, browserMode, sessionIdentity],
		)

		const { sessionId } = startResult
		console.log(`Session started: ${sessionId}`)

		// Reconnect with sessionId so the agent associates this CLI connection.
		// hasBrowser tells the agent this is the browser-owning connection,
		// so it survives DO hibernation and is preferred during recovery.
		conn.close()
		conn = await connectToAgent({
			port: isRemote ? undefined : effectivePort,
			agent: agentUrl,
			env: envName,
			sessionId,
			hasBrowser: true,
		})

		// 4. Launch local Playwright browser if in local browser mode
		if (browserMode === 'local' && options.browser !== false) {
			try {
				const { page } = await launchBrowser(config, sessionId)

				// Register browser command handler — sends results via AgentClient
				const handleBrowserCommand = createBrowserHandler(conn.client, page)
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
