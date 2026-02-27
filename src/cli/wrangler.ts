import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Resolve the wrangler config file path.
 *
 * 1. Explicit path from config.wrangler (resolved relative to cwd)
 * 2. wrangler.jsonc or wrangler.json in cwd
 * 3. Throws with setup instructions
 */
export function resolveWranglerConfig(cwd: string, configPath?: string): string {
	if (configPath) {
		const resolved = resolve(cwd, configPath)
		if (!existsSync(resolved)) {
			throw new Error(`Wrangler config not found at ${resolved}`)
		}
		return resolved
	}

	const jsonc = resolve(cwd, 'wrangler.jsonc')
	if (existsSync(jsonc)) return jsonc

	const json = resolve(cwd, 'wrangler.json')
	if (existsSync(json)) return json

	throw new Error(
		[
			'No wrangler config found.',
			'',
			'Fisgon needs a wrangler.jsonc (or wrangler.json) in your project root',
			'with a Durable Object binding for the Fisgon agent.',
			'',
			'Create one with at minimum:',
			'',
			'  {',
			'    "name": "fisgon-agent",',
			'    "main": "node_modules/@upbeat-works/fisgon/dist/agent/worker.js",',
			'    "compatibility_date": "2025-01-01",',
			'    "durable_objects": {',
			'      "bindings": [{ "name": "AGENT", "class_name": "Agent" }]',
			'    },',
			'    "migrations": [',
			'      { "tag": "v1", "new_sqlite_classes": ["Agent"] }',
			'    ]',
			'  }',
			'',
			'Place your API keys in a .dev.vars file next to the wrangler config.',
		].join('\n'),
	)
}

/**
 * Spawn `npx wrangler dev` and wait for "Ready on" output.
 * Returns the child process.
 */
export function startWrangler(opts: {
	port: number
	cwd?: string
	wrangler?: string
}): Promise<ChildProcess> {
	const cwd = opts.cwd ?? process.cwd()
	const configPath = resolveWranglerConfig(cwd, opts.wrangler)

	return new Promise((resolve_, reject) => {
		const wranglerArgs = [
			'wrangler',
			'dev',
			'--config',
			configPath,
			'--port',
			String(opts.port),
		]

		const wrangler = spawn('npx', wranglerArgs, {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env },
		})

		const timeout = setTimeout(
			() => reject(new Error('Wrangler startup timed out')),
			30000,
		)

		const onReady = (data: Buffer) => {
			if (data.toString().includes('Ready on')) {
				clearTimeout(timeout)
				resolve_(wrangler)
			}
		}

		wrangler.stderr?.on('data', onReady)
		wrangler.stdout?.on('data', onReady)

		wrangler.on('error', (err) => {
			clearTimeout(timeout)
			reject(err)
		})

		wrangler.on('exit', (code) => {
			clearTimeout(timeout)
			if (code !== 0) reject(new Error(`Wrangler exited with code ${code}`))
		})
	})
}
