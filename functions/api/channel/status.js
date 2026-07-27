import { requireAuth } from '../../_lib/auth.js'
import { checkHealth } from '../../_lib/whapi.js'
import { observeChannel } from '../../_lib/channel-gap.js'
import { json } from '../../_lib/respond.js'

/**
 * GET /api/channel/status
 *
 * Normalised channel health for the banner and the account dropdown, AND the
 * heartbeat that drives automatic gap recovery: observeChannel persists the
 * connected/disconnected state and, on a reconnect, creates a recovery sync for
 * the outage window. observeChannel never throws, so this endpoint always
 * returns health even if recovery bookkeeping fails.
 *
 * `auto_recovery` is the recovery job an admin tab should drive (or null).
 * `auto_halted` is set when an account-level Whapi error paused auto-recovery.
 *
 * Always 200: an unreachable Whapi is a disconnected channel, not a server
 * error, and the client must be able to render that state.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env)
  if (auth.response) return auth.response

  const health = await checkHealth(env)
  const observed = await observeChannel(env, health)

  return json({
    ok: true,
    connected: health.connected,
    status: health.status,
    uptime: health.uptime,
    checked_at: health.checked_at,
    auto_recovery: observed.auto || null,
    auto_halted: observed.halted || null,
  })
}
