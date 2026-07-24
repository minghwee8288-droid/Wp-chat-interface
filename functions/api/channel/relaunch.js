import { requireAdmin } from '../../_lib/auth.js'
import { launchChannel } from '../../_lib/whapi.js'
import { json } from '../../_lib/respond.js'

/**
 * POST /api/channel/relaunch  (admin only)
 *
 * The reconnect flow's first move: ask Whapi to relaunch the channel via
 * GET /health?wakeup=true. Some disconnections recover from this alone. The
 * client then polls /api/channel/status to see whether it worked, and only
 * falls back to the QR if it did not.
 *
 * Admin-gated because relaunching (and, next, the QR) touches the WhatsApp
 * account itself — an agent seeing the banner must not be able to trigger this.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  const health = await launchChannel(env)

  return json({
    ok: true,
    connected: health.connected,
    status: health.status,
    uptime: health.uptime,
    checked_at: health.checked_at,
  })
}
