import { createAiGateway } from 'ai-gateway-provider'
import { createAnthropic } from 'ai-gateway-provider/providers/anthropic'
import { env } from 'cloudflare:workers'

export const aiGateway = createAiGateway({
	accountId: env.ACCOUNT_ID,
	gateway: env.AI_GATEWAY,
	apiKey: env.AI_GATEWAY_TOKEN,
})

const anthropic = createAnthropic()

export const model = aiGateway(anthropic.chat('anthropic/claude-sonnet-4-5-20250929'))
