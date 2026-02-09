# fisgon

*__Fisgón__ (fee-SGOHN) is Spanish for "nosy person" — the kind who can't help but peek through the window to see what's going on.*

<p align="center">
  <img src=".github/sickos.png" width="100" alt="Yes... ha ha ha... YES!" />
</p>

*That's exactly what this tool does. It watches every fetch request, every SQL query, every navigation event, every email your app sends — and it loves every second of it. Your app has no secrets from el fisgón.*

*100% of the code was written by Claude Opus. A human just pointed and said "make it snoop on everything." The fisgón obliged.*

---

Low-level primitives for LLM-driven application testing.

Fisgon lets an LLM agent control a real browser while observing both client-side **and** server-side events. It captures every fetch request, navigation, SQL query, and custom event into **ticks** — groups of events collected during silence — giving the agent a complete picture of what happened after each action.

## How it works

<p align="center">
  <a href="https://x.com/i/status/2020660017272365349">
    <img src=".github/demo.png" height="250" alt="Watch demo" />
  </a>
  <br />
  <a href="https://x.com/i/status/2020660017272365349">Watch demo</a>
</p>

1. **Start a session** — Fisgon launches a browser and connects probes
2. **Give an instruction** — An LLM agent navigates the app like a real user, discovering links, filling forms, and clicking buttons
3. **Observe everything** — Browser probes capture fetch traffic and navigation; server probes capture SQL queries and custom events (e.g. email content, background jobs)
4. **Save and replay** — The agent's trace is distilled into a deterministic YAML task file that can be replayed without an LLM

```
fisgon start                                   # launch browser + session
fisgon do "Sign up and verify email" --save-task signup  # LLM does it, saves task
fisgon run signup                              # replay without LLM
```

## Install

```bash
npm install fisgon
```

## CLI

```bash
fisgon start [options]              # Start a session with browser
fisgon do <instruction> [options]   # LLM agent performs a task
fisgon run <task-name> [options]    # Replay a saved task
fisgon navigate <url> [options]     # Navigate to a URL
fisgon actions                      # List interactive elements on page
fisgon interact <selector> [options] # Interact with an element
fisgon tick [options]               # Wait for next tick
fisgon events                       # View all session events
fisgon open <actionId>              # Inspect an action's HTML
fisgon stop                         # Stop the session
```

## Configuration

Create a `fisgon.config.ts` (or `.js` / `.mjs`) in your project root:

```typescript
import { defineConfig } from 'fisgon'

export default defineConfig({
  url: 'http://localhost:3000',
  loginUrl: '/login',
  identity: {
    admin: { email: 'admin@example.com', password: 'secret' },
  },
  probes: {
    fetch: { match: ['/api/**'] },
    navigation: true,
  },
  tick: {
    silenceMs: 500,  // wait 500ms of silence to close a tick
    maxMs: 30000,    // max tick duration
  },
})
```

## Server-side probes

Fisgon can observe your server too. Add a probe to capture SQL queries and custom events:

```typescript
import { createProbe } from 'fisgon/server'

const probe = createProbe({ url: 'http://localhost:9876' })

// In your request handler:
const scoped = probe.fromRequest(request)
scoped.fromSQL('INSERT INTO users ...')
scoped.emit({ source: 'email', type: 'sent', timestamp: Date.now(), data: { to, subject, text } })
```

## Task files

Tasks live in `.fisgon/tasks/` as YAML:

```yaml
name: login
description: Log in with email and password
params:
  email: admin@example.com
  password: secret
steps:
  - tool: navigate
    args:
      url: "{{loginUrl}}"
  - tool: interact
    args:
      action: type
      selector: input[name="email"]
      value: "{{email}}"
  - tool: interact
    args:
      action: type
      selector: input[name="password"]
      value: "{{password}}"
  - tool: interact
    args:
      action: click
      selector: button[type="submit"]
validate:
  url_contains: /dashboard
```

Tasks support `{{param}}` placeholders and `extract` to capture dynamic values (like magic link URLs from email events) for use in later steps.

## Architecture

```
CLI ──────────────┐
                  │  WebSocket
Browser probes ───┤──────────── Agent (Cloudflare Durable Object)
                  │                 ├── Event ingestion
                  │                 ├── Tick detection
Server probes ────┘  HTTP POST      ├── SQLite session store
                                    └── LLM task execution
```

The agent runs locally via `wrangler dev` or remotely on Cloudflare Workers. The CLI and browser probes connect over WebSocket; server probes send events via HTTP POST. The browser gets instrumented with injected scripts that track fetch requests, navigation, and interactive elements.

## License

[O'Saasy License](LICENSE.md) — free to use, modify, and distribute; cannot be offered as a competing SaaS product.
