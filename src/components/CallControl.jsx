import { useCallback, useEffect, useRef, useState } from 'react'
import { Phone, ChevronDown, RefreshCw, User } from 'lucide-react'
import { api } from '../lib/api.js'
import { avatarIndex, digitsOnly, formatNumber, initials } from '../lib/format.js'

/**
 * Click-to-call for the thread header.
 *
 * The dialing is NOT done here. A browser extension watches the page for phone
 * numbers and places the call itself, so this control's only job is to put the
 * number on the page in the shape such extensions look for: a real
 * `tel:`-href anchor holding the bare E.164 digits. `data-phone` carries the
 * same digits as a second hook for extensions that match attributes rather
 * than hrefs, and the visible text is the formatted number for the human.
 *
 * Leaving it as an <a href="tel:"> also means the control still works with no
 * extension installed — the OS dialer picks it up — which a button wired to a
 * click handler would not.
 *
 * 1:1 chats get a single anchor. Groups get a menu, because the extension can
 * only dial one person at a time: there is no such thing as calling a group
 * through it, so the user picks the member to ring.
 */
export default function CallControl({ conversation }) {
  const isGroup = Boolean(conversation.is_group)
  const number = digitsOnly(conversation.customer_number)

  // --- Group: member picker ----------------------------------------------
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)

  // Same dismissal contract as the account switcher: pointer outside, or
  // Escape. Escape also returns focus to the trigger; the mouse path does not
  // need to, because the pointer is already where the user is looking.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Members are fetched lazily on first open rather than with the thread: most
  // threads are never called from, and this is the same cached endpoint the
  // info panel uses, so an open after visiting that panel is already warm.
  const load = useCallback(
    async (refresh) => {
      setLoading(true)
      setError(null)
      try {
        const data = refresh
          ? await api.refreshGroupMembers(conversation.id)
          : await api.groupMembers(conversation.id)
        setMembers(data.members || [])
        if (data.warning) setError(data.warning)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    },
    [conversation.id]
  )

  // A different conversation means a different roster. Drop the old one rather
  // than showing the previous group's members under this group's name.
  useEffect(() => {
    setOpen(false)
    setMembers([])
    setError(null)
  }, [conversation.id])

  if (!isGroup) {
    if (!number) return null
    return (
      <a
        className="icon-btn call-btn"
        href={`tel:+${number}`}
        data-phone={`+${number}`}
        aria-label={`Call ${formatNumber(number)}`}
        title={`Call ${formatNumber(number)}`}
      >
        <Phone size={18} />
      </a>
    )
  }

  const openMenu = () => {
    const next = !open
    setOpen(next)
    if (next && !members.length && !loading) load(false)
  }

  // A group whose members carry no number cannot be dialed at all. Keep the
  // menu open to say so rather than silently rendering an empty list.
  const dialable = members.filter((m) => digitsOnly(m.member_number))

  return (
    <div className="call-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`icon-btn call-btn call-btn-group${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Call a group member"
        title="Call a group member"
        onClick={openMenu}
      >
        <Phone size={18} />
        <ChevronDown size={11} className="call-caret" />
      </button>

      {open ? (
        <div className="call-pop" role="menu" aria-label="Call a group member">
          <div className="call-pop-head">
            <span>Call a member</span>
            <button
              type="button"
              className="icon-btn call-refresh"
              aria-label="Refresh member list"
              title="Refresh member list"
              disabled={loading}
              onClick={() => load(true)}
            >
              <RefreshCw size={13} className={loading ? 'is-spinning' : undefined} />
            </button>
          </div>

          {/* Says plainly why this is a list and not a single call button —
              the group itself is not dialable, only the people in it. */}
          <p className="call-pop-note">Calls go to one person at a time.</p>

          {loading && !members.length ? (
            <div className="call-pop-state">Loading members…</div>
          ) : error && !dialable.length ? (
            <div className="call-pop-state call-pop-error">{error}</div>
          ) : !dialable.length ? (
            <div className="call-pop-state">No member numbers recorded yet.</div>
          ) : (
            <div className="call-pop-list">
              {dialable.map((m) => {
                const digits = digitsOnly(m.member_number)
                const pretty = formatNumber(m.member_number)
                // WhatsApp does not always expose a member's name, and most
                // groups here have none at all. When there is no name the
                // number IS the identity, so it becomes the single primary
                // line — printing it as both the name and the subtitle showed
                // every row twice, and fed initials() a '+65...' string that
                // came out as a meaningless '+' in the avatar.
                const name = m.member_name?.trim() || null
                return (
                  <a
                    key={m.id}
                    role="menuitem"
                    className="menu-item call-item"
                    href={`tel:+${digits}`}
                    data-phone={`+${digits}`}
                    aria-label={`Call ${name || pretty}`}
                    onClick={() => setOpen(false)}
                  >
                    <span
                      className="conv-avatar call-item-avatar"
                      data-color={avatarIndex(m.member_number)}
                    >
                      {name ? initials(name) : <User size={14} />}
                    </span>
                    <span className="call-item-id">
                      {name ? (
                        <>
                          <span className="call-item-name">{name}</span>
                          <span className="call-item-number">{pretty}</span>
                        </>
                      ) : (
                        <span className="call-item-name call-item-name-number">{pretty}</span>
                      )}
                    </span>
                    <Phone size={14} className="call-item-icon" />
                  </a>
                )
              })}
            </div>
          )}

          {/* A refresh that partly failed still leaves usable rows above, so
              the warning sits under them instead of replacing them. */}
          {error && dialable.length ? <div className="call-pop-warn">{error}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
