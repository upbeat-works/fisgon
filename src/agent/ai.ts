import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { env } from 'cloudflare:workers'

const gateway = createOpenAICompatible({
	name: 'cf-ai-gateway',
	baseURL: `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.AI_GATEWAY}/compat`,
	apiKey: env.AI_GATEWAY_TOKEN,
})

export const model = gateway.chatModel('anthropic/claude-haiku-4-5-20251001')
