import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

/**
 * Kill a child process and its entire process tree.
 * Uses negative PID to send the signal to the process group.
 */
export function killProcessTree(child: ChildProcess) {
	if (!child.pid) return
	try {
		// Kill the entire process group (npx → node → wrangler)
		process.kill(-child.pid, 'SIGTERM')
	} catch {
		// Process group may already be dead, try direct kill
		try {
			child.kill('SIGTERM')
		} catch {
			// Already dead
		}
	}
}

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
 * Check if a port is free. If not, kill whatever is holding it
 * (likely a stale wrangler from a previous run).
 */
async function ensurePortFree(port: number): Promise<void> {
	const isFree = await new Promise<boolean>((resolve_) => {
		const server = createServer()
		server.once('error', () => resolve_(false))
		server.once('listening', () => {
			server.close()
			resolve_(true)
		})
		server.listen(port)
	})

	if (isFree) return

	// Port is taken — find and kill the process holding it
	try {
		const output = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf-8' })
		const pids = output.trim().split('\n').filter(Boolean)
		for (const pid of pids) {
			try {
				process.kill(parseInt(pid, 10), 'SIGTERM')
			} catch { /* already dead */ }
		}
		// Wait briefly for port to be released
		await new Promise((r) => setTimeout(r, 500))
	} catch {
		throw new Error(
			`Port ${port} is in use and could not be freed. Kill the process manually or use a different port.`,
		)
	}
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

	return ensurePortFree(opts.port).then(() => new Promise((resolve_, reject) => {
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
			detached: true,
			env: { ...process.env },
		})

		const timeout = setTimeout(
			() => reject(new Error('Wrangler startup timed out')),
			30000,
		)

		const stderrChunks: string[] = []

		const onReady = (data: Buffer) => {
			if (data.toString().includes('Ready on')) {
				clearTimeout(timeout)
				resolve_(wrangler)
			}
		}

		wrangler.stderr?.on('data', (data: Buffer) => {
			stderrChunks.push(data.toString())
			onReady(data)
		})
		wrangler.stdout?.on('data', onReady)

		wrangler.on('error', (err) => {
			clearTimeout(timeout)
			reject(err)
		})

		wrangler.on('exit', (code) => {
			clearTimeout(timeout)
			if (code !== 0) {
				const stderr = stderrChunks.join('').trim()
				const detail = stderr ? `:\n${stderr}` : ''
				reject(new Error(`Wrangler exited with code ${code}${detail}`))
			}
		})
	}))
}
