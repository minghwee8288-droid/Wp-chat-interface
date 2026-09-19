// Part of the removable "new lead" feature — see functions/api/leads/mine.js
// for the full removal checklist.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchMyLeads } from './leadsApi.js'

/** The inbox polls chats every 5s; leads change far less often. */
const POLL_MS = 60000

/**
 * Dismissals are per-browser and never touch the database — the feature was
 * specified to add no migration, and `leads` has no column to record "this
 * agent has seen it". localStorage is the honest place for a view-state fact.
 */
const SEEN_KEY = 'wp_leads_seen_v1'

function readSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set()
  } catch {
    // Private mode, blocked storage, or corrupt JSON. Showing every lead is
    // the safe failure: a lead seen twice beats a lead never seen.
    return new Set()
  }
}

function writeSeen(set) {
  try {
    // Bounded so a long-lived browser cannot grow this without limit.
    localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-200)))
  } catch {
    /* storage unavailable — dismissal simply does not persist */
  }
}

/**
 * The caller's new leads, polled, with locally-dismissed ones filtered out.
 *
 * Errors are swallowed into `leads: []`. This is a secondary surface: a failing
 * leads query must never put an error banner over a working inbox.
 */
export function useMyLeads() {
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [seen, setSeen] = useState(readSeen)
  // Held in a ref so the polling effect never re-subscribes when a lead is
  // dismissed — re-running it would fire an extra request per dismissal.
  const activeRef = useRef(true)

  const load = useCallback(async (signal) => {
    try {
      const rows = await fetchMyLeads({ signal })
      if (activeRef.current) setLeads(rows)
    } catch (err) {
      if (err?.name === 'AbortError') return
      if (activeRef.current) setLeads([])
    } finally {
      if (activeRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    activeRef.current = true
    const controller = new AbortController()
    load(controller.signal)

    const timer = setInterval(() => {
      // Polling a hidden tab wakes the worker for a view nobody is looking at.
      if (document.visibilityState === 'visible') load(controller.signal)
    }, POLL_MS)

    // A tab returning to the foreground may have missed several ticks.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load(controller.signal)
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      activeRef.current = false
      controller.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const dismiss = useCallback((id) => {
    setSeen((prev) => {
      const next = new Set(prev)
      next.add(String(id))
      writeSeen(next)
      return next
    })
  }, [])

  const dismissAll = useCallback(() => {
    setSeen((prev) => {
      const next = new Set(prev)
      leads.forEach((lead) => next.add(String(lead.id)))
      writeSeen(next)
      return next
    })
  }, [leads])

  const visible = useMemo(
    () => leads.filter((lead) => !seen.has(String(lead.id))),
    [leads, seen]
  )

  return { leads: visible, count: visible.length, loading, dismiss, dismissAll }
}
