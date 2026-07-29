import { requireAdmin } from '../../_lib/auth.js'
import { checkHealth, launchChannel, fetchLoginQr } from '../../_lib/whapi.js'
import { json } from '../../_lib/respond.js'

// WhatsApp rotates the pairing QR roughly every 20 seconds; the client uses
// this to show an expiry countdown and refetch before it dies.
const QR_TTL_SECONDS = 20

// Only 'QR' means Whapi can actually render the pairing image. STARTING/LAUNCHING
// are still coming up — we poll THROUGH them but must NOT fetch the image there
// (that is what 500s). Reaching 'QR' is what gates the fetch.
const QR_READY_STATE = 'QR'

// After asking Whapi to launch, poll /health this many times waiting to reach
// 'QR'. If it never does, we return soft "starting" and the client retries.
const READY_POLL_ATTEMPTS = 4
const READY_POLL_MS = 1200

// At the QR-ready state the image should render. Absorb a one-off blip with a
// bounded internal retry; a failure that PERSISTS at 'QR' is a real, actionable
// error — never an endless 'starting' loop.
const IMAGE_FETCH_ATTEMPTS = 3
const IMAGE_RETRY_MS = 800

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

  // Launch, then poll /health until the channel reaches 'QR' (or connects). We
  // poll THROUGH STARTING/LAUNCHING but never fetch the image there. launchChannel
  // is GET /health?wakeup=true, so its result is already the first health read.
  let state = await launchChannel(env)
  for (let i = 0; i < READY_POLL_ATTEMPTS && !state.connected && state.status !== QR_READY_STATE; i++) {
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

  // Still coming up (not yet 'QR'): soft "starting" — the client retries, but
  // only up to a total-time cap so a stuck launch surfaces rather than spins.
  if (state.status !== QR_READY_STATE) {
    console.log('whapi QR: not QR-ready yet, returning starting', JSON.stringify({ status: state.status }))
    return starting(state.status)
  }

  // Channel reports 'QR' — the image SHOULD render now. Fetch it (pure read, no
  // wakeup), with a bounded internal retry to absorb a one-off blip. Log the
  // ACTUAL image status/body each time: an image failure while channel_status is
  // already 'QR' is the real unknown, so it must be visible in the logs.
  let lastFail = null
  for (let attempt = 1; attempt <= IMAGE_FETCH_ATTEMPTS; attempt++) {
    // Try a pure read first. If that fails at the QR-ready state, retry WITH
    // wakeup — safe here because the channel is already up (no launch to race),
    // and it covers a Whapi that only emits the image on a wakeup read. The
    // no-wakeup failure is still logged, so the cause stays visible.
    const wakeup = attempt > 1
    const qr = await fetchLoginQr(env, { size: 400, wakeup })

    // Whapi answered 409 "already authenticated" — treat as connected.
    if (qr.alreadyAuthed) {
      return json({ ok: true, connected: true, status: 'AUTH' })
    }
    if (qr.ok) {
      return json({ ok: true, connected: false, status: 'QR', qr: qr.dataUrl, expires_in: QR_TTL_SECONDS })
    }

    lastFail = { image_status: qr.status ?? null, image_error: qr.error ?? null }
    console.error(
      'whapi QR: image fetch FAILED while channel_status=QR',
      JSON.stringify({ attempt, of: IMAGE_FETCH_ATTEMPTS, wakeup, channel_status: state.status, ...lastFail })
    )
    if (attempt < IMAGE_FETCH_ATTEMPTS) await sleep(IMAGE_RETRY_MS)
  }

  // The image failed on every attempt while the channel says it is QR-ready.
  // This is a REAL, persistent failure — surface it (with detail) so it is
  // visible and actionable, instead of soft-looping forever.
  console.error(
    'whapi QR: image persistently unavailable at QR-ready state',
    JSON.stringify({ channel_status: state.status, ...lastFail })
  )
  return json(
    {
      ok: false,
      connected: false,
      status: state.status,
      channel_status: state.status,
      image_status: lastFail?.image_status ?? null,
      error: lastFail?.image_error || 'qr_unavailable',
    },
    502
  )
}
