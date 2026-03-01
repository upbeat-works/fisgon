import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION_FILE = join(tmpdir(), 'fisgon.json')

export type SessionInfo = {
	port: number
	pid: number
	sessionId: string
	agent?: string // remote agent URL
	env?: string // DO instance name
	wranglerPid?: number
}

export function getRunningSession(): SessionInfo | null {
	if (!existsSync(SESSION_FILE)) return null

	try {
		const data = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
		// Check if the process is still alive
		try {
			process.kill(data.pid, 0)
			return data
		} catch {
			return null
		}
	} catch {
		return null
	}
}
