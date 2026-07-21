import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Check, X } from 'lucide-react'

/**
 * Filter row: two multi-select status chips plus an agent picker.
 *
 * Status chips are deliberately NOT radio buttons — both off and both on mean
 * the same thing (show everything), which keeps "clear the filter" reachable
 * from either direction.
 */
export default function ConversationFilters({ users, filters, onChange }) {
  const { assigned, unassigned, agentIds } = filters
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menuPos, setMenuPos] = useState(null)
  const pickerRef = useRef(null)
  const chipRef = useRef(null)
  const menuRef = useRef(null)

  /**
   * The menu is portalled to <body> and positioned with fixed coordinates.
   *
   * It cannot be an absolutely-positioned child: .filter-row is the mobile
   * horizontal scroller (overflow-x: auto / overflow-y: hidden), and a
   * non-visible overflow on either axis clips descendants on BOTH. Measured:
   * the row's box ends at y=152 while the menu needed to reach y=262, so it
   * was clipped away entirely. z-index was never the problem — the menu sat at
   * 60 with nothing above it.
   */
  const place = useCallback(() => {
    const chip = chipRef.current
    if (!chip) return
    const rect = chip.getBoundingClientRect()
    const MENU_W = 190
    const MENU_MAX_H = 260
    const GAP = 6

    // Flip above the chip when there is not enough room below it.
    const spaceBelow = window.innerHeight - rect.bottom - GAP
    const above = spaceBelow < Math.min(MENU_MAX_H, 160) && rect.top > spaceBelow

    setMenuPos({
      top: above ? undefined : rect.bottom + GAP,
      bottom: above ? window.innerHeight - rect.top + GAP : undefined,
      // Keep it on screen at narrow widths.
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_W - 8)),
      maxHeight: above ? rect.top - GAP - 8 : spaceBelow - 8,
    })
  }, [])

  useLayoutEffect(() => {
    if (pickerOpen) place()
  }, [pickerOpen, place])

  useEffect(() => {
    if (!pickerOpen) return undefined

    const onDown = (e) => {
      // The menu lives outside pickerRef now, so both have to be checked.
      const inPicker = pickerRef.current?.contains(e.target)
      const inMenu = menuRef.current?.contains(e.target)
      if (!inPicker && !inMenu) setPickerOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    // Capture, so a scroll inside the list or the filter row also repositions.
    const onScrollOrResize = () => place()

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [pickerOpen, place])

  const activeAgents = users.filter((u) => u.is_active)
  const count = agentIds.length

  const toggleAgent = (id) => {
    const key = String(id)
    onChange({
      ...filters,
      agentIds: agentIds.includes(key)
        ? agentIds.filter((a) => a !== key)
        : [...agentIds, key],
    })
  }

  return (
    <div className="filter-row" role="group" aria-label="Filter conversations">
      <button
        type="button"
        className={`filter-chip${assigned ? ' is-on' : ''}`}
        aria-pressed={assigned}
        onClick={() => onChange({ ...filters, assigned: !assigned })}
      >
        Assigned
      </button>

      <button
        type="button"
        className={`filter-chip${unassigned ? ' is-on' : ''}`}
        aria-pressed={unassigned}
        onClick={() => onChange({ ...filters, unassigned: !unassigned })}
      >
        Unassigned
      </button>

      <div className="filter-picker" ref={pickerRef}>
        <button
          type="button"
          ref={chipRef}
          className={`filter-chip${count ? ' is-on' : ''}`}
          aria-haspopup="true"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((v) => !v)}
        >
          {count ? (
            `${count} ${count === 1 ? 'agent' : 'agents'}`
          ) : (
            <>
              <Plus size={13} />
              Agent
            </>
          )}
        </button>

        {/* Reset sits outside the toggle so it never costs a second tap to
            reach, and never fires when the user meant to reopen the picker. */}
        {count ? (
          <button
            type="button"
            className="filter-clear-agents"
            aria-label="Clear agent filter"
            onClick={() => onChange({ ...filters, agentIds: [] })}
          >
            <X size={12} />
          </button>
        ) : null}

        {pickerOpen && menuPos
          ? createPortal(
              <div
                className="filter-menu"
                role="menu"
                ref={menuRef}
                style={{
                  top: menuPos.top,
                  bottom: menuPos.bottom,
                  left: menuPos.left,
                  maxHeight: menuPos.maxHeight,
                }}
              >
            {activeAgents.length === 0 ? (
              <div className="filter-menu-empty">No active team members</div>
            ) : (
              activeAgents.map((user) => {
                const checked = agentIds.includes(String(user.id))
                return (
                  <button
                    type="button"
                    key={user.id}
                    className="filter-menu-item"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    onClick={() => toggleAgent(user.id)}
                  >
                    <span className={`filter-check${checked ? ' is-on' : ''}`}>
                      {checked ? <Check size={11} /> : null}
                    </span>
                    <span className="filter-menu-name">{user.name}</span>
                  </button>
                )
              })
            )}
              </div>,
              document.body
            )
          : null}
      </div>
    </div>
  )
}

export const EMPTY_FILTERS = { assigned: false, unassigned: false, agentIds: [] }

export const hasActiveFilters = (f) =>
  Boolean(f.assigned || f.unassigned || f.agentIds.length)

/**
 * Status chips and the agent picker combine with AND.
 *
 * "Unassigned" active together with selected agents is contradictory by
 * definition — a conversation cannot both lack an assignee and be assigned to
 * a chosen agent. That falls out of the AND naturally and yields an empty
 * list, which is what the brief asks for: surface the contradiction rather
 * than silently dropping one of the filters.
 */
export function matchesFilters(conversation, filters) {
  const hasAssignee = conversation.assigned_user_id != null

  // Both off or both on means no status constraint.
  if (filters.assigned !== filters.unassigned) {
    if (filters.assigned && !hasAssignee) return false
    if (filters.unassigned && hasAssignee) return false
  }

  if (filters.agentIds.length) {
    if (!hasAssignee) return false
    if (!filters.agentIds.includes(String(conversation.assigned_user_id))) return false
  }

  return true
}
