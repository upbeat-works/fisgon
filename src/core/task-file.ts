import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

export type TaskStep = {
	tool: string
	args?: Record<string, string>
	extract?: Record<string, string>
}

export type TaskValidation = {
	url_contains?: string
	url_matches?: string
	event_exists?: { source: string; type: string }
}

export type TaskFile = {
	name: string
	description: string
	depends?: string[]
	params?: Record<string, string>
	steps: TaskStep[]
	validate?: TaskValidation
}

export type CaseFile = {
	name: string
	description: string
	tasks: string[]
}

const TASKS_DIR = '.fisgon/tasks'
const CASES_DIR = '.fisgon/cases'

function ensureDir(dir: string) {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
}

export function readTaskFile(projectDir: string, name: string): TaskFile | null {
	const filePath = join(projectDir, TASKS_DIR, `${name}.yaml`)
	if (!existsSync(filePath)) return null
	return parse(readFileSync(filePath, 'utf-8')) as TaskFile
}

export function writeTaskFile(projectDir: string, task: TaskFile): void {
	const dir = join(projectDir, TASKS_DIR)
	ensureDir(dir)
	const filePath = join(dir, `${task.name}.yaml`)
	writeFileSync(filePath, stringify(task, { lineWidth: 120 }))
}

export function readCaseFile(projectDir: string, name: string): CaseFile | null {
	const filePath = join(projectDir, CASES_DIR, `${name}.yaml`)
	if (!existsSync(filePath)) return null
	return parse(readFileSync(filePath, 'utf-8')) as CaseFile
}

export function writeCaseFile(projectDir: string, caseFile: CaseFile): void {
	const dir = join(projectDir, CASES_DIR)
	ensureDir(dir)
	const filePath = join(dir, `${caseFile.name}.yaml`)
	writeFileSync(filePath, stringify(caseFile, { lineWidth: 120 }))
}

export function listTasks(projectDir: string): string[] {
	const dir = join(projectDir, TASKS_DIR)
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((f) => f.endsWith('.yaml'))
		.map((f) => f.replace(/\.yaml$/, ''))
}

export function collectParams(projectDir: string): Record<string, string> {
	const params: Record<string, string> = {}
	for (const name of listTasks(projectDir)) {
		const task = readTaskFile(projectDir, name)
		if (task?.params) {
			for (const [key, value] of Object.entries(task.params)) {
				if (!(key in params)) params[key] = value
			}
		}
	}
	return params
}

export function listCases(projectDir: string): string[] {
	const dir = join(projectDir, CASES_DIR)
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((f) => f.endsWith('.yaml'))
		.map((f) => f.replace(/\.yaml$/, ''))
}
