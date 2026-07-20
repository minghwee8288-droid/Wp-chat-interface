// Fetch wrapper. Attaches the bearer token and surfaces a 401 as a logout
// signal that AuthContext subscribes to.

let token = null
let onUnauthorized = null

export function setToken(value) {
  token = value || null
}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let res
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    throw new ApiError('Network error — check your connection', 0)
  }

  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized()
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

export const api = {
  login: (email, password) =>
    request('/login', { method: 'POST', body: { email, password } }),

  conversations: (signal) => request('/conversations', { signal }),

  messages: (conversationId, signal) =>
    request(`/messages?conversation_id=${encodeURIComponent(conversationId)}`, { signal }),

  send: (conversationId, body) =>
    request('/send', { method: 'POST', body: { conversation_id: conversationId, body } }),

  assign: (conversationId, assignedUserId) =>
    request('/assign', {
      method: 'POST',
      body: { conversation_id: conversationId, assigned_user_id: assignedUserId },
    }),

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
