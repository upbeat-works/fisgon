import { generateText, Output, tool, stepCountIs } from 'ai'
import { z } from 'zod'

import { type TaskFile } from '../core/task-file.js'
import { type Action, type InteractCommand, type ProbeEvent, type Tick } from '../core/types.js'
import { model, structuredModel } from './ai.js'

// Context object — avoids exposing private agent internals directly.
// The agent constructs this from its own internal methods + session runtime.
export type StepLog = {
	step: number
	toolCalls: Array<{
		name: string
		args: Record<string, unknown>
		result?: unknown
	}>
	text?: string
}

export type TaskContext = {
	sendBrowserCommand: (command: unknown) => Promise<unknown>
	waitForTick: (timeoutMs: number) => Promise<Tick>
	getEvents: () => ProbeEvent[]
	onStepLog?: (log: StepLog) => void
	appUrl: string
	loginUrl?: string
	currentUrl?: string
}

const SYSTEM_PROMPT = `You are a browser automation agent. You control a real browser and can observe both client-side and server-side events.

Your tools give you full control over browser navigation and interaction. Use them to accomplish the user's instruction.

## How events work

Every action in the browser generates events from two sources:
- **Browser probes**: fetch requests/responses, navigation changes
- **Server probes**: SQL queries, custom application events (e.g. email content, background jobs)

After performing an action (clicking submit, navigating), call \`wait_for_tick\` to see what happened. A "tick" is a group of events collected until silence (no new events for ~500ms). The tick contains ALL events — both browser-side and server-side.

## Strategy

You are a USER of the application. Navigate it the way a user would — by looking at the page and clicking links, buttons, and menus.

1. Use \`get_actions\` to discover what's on the current page (links, buttons, forms, nav items)
2. Use \`open_action\` to inspect an element's HTML if you need more detail
3. Use \`interact\` to click links, fill forms, press buttons — it returns the resulting events automatically
4. Use \`navigate\` ONLY for exact URLs you already know (e.g. a callback URL from an email event). Never guess URLs.
5. Use \`wait_for_tick\` only when you need to wait for delayed events (e.g. after a page load that triggers background work)
6. Use \`get_events\` to review the full event history if needed

**Always start by calling \`get_actions\` to see what's available on the page**, then follow links/buttons to reach your destination. Do NOT construct or guess URLs — find them in the UI.

## Important

- Discover elements with \`get_actions\` — do NOT guess CSS selectors or URLs
- Both \`interact\` and \`navigate\` return the tick with all events — no need to call \`wait_for_tick\` after them
- Server events can reveal things not visible in the browser: magic link URLs in emails, session tokens, SQL operations
- If a login flow sends a magic link email, the email content appears as a server probe event — extract the URL and navigate to it
- Keep going until the instruction is fully accomplished, then respond with a summary of what you did`

function createTools(ctx: TaskContext) {
	return {
		navigate: tool<{ url: string }, Tick>({
			description:
				'Navigate the browser to a URL. Returns the tick with all events (browser + server) that fired during page load.',
			inputSchema: z.object({
				url: z.string().describe('The URL to navigate to'),
			}),
			execute: async ({ url }) => {
				await ctx.sendBrowserCommand({ type: 'browser-navigate', url })
				return ctx.waitForTick(10000)
			},
		}),

		get_actions: tool<Record<string, never>, Action[]>({
			description:
				'List available actions (forms, links, buttons) on the current page.',
			inputSchema: z.object({}),
			execute: async () => {
				return (await ctx.sendBrowserCommand({
					type: 'browser-actions',
				})) as Action[]
			},
		}),

		open_action: tool<{ actionId: string }, string>({
			description:
				'Get the raw innerHTML of an action element. Use this to understand form fields, link targets, etc.',
			inputSchema: z.object({
				actionId: z
					.string()
					.describe('The action ID from get_actions results'),
			}),
			execute: async ({ actionId }) => {
				return (await ctx.sendBrowserCommand({
					type: 'browser-open',
					actionId,
				})) as string
			},
		}),

		interact: tool<{ action: 'type' | 'click' | 'select'; selector: string; value?: string }, Tick>({
			description:
				'Type text, click, or select an option in the browser. Use CSS selectors from open_action results. Returns the tick with all events that fired as a result.',
			inputSchema: z.object({
				action: z.enum(['type', 'click', 'select']).describe('The interaction type'),
				selector: z.string().describe('CSS selector for the target element'),
				value: z
					.string()
					.optional()
					.describe('Value to type or select (required for type/select)'),
			}),
			execute: async ({ action, selector, value }) => {
				let command: InteractCommand
				if (action === 'type') {
					command = { action: 'type', selector, value: value ?? '' }
				} else if (action === 'select') {
					command = { action: 'select', selector, value: value ?? '' }
				} else {
					command = { action: 'click', selector }
				}
				await ctx.sendBrowserCommand({
					type: 'browser-interact',
					command,
				})
				return ctx.waitForTick(10000)
			},
		}),

		wait_for_tick: tool<{ timeout?: number }, Tick>({
			description:
				'Wait for the next tick (silence = all events settled). Returns all events including server-side probe data (SQL queries, custom events like email content).',
			inputSchema: z.object({
				timeout: z
					.number()
					.optional()
					.describe('Timeout in ms (default 10000)'),
			}),
			execute: async ({ timeout }) => {
				return ctx.waitForTick(timeout ?? 10000)
			},
		}),

		get_events: tool<Record<string, never>, ProbeEvent[]>({
			description:
				'Get all events captured so far in this session. Use to review what has happened.',
			inputSchema: z.object({}),
			execute: async () => {
				return ctx.getEvents()
			},
		}),
	}
}

export async function runTask(
	ctx: TaskContext,
	instruction: string,
): Promise<string> {
	const appContext = [`App URL: ${ctx.appUrl}`]
	if (ctx.loginUrl) appContext.push(`Login URL: ${ctx.loginUrl}`)
	if (ctx.currentUrl) appContext.push(`Current browser URL: ${ctx.currentUrl} — the browser is already here, do NOT navigate away unless the instruction requires it`)

	let stepNumber = 0
	const result = await generateText({
		model,
		system: SYSTEM_PROMPT + `\n\n## App context\n\n${appContext.join('\n')}`,
		prompt: instruction,
		tools: createTools(ctx),
		stopWhen: stepCountIs(30),
		onStepFinish(step) {
			stepNumber++
			ctx.onStepLog?.({
				step: stepNumber,
				toolCalls: step.toolCalls.map((tc, i) => ({
					name: tc.toolName,
					args: tc.input as Record<string, unknown>,
					result: step.toolResults[i]?.output,
				})),
				text: step.text || undefined,
			})
		},
	})

	return result.text
}

const DISTILL_PROMPT = `You are analyzing a browser automation trace. Given the full sequence of tool calls and their results, distill it into a clean, minimal task file that can be replayed deterministically.

## Rules

1. **Only keep steps that change state**: \`navigate\`, \`interact\`, and \`wait_for_tick\`.
   - REMOVE all \`get_actions\`, \`open_action\`, and \`get_events\` calls — they are read-only discovery steps the LLM used to explore the page. They are not needed for replay.
2. **Keep every interact step that matters** — clicks that switch views, type into fields, or submit forms. Look at the trace carefully: if a click changed the page (the next get_actions returned different results), it must be included.
3. **Remove missteps**: failed clicks (errors in result), redundant retries, and steps that didn't contribute to the goal.
4. **Use stable CSS selectors** — never use \`data-fisgon\` attributes (they are dynamically assigned and change between sessions). Never use \`:contains()\` (not valid CSS). Prefer: \`button[type="submit"]\`, \`input[name="email"]\`, \`a[href="..."]\`, \`role\` attributes, or \`nth-of-type\`. For text matching use Playwright's \`:has-text("...")\` pseudo-selector (e.g. \`button:has-text("Log In")\`).
5. **Parameterize dynamic values**: emails, passwords, URLs that vary. Replace with \`{{paramName}}\` placeholders and list defaults in \`params\`.
6. **Extract dynamic values** from step results: for values that are only known at runtime (like magic link URLs from email events), add \`extract\` on the step that produces them. The extract object maps variable names to expressions. Example: \`{"callbackUrl": "events[source=email].data.text | match(/http\\\\S+callback\\\\S+/)"}\`. The variable can then be used as \`{{callbackUrl}}\` in later steps.
7. **Add validation** based on the final state (typically url_contains).

## Output schema

- name: short kebab-case identifier
- description: what this task does
- params: object of param names to default values (null if none)
- steps: array of {tool, args, extract} — only navigate, interact, wait_for_tick
- validate: {url_contains, url_matches, event_exists} (null fields for unused)

Tool args:
- interact: {action: "click"|"type"|"select", selector: string, value?: string}
- navigate: {url: string}
- wait_for_tick: {timeout?: string}`

const taskFileSchema = z.object({
	name: z.string(),
	description: z.string(),
	params: z.record(z.string()).nullable(),
	steps: z.array(z.object({
		tool: z.string(),
		args: z.record(z.string()).nullable(),
		extract: z.record(z.string()).nullable(),
	})),
	validate: z.object({
		url_contains: z.string().nullable(),
		url_matches: z.string().nullable(),
		event_exists: z.object({
			source: z.string(),
			type: z.string(),
		}).nullable(),
	}).nullable(),
})

const matchTasksSchema = z.object({
	tasks: z.array(z.string()).nullable(),
	remaining: z.string().nullable(),
})

export async function matchTasks(
	instruction: string,
	tasks: Array<{ name: string; description: string }>,
): Promise<{ tasks: string[] | null; remaining: string | null }> {
	const catalog = tasks.map((t) => `- ${t.name}: ${t.description}`).join('\n')

	const result = await generateText({
		model: structuredModel,
		output: Output.object({ schema: matchTasksSchema }),
		system: `You are a task planner. Given a user instruction and a catalog of saved tasks, determine which saved tasks (if any) should be run to fulfill the instruction, and what (if anything) remains after those tasks.

Rules:
- Only match tasks that clearly correspond to part of the instruction
- Return task names in the order they should be executed
- If no tasks match, return tasks: null
- If the matched tasks fully cover the instruction, return remaining: null
- If there is leftover work after the matched tasks, describe it in remaining as a concise instruction for a browser automation agent
- Do NOT invent tasks — only return names from the catalog`,
		prompt: `Instruction: ${instruction}

Task catalog:
${catalog}`,
	})

	const output = result.output as { tasks: string[] | null; remaining: string | null }
	return {
		tasks: output.tasks,
		remaining: output.remaining,
	}
}

export async function distillSteps(
	stepLogs: StepLog[],
	instruction: string,
	finalUrl: string,
): Promise<TaskFile> {
	const trace = stepLogs.map((log) =>
		log.toolCalls.map((tc) => ({
			tool: tc.name,
			args: tc.args,
			result: tc.result,
		})),
	).flat()

	const result = await generateText({
		model: structuredModel,
		output: Output.object({ schema: taskFileSchema }),
		system: DISTILL_PROMPT,
		prompt: [
			`Instruction: ${instruction}`,
			`Final browser URL: ${finalUrl}`,
			`\nFull trace (${trace.length} tool calls):`,
			JSON.stringify(trace, null, 2),
		].join('\n'),
	})

	return result.output as TaskFile
}
