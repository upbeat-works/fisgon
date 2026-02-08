// Browser command handler for the CLI process.
// When the agent needs to control the browser, it sends commands to the CLI,
// which owns the Playwright browser instance.

import { type InteractCommand } from '../core/types.js'
import { createActionScannerScript } from '../probes/action-scanner.js'

export type PlaywrightPage = {
	goto(url: string, options?: { waitUntil?: string }): Promise<unknown>
	evaluate<T>(fn: string | (() => T)): Promise<T>
	addInitScript(script: string): Promise<void>
	type(selector: string, text: string): Promise<void>
	click(selector: string): Promise<void>
	selectOption(selector: string, value: string): Promise<unknown>
	waitForLoadState(state?: string): Promise<void>
	context(): {
		addCookies(
			cookies: Array<{
				name: string
				value: string
				domain: string
				path: string
			}>,
		): Promise<void>
	}
	close(): Promise<void>
}

export type PlaywrightBrowser = {
	newPage(): Promise<PlaywrightPage>
	close(): Promise<void>
}

type Sendable = {
	send(data: string): void
}

type BrowserCommand = {
	type: string
	commandId: string
	[key: string]: unknown
}

function isBrowserCommand(msg: unknown): msg is BrowserCommand {
	return (
		typeof msg === 'object' &&
		msg !== null &&
		'type' in msg &&
		'commandId' in msg &&
		typeof (msg as BrowserCommand).type === 'string' &&
		typeof (msg as BrowserCommand).commandId === 'string'
	)
}

export function createBrowserHandler(sender: Sendable, page: PlaywrightPage) {
	return async (raw: unknown) => {
		if (!isBrowserCommand(raw)) return

		const command = raw
		const { commandId } = command

		try {
			let data: unknown = undefined

			switch (command.type) {
				case 'browser-navigate': {
					await page.goto(command.url as string, {
						waitUntil: 'networkidle',
					})
					break
				}

				case 'browser-evaluate': {
					data = await page.evaluate(command.script as string)
					break
				}

				case 'browser-actions': {
					data = await page.evaluate(createActionScannerScript())
					break
				}

				case 'browser-open': {
					const actionId = command.actionId as string
					data = await page.evaluate(
						`document.querySelector('[data-fisgon="${actionId}"]')?.innerHTML ?? ''`,
					)
					break
				}

				case 'browser-interact': {
					const cmd = command.command as InteractCommand
					switch (cmd.action) {
						case 'type':
							await page.type(cmd.selector, cmd.value)
							break
						case 'click':
							await page.click(cmd.selector)
							break
						case 'select':
							await page.selectOption(cmd.selector, cmd.value)
							break
					}
					break
				}

				case 'browser-set-cookie': {
					await page.context().addCookies([
						{
							name: command.name as string,
							value: command.value as string,
							domain: command.domain as string,
							path: '/',
						},
					])
					break
				}

				case 'browser-close': {
					await page.close()
					break
				}
			}

			sender.send(
				JSON.stringify({
					type: 'browser-result',
					commandId,
					success: true,
					data,
				}),
			)
		} catch (err) {
			sender.send(
				JSON.stringify({
					type: 'browser-result',
					commandId,
					success: false,
					error: String(err),
				}),
			)
		}
	}
}
