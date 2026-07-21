// Direct Whapi integration. The app calls Whapi itself — there is no n8n hop.

const DEFAULT_API_URL = 'https://gate.whapi.cloud'

export function whapiConfig(env) {
  if (!env?.WHAPI_TOKEN) throw new Error('WHAPI_TOKEN is not configured')
  return {
    token: env.WHAPI_TOKEN,
    apiUrl: String(env.WHAPI_API_URL || DEFAULT_API_URL).replace(/\/+$/, ''),
  }
}

/** Digits only — strips a `@s.whatsapp.net` suffix, spaces, plus signs. */
export const toDigits = (value) => String(value ?? '').split('@')[0].replace(/\D/g, '')

/** Whapi has a distinct endpoint per media kind. */
const MEDIA_ENDPOINT = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
}

/**
 * Send a text message.
 * Resolves to {ok, messageId, error} — never throws, so a Whapi outage can't
 * take down /api/send after the row has already been persisted.
 */
export async function sendText(env, to, body) {
  return post(env, 'messages/text', {
    // `to` goes as bare digits, e.g. "13135555657". If a channel ever rejects
    // that, the alternative Whapi accepts is the full JID: `${digits}@s.whatsapp.net`.
    to: toDigits(to),
    body,
  })
}

/**
 * Send a media message. `mediaUrl` must be publicly fetchable by Whapi for the
 * life of the request — /api/send passes a 24h Supabase signed URL.
 * Same never-throws contract as sendText.
 */
export async function sendMedia(env, to, { mediaUrl, mediaType, caption, filename, mime }) {
  const endpoint = MEDIA_ENDPOINT[mediaType] || 'document'

  const payload = { to: toDigits(to), media: mediaUrl }
  if (caption) payload.caption = caption
  // Whapi uses the filename as the document's display name.
  if (endpoint === 'document') {
    if (filename) payload.filename = filename
    if (mime) payload.mime_type = mime
  }

  return post(env, `messages/${endpoint}`, payload)
}

/**
 * Download an inbound attachment's bytes from Whapi.
 * Resolves to {ok, bytes, mime, error} — never throws.
 */
export async function fetchMedia(env, mediaId, maxBytes = Infinity) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    if (!mediaId) return { ok: false, error: 'media_no_id' }

    const res = await fetch(`${apiUrl}/media/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 120)
      return { ok: false, error: `media_fetch_${res.status}${detail ? `: ${detail}` : ''}` }
    }

    // Trust Content-Length when present so an oversized body is rejected before
    // it is buffered into the isolate's memory.
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, error: 'media_too_large' }
    }

    const bytes = await res.arrayBuffer()
    if (bytes.byteLength > maxBytes) return { ok: false, error: 'media_too_large' }
    if (bytes.byteLength === 0) return { ok: false, error: 'media_empty' }

    const mime = String(res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()

    return { ok: true, bytes, mime: mime || null }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'media_fetch_failed') }
  }
}

async function post(env, endpointPath, payload) {
  try {
    const { token, apiUrl } = whapiConfig(env)

    const res = await fetch(`${apiUrl}/${endpointPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    })

    // Read the body once, defensively — errors are not always JSON.
    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      /* non-JSON response */
    }

    if (!res.ok) {
      const detail = data?.error?.message || data?.message || raw?.slice(0, 120) || ''
      return { ok: false, error: `whapi_${res.status}${detail ? `: ${detail}` : ''}` }
    }

    // Expected: { sent: true, message: { id: "..." } }. Shape varies, so probe
    // a couple of spots and just skip the id if it isn't there.
    const messageId = data?.message?.id ?? data?.id ?? null

    return { ok: true, messageId: messageId ? String(messageId) : null }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'whapi_request_failed') }
  }
}

/**
 * Contact profile picture.
 *
 * Whapi returns temporary pps.whatsapp.net URLs carrying an `oe=` expiry, so
 * the bytes must be downloaded and re-hosted — never stored or hotlinked.
 * We take `icon` (96x96) rather than `icon_full`: avatars render at 42px.
 *
 * Resolves to {ok, bytes, mime, error} — never throws. A disconnected channel
 * answers 401 "need channel authorization", which is a normal failure here.
 */
export async function fetchProfilePicture(env, chatId, maxBytes = 2 * 1024 * 1024) {
  try {
    const { token, apiUrl } = whapiConfig(env)
    const id = toDigits(chatId)
    if (!id) return { ok: false, error: 'profile_no_id' }

    const res = await fetch(`${apiUrl}/contacts/${encodeURIComponent(id)}/profile`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 120)
      return { ok: false, error: `profile_${res.status}${detail ? `: ${detail}` : ''}` }
    }

    const data = await res.json().catch(() => null)
    const icon = data?.icon
    // No picture set is the common case, not an error worth shouting about.
    if (!icon || typeof icon !== 'string') return { ok: false, error: 'profile_no_icon' }

    const img = await fetch(icon)
    if (!img.ok) return { ok: false, error: `profile_image_${img.status}` }

    const declared = Number(img.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, error: 'profile_too_large' }
    }

    const bytes = await img.arrayBuffer()
    if (bytes.byteLength === 0) return { ok: false, error: 'profile_empty' }
    if (bytes.byteLength > maxBytes) return { ok: false, error: 'profile_too_large' }

    const mime = String(img.headers.get('content-type') || '').split(';')[0].trim()
    return { ok: true, bytes, mime: mime || 'image/jpeg' }
  } catch (err) {
    return { ok: false, error: String(err?.message || 'profile_fetch_failed') }
  }
}

/**
 * Channel health.
 *
 * Keys on status.text === 'AUTH', NOT the numeric code: Whapi's live response
 * reports AUTH as code 4 while their documentation lists it as 5 (and lists 5
 * as ERROR elsewhere). The text is the only field both agree on. Anything we
 * cannot positively identify as AUTH counts as disconnected.
 *
 * Never throws — an unreachable Whapi is itself a disconnected state.
 */
export async function checkHealth(env) {
  const checkedAt = new Date().toISOString()
  try {
    const { token, apiUrl } = whapiConfig(env)

    const res = await fetch(`${apiUrl}/health`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })

    if (!res.ok) {
      return {
        connected: false,
        status: `http_${res.status}`,
        uptime: null,
        checked_at: checkedAt,
        error: `health_${res.status}`,
      }
    }

    const data = await res.json().catch(() => null)
    const text = data?.status?.text ? String(data.status.text).toUpperCase() : null

    return {
      connected: text === 'AUTH',
      status: text || 'UNKNOWN',
      code: data?.status?.code ?? null,
      uptime: Number.isFinite(Number(data?.uptime)) ? Number(data.uptime) : null,
      channel_id: data?.channel_id ?? null,
      checked_at: checkedAt,
    }
  } catch (err) {
    return {
      connected: false,
      status: 'UNREACHABLE',
      uptime: null,
      checked_at: checkedAt,
      error: String(err?.message || 'health_failed'),
    }
  }
}
