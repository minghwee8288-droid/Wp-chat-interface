import { requireAuth } from '../../_lib/auth.js'
import { launchChannel } from '../../_lib/whapi.js'
import { json } from '../../_lib/respond.js'

/**
 * POST /api/channel/relaunch  (any authenticated user)
 *
 * The reconnect flow's first move: ask Whapi to relaunch the channel via
 * GET /health?wakeup=true. Some disconnections recover from this alone. The
 * client then polls /api/channel/status to see whether it worked, and only
 * falls back to the QR if it did not.
 *
 * Open to any signed-in user: it is the first step of the same reconnect flow as
 * the QR (below), so gating it to admin would 403 a non-admin before they ever
 * reached the QR. requireAuth still keeps it behind a valid session.
 */
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env)
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
