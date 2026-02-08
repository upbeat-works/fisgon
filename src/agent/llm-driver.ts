import { generateText, tool, stepCountIs } from 'ai'
import { z } from 'zod'

import { type Action, type InteractCommand, type ProbeEvent, type Tick } from '../core/types.js'
import { model } from './ai.js'

// Context object — avoids exposing private agent internals directly.
// The agent constructs this from its own internal methods + session runtime.
export type TaskContext = {
	sendBrowserCommand: (command: unknown) => Promise<unknown>
	waitForTick: (timeoutMs: number) => Promise<Tick>
	getEvents: () => ProbeEvent[]
	appUrl: string
	loginUrl?: string
}

const SYSTEM_PROMPT = `You are a browser automation agent. You control a real browser and can observe both client-side and server-side events.

Your tools give you full control over browser navigation and interaction. Use them to accomplish the user's instruction.

## How events work

Every action in the browser generates events from two sources:
- **Browser probes**: fetch requests/responses, navigation changes
- **Server probes**: SQL queries, custom application events (e.g. email content, background jobs)

After performing an action (clicking submit, navigating), call \`wait_for_tick\` to see what happened. A "tick" is a group of events collected until silence (no new events for ~500ms). The tick contains ALL events — both browser-side and server-side.

## Strategy

1. Use \`get_actions\` to discover available interactive elements on the page (forms, links, buttons)
2. Use \`open_action\` to inspect a specific element's HTML and understand its fields
3. Use \`interact\` to fill fields, click buttons, or select options
4. Use \`wait_for_tick\` after actions to see what happened (including server-side effects)
5. Use \`navigate\` to go to specific URLs
6. Use \`get_events\` to review the full event history if needed

## Important

- Discover elements with \`get_actions\` — do NOT guess CSS selectors
- After interacting with a form, always \`wait_for_tick\` to see the result
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

		interact: tool<{ action: 'type' | 'click' | 'select'; selector: string; value?: string }, string>({
			description:
				'Type text, click, or select an option in the browser. Use CSS selectors from open_action results.',
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
				return 'ok'
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

	const result = await generateText({
		model,
		system: SYSTEM_PROMPT + `\n\n## App context\n\n${appContext.join('\n')}`,
		prompt: instruction,
		tools: createTools(ctx),
		stopWhen: stepCountIs(30),
	})

	return result.text
}
