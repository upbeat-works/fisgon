import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = readFileSync(resolve(__dirname, 'scripts/action-scanner.js'), 'utf-8')

export function createActionScannerScript(): string {
	return SCRIPT
}
