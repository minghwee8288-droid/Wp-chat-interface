// Part of the removable "new lead" feature — see functions/api/leads/mine.js
// for the full removal checklist.
//
// Mounted once, in the Shell topbar. Renders nothing at all when the caller has
// no leads, so a user who never owns leads sees no change to the UI. The red
// badge counts UNREAD leads only; read ones stay in the list.

import { useEffect, useRef, useState } from 'react'
import { Bell, Check, Mail, Phone } from 'lucide-react'
import { useMyLeads, isUnread } from './useMyLeads.js'
import { leadChips, isBlank, formatLeadTime, fullLeadTime, CONTACT_OUTCOMES, statusLabel } from './leadFields.js'

export default function LeadsBell() {
  const { leads, readSet, unreadCount, loading, markRead, markAllRead, logOutcome } = useMyLeads()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  // Close on outside click / Escape — same contract as the user menu next door.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // If the list empties (e.g. the last lead is archived in the OS), the bell
  // is about to unmount — close the panel rather than let it hang.
  useEffect(() => {
    if (open && leads.length === 0) setOpen(false)
  }, [open, leads.length])

  // The panel is anchored to the bell, but the bell is not the rightmost
  // control in the topbar, so on a phone a right-aligned panel runs off the
  // left edge of the screen. Measure how far the bell sits from the viewport's
  // right edge and publish it; the mobile CSS subtracts it to pull the panel
  // back onto the gutter. Recomputed on resize/orientation change because the
  // gap moves with the topbar's layout.
  useEffect(() => {
    if (!open) return undefined
    const measure = () => {
      const el = wrapRef.current
      if (!el) return
      const gap = window.innerWidth - el.getBoundingClientRect().right
      el.style.setProperty('--leads-pop-shift', `${Math.max(0, Math.round(gap))}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
    }
  }, [open])

  // No leads at all → nothing is drawn. With leads but none unread, the bell
  // stays (the list is still worth opening) but carries no badge.
  if (loading || leads.length === 0) return null

  const bellLabel = unreadCount
    ? `${unreadCount} unread lead${unreadCount === 1 ? '' : 's'}`
    : 'Leads'

  return (
    <div className="leads-bell" ref={wrapRef}>
      <button
        type="button"
        className="leads-bell-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={bellLabel}
        title={bellLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={16} />
        {unreadCount ? (
          <span className="leads-bell-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>
        ) : null}
      </button>

      {open ? (
        <div className="leads-pop" role="menu">
          <div className="leads-pop-head">
            <span className="leads-pop-title">Leads</span>
            {unreadCount ? (
              <span className="leads-pop-count" title={bellLabel}>
                {unreadCount}
              </span>
            ) : null}
            {unreadCount ? (
              <button
                type="button"
                className="leads-pop-clear"
                onClick={markAllRead}
                title="Mark every lead as read"
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <ul className="leads-pop-list">
            {leads.map((lead) => (
              <LeadRow
                key={lead.id}
                lead={lead}
                unread={isUnread(lead, readSet)}
                onMarkRead={() => markRead(lead.id)}
                onOutcome={(outcome) => logOutcome(lead.id, outcome)}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function LeadRow({ lead, unread, onMarkRead, onOutcome }) {
  // Summaries run to several sentences. Clamped to two lines so one verbose
  // lead cannot push the rest of the list out of view, with the full text one
  // click away rather than hidden behind a tooltip nobody hovers.
  const [expanded, setExpanded] = useState(false)

  const chips = leadChips(lead)
  const hasSummary = !isBlank(lead.summary)

  return (
    <li className={`leads-item${unread ? ' is-unread' : ''}`}>
      <div className="leads-item-top">
        {unread ? <span className="leads-item-dot" aria-label="Unread" /> : null}
        <span className="leads-item-name">{lead.full_name || 'Unnamed lead'}</span>
        {lead.lead_number ? <span className="leads-item-no">{lead.lead_number}</span> : null}
        {/* Marks read; never removes. Read leads stay in the list. */}
        {unread ? (
          <button
            type="button"
            className="leads-item-x"
            aria-label={`Mark ${lead.full_name || 'lead'} as read`}
            title="Mark as read"
            onClick={onMarkRead}
          >
            <Check size={13} />
          </button>
        ) : null}
      </div>

      {/* Phone is present on every lead in practice and is the one field an
          agent acts on, so it leads and stays a tap-to-call link. */}
      {!isBlank(lead.phone) ? (
        <div className="leads-item-row">
          <Phone size={12} />
          <a className="leads-item-link" href={`tel:${lead.phone}`}>
            {lead.phone}
          </a>
        </div>
      ) : null}

      {!isBlank(lead.email) ? (
        <div className="leads-item-row">
          <Mail size={12} />
          <a className="leads-item-link" href={`mailto:${lead.email}`}>
            {lead.email}
          </a>
        </div>
      ) : null}

      {/* Everything else as labelled chips. Absent fields are omitted, not
          dashed — most leads fill only four or five of these, and a column of
          dashes would bury the ones that carry an answer. */}
      {chips.length ? (
        <div className="leads-chips">
          {chips.map((chip) => (
            <span key={chip.key} className={`leads-chip leads-chip-${chip.tone}`}>
              <span className="leads-chip-label">{chip.label}</span>
              <span className="leads-chip-value">{chip.text}</span>
            </span>
          ))}
        </div>
      ) : null}

      <LeadMeta lead={lead} />

      <LeadOutcome status={lead.status} onLog={onOutcome} />

      {hasSummary ? (
        <button
          type="button"
          className={`leads-item-summary${expanded ? ' is-open' : ''}`}
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Show less' : 'Show full summary'}
        >
          {lead.summary}
        </button>
      ) : null}
    </li>
  )
}

/**
 * Provenance and ownership: when the enquiry came in and which salesperson
 * holds it. A label/value grid rather than chips — these are facts to look up,
 * not attributes to scan.
 */
function LeadMeta({ lead }) {
  const owner = lead.owner || null
  const ownerName = owner?.display_name || owner?.email || null
  const assignedAt = formatLeadTime(lead.assigned_at)

  const rows = [
    { key: 'received', label: 'Received', value: formatLeadTime(lead.received_at), title: fullLeadTime(lead.received_at) },
    {
      key: 'owner',
      label: 'Assigned to',
      value: lead.owner_profile_id ? (
        <>
          <span className="leads-meta-strong">{ownerName || 'Unknown profile'}</span>
          {assignedAt ? <span className="leads-meta-sub"> · {assignedAt}</span> : null}
        </>
      ) : (
        <span className="leads-meta-muted">Unassigned</span>
      ),
      title: assignedAt ? `Assigned ${fullLeadTime(lead.assigned_at)}` : '',
    },
  ].filter((row) => row.value)

  return (
    <dl className="leads-meta">
      {rows.map((row) => (
        <div key={row.key} className="leads-meta-row" title={row.title || undefined}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * "Log what happened…" — the same control as the OS lead drawer. Each pick is
 * logged as an activity; on a 'new' lead it also moves the status on, and the
 * resulting status is shown alongside. The select is locked while a save is in
 * flight so a second pick cannot race the first, and a failure shows inline.
 */
function LeadOutcome({ status, onLog }) {
  const [outcome, setOutcome] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleChange = async (e) => {
    const next = e.target.value
    if (!next) return
    setSaving(true)
    setError('')
    try {
      await onLog(next)
      setOutcome(next)
    } catch (err) {
      setError(err?.message || 'Could not log outcome')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="leads-status">
      <div className="leads-status-line">
        <span className="leads-status-label">Status</span>
        <span className={`leads-status-pill leads-status-${status || 'new'}`}>
          {statusLabel(status || 'new')}
        </span>
      </div>
      <select
        className={`leads-status-select${outcome ? ' is-set' : ''}`}
        value={outcome}
        onChange={handleChange}
        disabled={saving}
        aria-label="Log what happened"
      >
        <option value="" disabled>
          {saving ? 'Saving…' : 'Log what happened…'}
        </option>
        {CONTACT_OUTCOMES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      {error ? <span className="leads-status-error">{error}</span> : null}
    </div>
  )
}
