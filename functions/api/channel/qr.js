import { requireAdmin } from '../../_lib/auth.js'
import { checkHealth, launchChannel, fetchLoginQr } from '../../_lib/whapi.js'
import { json } from '../../_lib/respond.js'

// WhatsApp rotates the pairing QR roughly every 20 seconds; the client uses
// this to show an expiry countdown and refetch before it dies.
const QR_TTL_SECONDS = 20

// A channel that can hand out a QR is in one of these states. Anything else
// (LAUNCHING, INIT, unknown) is still coming up and cannot render one yet.
const QR_READY = new Set(['QR', 'STARTING'])

// After asking Whapi to launch, wait briefly for the channel to reach a
// QR-ready state before requesting the image. Bounded so the request stays
// snappy — if it is not ready in time we hand back a soft "starting" and let
// the client's countdown refetch, rather than blocking or 500ing.
const READY_POLL_ATTEMPTS = 4
const READY_POLL_MS = 1200
// How long the client should wait before asking again while still starting.
const STARTING_RETRY_SECONDS = 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const starting = (status) =>
  json({ ok: false, connected: false, status: 'starting', channel_status: status ?? null, retry_in: STARTING_RETRY_SECONDS }, 200)

/**
 * GET /api/channel/qr  (admin only)
 *
 * Returns a fresh login QR as a data URL, OR reports that the channel is
 * already connected, OR a soft "starting" the client should retry.
 *
 * Flow (Bug 2 fix — launch and fetch are decoupled):
 *   1. If already AUTH, no QR is needed.
 *   2. Ask Whapi to (re)launch the channel (wakeup), then poll /health until it
 *      reaches a QR-ready state (QR/STARTING).
 *   3. Fetch /users/login/image WITHOUT wakeup — a pure read of a QR that now
 *      exists. Whapi's transitional 500 is mapped to a soft "starting".
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

  // Launch, then wait for the channel to be able to issue a QR. launchChannel is
  // GET /health?wakeup=true, so its result is already the first health read.
  let state = await launchChannel(env)
  for (let i = 0; i < READY_POLL_ATTEMPTS && !state.connected && !QR_READY.has(state.status); i++) {
    await sleep(READY_POLL_MS)
    state = await checkHealth(env)
  }

  if (state.connected) {
    return json({ ok: true, connected: true, status: state.status })
  }

  console.log(
    'whapi QR: channel state before fetch',
    JSON.stringify({ status: state.status, code: state.code ?? null, connected: state.connected })
  )

  // Still not QR-ready: tell the client to retry shortly rather than erroring.
  if (!QR_READY.has(state.status)) {
    console.log('whapi QR: channel not QR-ready yet, returning starting', JSON.stringify({ status: state.status }))
    return starting(state.status)
  }

  // The channel can render a QR now — fetch it as a pure read (no wakeup).
  const qr = await fetchLoginQr(env, { size: 400, wakeup: false })

  // Whapi answered 409 "already authenticated" — treat as connected.
  if (qr.alreadyAuthed) {
    return json({ ok: true, connected: true, status: 'AUTH' })
  }

  if (!qr.ok) {
    // Transitional: /health says QR-ready but the image is not materialised yet
    // — a Whapi 5xx, an empty/no-data body, or a transport blip. All of these
    // mean "not ready this instant", so soft "starting" and let the client's
    // countdown refetch. This is the SAME treatment for every caller (initial,
    // auto-refresh tick, and manual New-code all hit this one path).
    const status = Number(qr.status) || 0
    const transitional =
      status >= 500 ||
      status === 0 || // thrown/transport failure (fetchLoginQr catch → no status)
      qr.error === 'qr_empty' ||
      qr.error === 'qr_no_data'
    if (transitional) {
      console.log(
        'whapi QR: transitional image failure, returning starting',
        JSON.stringify({ channel_status: state.status, qr_status: qr.status ?? null, error: qr.error ?? null })
      )
      return starting(state.status)
    }
    // Only a genuinely terminal failure (e.g. an unexpected 4xx) is surfaced,
    // so the UI can show the status and offer a retry rather than spinning.
    return json(
      { ok: false, connected: false, status: state.status, error: qr.error || 'qr_unavailable' },
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
