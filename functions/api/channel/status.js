import { requireAuth } from '../../_lib/auth.js'
import { checkHealth } from '../../_lib/whapi.js'
import { json } from '../../_lib/respond.js'

/**
 * GET /api/channel/status
 *
 * Normalised channel health for the banner and the account dropdown.
 * Always 200: an unreachable Whapi is a disconnected channel, not a server
 * error, and the client must be able to render that state.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const health = await checkHealth(env)

  return json({
    ok: true,
    connected: health.connected,
    status: health.status,
    uptime: health.uptime,
    checked_at: health.checked_at,
  })
}
