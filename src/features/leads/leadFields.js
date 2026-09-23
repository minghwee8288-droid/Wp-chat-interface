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
