import  { type Action, type InteractCommand } from '../core/types.js'

// Abstract browser control interface.
// In local mode: communicates with Playwright via the CLI process.
// In remote mode: uses Cloudflare Browser Rendering API.

export type BrowserBridge = {
  navigate(url: string): Promise<void>
  evaluateScript(script: string): Promise<unknown>
  getActions(): Promise<Action[]>
  getInnerHTML(actionId: string): Promise<string>
  interact(command: InteractCommand): Promise<void>
  setCookie(name: string, value: string, domain: string): Promise<void>
  close(): Promise<void>
}

// The browser bridge is controlled by the CLI in local mode.
// The agent delegates browser commands to the CLI connection, which runs Playwright.
// This keeps the agent itself stateless w.r.t. browser — the CLI owns the browser process.

export type BrowserCommand =
  | { type: 'browser-navigate'; url: string }
  | { type: 'browser-evaluate'; script: string }
  | { type: 'browser-actions' }
  | { type: 'browser-open'; actionId: string }
  | { type: 'browser-interact'; command: InteractCommand }
  | { type: 'browser-set-cookie'; name: string; value: string; domain: string }
  | { type: 'browser-close' }

export type BrowserResult =
  | { type: 'browser-result'; success: true; data?: unknown }
  | { type: 'browser-result'; success: false; error: string }
