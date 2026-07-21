// Fetch wrapper.
//
// Access token lives in memory only — never sessionStorage, never localStorage.
// Durable session state is the HttpOnly refresh cookie, which this file cannot
// read by design; it only ever calls /api/refresh and lets the browser attach
// the cookie.

let token = null
let onSessionLost = null

export function setToken(value) {
  token = value || null
}

export function getToken() {
  return token
}

/** Called only after a refresh attempt has itself failed. */
export function setSessionLostHandler(fn) {
  onSessionLost = fn
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// Endpoints that must never trigger the refresh-and-retry path: a 401 from
// these IS the answer, and retrying would recurse.
const NO_RETRY = new Set(['/login', '/refresh', '/logout'])

/**
 * A single shared in-flight refresh.
 *
 * The inbox polls conversations every 5s and the open thread every 4s. When an
 * access token expires those land together, so without this every pending
 * request would fire its own /api/refresh — a storm, and worse, each rotation
 * would invalidate the previous one and log the user out. Everyone awaits the
 * same promise instead.
 */
let refreshInFlight = null

export function refreshSession() {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-store' },
      })
      if (!res.ok) return null

      const data = await res.json().catch(() => null)
      if (!data?.ok || !data.token) return null

      setToken(data.token)
      return data
    } catch {
      // Offline or network failure — indistinguishable from an expired
      // session here, so the caller decides what to do.
      return null
    } finally {
      // Cleared in a microtask so callers that awaited this exact promise all
      // observe the same result before a new attempt can start.
      queueMicrotask(() => {
        refreshInFlight = null
      })
    }
  })()

  return refreshInFlight
}

function buildHeaders(extra = {}) {
  const headers = { ...extra }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * Core request. On a 401 it attempts exactly one silent refresh and exactly
 * one retry — `retried` guards against any possibility of a loop.
 */
async function send(path, { method = 'GET', body, signal, raw = false } = {}, retried = false) {
  const headers = buildHeaders(
    body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}
  )

  let res
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      // FormData must be passed through untouched so the browser sets the
      // multipart boundary itself.
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal,
      credentials: 'same-origin',
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Network error — check your connection', 0)
  }

  if (res.status === 401 && !retried && !NO_RETRY.has(path.split('?')[0])) {
    const refreshed = await refreshSession()
    if (refreshed) return send(path, { method, body, signal, raw }, true)

    // Refresh failed too — the session is genuinely gone.
    setToken(null)
    if (onSessionLost) onSessionLost()
    throw new ApiError('Your session has expired. Please sign in again.', 401)
  }

  if (res.status === 401) {
    if (!NO_RETRY.has(path.split('?')[0])) {
      setToken(null)
      if (onSessionLost) onSessionLost()
    }
    throw new ApiError('Your session has expired. Please sign in again.', 401)
  }

  let data = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON body — fall through to the status-based message */
  }

  if (!res.ok || data?.ok === false) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status)
  }

  return data ?? {}
}

const request = (path, options) => send(path, options)

export const api = {
  login: (email, password) =>
    request('/login', { method: 'POST', body: { email, password } }),

  /** Cold-start session restore. Resolves to {token, user} or null. */
  refresh: () => refreshSession(),

  logout: () =>
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => null),

  conversations: (signal) => request('/conversations', { signal }),

  newConversation: (payload) =>
    request('/conversations/new', { method: 'POST', body: payload }),

  messages: (conversationId, signal) =>
    request(`/messages?conversation_id=${encodeURIComponent(conversationId)}`, { signal }),

  send: (conversationId, body, media = null) =>
    request('/send', {
      method: 'POST',
      body: { conversation_id: conversationId, body, ...(media || {}) },
    }),

  /** Uploads one file as multipart/form-data. Returns the media_* fields. */
  upload: (conversationId, file, signal) => {
    const form = new FormData()
    form.append('conversation_id', String(conversationId))
    form.append('file', file)
    return request('/upload', { method: 'POST', body: form, signal, raw: true })
  },

  /** Short-lived signed URL for a private storage object. */
  mediaUrl: (mediaPath, signal) =>
    request(`/media/${String(mediaPath).split('/').map(encodeURIComponent).join('/')}`, {
      signal,
    }),

  assign: (conversationId, assignedUserId) =>
    request('/assign', {
      method: 'POST',
      body: { conversation_id: conversationId, assigned_user_id: assignedUserId },
    }),

  pushKey: () => request('/push/key'),

  pushSubscribe: (subscription) =>
    request('/push/subscribe', { method: 'POST', body: subscription }),

  pushUnsubscribe: (endpoint) =>
    request('/push/unsubscribe', { method: 'POST', body: { endpoint } }),

  users: (signal) => request('/users', { signal }),

  createUser: (payload) => request('/users/create', { method: 'POST', body: payload }),

  changePassword: (currentPassword, newPassword) =>
    request('/password/change', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
    }),

  resetPassword: (userId, newPassword) =>
    request('/password/reset', {
      method: 'POST',
      body: { user_id: userId, new_password: newPassword ?? null },
    }),
}
