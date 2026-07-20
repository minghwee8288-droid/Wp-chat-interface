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

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
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
