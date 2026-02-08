import { type FisgonConfig } from '../core/types.js'
import { createInjectableScript } from '../probes/inject.js'
import { type PlaywrightBrowser, type PlaywrightPage } from './browser-handler.js'

export type BrowserSession = {
	browser: PlaywrightBrowser
	page: PlaywrightPage
	cleanup: () => Promise<void>
}

export async function launchBrowser(
	config: FisgonConfig,
	sessionId: string,
	options?: { headless?: boolean },
): Promise<BrowserSession> {
	const pw = (await import('playwright')) as {
		chromium: {
			launch(opts: { headless: boolean }): Promise<PlaywrightBrowser>
		}
	}

	const headless = options?.headless ?? false
	const browser = await pw.chromium.launch({ headless })
	const page = await browser.newPage()
	const targetUrl = new URL(config.url)

	// Set fisgon cookie so server probes can identify this session
	await page.context().addCookies([
		{
			name: 'fisgon',
			value: sessionId,
			domain: targetUrl.hostname,
			path: '/',
		},
	])

	// Inject browser probes (fetch, navigation, WS bootstrap)
	const probeScript = createInjectableScript(config, sessionId)
	await page.addInitScript(probeScript)

	const cleanup = async () => {
		await browser.close()
	}

	return { browser, page, cleanup }
}
