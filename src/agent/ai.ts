import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAiGateway } from 'ai-gateway-provider'
import { createOpenAI } from 'ai-gateway-provider/providers/openai'
import { env } from 'cloudflare:workers'

const gateway = createOpenAICompatible({
	name: 'cf-ai-gateway',
	baseURL: `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.AI_GATEWAY}/compat`,
	apiKey: env.AI_GATEWAY_TOKEN,
})

export const model = gateway.chatModel('anthropic/claude-haiku-4-5-20251001')

// OpenAI model via AI Gateway for structured output (json_schema)
const aiGateway = createAiGateway({
	accountId: env.ACCOUNT_ID,
	gateway: env.AI_GATEWAY,
	apiKey: env.AI_GATEWAY_TOKEN,
})
const openai = createOpenAI()
export const structuredModel = aiGateway(openai.chat('gpt-5-nano-2025-08-07'))
