import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type FisgonConfig } from '../core/types.js'

import { createFetchProbeScript } from './fetch-probe.js'
import { createNavigationProbeScript } from './navigation-probe.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS_BOOTSTRAP = readFileSync(
	resolve(__dirname, 'scripts/ws-bootstrap.js'),
	'utf-8',
)

export function createInjectableScript(
	config: FisgonConfig,
	sessionId: string,
): string {
	const port = config.port ?? 9876
	const wsUrl = `ws://localhost:${port}/agents/fisgon/default?role=browser-probe`

	const parts: string[] = []

	// WebSocket connection + __FISGON_EMIT__ function
	parts.push(
		WS_BOOTSTRAP.replaceAll('__FISGON_WS_URL__', JSON.stringify(wsUrl)).replaceAll(
			'__FISGON_SESSION_ID__',
			JSON.stringify(sessionId),
		),
	)

	// Navigation probe (always on unless explicitly disabled)
	if (config.probes?.navigation !== false) {
		parts.push(createNavigationProbeScript())
	}

	// Fetch probe (pattern-matched)
	if (config.probes?.fetch?.match) {
		parts.push(createFetchProbeScript(config.probes.fetch.match))
	}

	return parts.join('\n')
}
