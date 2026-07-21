const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '')

/** 919669229223 -> +91 96692 29223 (best effort; falls back to +digits). */
export function formatNumber(number) {
  const d = digitsOnly(number)
  if (!d) return ''
  if (d.length === 12 && d.startsWith('91')) {
    return `+91 ${d.slice(2, 7)} ${d.slice(7)}`
  }
  if (d.length === 11 && d.startsWith('1')) {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  }
  return `+${d}`
}

export const displayName = (conversation) =>
  conversation?.customer_name?.trim() || formatNumber(conversation?.customer_number)

/**
 * First character of the first and last word.
 *
 * Uses Array.from so it splits by code POINT, not code unit — otherwise a name
 * beginning with an emoji or an astral-plane character (and many CJK/Indic
 * scripts once combining marks are involved) would be cut mid-character and
 * render as a replacement glyph. toUpperCase is a no-op for scripts without
 * case, which is correct.
 */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'

  const first = Array.from(parts[0])[0] || ''
  if (parts.length === 1) return first.toUpperCase()

  const last = Array.from(parts[parts.length - 1])[0] || ''
  return (first + last).toUpperCase()
}

/**
 * Deterministic avatar colour index, 0–7.
 *
 * Keyed on the phone number rather than the name so the colour survives a
 * contact being renamed. Plain FNV-1a — stable across sessions and devices,
 * which a random or insertion-order colour would not be.
 */
export function avatarIndex(identifier) {
  const key = String(identifier ?? '').replace(/\D/g, '') || String(identifier ?? '')
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 8
}

/** Compact stamp for the conversation list: time today, weekday this week, else date. */
export function relativeStamp(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)

  if (days === 0) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' })
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export function clockTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function dayLabel(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)

  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' })
  return date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
}

export const dayKey = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toDateString()
}

/** "Priya Sharma" -> "Priya". Rows only have room for one name. */
export function firstName(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return ''
  return trimmed.split(/\s+/)[0]
}

/** 4096 -> "4.0 KB". Documents show size under the filename. */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Label for a media message with no caption. */
export function mediaLabel(mediaType) {
  if (mediaType === 'image') return '📷 Photo'
  if (mediaType === 'video') return '🎥 Video'
  if (mediaType === 'audio') return '🎵 Audio'
  return '📄 Document'
}

/**
 * Live filter: case-insensitive substring on the name, OR a digits-only
 * substring on the number so "732" matches "917326198427".
 */
export function matchesQuery(conversation, rawQuery) {
  const query = String(rawQuery || '').trim()
  if (!query) return true

  const name = String(conversation.customer_name || '').toLowerCase()
  if (name && name.includes(query.toLowerCase())) return true

  const queryDigits = digitsOnly(query)
  if (queryDigits && digitsOnly(conversation.customer_number).includes(queryDigits)) {
    return true
  }

  return false
}
