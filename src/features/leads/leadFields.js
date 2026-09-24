// Part of the removable "new lead" feature — see functions/api/leads/mine.js
// for the full removal checklist.
//
// Display formatting for lead columns. Kept apart from the component so the
// mapping tables stay readable and are testable on their own.

/**
 * Most of these columns are free text or loosely-constrained strings written by
 * the chatbot, not enums — 'passport_renewal', 'as soon as possible', 'not
 * provided'. Underscores are separators rather than content, so they become
 * spaces; CSS supplies the casing.
 */
export const humanize = (value) => String(value ?? '').replace(/[_-]/g, ' ').trim()

/**
 * preferred_nationality is stored as a 2-letter code ('ID', 'PH'). The codes
 * that actually occur in this domain are spelled out; anything else falls back
 * to the raw value rather than rendering a blank, so an unmapped country is
 * still informative.
 */
const NATIONALITY = {
  ID: 'Indonesia',
  PH: 'Philippines',
  MM: 'Myanmar',
  IN: 'India',
  LK: 'Sri Lanka',
  BD: 'Bangladesh',
  NP: 'Nepal',
  KH: 'Cambodia',
  TH: 'Thailand',
  VN: 'Vietnam',
  SG: 'Singapore',
  MY: 'Malaysia',
}

export const nationality = (code) => {
  const key = String(code ?? '').trim().toUpperCase()
  return NATIONALITY[key] || humanize(code)
}

/**
 * The chatbot writes placeholder strings when a caller declines to answer.
 * 'not provided' is not a budget, and showing it as one would be a small lie —
 * these read as absent instead, which the caller then drops from the UI.
 */
const PLACEHOLDERS = new Set([
  'not provided',
  'not specified',
  'not mentioned',
  'unknown',
  'n/a',
  'na',
  'none',
  'null',
])

/** True when a value carries no information worth a chip. */
export const isBlank = (value) => {
  if (value === null || value === undefined) return true
  const text = String(value).trim()
  if (!text) return true
  return PLACEHOLDERS.has(text.toLowerCase())
}

/**
 * The chips shown under a lead, in priority order: what they want, then who
 * they want, then how urgently, then commercial and routing context.
 *
 * Empty and placeholder values are dropped rather than rendered as a dash —
 * most leads populate only four or five of these, and a column of dashes would
 * bury the fields that do carry an answer.
 *
 * `tone` selects the chip's colour role; see leads-feature.css.
 */
export function leadChips(lead) {
  const candidates = [
    { key: 'interest', label: 'Interest', value: lead.interest_type, tone: 'primary', format: humanize },
    { key: 'requirement', label: 'Requirement', value: lead.requirement, tone: 'primary', format: humanize },
    { key: 'nationality', label: 'Preferred', value: lead.preferred_nationality, tone: 'neutral', format: nationality },
    { key: 'urgency', label: 'Urgency', value: lead.urgency, tone: 'urgent', format: humanize },
    { key: 'budget', label: 'Budget', value: lead.budget, tone: 'neutral', format: humanize },
    { key: 'temperature', label: 'Temperature', value: lead.temperature, tone: 'temp', format: humanize },
    { key: 'source', label: 'Source', value: lead.source, tone: 'neutral', format: humanize },
  ]

  const chips = candidates
    .filter((chip) => !isBlank(chip.value))
    .map((chip) => ({ ...chip, text: chip.format(chip.value) }))

  // interest_type and requirement often agree ('replacement' / 'replacement'),
  // which would print the same word twice under two labels and read as a bug.
  // Identical text collapses to the first chip; genuinely different values
  // ('passport_renewal' vs 'childcare') both survive, which is the case the two
  // columns exist for.
  const seen = new Set()
  return chips.filter((chip) => {
    const key = chip.text.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * A lead timestamp as the agent reads it: '23 Sep, 11:41 AM' in their own
 * timezone, with the year added only when it is not the current one. Returns
 * null for a missing or unparseable value so the caller can drop the row.
 */
export function formatLeadTime(value) {
  if (isBlank(value)) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'
  return date.toLocaleString(undefined, opts)
}

/** Full, unambiguous form for the hover title. */
export const fullLeadTime = (value) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

/**
 * The OS's contact outcomes — what a salesperson logs after reaching out. Not
 * statuses: the server logs each as an activity and moves a 'new' lead on to
 * 'contacted' / 'follow_up_required'. Mirrors CONTACT_OUTCOMES in
 * functions/api/leads/outcome.js — keep the two in step.
 */
export const CONTACT_OUTCOMES = [
  'Contacted',
  'Call not picked',
  'No answer',
  'Wrong number',
  'Requested callback',
]

/** The OS's own wording for leads.status (os-minghwee leadLabels.ts). */
const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  follow_up_required: 'Follow-up required',
  qualified: 'Qualified',
  converted: 'Converted',
  lost: 'Lost',
}

export const statusLabel = (status) => STATUS_LABELS[status] || humanize(status)

/** Minutes → '2h 0m', or '48m' under an hour (os-minghwee fmtHM). */
export function fmtHM(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes))
  const h = Math.floor(m / 60)
  const mm = m % 60
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`
}

// SLA rule as the OS states it: first contact within 2h of receipt, and an
// uncontacted lead is rotated to another salesperson 3h after assignment.
const SLA_HOURS = 2
const REASSIGN_HOURS = 3

/**
 * The OS's Contact SLA pill (os-minghwee leadLabels.ts leadSlaPill), ported
 * for display only. Nothing here decides anything — the API's `sla_due_at` /
 * `sla_overdue` are authoritative; the client clock only keeps the countdown
 * text live between refetches. Returns { tone, icon, label }; `tone` picks the
 * colour in leads-feature.css.
 */
export function leadSlaPill(lead, nowMs) {
  const status = lead.status || 'new'
  if (status === 'converted') return { tone: 'done', icon: 'verified', label: 'Complete · converted' }
  if (status === 'lost') return { tone: 'closed', icon: 'closed', label: 'Closed' }
  if (status === 'follow_up_required') return { tone: 'callback', icon: 'callback', label: 'Callback set' }
  if (status !== 'new') return { tone: 'done', icon: 'verified', label: 'Complete · contact made' }

  // Deadline from sla_due_at when the payload carries it. /api/leads/mine reads
  // the table directly and does not, so fall back to received_at + 2h — the
  // same value the OS API computes (leads_service._sla_block).
  let dueMs = isBlank(lead.sla_due_at) ? NaN : new Date(lead.sla_due_at).getTime()
  if (Number.isNaN(dueMs)) {
    const receivedMs = new Date(lead.received_at).getTime()
    dueMs = Number.isNaN(receivedMs) ? nowMs : receivedMs + SLA_HOURS * 3600_000
  }
  const left = (dueMs - nowMs) / 60_000

  if (left > 0 && lead.sla_overdue !== true) {
    return { tone: 'ontrack', icon: 'ontrack', label: `On track · ${fmtHM(left)} to contact` }
  }

  // Past the SLA: while the current owner still holds it, warn when it leaves them.
  if (!isBlank(lead.assigned_at)) {
    const assignedMs = new Date(lead.assigned_at).getTime()
    if (!Number.isNaN(assignedMs)) {
      const toReassign = REASSIGN_HOURS * 60 - (nowMs - assignedMs) / 60_000
      if (toReassign > 0) {
        return { tone: 'overdue', icon: 'timer', label: `Overdue · reassigns in ${fmtHM(toReassign)}` }
      }
    }
  }

  return { tone: 'overdue', icon: 'warning', label: `Overdue · ${fmtHM(-left)} overdue` }
}
