import { routeAgentRequest } from 'agents'

export { FisgonAgent } from './index.js'

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    // Route WebSocket and HTTP requests to the FisgonAgent Durable Object
    const response = await routeAgentRequest(request, env)
    if (response) return response

    return new Response('Fisgon Agent — connect via WebSocket', { status: 200 })
  },
}
