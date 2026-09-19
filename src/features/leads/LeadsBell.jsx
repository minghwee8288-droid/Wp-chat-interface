// Part of the removable "new lead" feature — see functions/api/leads/mine.js
// for the full removal checklist.
//
// Mounted once, in the Shell topbar. Renders nothing at all when the caller has
// no new leads, so a user who never owns leads sees no change to the UI.

import { useEffect, useRef, useState } from 'react'
import { Bell, Mail, Phone, X } from 'lucide-react'
import { useMyLeads } from './useMyLeads.js'
import { leadChips, isBlank } from './leadFields.js'

export default function LeadsBell() {
  const { leads, count, loading, dismiss, dismissAll } = useMyLeads()
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

  // Dismissing the last lead leaves an empty panel anchored to a bell that is
  // about to unmount — close it rather than let it hang.
  useEffect(() => {
    if (open && count === 0) setOpen(false)
  }, [open, count])

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

  // Nothing to say, so nothing is drawn. Not even a zero-state bell: this is an
  // alert, and an alert with nothing to alert about is noise.
  if (loading || count === 0) return null

  return (
    <div className="leads-bell" ref={wrapRef}>
      <button
        type="button"
        className="leads-bell-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${count} new lead${count === 1 ? '' : 's'}`}
        title={`${count} new lead${count === 1 ? '' : 's'}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={16} />
        <span className="leads-bell-badge">{count > 9 ? '9+' : count}</span>
      </button>

      {open ? (
        <div className="leads-pop" role="menu">
          <div className="leads-pop-head">
            <span className="leads-pop-title">
              New lead{count === 1 ? '' : 's'} arrived
            </span>
            <span className="leads-pop-count">{count}</span>
            <button
              type="button"
              className="leads-pop-clear"
              onClick={dismissAll}
              title="Dismiss all"
            >
              Clear all
            </button>
          </div>

          <ul className="leads-pop-list">
            {leads.map((lead) => (
              <LeadRow key={lead.id} lead={lead} onDismiss={() => dismiss(lead.id)} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function LeadRow({ lead, onDismiss }) {
  // Summaries run to several sentences. Clamped to two lines so one verbose
  // lead cannot push the rest of the list out of view, with the full text one
  // click away rather than hidden behind a tooltip nobody hovers.
  const [expanded, setExpanded] = useState(false)

  const chips = leadChips(lead)
  const hasSummary = !isBlank(lead.summary)

  return (
    <li className="leads-item">
      <div className="leads-item-top">
        <span className="leads-item-name">{lead.full_name || 'Unnamed lead'}</span>
        {lead.lead_number ? <span className="leads-item-no">{lead.lead_number}</span> : null}
        <button
          type="button"
          className="leads-item-x"
          aria-label={`Dismiss ${lead.full_name || 'lead'}`}
          onClick={onDismiss}
        >
          <X size={13} />
        </button>
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
