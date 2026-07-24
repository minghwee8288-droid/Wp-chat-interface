import { requireAdmin } from '../../_lib/auth.js'
import { checkHealth, fetchLoginQr } from '../../_lib/whapi.js'
import { json } from '../../_lib/respond.js'

// WhatsApp rotates the pairing QR roughly every 20 seconds; the client uses
// this to show an expiry countdown and refetch before it dies.
const QR_TTL_SECONDS = 20

/**
 * GET /api/channel/qr  (admin only)
 *
 * Returns a fresh login QR as a data URL, OR reports that the channel is
 * already connected so the client never shows a QR for a healthy channel.
 *
 * Admin-gated: the QR grants access to the linked WhatsApp account, so an agent
 * must never be able to fetch it.
 */
export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env)
  if (auth.response) return auth.response

  // Cheap guard first: if we are already AUTH, do not even mint a QR.
  const health = await checkHealth(env)
  if (health.connected) {
    return json({ ok: true, connected: true, status: health.status })
  }

  const qr = await fetchLoginQr(env, { size: 400 })

  // Whapi answered 409 "already authenticated" — treat as connected.
  if (qr.alreadyAuthed) {
    return json({ ok: true, connected: true, status: 'AUTH' })
  }

  if (!qr.ok) {
    // A QR failure is not a server bug; report it so the UI can show the status
    // and offer a retry rather than a spinner forever.
    return json(
      { ok: false, connected: false, status: health.status, error: qr.error || 'qr_unavailable' },
      502
    )
  }

  return json({
    ok: true,
    connected: false,
    status: 'QR',
    qr: qr.dataUrl,
    expires_in: QR_TTL_SECONDS,
  })
}
