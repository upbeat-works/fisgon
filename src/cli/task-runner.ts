import { type TaskFile } from '../core/task-file.js'
import { type PlaywrightPage } from './browser-handler.js'
import { type AgentConnection } from './connection.js'

type ReplayOptions = {
	fallback?: boolean
	verbose?: boolean
	page?: PlaywrightPage
}

type ReplayResult = {
	success: boolean
	failedStep?: number
	error?: string
}

/**
 * Substitute {{paramName}} placeholders in all string values of an object.
 */
function substituteParams(
	obj: Record<string, unknown>,
	vars: Record<string, string>,
): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === 'string') {
			let resolved = value
			for (const [varName, varValue] of Object.entries(vars)) {
				resolved = resolved.replaceAll(`{{${varName}}}`, varValue)
			}
			result[key] = resolved
		} else {
			result[key] = value
		}
	}
	return result
}

/**
 * Unwrap common RPC response shapes to get at the raw data.
 * e.g. { tick: { events: [...] } } → { events: [...] }
 */
function unwrapResult(result: unknown): unknown {
	if (result == null || typeof result !== 'object') return result
	const obj = result as Record<string, unknown>
	// { tick: { ... } } from waitForNextTick / navigate RPCs
	if ('tick' in obj && typeof obj.tick === 'object') return obj.tick
	return result
}

/**
 * Extract events array from various result shapes.
 */
function extractEvents(result: unknown): Array<{ source: string; data: unknown }> {
	if (result == null || typeof result !== 'object') return []
	// Direct tick object with events array
	if ('events' in (result as Record<string, unknown>)) {
		return (result as { events: Array<{ source: string; data: unknown }> }).events ?? []
	}
	// Array of events directly
	if (Array.isArray(result)) return result
	return []
}

/**
 * Evaluate a simple extract expression against a tool result.
 *
 * Supported formats:
 * - `events[source=X].data.field` — find event with matching source, traverse path
 * - `events[source=X].data.text | match(/regex/)` — find event, extract regex match
 * - `data.field.subfield` — simple dot-path traversal on the result
 */
function evaluateExtract(expression: string, result: unknown): string | null {
	const parts = expression.split('|').map((p) => p.trim())
	const path = parts[0]
	const matchExpr = parts[1]

	let value: unknown = result

	// Unwrap RPC response wrappers: { tick: { events: [...] } } or { events: [...] }
	const unwrapped = unwrapResult(result)

	// Handle events[source=X] prefix
	const eventsMatch = path.match(/^events\[source=(\w+)\]\.(.+)$/)
	if (eventsMatch) {
		const source = eventsMatch[1]
		const restPath = eventsMatch[2]

		// Collect events from whatever shape we got
		const events = extractEvents(unwrapped)
		const event = events.find((e) => e.source === source)
		if (!event) return null
		value = traversePath(event, restPath)
	} else {
		value = traversePath(unwrapped, path)
	}

	if (value == null) return null

	// Apply match() regex if present
	if (matchExpr) {
		const regexMatch = matchExpr.match(/^match\(\/(.+)\/\)$/)
		if (regexMatch) {
			const regex = new RegExp(regexMatch[1])
			const str = String(value)
			const m = str.match(regex)
			return m ? (m[1] ?? m[0]) : null
		}
	}

	return String(value)
}

function traversePath(obj: unknown, path: string): unknown {
	const segments = path.split('.')
	let current: unknown = obj
	for (const seg of segments) {
		if (current == null || typeof current !== 'object') return null
		current = (current as Record<string, unknown>)[seg]
	}
	return current
}

/**
 * Map a task step's tool name to the corresponding agent RPC call.
 * For interact, wait for tick but don't fail if it times out (e.g. typing
 * into an input won't generate probe events).
 */
async function executeStep(
	conn: AgentConnection,
	sessionId: string,
	tool: string,
	args: Record<string, unknown>,
	hasExtract: boolean,
	page?: PlaywrightPage,
): Promise<unknown> {
	switch (tool) {
		case 'navigate': {
			if (page) {
				await page.goto(args.url as string, { waitUntil: 'networkidle' })
				// Wait for probe events from the navigation
				try {
					return await conn.call('waitForNextTick', [sessionId, 5000], { timeout: 15000 })
				} catch {
					if (hasExtract) throw new Error('Tick timed out (needed for extract)')
					return null
				}
			}
			return conn.call('navigate', [sessionId, args.url as string], { timeout: 30000 })
		}
		case 'get_actions':
			return conn.call('getActions', [sessionId], { timeout: 30000 })
		case 'open_action':
			return conn.call('openAction', [sessionId, args.actionId as string], { timeout: 30000 })
		case 'interact': {
			if (page) {
				const action = args.action as string
				const selector = args.selector as string
				switch (action) {
					case 'type':
						await page.fill(selector, args.value as string)
						break
					case 'click':
						await page.click(selector)
						break
					case 'select':
						await page.selectOption(selector, args.value as string)
						break
				}
			} else {
				await conn.call('interact', [sessionId, {
					action: args.action as string,
					selector: args.selector as string,
					...(args.value != null ? { value: args.value } : {}),
				}], { timeout: 30000 })
			}
			// Wait for tick but tolerate timeout — some interactions (typing)
			// don't generate probe events. Only fail if we need extract data.
			try {
				return await conn.call('waitForNextTick', [sessionId, 5000], { timeout: 15000 })
			} catch {
				if (hasExtract) throw new Error('Tick timed out (needed for extract)')
				return null
			}
		}
		case 'wait_for_tick':
			return conn.call('waitForNextTick', [sessionId, (args.timeout as number) ?? 10000], { timeout: 30000 })
		case 'get_events':
			return conn.call('getEvents', [sessionId], { timeout: 30000 })
		default:
			throw new Error(`Unknown tool: ${tool}`)
	}
}

/**
 * Validate the task's success conditions against current browser state.
 */
async function validateTask(
	conn: AgentConnection,
	sessionId: string,
	validate: TaskFile['validate'],
): Promise<{ passed: boolean; reason?: string }> {
	if (!validate) return { passed: true }

	const { events } = await conn.call<{ events: Array<{ source: string; type: string; data: unknown }> }>(
		'getEvents', [sessionId],
		{ timeout: 10000 },
	)

	// Collect all nav URLs (some intermediate ones matter, not just the last)
	const navUrls = events
		.filter((e) => e.source === 'nav')
		.map((e) => String((e.data as Record<string, unknown>).url ?? ''))
		.filter((url) => url && url !== 'blank')

	const currentUrl = navUrls[navUrls.length - 1] ?? ''

	if (validate.url_contains) {
		// Check if any recent nav URL contains the expected string
		const found = navUrls.some((url) => url.includes(validate.url_contains!))
		if (!found) {
			return { passed: false, reason: `No navigation URL contains "${validate.url_contains}" (last: "${currentUrl}")` }
		}
	}

	if (validate.url_matches) {
		const regex = new RegExp(validate.url_matches)
		const found = navUrls.some((url) => regex.test(url))
		if (!found) {
			return { passed: false, reason: `No navigation URL matches /${validate.url_matches}/ (last: "${currentUrl}")` }
		}
	}

	if (validate.event_exists) {
		const found = events.some(
			(e) => e.source === validate.event_exists!.source && e.type === validate.event_exists!.type,
		)
		if (!found) {
			return { passed: false, reason: `No event with source="${validate.event_exists.source}" type="${validate.event_exists.type}"` }
		}
	}

	return { passed: true }
}

/**
 * Replay a persisted task by executing its steps directly via agent RPC.
 * Falls back to LLM for individual steps if they fail and fallback is enabled.
 */
export async function replayTask(
	conn: AgentConnection,
	sessionId: string,
	task: TaskFile,
	params: Record<string, string>,
	options: ReplayOptions = {},
): Promise<ReplayResult> {
	// Merge task defaults with provided params (caller overrides)
	const vars: Record<string, string> = { ...task.params, ...params }

	for (let i = 0; i < task.steps.length; i++) {
		const step = task.steps[i]
		const resolvedArgs = step.args ? substituteParams(step.args, vars) : {}

		if (options.verbose) {
			const argStr = Object.entries(resolvedArgs)
				.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
				.join(' ')
			console.log(`  [step ${i + 1}/${task.steps.length}] ${step.tool}(${argStr})`)
		}

		let result: unknown
		try {
			result = await executeStep(conn, sessionId, step.tool, resolvedArgs, !!step.extract, options.page)
		} catch (err) {
			if (options.fallback) {
				if (options.verbose) {
					console.log(`  [step ${i + 1}] failed, falling back to LLM...`)
				}
				// Describe the intent of this step for the LLM
				const stepDescription = describeStep(step, resolvedArgs)
				try {
					await conn.call('performTask', [sessionId, stepDescription], { timeout: 300000 })
					continue
				} catch (fallbackErr) {
					return {
						success: false,
						failedStep: i + 1,
						error: `Step ${i + 1} failed (LLM fallback also failed): ${fallbackErr}`,
					}
				}
			}
			return {
				success: false,
				failedStep: i + 1,
				error: `Step ${i + 1} (${step.tool}) failed: ${err}`,
			}
		}

		// Process extract expressions
		if (step.extract) {
			for (const [varName, expression] of Object.entries(step.extract)) {
				const extracted = evaluateExtract(expression, result)
				if (extracted) {
					vars[varName] = extracted
					if (options.verbose) {
						console.log(`  [extract] ${varName} = ${extracted.length > 80 ? extracted.slice(0, 77) + '...' : extracted}`)
					}
				} else if (options.verbose) {
					console.log(`  [extract] ${varName} = (not found)`)
				}
			}
		}
	}

	// Validate
	const validation = await validateTask(conn, sessionId, task.validate)
	if (!validation.passed) {
		if (options.fallback) {
			if (options.verbose) {
				console.log(`  [validate] failed: ${validation.reason}`)
				console.log(`  [validate] falling back to LLM for full task...`)
			}
			try {
				await conn.call('performTask', [sessionId, task.description], { timeout: 300000 })
				const revalidation = await validateTask(conn, sessionId, task.validate)
				return {
					success: revalidation.passed,
					error: revalidation.passed ? undefined : `Validation failed after LLM fallback: ${revalidation.reason}`,
				}
			} catch (err) {
				return { success: false, error: `LLM fallback failed: ${err}` }
			}
		}
		return { success: false, error: `Validation failed: ${validation.reason}` }
	}

	return { success: true }
}

/**
 * Generate a natural-language description of a step for LLM fallback.
 */
function describeStep(step: { tool: string; args?: Record<string, unknown> }, resolvedArgs: Record<string, unknown>): string {
	switch (step.tool) {
		case 'navigate':
			return `Navigate the browser to ${resolvedArgs.url}`
		case 'interact':
			if (resolvedArgs.action === 'click') {
				return `Click the element matching selector "${resolvedArgs.selector}" on the current page`
			}
			if (resolvedArgs.action === 'type') {
				return `Type "${resolvedArgs.value}" into the element matching selector "${resolvedArgs.selector}"`
			}
			if (resolvedArgs.action === 'select') {
				return `Select the value "${resolvedArgs.value}" in the dropdown matching selector "${resolvedArgs.selector}"`
			}
			return `Interact with element "${resolvedArgs.selector}" (${resolvedArgs.action})`
		case 'wait_for_tick':
			return 'Wait for the page to settle and observe any new events'
		case 'get_actions':
			return 'List available actions on the current page'
		case 'get_events':
			return 'Review all events captured so far'
		default:
			return `Execute ${step.tool} with args: ${JSON.stringify(resolvedArgs)}`
	}
}
