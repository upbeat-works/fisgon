import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = readFileSync(resolve(__dirname, 'scripts/fetch.js'), 'utf-8')

export function createFetchProbeScript(patterns: string[]): string {
	return SCRIPT.replace('__FISGON_FETCH_PATTERNS__', JSON.stringify(patterns))
}
